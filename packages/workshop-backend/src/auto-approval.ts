// Auto-approval drain core: applies eligible pending actions in id order, with a per-gatekeeper
// single-flight guard so two concurrent drains (the DO's input gate is open across the apply await)
// can't double-apply the same action. The apply is injected, keeping this constructible over a
// mock storage in tests.

import type { Collection } from "@gadgets/typed-storage";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { createWorkshopLogger } from "./observability";
import type { ActionRecord, AutoApproveTagRecord } from "./overseer.js";

const logger = createWorkshopLogger("workshop.auto.approval");

export interface AutoApprovalStorage {
  actions: Collection<ActionRecord, number>;
  autoApproveTags: Collection<AutoApproveTagRecord>;
}

// Match a branch reference against a list of glob patterns. Patterns are evaluated in order;
// a leading "!" negates the pattern and denies a match. "*" matches any sequence of characters.
function branchMatchesPatterns(branchRef: string, patterns: string[]): boolean {
  let included = false;
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

  // Apply all currently-eligible pending actions of the gatekeeper, in ascending id order. Stops at
  // the first pending action that is NOT auto-eligible (a manual gate) or that throws while applying
  // -- it is never skipped ahead of. This preserves in-order application and the invariant that
  // nothing is silently applied past a human gate.
  //
  // Eligibility requires BOTH signals: the author's `autoApprovable` verdict on the action AND a
  // user-enabled rule for the action's type on this gatekeeper.
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
      if (record.description.autoApprovable !== true || rule === undefined) {
        // A manual gate. Stop rather than skipping ahead to any later auto-eligible action.
        break;
      }
      if (rule.branchPatterns && rule.branchPatterns.length > 0 &&
          (record.description.branchRef === undefined ||
           !branchMatchesPatterns(record.description.branchRef, rule.branchPatterns))) {
        // A branch-pattern gate. The action targets a branch this rule does not cover.
        break;
      }

      // Re-check immediately before applying, to guard against a concurrent drain having already
      // taken this one.
      let fresh = this.storage.actions.get(record.id);
      if (!fresh || fresh.type !== "action" || fresh.state !== "pending") {
        continue;
      }

      try {
        // Attribute the auto-approval to the user who enabled the rule -- it runs under their
        // authority.
        await this.applyPendingAction(fresh, rule.enabledBy, true);
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
