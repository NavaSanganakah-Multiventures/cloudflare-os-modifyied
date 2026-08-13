import { describe, it, expect } from "vitest";
import { createTypedStorage, collection } from "@gadgets/typed-storage";
import { AutoApprovalDrainer, AutoApprovalStorage, ApplyPendingActionFn, autoApprovalGate } from "../src/auto-approval.js";
import type { ActionRecord, AutoApproveTagRecord } from "../src/overseer.js";
import type { ActionDescription } from "@gadgets/workshop-shared/gatekeeper";
import type { AiChatAuthorInfo } from "@gadgets/workshop-shared/api";
import { makeMockStorage } from "./mock-storage.js";

function makeStorage(): AutoApprovalStorage {
  return createTypedStorage(makeMockStorage(), {
    collections: {
      actions: collection<ActionRecord>()({ primaryKey: "id" }),
      autoApproveTags: collection<AutoApproveTagRecord>()({
        primaryKey: (r: AutoApproveTagRecord) => `${r.gatekeeperId}:${r.actionKind.tag}`,
      }),
    },
  });
}

const GK = 1;
const ENABLER: AiChatAuthorInfo = { type: "user", id: "enabler@example.com", name: "Enabler" };

function enableRule(storage: AutoApprovalStorage, actionTag = "edit", gatekeeperId = GK,
    branchPatterns?: string[]) {
  storage.autoApproveTags.put({
    gatekeeperId, actionKind: { tag: actionTag, label: "Edits" }, enabledBy: ENABLER, branchPatterns });
}

function putAction(
    storage: AutoApprovalStorage, id: number,
    opts: { gatekeeperId?: number; actionTag?: string; autoApprovable?: boolean;
            state?: ActionRecord["state"]; branchRef?: string; branchScoped?: boolean } = {}) {
  storage.actions.put({
    id,
    gatekeeperId: opts.gatekeeperId ?? GK,
    caller: { from: "agent", chatId: 1 },
    createdAt: new Date(),
    state: opts.state ?? "pending",
    type: "action",
    action: id,
    description: {
      title: `Action ${id}`,
      description: `Action ${id} description`,
      implementsRevert: true,
      actionKind: {
        tag: opts.actionTag ?? "edit",
        label: "Edits",
        ...(opts.branchScoped !== undefined ? { branchScoped: opts.branchScoped } : {}),
      },
      autoApprovable: opts.autoApprovable ?? true,
      branchRef: opts.branchRef,
    },
  });
}

function getAction(storage: AutoApprovalStorage, id: number): ActionRecord & {type: "action"} {
  let record = storage.actions.get(id);
  if (!record || record.type !== "action") throw new Error(`No action ${id}`);
  return record;
}

// An apply fn that resolves immediately, mirroring OverseerImpl.applyPendingAction's effect:
// mark the record approved and persist. Records the order of applied action ids.
function makeImmediateApply(storage: AutoApprovalStorage) {
  let calls: number[] = [];
  let applyFn: ApplyPendingActionFn = async (record, resolvedBy, autoApproved) => {
    calls.push(record.id);
    let fresh = storage.actions.get(record.id);
    if (fresh && fresh.type === "action") {
      fresh.state = "approved";
      fresh.appliedAt = new Date();
      fresh.resolvedBy = resolvedBy;
      fresh.autoApproved = autoApproved;
      storage.actions.put(fresh);
    }
  };
  return { applyFn, calls };
}

// An apply fn whose every invocation parks on a test-held promise until released. Lets a test hold
// an apply mid-flight (input gate open) while launching a second concurrent drain. On release it
// performs the same approve+persist effect as the real apply.
function makeControlledApply(storage: AutoApprovalStorage) {
  let calls: number[] = [];
  let gates: Array<() => void> = [];
  let applyFn: ApplyPendingActionFn = (record, resolvedBy, autoApproved) => {
    calls.push(record.id);
    return new Promise<void>((resolve) => {
      gates.push(() => {
        let fresh = storage.actions.get(record.id);
        if (fresh && fresh.type === "action") {
          fresh.state = "approved";
          fresh.appliedAt = new Date();
          fresh.resolvedBy = resolvedBy;
          fresh.autoApproved = autoApproved;
          storage.actions.put(fresh);
        }
        resolve();
      });
    });
  };
  return {
    applyFn,
    calls,
    inFlight: () => gates.length,
    releaseNext() {
      let gate = gates.shift();
      if (!gate) throw new Error("no apply in flight to release");
      gate();
    },
  };
}

// Drain all microtasks (and the macrotask queue) so suspended drain continuations run to their next
// park point.
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("AutoApprovalDrainer.drain", () => {
  it("applies all eligible pending actions in ascending id order", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2);
    putAction(storage, 3);

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual([1, 2, 3]);
    for (let id of [1, 2, 3]) {
      let record = getAction(storage, id);
      expect(record.state).toBe("approved");
      expect(record.autoApproved).toBe(true);
      expect(record.resolvedBy?.id).toBe(ENABLER.id);
    }
  });

  it("stops at a manual gate without skipping ahead, then resumes once it clears", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);
    putAction(storage, 2, { autoApprovable: false });  // manual gate
    putAction(storage, 3);

    let { applyFn, calls } = makeImmediateApply(storage);
    let drainer = new AutoApprovalDrainer(storage, applyFn);
    await drainer.drain(GK);

    // Only the action before the gate is applied; the gate and everything behind it stay pending.
    expect(calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");

    // Clear the gate (as a manual approval would) and re-drain: the rest applies, still in order.
    let gate = getAction(storage, 2);
    gate.state = "approved";
    storage.actions.put(gate);
    await drainer.drain(GK);

    expect(calls).toEqual([1, 3]);
    expect(getAction(storage, 3).state).toBe("approved");
  });

  // Two concurrent drains for the same gatekeeper must not double-apply. The input gate is open
  // across the apply await, so without the single-flight guard the second drain's pending re-check
  // would see the still-"pending" record and apply it again.
  it("never applies an action more than once under concurrent drains", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn);

    let first = drainer.drain(GK);   // starts, calls apply(1), parks mid-apply
    let second = drainer.drain(GK);  // must coalesce, not start a second apply
    await second;

    expect(apply.calls).toEqual([1]);
    expect(apply.inFlight()).toBe(1);

    apply.releaseNext();             // resolve apply(1); record becomes approved
    await first;                     // rerun pass re-lists: action 1 no longer pending -> no re-apply

    expect(apply.calls).toEqual([1]);
    expect(getAction(storage, 1).state).toBe("approved");
  });

  // Work that arrives while a drain is parked must still be applied -- the coalescing
  // "rerun" flag must not drop the wakeup.
  it("applies work submitted while a drain is parked mid-apply", async () => {
    let storage = makeStorage();
    enableRule(storage);
    putAction(storage, 1);

    let apply = makeControlledApply(storage);
    let drainer = new AutoApprovalDrainer(storage, apply.applyFn);

    let first = drainer.drain(GK);   // parks mid-apply on action 1

    putAction(storage, 2);           // new eligible action arrives mid-drain
    let second = drainer.drain(GK);  // coalesces -> sets the rerun flag
    await second;
    expect(apply.calls).toEqual([1]);

    apply.releaseNext();             // finish action 1; rerun pass should pick up action 2
    await flush();

    expect(apply.calls).toEqual([1, 2]);
    expect(apply.inFlight()).toBe(1);

    apply.releaseNext();             // finish action 2
    await first;

    expect(apply.calls).toEqual([1, 2]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("approved");
  });

  it("respects branch patterns on auto-approval rules", async () => {
    let storage = makeStorage();
    enableRule(storage, "edit", GK, ["feature/*", "*", "!main"]);

    putAction(storage, 1, { branchRef: "feature/auto-approval" });
    putAction(storage, 2, { branchRef: "main" });
    putAction(storage, 3, { branchRef: "random-branch" });

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual([1, 3]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("approved");
  });

  it("treats a rule without branch patterns as matching any branch", async () => {
    let storage = makeStorage();
    enableRule(storage);

    putAction(storage, 1, { branchRef: "feature/foo" });
    putAction(storage, 2, { branchRef: "main" });

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual([1, 2]);
  });

  // A branch-pattern gate (an action on a branch the rule does not cover) must be skipped and
  // left pending -- it must NOT stall the drain, so later actions on other branches still apply.
  it("skips a branch-mismatched action and continues to later eligible ones", async () => {
    let storage = makeStorage();
    enableRule(storage, "edit", GK, ["feature/*", "*", "!main"]);

    putAction(storage, 1, { branchRef: "feature/x" });
    putAction(storage, 2, { branchRef: "main" });        // branch gate -> skip
    putAction(storage, 3, { branchRef: "other" });       // still applies
    putAction(storage, 4, { branchRef: "main" });        // branch gate -> skip

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual([1, 3]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("approved");
    expect(getAction(storage, 4).state).toBe("pending");
  });

  // Non-branch actions (branchScoped === false), such as posting a comment or creating an issue,
  // have no branchRef. They must auto-approve regardless of the rule's branch patterns -- both at
  // submit time (the drain is triggered) and during the drain.
  it("auto-approves non-branch actions even with branch patterns and no branchRef", async () => {
    let storage = makeStorage();
    enableRule(storage, "comment", GK, ["feature/*", "*", "!main"]);

    putAction(storage, 1, { actionTag: "comment", branchScoped: false });
    putAction(storage, 2, { actionTag: "comment", branchScoped: false });

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual([1, 2]);
    expect(getAction(storage, 1).state).toBe("approved");
    expect(getAction(storage, 2).state).toBe("approved");
  });

  // A true manual gate (action not marked auto-approvable, or no rule) still stops the drain so
  // nothing is silently applied past a human gate, even when a branch gate is interleaved.
  it("still stops at a true manual gate, not a branch gate", async () => {
    let storage = makeStorage();
    enableRule(storage, "edit", GK, ["feature/*", "*", "!main"]);

    putAction(storage, 1, { branchRef: "feature/x" });
    putAction(storage, 2, { branchRef: "main", autoApprovable: false });  // manual gate -> stop
    putAction(storage, 3, { branchRef: "other" });

    let { applyFn, calls } = makeImmediateApply(storage);
    await new AutoApprovalDrainer(storage, applyFn).drain(GK);

    expect(calls).toEqual([1]);
    expect(getAction(storage, 2).state).toBe("pending");
    expect(getAction(storage, 3).state).toBe("pending");
  });
});

// The shared eligibility predicate is the contract both the submit path and the drain rely on,
// so lock its behavior directly.
describe("autoApprovalGate", () => {
  const rule = (branchPatterns?: string[]): AutoApproveTagRecord => ({
    gatekeeperId: GK, actionKind: { tag: "edit", label: "Edits" }, enabledBy: ENABLER, branchPatterns,
  });
  const desc = (opts: Partial<Pick<ActionDescription,
      "autoApprovable" | "actionKind" | "branchRef">> = {}): ActionDescription => ({
    title: "t", description: "d", implementsRevert: true,
    autoApprovable: opts.autoApprovable ?? true,
    actionKind: opts.actionKind ?? { tag: "edit", label: "Edits" },
    ...(opts.branchRef !== undefined ? { branchRef: opts.branchRef } : {}),
  });

  it("is manual when the action is not auto-approvable", () => {
    expect(autoApprovalGate(desc({ autoApprovable: false }), rule())).toBe("manual");
  });

  it("is manual when no rule is enabled", () => {
    expect(autoApprovalGate(desc(), undefined)).toBe("manual");
  });

  it("is eligible for a branch-scoped action on a covered branch", () => {
    expect(autoApprovalGate(desc({ branchRef: "feature/x" }), rule(["feature/*", "*", "!main"]))).toBe("eligible");
  });

  it("is branch for a branch-scoped action on an uncovered branch", () => {
    expect(autoApprovalGate(desc({ branchRef: "main" }), rule(["feature/*", "*", "!main"]))).toBe("branch");
  });

  it("is branch for a branch-scoped action with no branchRef and non-empty patterns", () => {
    expect(autoApprovalGate(desc(), rule(["feature/*", "*", "!main"]))).toBe("branch");
  });

  it("is eligible for a non-branch action (branchScoped: false) with no branchRef", () => {
    expect(autoApprovalGate(
        desc({ actionKind: { tag: "comment", label: "Comments", branchScoped: false } }),
        rule(["feature/*", "*", "!main"]))).toBe("eligible");
  });

  it("is eligible when patterns are empty (match any branch)", () => {
    expect(autoApprovalGate(desc({ branchRef: "main" }), rule([]))).toBe("eligible");
  });

  it("is eligible when patterns are absent (match any branch)", () => {
    expect(autoApprovalGate(desc({ branchRef: "main" }), rule(undefined))).toBe("eligible");
  });
});
