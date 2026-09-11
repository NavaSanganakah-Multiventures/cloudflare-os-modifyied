import { describe, expect, it } from "vitest";

import {
  AaryaToolRegistry,
  executeAaryaTool,
  normalizeRunWorkspaceAgentArgs,
} from "../src/aarya/aarya-tools";
import type { AaryaAgentRuntime, AaryaToolRuntime, RunWorkspaceAgentInput } from "../src/aarya/aarya-tools";

describe("normalizeRunWorkspaceAgentArgs", () => {
  it("trims title and prompt and passes through workspaceId", () => {
    expect(
      normalizeRunWorkspaceAgentArgs({
        title: "  Inspect repo  ",
        prompt: "  Read the repo and plan.  ",
        workspaceId: " ws-1 ",
      }),
    ).toEqual({
      title: "Inspect repo",
      prompt: "Read the repo and plan.",
      workspaceId: "ws-1",
    });
  });

  it("omits a blank workspaceId", () => {
    expect(
      normalizeRunWorkspaceAgentArgs({ title: "t", prompt: "p", workspaceId: "   " }),
    ).toEqual({ title: "t", prompt: "p" });
  });

  it("rejects an empty title", () => {
    expect(() => normalizeRunWorkspaceAgentArgs({ title: " ", prompt: "p" })).toThrow(/title/);
  });

  it("rejects an empty prompt", () => {
    expect(() => normalizeRunWorkspaceAgentArgs({ title: "t", prompt: " " })).toThrow(/prompt/);
  });
});

describe("run_workspace_agent tool", () => {
  const makeRuntime = (agent?: AaryaAgentRuntime): AaryaToolRuntime => ({
    now: () => new Date("2026-01-01T00:00:00Z"),
    voiceStatus: () => ({ state: "listening" as const }),
    mutations: {
      setOwnerDisplayName: async (_name: string) => {},
      setReminder: async (_message: string, _dueAt: number) => ({
        id: "r1",
        message: "test",
        dueAt: 0,
        createdAt: 0,
      }),
      cancelReminder: async (_id: string) => true,
      createWorkspace: async (_title: string) => ({ workspaceId: "ws-1", title: "Workspace" }),
    },
    readReminders: async () => [],
    readNotifications: async () => [],
    ...(agent ? { agent } : {}),
  });

  it("delegates to the agent runtime and returns the queued envelope", async () => {
    let received: RunWorkspaceAgentInput | undefined;
    const runtime = makeRuntime({
      runWorkspaceAgent: async (input: RunWorkspaceAgentInput) => {
        received = input;
        return { taskId: "t1", title: input.title, status: "queued" as const };
      },
    });
    const registry = new AaryaToolRegistry(runtime);
    const result = await registry.execute({
      id: "c1",
      name: "run_workspace_agent",
      args: { title: "Plan", prompt: "Read the repo", workspaceId: "ws-1" },
    });
    expect(result.response).toEqual({
      ok: true,
      result: { taskId: "t1", title: "Plan", status: "queued" },
    });
    expect(received).toEqual({ title: "Plan", prompt: "Read the repo", workspaceId: "ws-1" });
  });

  it("returns an error envelope when no agent runtime is wired", async () => {
    const result = await executeAaryaTool(
      { id: "c2", name: "run_workspace_agent", args: { title: "Plan", prompt: "Read the repo" } },
      makeRuntime(),
    );
    expect(result.response).toMatchObject({ ok: false });
  });
});
