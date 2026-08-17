import { DurableObject } from "cloudflare:workers";
import { GitHubClient, type Repository } from "./github-client.js";

const DEFAULT_INSTRUCTIONS = `You are a helpful developer-support assistant integrated into a website.
When a user reports a problem or asks a question about their website or application:
1. Identify whether the message is about a bug, feature, question, or general feedback.
2. For bugs, collect URL, reproduction steps, expected vs actual behavior.
3. For questions, give a concise actionable reply in the user's language.
Be polite and clear.`;

const BUGS = ["error", "bug", "fail", "crash", "broken", "not working", "doesn't work", "exception", "timeout", "blank", "404", "500"];
const FEATURES = ["feature", "add", "support", "implement", "would like", "need", "want"];
const QUESTIONS = ["how", "what", "why", "can i", "is it possible", "question"];
const AUTO_FIX_WORKFLOW = "developer-api-auto-fix.yml";

export interface Env {
  DEVELOPER_API_GATEWAY: DurableObjectNamespace<DeveloperApiGateway>;
  GITHUB_TOKEN: string;
  GITHUB_OWNER?: string;
  GITHUB_REPO?: string;
  CALLBACK_SECRET?: string;
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function makeKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "dev_" + Array.from(bytes).map(b => b.toString(36)).join("").slice(0, 40);
}

function json(data: unknown, status = 200, origin?: string): Response {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
  };
  return new Response(JSON.stringify(data), { status, headers });
}

export class DeveloperApiGateway extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.initDb();
  }

  private initDb(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS queries (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at INTEGER NOT NULL, issue_id TEXT, issue_url TEXT, pr_url TEXT, response TEXT, callback_url TEXT, callback_status TEXT);`);
  }

  private cfg(key: string): string | null {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM config WHERE key = ?", key).toArray();
    return rows.length ? String(rows[0].value) : null;
  }

  private setCfg(key: string, value: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", key, value);
  }

  private getSystemInstructions(): string {
    return this.cfg("systemInstructions") ?? DEFAULT_INSTRUCTIONS;
  }

  private github(): GitHubClient {
    const token = this.env.GITHUB_TOKEN;
    if (!token) throw new Error("GITHUB_TOKEN is not configured");
    return new GitHubClient(token);
  }

  private getRepo(body: Record<string, unknown>): Repository {
    const owner = String(body.repoOwner ?? body.repo_owner ?? this.env.GITHUB_OWNER ?? "");
    const name = String(body.repoName ?? body.repo_name ?? this.env.GITHUB_REPO ?? "");
    if (!owner || !name) throw new Error("Missing repoOwner/repoName or GITHUB_OWNER/GITHUB_REPO config");
    return { owner, name };
  }

  private async validateKey(key: string | null): Promise<boolean> {
    if (!key) return false;
    const hash = await sha256(key);
    const rows = this.ctx.storage.sql.exec("SELECT active FROM api_keys WHERE key_hash = ?", hash).toArray();
    return rows.length === 1 && rows[0].active === 1;
  }

  private log(payload: Record<string, unknown>, issueId?: string | null, issueUrl?: string | null, prUrl?: string | null, response?: string | null, callbackUrl?: string | null, callbackStatus?: string | null): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO queries (payload, created_at, issue_id, issue_url, pr_url, response, callback_url, callback_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      JSON.stringify(payload), Date.now(), issueId ?? null, issueUrl ?? null, prUrl ?? null, response ?? null, callbackUrl ?? null, callbackStatus ?? null
    );
  }

  private classify(query: string): string {
    const l = query.toLowerCase();
    for (const w of BUGS) if (l.includes(w)) return "bug";
    for (const w of FEATURES) if (l.includes(w)) return "feature";
    for (const w of QUESTIONS) if (l.includes(w)) return "question";
    return "general";
  }

  private issueBody(query: string, websiteUrl: string, userEmail: string, context: string, classification: string, instructions: string): string {
    return [
      "## User Query", "", query, "",
      `## Classification: ${classification}`,
      `## Website URL: ${websiteUrl || "Not provided"}`,
      `## User Email: ${userEmail || "Not provided"}`,
      `## Context: ${context || "None"}`, "",
      "## System Instructions", "", "```", instructions, "```"
    ].join("\n");
  }

  private reply(classification: string): string {
    if (classification === "bug") return "Aapki report ke liye dhanyavaad. Yeh ek bug lag raha hai; maine iski GitHub issue bana di hai.";
    if (classification === "feature") return "Aapka suggestion liya gaya hai. Ek feature request ke roop mein GitHub issue create kar di gayi hai.";
    if (classification === "question") return "Aapka prashna record kar liya gaya hai. Team iska jawab jaldi degi.";
    return "Aapki query record kar li gayi hai.";
  }

  private async sendCallback(callbackUrl: string, payload: Record<string, unknown>): Promise<{ success: boolean; status: string }> {
    if (!callbackUrl) return { success: false, status: "no_callback_url" };
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.env.CALLBACK_SECRET) headers["X-Callback-Secret"] = this.env.CALLBACK_SECRET;
      const res = await fetch(callbackUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });
      const ok = res.ok;
      const text = await res.text();
      return { success: ok, status: ok ? `ok:${res.status}` : `error:${res.status}:${text.slice(0, 80)}` };
    } catch (e) {
      return { success: false, status: `network_error:${String(e.message || e).slice(0, 80)}` };
    }
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") ?? undefined;

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization" } });
    }

    try {
      if (url.pathname === "/api/v1/health" && request.method === "GET") return json({ status: "ok" }, 200, origin);
      if (url.pathname === "/api/v1/query" && request.method === "POST") return this.handleQuery(request, origin);
      if (url.pathname === "/api/v1/fix" && request.method === "POST") return this.handleFix(request, origin);
      if (url.pathname === "/api/v1/analyze" && request.method === "POST") return this.handleAnalyze(request, origin);
      if (url.pathname === "/api/v1/auto-fix" && request.method === "POST") return this.handleAutoFix(request, origin);
      if (url.pathname === "/admin/system-instructions" && request.method === "GET") return json({ instructions: this.getSystemInstructions() }, 200, origin);
      if (url.pathname === "/admin/system-instructions" && request.method === "POST") return this.handleSetInstructions(request, origin);
      if (url.pathname === "/admin/api-keys" && request.method === "GET") return this.handleListApiKeys(origin);
      if (url.pathname === "/admin/api-keys" && request.method === "POST") return this.handleCreateApiKey(request, origin);
      if (url.pathname === "/admin/api-keys/revoke" && request.method === "POST") return this.handleRevokeApiKey(request, origin);
      if (url.pathname === "/admin/queries" && request.method === "GET") return this.handleListQueries(origin);
      if (url.pathname === "/admin/docs" && request.method === "GET") return this.handleDocs(request, origin);
      return json({ error: "Not found" }, 404, origin);
    } catch (e) {
      console.error("API error:", e);
      return json({ error: "Internal error", message: e instanceof Error ? e.message : String(e) }, 500, origin);
    }
  }

  private async bodyJson(request: Request): Promise<Record<string, unknown>> {
    try {
      return (await request.json()) as Record<string, unknown>;
    } catch {
      throw new Error("Invalid JSON body");
    }
  }

  private async handleQuery(request: Request, origin?: string): Promise<Response> {
    const apiKey = request.headers.get("X-API-Key") ?? request.headers.get("Authorization")?.replace("Bearer ", "");
    if (!(await this.validateKey(apiKey))) return json({ error: "Invalid or missing API key" }, 401, origin);
    const body = await this.bodyJson(request);
    const query = String(body.query ?? body.message ?? body.text ?? "");
    if (!query) return json({ error: "Missing required field: query" }, 400, origin);
    const repo = this.getRepo(body);
    const websiteUrl = String(body.websiteUrl ?? body.website_url ?? "");
    const userEmail = String(body.userEmail ?? body.user_email ?? "");
    const context = String(body.context ?? "");
    const callbackUrl = String(body.callbackUrl ?? body.callback_url ?? "");
    const classification = this.classify(query);
    const instructions = this.getSystemInstructions();
    const title = `[${classification.toUpperCase()}] ${query.slice(0, 80)}${query.length > 80 ? "..." : ""}`;
    const issueBody = this.issueBody(query, websiteUrl, userEmail, context, classification, instructions);

    let issue;
    try {
      issue = await this.github().createIssue(repo, title, issueBody, ["api-query", classification]);
    } catch (e) {
      return json({ error: "Failed to create GitHub issue", message: e instanceof Error ? e.message : String(e) }, 502, origin);
    }

    const reply = this.reply(classification);
    const cb = await this.sendCallback(callbackUrl, { event: "query_received", query, classification, issue_url: issue.url, issue_number: issue.number, reply, website_url: websiteUrl, user_email: userEmail });
    this.log({ query, websiteUrl, userEmail, context, classification, callbackUrl }, String(issue.number), issue.url, null, reply, callbackUrl, cb.status);
    return json({ success: true, classification, issue_url: issue.url, issue_number: issue.number, reply, callback_dispatched: cb.success, callback_status: cb.status }, 200, origin);
  }

  private async handleFix(request: Request, origin?: string): Promise<Response> {
    const apiKey = request.headers.get("X-API-Key") ?? request.headers.get("Authorization")?.replace("Bearer ", "");
    if (!(await this.validateKey(apiKey))) return json({ error: "Invalid or missing API key" }, 401, origin);
    const body = await this.bodyJson(request);
    const repo = this.getRepo(body);
    const path = String(body.file_path ?? "");
    const content = String(body.new_content ?? "");
    if (!path || !content) return json({ error: "Missing file_path or new_content" }, 400, origin);
    const message = String(body.message ?? `Fix via developer API: ${path}`);
    const branchName = String(body.branch_name ?? `api-fix/${path.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${Date.now()}`);
    const issueUrl = String(body.issue_url ?? "");
    const github = this.github();

    let sha: string | undefined;
    try {
      const existing = await github.getFile(repo, path, "main");
      if (existing) sha = existing.sha;
    } catch {
      // file does not exist
    }

    try {
      const mainSha = await github.getRef(repo, "heads/main");
      await github.createBranch(repo, branchName, mainSha);
      await github.writeFile(repo, path, message, content, branchName, sha);
    } catch (e) {
      return json({ error: "Failed to prepare fix branch", message: e instanceof Error ? e.message : String(e) }, 502, origin);
    }

    try {
      const pr = await github.createPullRequest(repo, message, branchName, "main", issueUrl ? `Fix for ${issueUrl}` : "Fix via developer API");
      this.log({ type: "fix", filePath: path, branchName, message, issueUrl }, null, issueUrl || null, pr.url, null);
      return json({ success: true, pull_request_url: pr.url, pull_request_number: pr.number, branch: pr.branch }, 200, origin);
    } catch (e) {
      return json({ error: "Failed to create pull request", message: e instanceof Error ? e.message : String(e) }, 502, origin);
    }
  }
