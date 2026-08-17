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
  constructor(ctx, env: Env) {
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
      const msg = e instanceof Error ? e.message : String(e);
      return { success: false, status: `network_error:${msg.slice(0, 80)}` };
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
  private async handleAnalyze(request: Request, origin?: string): Promise<Response> {
    const apiKey = request.headers.get("X-API-Key") ?? request.headers.get("Authorization")?.replace("Bearer ", "");
    if (!(await this.validateKey(apiKey))) return json({ error: "Invalid or missing API key" }, 401, origin);
    const body = await this.bodyJson(request);
    const query = String(body.query ?? "");
    if (!query) return json({ error: "Missing required field: query" }, 400, origin);
    const cls = this.classify(query);
    const lines: string[] = [];
    if (cls === "bug") lines.push("Yeh input ek bug report jaisa dikh raha hai.", "Typical wajah ho sakti hai: galat file path, missing dependency, ya koi JavaScript error.");
    else if (cls === "feature") lines.push("Yeh ek feature request ya improvement suggestion lag raha hai.");
    else if (cls === "question") lines.push("Yeh ek question/support request hai.");
    else lines.push("Yeh ek general feedback ya support message hai.");
    return json({ success: true, classification: cls, possible_problems: lines, next_step: "/api/v1/query par issue banayein" }, 200, origin);
  }

  private async handleAutoFix(request: Request, origin?: string): Promise<Response> {
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
    const filePaths = Array.isArray(body.file_paths) ? body.file_paths.map(String) : [];
    const classification = this.classify(query);
    const instructions = this.getSystemInstructions();
    const title = `[AUTO-FIX ${classification.toUpperCase()}] ${query.slice(0, 80)}${query.length > 80 ? "..." : ""}`;
    const issueBody = this.issueBody(query, websiteUrl, userEmail, context, classification, instructions);
    const github = this.github();
    let issueNumber: number;
    let issueUrl: string;
    try {
      const issue = await github.createIssue(repo, title, issueBody, ["api-query", classification, "auto-fix"]);
      issueNumber = issue.number;
      issueUrl = issue.url;
    } catch (e) {
      return json({ error: "Failed to create GitHub issue", message: e instanceof Error ? e.message : String(e) }, 502, origin);
    }

    let workflowDispatched = false;
    try {
      const exists = await github.workflowExists(repo, `.github/workflows/${AUTO_FIX_WORKFLOW}`, "main");
      if (exists) {
        const safeBranch = `auto-fix/issue-${issueNumber}`.replace(/[^a-zA-Z0-9/-]/g, "-").replace(/--+/g, "-").slice(0, 128);
        await github.dispatchWorkflow(repo, AUTO_FIX_WORKFLOW, "main", { issue_url: issueUrl, query, website_url: websiteUrl, context, file_paths: filePaths.join(","), branch_name: safeBranch });
        workflowDispatched = true;
      }
    } catch (e) {
      console.error("Auto-fix workflow dispatch failed:", e);
    }

    const reply = workflowDispatched ? "Aapki auto-fix request submit ho gayi hai. AI workflow trigger ho gaya hai." : "Aapki query ke liye GitHub issue ban gayi hai.";
    const cb = await this.sendCallback(callbackUrl, { event: "auto_fix_received", query, classification, issue_url: issueUrl, issue_number: issueNumber, workflow_dispatched: workflowDispatched, reply, website_url: websiteUrl, user_email: userEmail });
    this.log({ type: "auto-fix", query, websiteUrl, userEmail, context, classification, filePaths, workflowDispatched, callbackUrl }, String(issueNumber), issueUrl, null, reply, callbackUrl, cb.status);
    return json({ success: true, classification, issue_url: issueUrl, issue_number: issueNumber, workflow_dispatched: workflowDispatched, reply, callback_dispatched: cb.success, callback_status: cb.status }, 200, origin);
  }
  private async handleSetInstructions(request: Request, origin?: string): Promise<Response> {
    const body = await this.bodyJson(request);
    const instructions = String(body.instructions ?? "");
    if (!instructions) return json({ error: "Missing instructions" }, 400, origin);
    this.setCfg("systemInstructions", instructions);
    return json({ success: true, message: "System instructions updated" }, 200, origin);
  }

  private async handleCreateApiKey(request: Request, origin?: string): Promise<Response> {
    const body = await this.bodyJson(request);
    const name = String(body.name ?? "");
    if (!name) return json({ error: "Missing name" }, 400, origin);
    const key = makeKey();
    const hash = await sha256(key);
    this.ctx.storage.sql.exec("INSERT INTO api_keys (key_hash, name, created_at, active) VALUES (?, ?, ?, 1)", hash, name, Date.now());
    return json({ success: true, name, key }, 200, origin);
  }

  private async handleListApiKeys(origin?: string): Promise<Response> {
    const rows = this.ctx.storage.sql.exec("SELECT key_hash, name, created_at, active FROM api_keys ORDER BY created_at DESC").toArray();
    return json({ keys: rows.map(r => ({ hash: r.key_hash, name: r.name, created_at: r.created_at, active: r.active === 1 })) }, 200, origin);
  }

  private async handleRevokeApiKey(request: Request, origin?: string): Promise<Response> {
    const body = await this.bodyJson(request);
    const hash = String(body.hash ?? "");
    if (!hash) return json({ error: "Missing hash" }, 400, origin);
    this.ctx.storage.sql.exec("UPDATE api_keys SET active = 0 WHERE key_hash = ?", hash);
    return json({ success: true, message: "API key revoked" }, 200, origin);
  }

  private async handleListQueries(origin?: string): Promise<Response> {
    const rows = this.ctx.storage.sql.exec("SELECT id, payload, created_at, issue_id, issue_url, pr_url, response, callback_url, callback_status FROM queries ORDER BY created_at DESC LIMIT 100").toArray();
    return json({ queries: rows.map(r => ({ id: r.id, payload: JSON.parse(String(r.payload)), created_at: r.created_at, issue_id: r.issue_id, issue_url: r.issue_url, pr_url: r.pr_url, response: r.response, callback_url: r.callback_url, callback_status: r.callback_status })) }, 200, origin);
  }

  private async handleDocs(request: Request, origin?: string): Promise<Response> {
    const url = new URL(request.url);
    return json({
      endpoints: [
        { method: "POST", path: "/api/v1/query", auth: "X-API-Key", body: { query: "string", websiteUrl: "string?", userEmail: "string?", context: "string?", repoOwner: "string?", repoName: "string?", callbackUrl: "string?" }, response: { success: true, issue_url: "string", reply: "string", callback_dispatched: "boolean" } },
        { method: "POST", path: "/api/v1/fix", auth: "X-API-Key", body: { file_path: "string", new_content: "string", repoOwner: "string?", repoName: "string?", issue_url: "string?", message: "string?", branch_name: "string?" }, response: { success: true, pull_request_url: "string", pull_request_number: "number" } },
        { method: "POST", path: "/api/v1/analyze", auth: "X-API-Key", body: { query: "string" }, response: { success: true, classification: "string", possible_problems: ["string"] } },
        { method: "POST", path: "/api/v1/auto-fix", auth: "X-API-Key", body: { query: "string", websiteUrl: "string?", context: "string?", file_paths: ["string?"], repoOwner: "string?", repoName: "string?", callbackUrl: "string?" }, response: { success: true, issue_url: "string", workflow_dispatched: "boolean" } },
        { method: "GET", path: "/api/v1/health", auth: "none", response: { status: "ok" } },
      ],
      integration_example: `fetch("${url.origin}/api/v1/query", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": "YOUR_KEY" }, body: JSON.stringify({ query: "...", websiteUrl: "https://example.com", callbackUrl: "https://example.com/api/callback" }) }).then(r => r.json()).then(console.log);`
    }, 200, origin);
  }
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const id = env.DEVELOPER_API_GATEWAY.idFromName("default");
    const stub = env.DEVELOPER_API_GATEWAY.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
