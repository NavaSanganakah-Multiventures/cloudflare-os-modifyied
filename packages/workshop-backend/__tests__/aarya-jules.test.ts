import { describe, expect, it } from "vitest";

import {
  normalizeApprovePlanArgs,
  normalizeJulesActivitiesArgs,
  normalizeJulesFlowIdArg,
  normalizeStartJulesFlowArgs,
  normalizeStartJulesSessionArgs,
  summarizeJulesActivity,
} from "../src/aarya/aarya-jules";
import type { AaryaJulesActivity } from "../src/aarya/aarya-jules";

describe("normalizeStartJulesSessionArgs", () => {
  it("builds a source-qualified input with requirePlanApproval on by default", () => {
    const input = normalizeStartJulesSessionArgs({ prompt: "Fix the tests", source: "src-1" });
    expect(input.prompt).toBe("Fix the tests");
    expect(input.source).toBe("sources/src-1");
    expect(input.title).toBeUndefined();
    expect(input.startingBranch).toBeUndefined();
    expect(input.requirePlanApproval).toBe(true);
    expect(input.automationMode).toBeUndefined();
  });

  it("keeps already-qualified names and honours explicit false", () => {
    const input = normalizeStartJulesSessionArgs({
      prompt: "p",
      source: "sources/src-1",
      title: "t",
      startingBranch: "feature/x",
      requirePlanApproval: false,
      automationMode: "AUTO_CREATE_PR",
    });
    expect(input.source).toBe("sources/src-1");
    expect(input.title).toBe("t");
    expect(input.startingBranch).toBe("feature/x");
    expect(input.requirePlanApproval).toBe(false);
    expect(input.automationMode).toBe("AUTO_CREATE_PR");
  });

  it("rejects a missing prompt or source", () => {
    expect(() => normalizeStartJulesSessionArgs({ source: "s" })).toThrow(/prompt/i);
    expect(() => normalizeStartJulesSessionArgs({ prompt: "p" })).toThrow(/source/i);
  });
});

describe("normalizeApprovePlanArgs", () => {
  it("expands a short session id", () => {
    expect(normalizeApprovePlanArgs({ sessionId: "sess-1" })).toBe("sessions/sess-1");
    expect(normalizeApprovePlanArgs({ sessionId: "sessions/sess-1" })).toBe("sessions/sess-1");
  });
  it("rejects a missing sessionId", () => {
    expect(() => normalizeApprovePlanArgs({})).toThrow(/sessionId/i);
  });
});

describe("normalizeJulesActivitiesArgs", () => {
  it("expands a short session id", () => {
    expect(normalizeJulesActivitiesArgs({ sessionId: "sess-1" })).toBe("sessions/sess-1");
  });
  it("rejects a missing sessionId", () => {
    expect(() => normalizeJulesActivitiesArgs({})).toThrow(/sessionId/i);
  });
});

describe("normalizeStartJulesFlowArgs", () => {
  it("builds a valid start input", () => {
    const input = normalizeStartJulesFlowArgs({
      request: "Build X",
      planSummary: "Do X in 3 steps",
      julesPrompt: "Please build X",
      githubRepo: "acme/repo",
      julesSource: "src-1",
      title: "flow-1",
    });
    expect(input.request).toBe("Build X");
    expect(input.planSummary).toBe("Do X in 3 steps");
    expect(input.julesPrompt).toBe("Please build X");
    expect(input.githubRepo).toBe("acme/repo");
    expect(input.julesSource).toBe("sources/src-1");
    expect(input.title).toBe("flow-1");
    expect(input.officialDocs).toBeUndefined();
  });

  it("filters officialDocs to titled, url'd entries", () => {
    const input = normalizeStartJulesFlowArgs({
      request: "r",
      planSummary: "p",
      julesPrompt: "j",
      githubRepo: "acme/repo",
      julesSource: "src-1",
      officialDocs: [
        { title: "Doc A", url: "https://a" },
        { title: "", url: "https://no-title" },
        { url: "https://no-title-2" },
        { title: "Doc B", url: "https://b", note: "extra" },
      ],
    });
    expect(input.officialDocs).toEqual([
      { title: "Doc A", url: "https://a" },
      { title: "Doc B", url: "https://b", note: "extra" },
    ]);
  });

  it("rejects malformed githubRepo and missing required fields", () => {
    expect(() => normalizeStartJulesFlowArgs({
      request: "r", planSummary: "p", julesPrompt: "j", githubRepo: "nope", julesSource: "s",
    })).toThrow(/owner\/repo/);
    expect(() => normalizeStartJulesFlowArgs({
      planSummary: "p", julesPrompt: "j", githubRepo: "a/b", julesSource: "s",
    })).toThrow(/request/i);
    expect(() => normalizeStartJulesFlowArgs({
      request: "r", planSummary: "p", julesPrompt: "j", githubRepo: "a/b",
    })).toThrow(/julesSource/i);
  });
});

describe("normalizeJulesFlowIdArg", () => {
  it("trims an id", () => {
    expect(normalizeJulesFlowIdArg({ id: " flow-1 " })).toBe("flow-1");
  });
  it("rejects a missing id", () => {
    expect(() => normalizeJulesFlowIdArg({})).toThrow(/id/i);
  });
});

describe("summarizeJulesActivity", () => {
  it("summarizes a plan-generated activity", () => {
    const activity: AaryaJulesActivity = {
      name: "activities/1",
      id: "1",
      createTime: "2026-01-01T00:00:00Z",
      originator: "user",
      description: "made a plan",
      planGenerated: {
        plan: {
          id: "plans/p1",
          steps: [
            { title: "Step one", description: "first" },
            { description: "Step two" },
            { title: "", description: "" },
          ],
        },
      },
    };
    const summary = summarizeJulesActivity(activity);
    expect(summary.id).toBe("1");
    expect(summary.createTime).toBe("2026-01-01T00:00:00Z");
    expect(summary.originator).toBe("user");
    expect(summary.description).toBe("made a plan");
    expect(summary.plan).toEqual({ id: "plans/p1", steps: ["Step one", "Step two"] });
  });

  it("captures messages, progress, and terminal status", () => {
    const failed: AaryaJulesActivity = {
      name: "activities/2",
      id: "2",
      userMessaged: { userMessage: "hello" },
      progressUpdated: { title: "working" },
      sessionFailed: { reason: "boom" },
    };
    const failedSummary = summarizeJulesActivity(failed);
    expect(failedSummary.message).toBe("hello");
    expect(failedSummary.progress).toBe("working");
    expect(failedSummary.status).toBe("failed");
    expect(failedSummary.reason).toBe("boom");

    const completed: AaryaJulesActivity = {
      name: "activities/3",
      id: "3",
      agentMessaged: { agentMessage: "done" },
      sessionCompleted: {},
    };
    const completedSummary = summarizeJulesActivity(completed);
    expect(completedSummary.message).toBe("done");
    expect(completedSummary.status).toBe("completed");
  });
});
