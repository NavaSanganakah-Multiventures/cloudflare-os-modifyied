// GitHub support for the Aarya voice assistant. Aarya reviews pull requests through the owner's
// connected GitHub gatekeeper, reusing Aarya's confirmation gate (AaryaApprovalQueue) for the
// mutating postReview() call. Reads (list/read diff) authorize through the same queue, which
// auto-approves observations of the owner's own data.

/** A review decision Aarya may post on a pull request. */
export type AaryaReviewDecision = "approve" | "comment" | "requestChanges";

/** A pagination cursor over GitHub results. */
export interface AaryaGithubCursor<T> {
  next(): Promise<T[] | null>;
}

/** A pull request as returned by listPullRequests(). */
export interface AaryaGithubListPr {
  id: string;
  title: string;
  state: string;
  author: { login: string } | null;
}

/** A pull request summary shown to the model. */
export interface AaryaGithubPrSummary {
  number: number;
  title: string;
  author: string;
  state: string;
}

/** Full pull request details from getDetails(). Only the fields Aarya reads are declared. */
export interface AaryaGithubPrDetails {
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
export interface AaryaGithubDiffLine {
  kind: "context" | "added" | "removed";
  text: string;
}

/** One hunk inside a changed file. */
export interface AaryaGithubDiffHunk {
  header: string;
  lines: AaryaGithubDiffLine[];
}

/** One changed file in a pull request diff. */
export interface AaryaGithubDiffFile {
  path: string;
  status: string;
  additions: number;
  deletions: number;
  hunks: AaryaGithubDiffHunk[];
}

/** A pull request diff pinned to a revision. */
export interface AaryaGithubDiff {
  revision: { baseSha: string; headSha: string };
  files: AaryaGithubCursor<AaryaGithubDiffFile>;
}

/** The subset of the GitHub pull-request capability Aarya uses. */
export interface AaryaGithubPullRequest {
  getDetails(): Promise<AaryaGithubPrDetails>;
  readDiff(): Promise<AaryaGithubDiff>;
  postReview(review: {
    revision: AaryaGithubDiff["revision"];
    decision: AaryaReviewDecision;
    bodyMarkdown?: string;
  }): Promise<void>;
}

/** One entry returned by listDirectory(). */
export interface AaryaGithubDirectoryEntry {
  name: string;
  path: string;
  sha: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

/** A file read from the repository. */
export interface AaryaGithubFileContent {
  path: string;
  sha: string;
  contentBase64: string;
}

/** The subset of the GitHub repo session Aarya uses. */
export interface AaryaGithubRepoSession {
  getPullRequest(id: string): Promise<AaryaGithubPullRequest>;
  listPullRequests(options?: { state?: string }): Promise<AaryaGithubCursor<AaryaGithubListPr>>;
  readFile(path: string, ref?: string): Promise<AaryaGithubFileContent>;
  listDirectory(path: string, ref?: string): Promise<AaryaGithubDirectoryEntry[]>;
}

/** A pull request read result returned to the model. */
export interface AaryaGithubPrReadResult {
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
  decision: AaryaReviewDecision;
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
export function serializePrDiffFiles(files: AaryaGithubDiffFile[], maxBytes = 20000): string {
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
export async function summarizePrDiff(diff: AaryaGithubDiff, maxBytes = 20000): Promise<string> {
  const collected: AaryaGithubDiffFile[] = [];
  for (let i = 0; i < 50; i++) {
    const page = await diff.files.next();
    if (!page) break;
    collected.push(...page);
  }
  return serializePrDiffFiles(collected, maxBytes);
}

// ---------------------------------------------------------------------------
// Repository file reading. Aarya can list a directory and read (capped) file text so the model can
// analyze the repo without pulling an unbounded amount of content into the call context.

/** A file's decoded text returned to the model. */
export interface AaryaRepoFileResult {
  path: string;
  sha: string;
  text: string;
  truncated: boolean;
  bytes: number;
}

/** One entry in a directory listing returned to the model. */
export interface AaryaRepoFileEntry {
  name: string;
  path: string;
  type: string;
  sha: string;
}

/** A directory listing returned to the model. */
export interface AaryaRepoDirectoryResult {
  path: string;
  entries: AaryaRepoFileEntry[];
}

const MAX_REPO_FILE_BYTES = 20000;

/** Normalize and validate the directory path for list_repo_files ("" or "/" means the repo root). */
export function normalizeRepoPathArg(args: Record<string, unknown>): string {
  const raw = typeof args.path === "string" ? args.path.trim() : "";
  const path = raw === "/" ? "" : raw.replace(/^\.?\//, "").replace(/\/+$/, "");
  if (path.includes("\0")) throw new Error("path must not contain NUL bytes.");
  return path;
}

/** Normalize and validate a file path for read_repo_file. */
export function normalizeRepoFilePathArg(args: Record<string, unknown>): string {
  const raw = typeof args.path === "string" ? args.path.trim() : "";
  if (!raw) throw new Error('A file path is required (e.g. "src/index.ts").');
  const path = raw.replace(/^\.?\//, "");
  if (path === "" || path === "/") throw new Error('A file path is required (e.g. "src/index.ts").');
  if (path.includes("\0")) throw new Error("path must not contain NUL bytes.");
  return path;
}

/** Normalize an optional git ref (branch/tag/SHA). */
export function normalizeRepoRefArg(args: Record<string, unknown>): string | undefined {
  const raw = typeof args.ref === "string" ? args.ref.trim() : "";
  return raw || undefined;
}

/** Decode base64 file content to UTF-8 text, capping at maxBytes on a character boundary. Pure. */
export function decodeRepoFileText(
  contentBase64: string,
  maxBytes = MAX_REPO_FILE_BYTES,
): { text: string; truncated: boolean; bytes: number } {
  const bin = atob(contentBase64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  // Decode (lenient) then re-encode so we always work on well-formed UTF-8.
  const text = new TextDecoder("utf-8").decode(bytes);
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) {
    return { text, truncated: false, bytes: encoded.byteLength };
  }
  // Find the largest prefix that ends on a UTF-8 character boundary (walk back over any
  // trailing continuation bytes; safe because TextEncoder output is always well-formed).
  let end = maxBytes;
  while (end > 0 && (encoded[end] & 0xc0) === 0x80) end--;
  const prefix = new TextDecoder("utf-8").decode(encoded.subarray(0, end));
  return { text: prefix + "\n[...file truncated...]", truncated: true, bytes: end };
}

// ---------------------------------------------------------------------------
// Repository file search. Aarya can find files and folders by a fuzzy name query
// (partial names, camelCase pieces, and multi-word topics) without the caller
// knowing the exact path or filename.

/** A file or folder found by repository name search. */
export interface AaryaRepoSearchHit {
  path: string;
  name: string;
  type: string;
}

/** Highest-scoring search hits returned to the model. */
export const MAX_REPO_SEARCH_RESULTS = 20;

/** Safety caps for the recursive directory walk in searchRepoFiles(). */
export const MAX_REPO_SEARCH_DIRS = 400;
export const MAX_REPO_SEARCH_CANDIDATES = 4000;

/** Normalize and validate the query argument for search_repo_files. */
export function normalizeRepoSearchQueryArg(args: Record<string, unknown>): string {
  const raw = typeof args.query === "string" ? args.query.trim() : "";
  if (!raw) throw new Error('A search query is required (e.g. "voice panel").');
  if (raw.length > 200) throw new Error("Search query must be at most 200 characters.");
  if (raw.includes("\0")) throw new Error("query must not contain NUL bytes.");
  return raw;
}

/** Split a name or query into search tokens: lowercased pieces split on camelCase,
 *  snake_case, kebab-case, and punctuation. Devanagari text is preserved as tokens. */
export function tokenizeRepoSearchTerm(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9\u0900-\u097F]+/)
    .map((token) => token.toLowerCase())
    .filter((token) => token.length > 0);
}

/** Score one repo entry against query tokens. Higher scores are better matches. */
export function scoreRepoSearchMatch(
  entry: { name: string; path: string },
  queryTokens: string[],
): number {
  const nameTokens = tokenizeRepoSearchTerm(entry.name);
  const pathTokens = tokenizeRepoSearchTerm(entry.path);
  let score = 0;
  for (const query of queryTokens) {
    for (const token of nameTokens) {
      if (token === query) score += 4;
      else if (token.startsWith(query)) score += 3;
      else if (token.includes(query)) score += 2;
    }
    for (const token of pathTokens) {
      if (token === query) score += 2;
      else if (token.startsWith(query)) score += 1;
    }
  }
  const phrase = queryTokens.join(" ");
  if (phrase.length >= 3 && entry.name.toLowerCase().includes(phrase)) score += 8;
  if (phrase.length >= 3 && entry.path.toLowerCase().includes(phrase)) score += 4;
  return score;
}

/** Rank candidate entries against a query, returning the top matches. Pure for testing. */
export function selectRepoSearchMatches(
  entries: { name: string; path: string; type: string }[],
  query: string,
  limit = MAX_REPO_SEARCH_RESULTS,
): AaryaRepoSearchHit[] {
  const queryTokens = tokenizeRepoSearchTerm(query);
  if (queryTokens.length === 0) return [];
  return entries
    .map((entry) => ({ ...entry, score: scoreRepoSearchMatch(entry, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) =>
      b.score - a.score ||
      a.path.length - b.path.length ||
      (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, limit)
    .map(({ path, name, type }) => ({ path, name, type }));
}