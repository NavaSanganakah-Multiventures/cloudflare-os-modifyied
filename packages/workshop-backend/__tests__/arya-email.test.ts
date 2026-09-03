import { describe, expect, it, vi } from "vitest";
import { RpcTarget } from "cloudflare:workers";

import { AryaApprovalQueue, normalizeSendEmailArgs } from "../src/arya/arya-email";
import type { Gatekeeper, HookController } from "@gadgets/workshop-shared/gatekeeper";

describe("normalizeSendEmailArgs", () => {
  it("accepts an array of recipients with a subject and body", () => {
    const input = normalizeSendEmailArgs({
      to: ["a@b.com", " c@d.com "],
      subject: "Hi",
      body: "Hello",
    });
    expect(input).toEqual({ to: ["a@b.com", "c@d.com"], subject: "Hi", body: "Hello" });
  });

  it("accepts a single string recipient", () => {
    const input = normalizeSendEmailArgs({ to: "x@y.com", subject: "S", body: "B" });
    expect(input.to).toEqual(["x@y.com"]);
  });

  it("throws when there are no recipients", () => {
    expect(() => normalizeSendEmailArgs({ to: [], subject: "s", body: "b" })).toThrow(/recipient/i);
    expect(() => normalizeSendEmailArgs({ to: "  ", subject: "s", body: "b" })).toThrow(/recipient/i);
  });

  it("throws when the subject or body is empty", () => {
    expect(() => normalizeSendEmailArgs({ to: ["a@b.com"], subject: "  ", body: "b" })).toThrow(/subject/i);
    expect(() => normalizeSendEmailArgs({ to: ["a@b.com"], subject: "s", body: "  " })).toThrow(/body/i);
  });
});

function makeMockGatekeeper() {
  const calls: { apply: number[]; reject: number[] } = { apply: [], reject: [] };
  const gatekeeper = {
    applyAction: async (n: number) => {
      calls.apply.push(n);
    },
    rejectAction: async (n: number) => {
      calls.reject.push(n);
    },
  } as unknown as Fetcher<Gatekeeper<any>>;
  return { gatekeeper, calls };
}

const SEND_DESC = { title: "Send: Hi", description: "**To:** a@b.com", implementsRevert: false };

describe("AryaApprovalQueue", () => {
  it("auto-approves observations of the owner's own mailbox", async () => {
    const { gatekeeper } = makeMockGatekeeper();
    const queue = new AryaApprovalQueue(gatekeeper, async () => "rejected");
    await expect(queue.authorizeObservation({ title: "t", description: "d" })).resolves.toBeUndefined();
  });

  it("applies the action when the owner approves", async () => {
    const { gatekeeper, calls } = makeMockGatekeeper();
    const queue = new AryaApprovalQueue(gatekeeper, async () => "approved");
    await queue.submitAction(7, SEND_DESC);
    expect(calls.apply).toEqual([7]);
    expect(calls.reject).toEqual([]);
  });

  it("rejects the action and throws when the owner denies", async () => {
    const { gatekeeper, calls } = makeMockGatekeeper();
    const queue = new AryaApprovalQueue(gatekeeper, async () => "rejected");
    await expect(queue.submitAction(3, SEND_DESC)).rejects.toThrow(/rejected/i);
    expect(calls.reject).toEqual([3]);
    expect(calls.apply).toEqual([]);
  });

  it("throws a timeout error and rejects the pending action", async () => {
    const { gatekeeper, calls } = makeMockGatekeeper();
    const queue = new AryaApprovalQueue(gatekeeper, async () => "timeout");
    await expect(queue.submitAction(1, SEND_DESC)).rejects.toThrow(/timed out/i);
    expect(calls.apply).toEqual([]);
    expect(calls.reject).toEqual([1]);
  });

  it("forwards the action title and description to the confirmation callback", async () => {
    const { gatekeeper } = makeMockGatekeeper();
    const confirm = vi.fn(async () => "approved");
    const queue = new AryaApprovalQueue(gatekeeper, confirm);
    await queue.submitAction(9, SEND_DESC);
    expect(confirm).toHaveBeenCalledWith("Send: Hi", "**To:** a@b.com");
  });

  it("does not support binding hooks", async () => {
    const { gatekeeper } = makeMockGatekeeper();
    const queue = new AryaApprovalQueue(gatekeeper, async () => "approved");
    await expect(
      queue.bindHook(
        null as unknown as Fetcher<HookController<RpcTarget>>,
        null as unknown as RpcStub<RpcTarget>,
        { title: "t", description: "d" },
      ),
    ).rejects.toThrow(/hook/i);
  });
});
