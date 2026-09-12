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

/** One issue or pull request surfaced by GitHub issue/PR text search. */
export interface AaryaGithubWorkSearchHit {
  number: number;
  title: string;
  state: string;
  author: string;
}

/** One entry returned by searchIssues(). */
export interface AaryaGithubIssueSearchEntry {
  id: string;
  title: string;
  state: string;
  author: { login: string } | null;
  commentCount?: number;
}

/** One entry returned by searchPullRequests(). */
export interface AaryaGithubPrSearchEntry extends AaryaGithubIssueSearchEntry {
  draft?: boolean;
  merged?: boolean;
  head?: { ref?: string };
}

/** A GitHub issue's details (only the fields Aarya reads). */
export interface AaryaGithubIssueDetails {
  id: string;
  title: string;
  state: string;
  author: { login: string } | null;
  bodyMarkdown?: string;
  commentCount?: number;
}

/** One human comment in an issue/PR discussion. */
export interface AaryaGithubIssueCommentSummary {
  author: string;
  body: string;
}

/** One entry in an issue/PR discussion cursor. */
export interface AaryaGithubIssueDiscussionEntry {
  kind: "comment" | "review";
  author: { login: string } | null;
  bodyMarkdown?: string;
  createdAt?: string;
}

/** The subset of the GitHub issue capability Aarya uses. */
export interface AaryaGithubIssue {
  getDetails(): Promise<AaryaGithubIssueDetails>;
  readDiscussion(): Promise<AaryaGithubCursor<AaryaGithubIssueDiscussionEntry>>;
  postComment(bodyMarkdown: string): Promise<void>;
}

/** An issue read result returned to the model. */
export interface AaryaGithubIssueReadResult {
  number: number;
  title: string;
  state: string;
  author: string;
  body?: string;
  commentCount?: number;
  comments: AaryaGithubIssueCommentSummary[];
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
  readDiscussion(): Promise<AaryaGithubCursor<AaryaGithubIssueDiscussionEntry>>;
  postComment(bodyMarkdown: string): Promise<void>;
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
  getIssue(id: string): Promise<AaryaGithubIssue>;
  listPullRequests(options?: { state?: string }): Promise<AaryaGithubCursor<AaryaGithubListPr>>;
  searchIssues(query: {
    text: string;
    state?: "open" | "closed" | "all";
  }): Promise<AaryaGithubCursor<AaryaGithubIssueSearchEntry>>;
  searchPullRequests(query: {
    text: string;
    state?: "open" | "closed" | "all";
  }): Promise<AaryaGithubCursor<AaryaGithubPrSearchEntry>>;
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
  comments?: AaryaGithubIssueCommentSummary[];
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

/** Normalize and validate an issue number argument. */
export function normalizeGithubIssueNumberArg(args: Record<string, unknown>): number {
  const raw = args.issueNumber ?? args.number;
  const issueNumber =
    typeof raw === "number" ? raw
    : typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw)
    : NaN;
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    throw new Error("A valid positive issueNumber is required.");
  }
  return issueNumber;
}

/** Normalize and validate the text query shared by issue/PR search tools. */
export function normalizeGithubWorkSearchArgs(
  args: Record<string, unknown>,
): { text: string; state?: "open" | "closed" | "all" } {
  const text = typeof args.query === "string" ? args.query.trim() : "";
  if (!text) throw new Error('A search query is required (e.g. "voice capture").');
  if (text.length > 200) throw new Error("Search query must be at most 200 characters.");
  if (text.includes("\0")) throw new Error("query must not contain NUL bytes.");
  const state =
    args.state === "open" || args.state === "closed" || args.state === "all" ? args.state : undefined;
  return { text, ...(state ? { state } : {}) };
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

export interface CommentGithubIssueInput {
  repo: string;
  issueNumber: number;
  body: string;
}

/** Maximum number of cursor pages read when searching issues/PRs by text. */
export const MAX_GITHUB_WORK_SEARCH_PAGES = 3;

/** Normalize and require a non-empty comment body. Shared by comment_github_issue and comment_github_pr. */
export function normalizeGithubCommentBody(args: Record<string, unknown>): string {
  const body = typeof args.body === "string" ? args.body : "";
  if (!body.trim()) throw new Error("A comment body is required.");
  return body;
}

/** Normalize and validate arguments for the comment_github_issue tool. */
export function normalizeCommentGithubIssueArgs(args: Record<string, unknown>): CommentGithubIssueInput {
  const repo = normalizeGithubRepoArg(args);
  const issueNumber = normalizeGithubIssueNumberArg(args);
  const body = normalizeGithubCommentBody(args);
  return { repo, issueNumber, body };
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

/** Page an issue/PR discussion cursor and return a small list of human comments. */
export async function summarizeGithubIssueDiscussion(
  cursor: AaryaGithubCursor<AaryaGithubIssueDiscussionEntry>,
  maxComments = 20,
  maxPages = 5,
): Promise<AaryaGithubIssueCommentSummary[]> {
  const comments: AaryaGithubIssueCommentSummary[] = [];
  for (let page = 0; page < maxPages && comments.length < maxComments; page++) {
    const entries = await cursor.next();
    if (!entries) break;
    for (const entry of entries) {
      if (comments.length >= maxComments) break;
      if (entry.kind !== "comment") continue;
      const body = entry.bodyMarkdown?.trim();
      if (!body) continue;
      comments.push({ author: entry.author?.login ?? "", body: body.slice(0, 2000) });
    }
  }
  return comments;
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

/** Edit distance between two strings (used for forgiving, related-term matching). */
export function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, () => 0);
  let curr = Array.from({ length: b.length + 1 }, () => 0);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[b.length];
}

/** Score one name/path token against a query token, falling back to edit distance for typos. */
function scoreTokenMatch(
  query: string,
  token: string,
  exact: number,
  prefix: number,
  contains: number,
  fuzzy: number,
): number {
  if (token === query) return exact;
  if (token.startsWith(query)) return prefix;
  if (token.includes(query)) return contains;
  if (query.length >= 3 && token.length >= 3) {
    const similarity = 1 - levenshteinDistance(query, token) / Math.max(query.length, token.length);
    if (similarity >= 0.6) return fuzzy;
  }
  return 0;
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
      score += scoreTokenMatch(query, token, 4, 3, 2, 2);
    }
    for (const token of pathTokens) {
      score += scoreTokenMatch(query, token, 2, 1, 1, 1);
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

/** Score one issue/PR title against query tokens (same forgiving token match as repo search). */
export function scoreGithubWorkSearchMatch(title: string, queryTokens: string[]): number {
  const titleTokens = tokenizeRepoSearchTerm(title);
  let score = 0;
  for (const query of queryTokens) {
    for (const token of titleTokens) {
      score += scoreTokenMatch(query, token, 4, 3, 2, 2);
    }
  }
  const phrase = queryTokens.join(" ");
  if (phrase.length >= 3 && title.toLowerCase().includes(phrase)) score += 8;
  return score;
}

/** Re-rank issue/PR search results so related titles surface near the top. Pure for testing. */
export function rankGithubWorkSearchHits<T extends { title: string }>(
  hits: T[],
  query: string,
  limit = 20,
): T[] {
  const queryTokens = tokenizeRepoSearchTerm(query);
  if (queryTokens.length === 0) return hits.slice(0, limit);
  return hits
    .map((hit) => ({ hit, score: scoreGithubWorkSearchMatch(hit.title, queryTokens) }))
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((entry) => entry.hit);
}

// ---------------------------------------------------------------------------
// Repository content search. Aarya can also search inside files (not just names)
// so "related" lookups surface where a feature or concept is implemented.

/** A single matching line inside a repository file. */
export interface AaryaRepoContentHit {
  path: string;
  line: number;
  text: string;
}

/** Safety caps for repository content search. */
export const MAX_REPO_CONTENT_FILES = 200;
export const MAX_REPO_CONTENT_MATCHES = 40;
export const MAX_REPO_CONTENT_LINE_BYTES = 200;

/** File extensions that are not useful to full-text search (binaries, media, locks). */
const SKIP_REPO_CONTENT_EXT =
  /\.(png|jpe?g|gif|webp|ico|bmp|woff2?|ttf|otf|eot|mp3|wav|ogg|m4a|mp4|mov|avi|webm|pdf|zip|gz|tgz|tar|7z|wasm|bin|exe|dll|so|dylib|map|lock)$/i;

/** True when a repo file is a reasonable candidate for full-text search. */
export function isSearchableRepoFile(name: string): boolean {
  return !SKIP_REPO_CONTENT_EXT.test(name);
}

/**
 * Find lines in a file's text that relate to a query. Matches are forgiving: a line
 * matches when it contains a query token or a token within a short edit distance, so
 * typos and transliteration variants still surface. Pure for testing.
 */
export function findRepoTextMatches(
  text: string,
  query: string,
  path: string,
  limit = MAX_REPO_CONTENT_MATCHES,
): AaryaRepoContentHit[] {
  const queryTokens = tokenizeRepoSearchTerm(query).filter((token) => token.length >= 2);
  if (queryTokens.length === 0) return [];
  const lines = text.split(/\r?\n/);
  const hits: AaryaRepoContentHit[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (hits.length >= limit) break;
    const lineTokens = tokenizeRepoSearchTerm(lines[i]);
    let matched = false;
    for (const query of queryTokens) {
      for (const token of lineTokens) {
        if (token.length < 2) continue;
        if (token === query || token.includes(query)) {
          matched = true;
          break;
        }
        if (query.length >= 3 && token.length >= 3) {
          const similarity = 1 - levenshteinDistance(query, token) / Math.max(query.length, token.length);
          if (similarity >= 0.7) {
            matched = true;
            break;
          }
        }
      }
      if (matched) break;
    }
    if (!matched) continue;
    const trimmed = lines[i].trim();
    const snippet = trimmed.length > MAX_REPO_CONTENT_LINE_BYTES
      ? trimmed.slice(0, MAX_REPO_CONTENT_LINE_BYTES) + "..."
      : trimmed;
    hits.push({ path, line: i + 1, text: snippet });
  }
  return hits;
}