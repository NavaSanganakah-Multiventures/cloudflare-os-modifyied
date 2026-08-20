// Auto-approval drain core: applies eligible pending actions in id order, with a per-gatekeeper
// single-flight guard so two concurrent drains (the DO's input gate is open across the apply await)
// can't double-apply the same action. The apply is injected, keeping this constructible over a
// mock storage in tests.

import type { Collection } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord, AutoApproveTagRecord } from "./overseer.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>;
  autoApproveTags: Collection<AutoApproveTagRecord>;
}

// The verdict shared by both auto-approval paths so they can never diverge:
//   - "eligible": apply automatically (the action is auto-approvable AND a user-enabled rule
//     covers it, on a matching branch for branch-scoped kinds).
//   - "manual":   the author did not mark the action `autoApprovable`, or no rule is enabled for
//     its action kind. The drain stops here so nothing is silently applied past a human gate.
//   - "branch":   the action is auto-approvable and a rule exists, but it targets a branch the
//     rule's patterns do not cover. The drain leaves it pending and continues, so a
//     blocked-branch action never stalls later actions on other branches.
export type AutoApprovalGate = "eligible" | "manual" | "branch";

// Single source of truth for auto-approval eligibility, used both at submit time (to decide
// whether to trigger the drain and whether the agent should await a decision) and during the
// drain (to decide apply / stop / skip). Branch patterns only restrict branch-scoped actions;
// non-branch actions (`branchScoped === false`) auto-approve on any branch. An empty/absent
// pattern list matches every branch.
export function autoApprovalGate(
    description: ActionDescription,
    rule: AutoApproveTagRecord | undefined): AutoApprovalGate {
  if (description.autoApprovable !== true || description.actionKind === undefined
      || rule === undefined) {
    return "manual";
  }
  if (description.actionKind.branchScoped !== false &&
      rule.branchPatterns && rule.branchPatterns.length > 0 &&
      (description.branchRef === undefined ||
       !branchMatchesPatterns(normalizeBranchRef(description.branchRef), rule.branchPatterns))) {
    return "branch";
  }
  return "eligible";
}

// Match a branch reference against a list of glob patterns. Patterns are evaluated in order;
// a leading "!" negates the pattern and denies a match. "*" matches any sequence of characters.
function branchMatchesPatterns(branchRef: string, patterns: string[]): boolean {
  // If the first pattern is a negation, implicitly start by including everything.
  let included = patterns.length > 0 && patterns[0].startsWith("!");
  for (const pattern of patterns) {
    let negated = pattern.startsWith("!");
    let glob = negated ? pattern.slice(1) : pattern;
    let match = matchesGlob(branchRef, glob);
    if (match) {
      included = !negated;
    }
  }
  return included;
}

// Simple glob matcher supporting only "*" (any sequence).
function matchesGlob(str: string, pattern: string): boolean {
  if (pattern === "*") return true;
  // No wildcard means exact match.
  if (!pattern.includes("*")) return str === pattern;
  let parts = pattern.split("*");
  // Leading literal must match the start of the string.
  if (parts[0] !== "" && !str.startsWith(parts[0])) return false;
  // Trailing literal must match the end of the string.
  if (parts[parts.length - 1] !== "" && !str.endsWith(parts[parts.length - 1])) return false;
  let pos = parts[0].length;
  let end = str.length - parts[parts.length - 1].length;
  for (let i = 1; i < parts.length - 1; i++) {
    let part = parts[i];
    if (part === "") continue;
    let idx = str.indexOf(part, pos);
    if (idx === -1 || idx + part.length > end) return false;
    pos = idx + part.length;
  }
  return pos <= end;
}

// Normalize a branch ref to a short branch name before pattern matching, so
// patterns like "!main" work whether the gatekeeper passes "main" or "refs/heads/main".
function normalizeBranchRef(branchRef: string): string {
  return branchRef.replace(/^refs\/heads\//, "");
}

// Applies a single eligible pending action: invoke the gatekeeper, mark it approved, persist. The
// caller has already validated that the record is still pending.
export type ApplyPendingActionFn = (
    record: ActionRecord & {type: "action"},
    resolvedBy: AiChatAuthorInfo,
    autoApproved: boolean) => Promise<void>;

export class AutoApprovalDrainer {
  // Per-gatekeeper single-flight state. Key present => a drain is running for that gatekeeper; the
  // value is a "rerun" flag, set when another drain is requested while one is in flight, so work
  // submitted during a drain isn't lost.
  #draining = new Map<number, boolean>();

  constructor(
      private storage: AutoApprovalStorage,
      private applyPendingAction: ApplyPendingActionFn) {}

  async drain(gatekeeperId: number): Promise<void> {
    if (this.#draining.has(gatekeeperId)) {
      this.#draining.set(gatekeeperId, true);  // ask the running drain to loop again
      return;
    }
    this.#draining.set(gatekeeperId, false);
    try {
      do {
        this.#draining.set(gatekeeperId, false);
        await this.#drainOnce(gatekeeperId);
      } while (this.#draining.get(gatekeeperId));
    } finally {
      this.#draining.delete(gatekeeperId);
    }
  }

  // Apply all currently-eligible pending actions of the gatekeeper, in ascending id order. A
  // true manual gate (no rule, or the action is not marked auto-approvable) stops the drain so
  // nothing is silently applied past a human gate -- the human controls the order of the rest.
  // A branch-pattern gate (the action targets a branch the rule does not cover) is instead
  // skipped and left pending for review, so a blocked-branch action never stalls auto-approval
  // of later actions on other branches. An apply that throws also stops the drain (never skip
  // ahead). This preserves in-order application and the invariant that nothing is silently
  // applied past a human gate.
  //
  // Eligibility uses the shared `autoApprovalGate` predicate, the same one the submit path uses,
  // so the "will this auto-approve?" verdict at submit time and the "apply this" verdict during
  // the drain can never diverge.
  async #drainOnce(gatekeeperId: number): Promise<void> {
    // Materialize a snapshot first: list() is a lazy generator over storage, and we mutate the
    // actions collection (via applyPendingAction) as we go.
    let pending = [...this.storage.actions.list()].filter(
        (rec): rec is ActionRecord & {type: "action"} =>
            rec.gatekeeperId === gatekeeperId && rec.type === "action" && rec.state === "pending");

    for (let record of pending) {
      let tag = record.description.actionKind?.tag;
      let rule = tag !== undefined
          ? this.storage.autoApproveTags.get(`${gatekeeperId}:${tag}`)
          : undefined;
      let gate = autoApprovalGate(record.description, rule);
      if (gate === "manual") {
        // A true manual gate. Stop rather than skipping ahead to any later auto-eligible action;
        // the human controls the order of the remaining actions.
        break;
      }
      if (gate === "branch") {
        // A branch-pattern gate: the action targets a branch this rule does not cover. Leave it
        // pending for review and continue, so it never stalls later actions on other branches.
        continue;
      }

      // Re-check immediately before applying, to guard against a concurrent drain having already
      // taken this one.
      let fresh = this.storage.actions.get(record.id);
      if (!fresh || fresh.type !== "action" || fresh.state !== "pending") {
        continue;
      }

      try {
        // Attribute the auto-approval to the user who enabled the rule -- it runs under their
        // authority. "eligible" implies a rule exists (autoApprovalGate returns "manual" when
        // rule is undefined), so the non-null assertion is safe.
        await this.applyPendingAction(fresh, rule!.enabledBy, true);
      } catch (err) {
        // Leave the action pending for manual handling and stop the drain (never skip ahead).
        logger.error("auto-approval failed", {
          event: "auto.approval.failed", actionId: fresh.id, error: err,
        });
        break;
      }
    }
  }
}
