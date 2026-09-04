import { describe, expect, it } from "vitest";

import {
  normalizeGithubPrNumberArg,
  normalizeGithubRepoArg,
  normalizeReviewPrArgs,
  serializePrDiffFiles,
  summarizePrDiff,
} from "../src/aarya/aarya-github";
import type { AaryaGithubCursor, AaryaGithubDiff, AaryaGithubDiffFile } from "../src/aarya/aarya-github";

function mockCursor<T>(pages: T[][]): AaryaGithubCursor<T> {
  let i = 0;
  return { next: async () => (i < pages.length ? pages[i++] : null) };
}

describe("normalizeGithubRepoArg", () => {
  it("accepts owner/repo", () => {
    expect(normalizeGithubRepoArg({ repo: "owner/repo" })).toBe("owner/repo");
    expect(normalizeGithubRepoArg({ repo: " owner/repo " })).toBe("owner/repo");
  });
  it("rejects missing or malformed repos", () => {
    expect(() => normalizeGithubRepoArg({ repo: "" })).toThrow(/repo/i);
    expect(() => normalizeGithubRepoArg({ repo: "no-slash" })).toThrow(/must be in/i);
    expect(() => normalizeGithubRepoArg({})).toThrow(/repo/i);
  });
});

describe("normalizeGithubPrNumberArg", () => {
  it("accepts a number or numeric string", () => {
    expect(normalizeGithubPrNumberArg({ prNumber: 42 })).toBe(42);
    expect(normalizeGithubPrNumberArg({ prNumber: "42" })).toBe(42);
  });
  it("rejects invalid numbers", () => {
    expect(() => normalizeGithubPrNumberArg({ prNumber: 0 })).toThrow();
    expect(() => normalizeGithubPrNumberArg({ prNumber: -1 })).toThrow();
    expect(() => normalizeGithubPrNumberArg({ prNumber: "abc" })).toThrow();
    expect(() => normalizeGithubPrNumberArg({})).toThrow();
  });
});

describe("normalizeReviewPrArgs", () => {
  it("accepts an approve review without a body", () => {
    const input = normalizeReviewPrArgs({ repo: "o/r", prNumber: 7, decision: "approve" });
    expect(input).toEqual({ repo: "o/r", prNumber: 7, decision: "approve", body: "" });
  });
  it("accepts a comment review with a body", () => {
    const input = normalizeReviewPrArgs({ repo: "o/r", prNumber: 7, decision: "comment", body: "looks good" });
    expect(input.decision).toBe("comment");
    expect(input.body).toBe("looks good");
  });
  it("rejects an unknown decision", () => {
    expect(() => normalizeReviewPrArgs({ repo: "o/r", prNumber: 7, decision: "lgtm" })).toThrow(/decision/i);
  });
  it("requires a body for comment and requestChanges", () => {
    expect(() => normalizeReviewPrArgs({ repo: "o/r", prNumber: 7, decision: "comment" })).toThrow(/body/i);
    expect(() => normalizeReviewPrArgs({ repo: "o/r", prNumber: 7, decision: "requestChanges", body: "  " })).toThrow(/body/i);
  });
});

describe("serializePrDiffFiles", () => {
  it("serializes files, hunks, and diff line markers", () => {
    const files: AaryaGithubDiffFile[] = [
      {
        path: "src/a.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        hunks: [{ header: "@@ -1,2 +1,2 @@", lines: [
          { kind: "context", text: "keep" },
          { kind: "removed", text: "old" },
          { kind: "added", text: "new" },
        ] }],
      },
    ];
    const out = serializePrDiffFiles(files);
    expect(out).toContain("modified\tsrc/a.ts (+1 -1)");
    expect(out).toContain("@@ -1,2 +1,2 @@");
    expect(out).toContain(" keep");
    expect(out).toContain("-old");
    expect(out).toContain("+new");
  });

  it("truncates at maxBytes", () => {
    const big = "x".repeat(500);
    const files: AaryaGithubDiffFile[] = [
      { path: "f", status: "added", additions: 10, deletions: 0, hunks: [{ header: "@@", lines: [{ kind: "added", text: big }] }] },
    ];
    const out = serializePrDiffFiles(files, 100);
    expect(out).toContain("truncated");
    expect(out.length).toBeLessThan(big.length);
  });
});

describe("summarizePrDiff", () => {
  it("pages the files cursor and serializes", async () => {
    const diff: AaryaGithubDiff = {
      revision: { baseSha: "aaa", headSha: "bbb" },
      files: mockCursor([
        [{ path: "a", status: "added", additions: 1, deletions: 0, hunks: [] }],
        [{ path: "b", status: "modified", additions: 2, deletions: 1, hunks: [] }],
      ]),
    };
    const out = await summarizePrDiff(diff);
    expect(out).toContain("added\ta (+1 -0)");
    expect(out).toContain("modified\tb (+2 -1)");
  });

  it("stops paging when the cursor returns null", async () => {
    const diff: AaryaGithubDiff = {
      revision: { baseSha: "a", headSha: "b" },
      files: mockCursor([[]]),
    };
    const out = await summarizePrDiff(diff);
    // First page empty, second call null -> no files serialized.
    expect(out).toBe("");
  });
});
