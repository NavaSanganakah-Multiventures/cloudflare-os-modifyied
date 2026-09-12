import { describe, expect, it } from "vitest";

import {
  decodeRepoFileText,
  findRepoTextMatches,
  isSearchableRepoFile,
  levenshteinDistance,
  normalizeCommentGithubIssueArgs,
  normalizeGithubIssueNumberArg,
  normalizeGithubPrNumberArg,
  normalizeGithubRepoArg,
  normalizeGithubWorkSearchArgs,
  normalizeRepoFilePathArg,
  normalizeRepoPathArg,
  normalizeRepoRefArg,
  normalizeRepoSearchQueryArg,
  normalizeReviewPrArgs,
  rankGithubWorkSearchHits,
  selectRepoSearchMatches,
  serializePrDiffFiles,
  summarizeGithubIssueDiscussion,
  summarizePrDiff,
  tokenizeRepoSearchTerm,
} from "../src/aarya/aarya-github";
import type { AaryaGithubCursor, AaryaGithubDiff, AaryaGithubDiffFile, AaryaGithubIssueDiscussionEntry } from "../src/aarya/aarya-github";

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

function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

describe("normalizeRepoPathArg", () => {
  it("defaults to the repo root", () => {
    expect(normalizeRepoPathArg({})).toBe("");
    expect(normalizeRepoPathArg({ path: "" })).toBe("");
    expect(normalizeRepoPathArg({ path: "/" })).toBe("");
    expect(normalizeRepoPathArg({ path: "  " })).toBe("");
  });
  it("trims a leading ./ and trailing slashes", () => {
    expect(normalizeRepoPathArg({ path: "./src" })).toBe("src");
    expect(normalizeRepoPathArg({ path: "src/utils/" })).toBe("src/utils");
  });
  it("rejects NUL bytes", () => {
    expect(() => normalizeRepoPathArg({ path: "a\0b" })).toThrow(/NUL/);
  });
});

describe("normalizeRepoFilePathArg", () => {
  it("accepts and normalizes a file path", () => {
    expect(normalizeRepoFilePathArg({ path: "src/index.ts" })).toBe("src/index.ts");
    expect(normalizeRepoFilePathArg({ path: "./src/index.ts" })).toBe("src/index.ts");
    expect(normalizeRepoFilePathArg({ path: " src/index.ts " })).toBe("src/index.ts");
  });
  it("rejects missing or root paths", () => {
    expect(() => normalizeRepoFilePathArg({})).toThrow(/file path/i);
    expect(() => normalizeRepoFilePathArg({ path: "" })).toThrow(/file path/i);
    expect(() => normalizeRepoFilePathArg({ path: "/" })).toThrow(/file path/i);
  });
});

describe("normalizeRepoRefArg", () => {
  it("returns undefined for missing or blank refs", () => {
    expect(normalizeRepoRefArg({})).toBeUndefined();
    expect(normalizeRepoRefArg({ ref: "  " })).toBeUndefined();
  });
  it("trims a provided ref", () => {
    expect(normalizeRepoRefArg({ ref: " main " })).toBe("main");
  });
});

describe("decodeRepoFileText", () => {
  it("round-trips UTF-8 text without truncation", () => {
    const text = "hello world";
    const decoded = decodeRepoFileText(toBase64(text));
    expect(decoded.text).toBe(text);
    expect(decoded.truncated).toBe(false);
    expect(decoded.bytes).toBe(new TextEncoder().encode(text).byteLength);
  });
  it("truncates on a UTF-8 character boundary", () => {
    const text = "\u0939".repeat(100); // Devanagari "ह": 3 bytes each
    const decoded = decodeRepoFileText(toBase64(text), 10);
    expect(decoded.truncated).toBe(true);
    expect(decoded.bytes).toBeGreaterThan(0);
    expect(decoded.bytes).toBeLessThanOrEqual(10);
    expect(decoded.text).toContain("[...file truncated...]");
    expect(decoded.text).not.toContain("\uFFFD");
  });
});

describe("normalizeRepoSearchQueryArg", () => {
  it("accepts and trims a query", () => {
    expect(normalizeRepoSearchQueryArg({ query: " voice panel " })).toBe("voice panel");
  });
  it("rejects missing or blank queries", () => {
    expect(() => normalizeRepoSearchQueryArg({})).toThrow(/query/i);
    expect(() => normalizeRepoSearchQueryArg({ query: "  " })).toThrow(/query/i);
  });
  it("rejects NUL bytes", () => {
    expect(() => normalizeRepoSearchQueryArg({ query: "a\0b" })).toThrow(/NUL/);
  });
});

describe("tokenizeRepoSearchTerm", () => {
  it("splits camelCase, snake_case, kebab-case, and extensions", () => {
    expect(tokenizeRepoSearchTerm("AaryaVoicePanel.tsx")).toEqual(["aarya", "voice", "panel", "tsx"]);
    expect(tokenizeRepoSearchTerm("voice_panel-helper")).toEqual(["voice", "panel", "helper"]);
  });
  it("preserves Devanagari tokens", () => {
    expect(tokenizeRepoSearchTerm("प्रोजेक्ट-voice")).toEqual(["प्रोजेक्ट", "voice"]);
  });
});

describe("selectRepoSearchMatches", () => {
  const entries = [
    { name: "AaryaVoicePanel.tsx", path: "src/AaryaVoicePanel.tsx", type: "file" },
    { name: "aarya-voice.ts", path: "src/aarya-voice.ts", type: "file" },
    { name: "VoiceSection.tsx", path: "src/VoiceSection.tsx", type: "file" },
    { name: "voice", path: "src/voice", type: "dir" },
    { name: "README.md", path: "README.md", type: "file" },
  ];

  it("finds files by a partial name", () => {
    const hits = selectRepoSearchMatches(entries, "voice");
    expect(hits.map((h) => h.name)).toContain("AaryaVoicePanel.tsx");
    expect(hits.map((h) => h.name)).toContain("voice");
  });

  it("finds a multi-word topic without the exact filename", () => {
    const hits = selectRepoSearchMatches(entries, "voice panel");
    expect(hits[0].name).toBe("AaryaVoicePanel.tsx");
  });

  it("prefers the shorter path when scores tie", () => {
    const hits = selectRepoSearchMatches(entries, "aarya");
    expect(hits[0].name).toBe("aarya-voice.ts");
  });

  it("returns no matches for an unrelated query", () => {
    expect(selectRepoSearchMatches(entries, "zzzz")).toEqual([]);
  });
});

describe("levenshteinDistance", () => {
  it("is zero for equal strings and small for near-matches", () => {
    expect(levenshteinDistance("voice", "voice")).toBe(0);
    expect(levenshteinDistance("voice", "voise")).toBe(1);
    expect(levenshteinDistance("voice", "voise")).toBe(levenshteinDistance("voise", "voice"));
  });
});

describe("findRepoTextMatches", () => {
  const text = "const mic = createMicCapture()\nfunction searchRepoFiles(query: string) {\n  return results\n}";

  it("finds lines containing query tokens", () => {
    const hits = findRepoTextMatches(text, "search repo", "src/aarya.ts");
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].path).toBe("src/aarya.ts");
    expect(hits[0].line).toBe(2);
  });

  it("finds near-matches for typos", () => {
    const hits = findRepoTextMatches("const voise = true", "voice", "a.ts");
    expect(hits.length).toBe(1);
  });

  it("returns no matches for unrelated queries", () => {
    expect(findRepoTextMatches("const x = 1", "zzzz", "a.ts")).toEqual([]);
  });
});

describe("isSearchableRepoFile", () => {
  it("skips binaries and locks", () => {
    expect(isSearchableRepoFile("app.ts")).toBe(true);
    expect(isSearchableRepoFile("logo.png")).toBe(false);
    expect(isSearchableRepoFile("yarn.lock")).toBe(false);
  });
});

describe("selectRepoSearchMatches fuzzy typo matching", () => {
  it("surfaces entries with near-miss spellings", () => {
    const entries = [
      { name: "voice.ts", path: "src/voice.ts", type: "file" as const },
      { name: "README.md", path: "README.md", type: "file" as const },
    ];
    const hits = selectRepoSearchMatches(entries, "voise");
    expect(hits.map((h) => h.name)).toContain("voice.ts");
  });
});

describe("normalizeGithubIssueNumberArg", () => {
  it("accepts issueNumber as number or numeric string", () => {
    expect(normalizeGithubIssueNumberArg({ issueNumber: 12 })).toBe(12);
    expect(normalizeGithubIssueNumberArg({ number: 13 })).toBe(13);
    expect(normalizeGithubIssueNumberArg({ issueNumber: "14" })).toBe(14);
  });

  it("rejects missing, zero, negative, or non-numeric values", () => {
    expect(() => normalizeGithubIssueNumberArg({})).toThrow(/issueNumber/);
    expect(() => normalizeGithubIssueNumberArg({ issueNumber: 0 })).toThrow(/issueNumber/);
    expect(() => normalizeGithubIssueNumberArg({ issueNumber: -3 })).toThrow(/issueNumber/);
    expect(() => normalizeGithubIssueNumberArg({ issueNumber: "abc" })).toThrow(/issueNumber/);
  });
});

describe("normalizeGithubWorkSearchArgs", () => {
  it("requires and trims a query", () => {
    expect(normalizeGithubWorkSearchArgs({ query: "  voice capture  " })).toEqual({ text: "voice capture" });
  });

  it("keeps only valid state filters", () => {
    expect(normalizeGithubWorkSearchArgs({ query: "voice", state: "open" })).toEqual({ text: "voice", state: "open" });
    expect(normalizeGithubWorkSearchArgs({ query: "voice", state: "bogus" })).toEqual({ text: "voice" });
  });

  it("rejects empty or too-long queries", () => {
    expect(() => normalizeGithubWorkSearchArgs({})).toThrow(/query/);
    expect(() => normalizeGithubWorkSearchArgs({ query: "x".repeat(201) })).toThrow(/200/);
  });
});

describe("normalizeCommentGithubIssueArgs", () => {
  it("parses repo, issueNumber, and body", () => {
    expect(
      normalizeCommentGithubIssueArgs({ repo: "NavaSanganakah-Multiventures/cloudflare-os-modifyied", issueNumber: 5, body: "Looking into this." }),
    ).toEqual({
      repo: "NavaSanganakah-Multiventures/cloudflare-os-modifyied",
      issueNumber: 5,
      body: "Looking into this.",
    });
  });

  it("requires a body and a valid repo", () => {
    expect(() => normalizeCommentGithubIssueArgs({ issueNumber: 5 })).toThrow(/repo/i);
    expect(() =>
      normalizeCommentGithubIssueArgs({ repo: "NavaSanganakah-Multiventures/cloudflare-os-modifyied", issueNumber: 5, body: "  " }),
    ).toThrow(/comment body/i);
  });
});

describe("rankGithubWorkSearchHits", () => {
  it("ranks related titles above unrelated ones", () => {
    const hits = [
      { number: 1, title: "Fix voice capture bug" },
      { number: 2, title: "Update README" },
      { number: 3, title: "Voice capture retry" },
    ];
    const ranked = rankGithubWorkSearchHits(hits, "voice capture");
    expect(ranked.map((h) => h.number)).toEqual([1, 3]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(rankGithubWorkSearchHits([{ number: 1, title: "Docs" }], "zzzz")).toEqual([]);
  });
});

describe("summarizeGithubIssueDiscussion", () => {
  it("keeps only human comments and caps their length", async () => {
    const cursor = mockCursor<AaryaGithubIssueDiscussionEntry>([
      [
        { kind: "comment", author: { login: "alice" }, bodyMarkdown: "First." },
        { kind: "review", author: { login: "bob" }, bodyMarkdown: "review body" },
        { kind: "comment", author: null, bodyMarkdown: "anonymous" },
        { kind: "comment", author: { login: "carol" }, bodyMarkdown: "y".repeat(2500) },
      ],
    ]);
    const comments = await summarizeGithubIssueDiscussion(cursor);
    expect(comments).toEqual([
      { author: "alice", body: "First." },
      { author: "", body: "anonymous" },
      { author: "carol", body: "y".repeat(2000) },
    ]);
  });

  it("stops when the cursor is exhausted", async () => {
    const cursor = mockCursor<AaryaGithubIssueDiscussionEntry>([
      [{ kind: "comment", author: { login: "alice" }, bodyMarkdown: "Hello" }],
    ]);
    const comments = await summarizeGithubIssueDiscussion(cursor, 20, 5);
    expect(comments).toEqual([{ author: "alice", body: "Hello" }]);
  });
});
