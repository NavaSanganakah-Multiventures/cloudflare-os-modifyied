// GitHub support for the Arya voice assistant. Arya reviews pull requests through the owner's
// connected GitHub gatekeeper, reusing Arya's confirmation gate (AryaApprovalQueue) for the
// mutating postReview() call. Reads (list/read diff) authorize through the same queue, which
// auto-approves observations of the owner's own data.

/** A review decision Arya may post on a pull request. */
export type AryaReviewDecision = "approve" | "comment" | "requestChanges";

/** A pagination cursor over GitHub results. */
export interface AryaGithubCursor<T> {
  next(): Promise<T[] | null>;
}

/** A pull request as returned by listPullRequests(). */
export interface AryaGithubListPr {
  id: string;
  title: string;
  state: string;
  author: { login: string } | null;
}

/** A pull request summary shown to the model. */
export interface AryaGithubPrSummary {
  number: number;
  title: string;
  author: string;
  state: string;
}

/** Full pull request details from getDetails(). Only the fields Arya reads are declared. */
export interface AryaGithubPrDetails {
  id: string;
  title: string;
  state: string;
  author: { login: string } | null;
  bodyMarkdown?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergeable?: boolean;
}

/** One line inside a diff hunk. */
export interface AryaGithubDiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

/** One hunk inside a changed file. */
export interface AryaGithubDiffHunk {
  header: string;
  lines: AryaGithubDiffLine[];
}

/** One changed file in a pull request diff. */
export interface AryaGithubDiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: AryaGithubDiffHunk[];
}

/** A pull request diff pinned to a revision. */
export interface AryaGithubDiff {
  revision: { baseSha: string; headSha: string };
  files: AryaGithubCursor<AryaGithubDiffFile>;
}

/** The subset of the GitHub pull-request capability Arya uses. */
export interface AryaGithubPullRequest {
  getDetails(): Promise<AryaGithubPrDetails>;
  readDiff(): Promise<AryaGithubDiff>;
  postReview(review: {
    revision: AryaGithubDiff["revision"];
    decision: AryaReviewDecision;
    bodyMarkdown?: string;
  }): Promise<void>;
}

/** The subset of the GitHub repo session Arya uses. */
export interface AryaGithubRepoSession {
  getPullRequest(id: string): Promise<AryaGithubPullRequest>;
  listPullRequests(options?: { state?: string }): Promise<AryaGithubCursor<AryaGithubListPr>>;
}

/** A pull request read result returned to the model. */
export interface AryaGithubPrReadResult {
  number: number;
  title: string;
  state: string;
  author: string;
  body?: string;
  additions?: number;
  deletions?: number;
  changedFiles?: number;
  mergeable?: boolean;
  diff: string;
}

// ---------------------------------------------------------------------------
// Argument validation

const REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Normalize and validate the "owner/repo" argument shared by the GitHub tools. */
export function normalizeGithubRepoArg(args: Record<string, unknown>): string {
  const repo = typeof args.repo === "string" ? args.repo.trim() : "";
  if (!repo) throw new Error('A repo is required (e.g. "owner/repo").');
  if (!REPO_RE.test(repo)) throw new Error('repo must be in "owner/repo" form.');
  return repo;
}

/** Normalize and validate a pull-request number argument. */
export function normalizeGithubPrNumberArg(args: Record<string, unknown>): number {
  const raw = args.prNumber ?? args.number;
  const prNumber =
    typeof raw === "number" ? raw
    : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw)
    : NaN;
  if (!Number.isFinite(prNumber) || prNumber <= 0) {
    throw new Error("A valid positive prNumber is required.");
  }
  return prNumber;
}

export interface ReviewPrInput {
  repo: string;
  prNumber: number;
  decision: AryaReviewDecision;
  body: string;
}

/** Normalize and validate arguments for the review_pr tool. */
export function normalizeReviewPrArgs(args: Record<string, unknown>): ReviewPrInput {
  const repo = normalizeGithubRepoArg(args);
  const prNumber = normalizeGithubPrNumberArg(args);
  const decisionRaw = typeof args.decision === "string" ? args.decision : "";
  if (decisionRaw !== "approve" && decisionRaw !== "comment" && decisionRaw !== "requestChanges") {
    throw new Error('decision must be "approve", "comment", or "requestChanges".');
  }
  const body = typeof args.body === "string" ? args.body : "";
  // Approve can be silent, but a comment or request-changes review needs a body.
  if (decisionRaw !== "approve" && !body.trim()) {
    throw new Error("A review body is required for comment/requestChanges reviews.");
  }
  return { repo, prNumber, decision: decisionRaw, body };
}

// ---------------------------------------------------------------------------
// Diff serialization. The model needs the diff text to review a PR, but a full diff can be very
// large, so it is capped at maxBytes and the file list is paged lazily.

/** Serialize a page of diff files into capped plain-text for the model. Pure for testing. */
export function serializePrDiffFiles(files: AryaGithubDiffFile[], maxBytes = 20000): string {
  const blocks: string[] = [];
  let bytes = 0;
  for (const file of files) {
    const lines: string[] = [`${file.status}	${file.path} (+${file.additions} -${file.deletions})`];
    for (const hunk of file.hunks ?? []) {
      lines.push(hunk.header);
      for (const line of hunk.lines ?? []) {
        const prefix = line.kind === "added" ? "+" : line.kind === "removed" ? "-" : " ";
        lines.push(prefix + line.text);
      }
    }
    const block = lines.join("\n");
    if (bytes + block.length > maxBytes) {
      blocks.push(`[...diff truncated at ${maxBytes} bytes]`);
      break;
    }
    blocks.push(block);
    bytes += block.length;
  }
  return blocks.join("\n\n");
}

/** Page the diff files cursor (up to 50 files) and serialize to capped text. */
export async function summarizePrDiff(diff: AryaGithubDiff, maxBytes = 20000): Promise<string> {
  const collected: AryaGithubDiffFile[] = [];
  for (let i = 0; i < 50; i++) {
    const page = await diff.files.next();
    if (!page) break;
    collected.push(...page);
  }
  return serializePrDiffFiles(collected, maxBytes);
}
