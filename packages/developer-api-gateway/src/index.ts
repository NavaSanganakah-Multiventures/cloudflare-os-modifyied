import { DurableObject } from "cloudflare:workers";
import { GitHubClient } from "./github-client.js";

const DEFAULT_SYSTEM_INSTRUCTIONS = [
  "You are a helpful developer-support assistant integrated into a website.",
  "When a user reports a problem or asks a question about their website or application:",
  "1. Identify whether the message is about a bug, a feature request, a question, or general feedback.",
  "2. If it looks like a bug or error, collect enough detail and prepare a precise GitHub issue.",
  "3. If the user provides a fix or corrected code, propose it as a pull request.",
  "4. For questions or possible-problem explanations, give a concise, actionable reply in the user's language.",
  "Be polite and clear.",
].join("\n");

const BUG_KEYWORDS = ["error", "bug", "fail", "crash", "broken", "not working", "doesn't work", "exception", "timeout", "blank", "404", "500", "issue"];
const FEATURE_KEYWORDS = ["add", "feature", "support", "implement", "would like", "need", "want", "should have"];
const QUESTION_KEYWORDS = ["how", "what", "why", "can i", "is it possible", "question"];
const AUTO_FIX_WORKFLOW = "developer-api-auto-fix.yml";

async function sha256Hex(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "dev_" + Array.from(bytes)
    .map((b) => b.toString(36))
    .join("")
    .slice(0, 40);
}

function jsonResponse(data: unknown, status = 200, corsOrigin = "*"): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization",
    },
  });
}

export class DeveloperApiGateway extends DurableObject {
  private github: GitHubClient;
  private corsOrigin: string;

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env);
    if (!env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is not configured");
    if (!env.GITHUB_OWNER || !env.GITHUB_REPO) throw new Error("GITHUB_OWNER and GITHUB_REPO must be configured");
    this.github = new GitHubClient(env.GITHUB_TOKEN, env.GITHUB_OWNER, env.GITHUB_REPO);
    this.corsOrigin = env.API_CORS_ORIGIN ?? "*";
    this.initDb();
  }

  private initDb(): void {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1);`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS queries (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT NOT NULL, created_at INTEGER NOT NULL, issue_id TEXT, issue_url TEXT, pr_url TEXT, response TEXT);`);
  }

  private getConfig(key: string): string | null {
    const rows = this.ctx.storage.sql.exec("SELECT value FROM config WHERE key = ?", key).toArray();
    return rows.length ? String(rows[0].value) : null;
  }

  private setConfig(key: string, value: string): void {
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", key, value);
  }

  private async getSystemInstructions(): Promise<string> {
    return this.getConfig("systemInstructions") || DEFAULT_SYSTEM_INSTRUCTIONS;
  }

  private async validateApiKey(key: string | null): Promise<boolean> {
    if (!key) return false;
    const hash = await sha256Hex(key);
    const rows = this.ctx.storage.sql.exec("SELECT active FROM api_keys WHERE key_hash = ?", hash).toArray();
    return rows.length === 1 && rows[0].active === 1;
  }

  private logQuery(payload: object, issueId: string | null, issueUrl: string | null, prUrl: string | null, response: string | null): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO queries (payload, created_at, issue_id, issue_url, pr_url, response) VALUES (?, ?, ?, ?, ?, ?)",
      JSON.stringify(payload),
      Date.now(),
      issueId,
      issueUrl,
      prUrl,
      response,
    );
  }

  private classifyQuery(query: string): string {
    const lower = query.toLowerCase();
    for (const kw of BUG_KEYWORDS) if (lower.includes(kw)) return "bug";
    for (const kw of FEATURE_KEYWORDS) if (lower.includes(kw)) return "feature";
    for (const kw of QUESTION_KEYWORDS) if (lower.includes(kw)) return "question";
    return "general";
  }

  private buildIssueBody(query: string, websiteUrl: string, userEmail: string, context: string, classification: string, systemInstructions: string): string {
    return [
      "## User Query",
      "",
      query,
      "",
      `## Classification: ${classification}`,
      `## Website URL: ${websiteUrl || "Not provided"}`,
      `## User Email: ${userEmail || "Not provided"}`,
      `## Context: ${context || "None"}`,
      "",
      "## System Instructions in Effect",
      "",
      "```",
      systemInstructions,
      "```",
    ].join("\n");
  }

  private buildReply(query: string, classification: string): string {
    if (classification === "bug") {
      return "Aapki report ke liye dhanyavaad. Yeh ek bug lag raha hai; maine iski GitHub issue bana di hai. Team jaldi iska jawab degi aur zaroorat padne par pull request bhi banayegi.";
    }
    if (classification === "feature") {
      return "Aapka suggestion liya gaya hai. Ek feature request ke roop mein GitHub issue create kar di gayi hai.";
    }
    if (classification === "question") {
      return "Aapka prashna record kar liya gaya hai. Team iska jawab jaldi degi.";
    }
    return "Aapki query record kar li gayi hai. Harek update ke liye aapko email ya website par notification mil jayegi.";
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": this.corsOrigin, "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization" } });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === "/api/v1/query" && request.method === "POST") return this.handleQuery(request);
      if (url.pathname === "/api/v1/fix" && request.method === "POST") return this.handleFix(request);
      if (url.pathname === "/api/v1/analyze" && request.method === "POST") return this.handleAnalyze(request);
      if (url.pathname === "/api/v1/auto-fix" && request.method === "POST") return this.handleAutoFix(request);
      if (url.pathname === "/api/v1/health" && request.method === "GET") return jsonResponse({ status: "ok" }, 200, this.corsOrigin);

      if (url.pathname === "/admin/system-instructions" && request.method === "GET") return jsonResponse({ instructions: await this.getSystemInstructions() }, 200, this.corsOrigin);
      if (url.pathname === "/admin/system-instructions" && request.method === "POST") return this.handleSetInstructions(request);
      if (url.pathname === "/admin/api-keys" && request.method === "GET") return this.handleListApiKeys();
      if (url.pathname === "/admin/api-keys" && request.method === "POST") return this.handleCreateApiKey(request);
      if (url.pathname === "/admin/api-keys/revoke" && request.method === "POST") return this.handleRevokeApiKey(request);
      if (url.pathname === "/admin/queries" && request.method === "GET") return this.handleListQueries();
      if (url.pathname === "/admin/docs" && request.method === "GET") return this.handleDocs(request);

      return jsonResponse({ error: "Not found" }, 404, this.corsOrigin);
    } catch (e: any) {
      console.error("API error:", e);
      return jsonResponse({ error: "Internal error", message: e?.message ?? String(e) }, 500, this.corsOrigin);
    }
  }

  private async requireApiKey(request: Request): Promise<string | Response> {
    const header = request.headers.get("X-API-Key") ?? request.headers.get("Authorization")?.replace("Bearer ", "");
    if (!header || !(await this.validateApiKey(header))) {
      return jsonResponse({ error: "Invalid or missing API key" }, 401, this.corsOrigin);
    }
    return header;
  }

  private async bodyJson(request: Request): Promise<any> {
    return request.json();
  }

  private async handleQuery(request: Request): Promise<Response> {
    const keyCheck = await this.requireApiKey(request);
    if (keyCheck instanceof Response) return keyCheck;

    const body = await this.bodyJson(request);
    const actualQuery = body.query ?? body.message ?? body.text;
    if (!actualQuery || typeof actualQuery !== "string" || actualQuery.trim().length === 0) {
      return jsonResponse({ error: "Missing required field: query" }, 400, this.corsOrigin);
    }

    const websiteUrl: string = body.websiteUrl ?? body.website_url ?? "";
    const userEmail: string = body.userEmail ?? body.user_email ?? "";
    const context: string = body.context ?? "";
    const classification = this.classifyQuery(actualQuery);
    const systemInstructions = await this.getSystemInstructions();

    const title = `[${classification.toUpperCase()}] ${actualQuery.slice(0, 80)}${actualQuery.length > 80 ? "..." : ""}`;
    const issueBody = this.buildIssueBody(actualQuery, websiteUrl, userEmail, context, classification, systemInstructions);

    let issue: { number: number; url: string };
    try {
      issue = await this.github.createIssue(title, issueBody, ["api-query", classification]);
    } catch (e: any) {
      return jsonResponse({ error: "Failed to create GitHub issue", message: e.message }, 502, this.corsOrigin);
    }

    const reply = this.buildReply(actualQuery, classification);
    this.logQuery(
      { query: actualQuery, websiteUrl, userEmail, context, classification },
      String(issue.number),
      issue.url,
      null,
      reply,
    );

    return jsonResponse({ success: true, classification, issue_url: issue.url, issue_number: issue.number, reply }, 200, this.corsOrigin);
  }
  private async handleFix(request: Request): Promise<Response> {
    const keyCheck = await this.requireApiKey(request);
    if (keyCheck instanceof Response) return keyCheck;

    const body = await this.bodyJson(request);
    const filePath: string = body.file_path;
    const newContent: string = body.new_content;
    if (!filePath || typeof filePath !== "string") {
      return jsonResponse({ error: "Missing required field: file_path" }, 400, this.corsOrigin);
    }
    if (!newContent || typeof newContent !== "string") {
      return jsonResponse({ error: "Missing required field: new_content" }, 400, this.corsOrigin);
    }

    let sha: string | undefined;
    try {
      const existing = await this.github.getFile(filePath, "main");
      sha = existing.sha;
    } catch {
      // file does not exist; it will be created
    }

    const branchName: string = body.branch_name ?? `api-fix/${filePath.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${Date.now()}`;
    const message: string = body.message ?? `Fix via developer API: ${filePath}`;

    let commitSha: string;
    try {
      const mainRef = await this.github.getRef("heads/main");
      await this.github.createBranch(branchName, mainRef.sha);
      const result = await this.github.writeFile(filePath, message, newContent, branchName, sha);
      commitSha = result.commitSha;
    } catch (e: any) {
      return jsonResponse({ error: "Failed to prepare fix branch", message: e.message }, 502, this.corsOrigin);
    }

    let pr: { number: number; url: string };
    try {
      pr = await this.github.createPullRequest(
        message,
        branchName,
        "main",
        body.issue_url ? `Fix proposed for issue referenced in ${body.issue_url}` : "Fix proposed via developer API.",
      );
    } catch (e: any) {
      return jsonResponse({ error: "Failed to create pull request", message: e.message }, 502, this.corsOrigin);
    }

    this.logQuery(
      { type: "fix", filePath, branchName, message, issueUrl: body.issue_url },
      null,
      body.issue_url ?? null,
      pr.url,
      null,
    );

    return jsonResponse(
      { success: true, pull_request_url: pr.url, pull_request_number: pr.number, branch: branchName, commit_sha: commitSha },
      200,
      this.corsOrigin,
    );
  }

  private async handleAnalyze(request: Request): Promise<Response> {
    const keyCheck = await this.requireApiKey(request);
    if (keyCheck instanceof Response) return keyCheck;

    const body = await this.bodyJson(request);
    const query: string = body.query;
    if (!query || typeof query !== "string") {
      return jsonResponse({ error: "Missing required field: query" }, 400, this.corsOrigin);
    }

    const classification = this.classifyQuery(query);
    const systemInstructions = await this.getSystemInstructions();
    const lines: string[] = [];
    if (classification === "bug") {
      lines.push("Yeh input ek bug report jaisa dikh raha hai.");
      lines.push("Typical wajah ho sakti hai: galat file path, missing dependency, ya koi JavaScript error.");
    } else if (classification === "feature") {
      lines.push("Yeh ek feature request ya improvement suggestion lag raha hai.");
    } else if (classification === "question") {
      lines.push("Yeh ek question/support request hai.");
    } else {
      lines.push("Yeh ek general feedback ya support message hai.");
    }

    return jsonResponse(
      {
        success: true,
        classification,
        possible_problems: lines,
        next_step: "Is query ko GitHub issue banane ke liye /api/v1/query endpoint par bhejein. Agar aapke paas fix ka code hai to /api/v1/fix endpoint se PR banayein.",
        system_instructions_preview: systemInstructions.slice(0, 200),
      },
      200,
      this.corsOrigin,
    );
  }

  private async handleAutoFix(request: Request): Promise<Response> {
    const keyCheck = await this.requireApiKey(request);
    if (keyCheck instanceof Response) return keyCheck;

    const body = await this.bodyJson(request);
    const actualQuery = body.query ?? body.message ?? body.text;
    if (!actualQuery || typeof actualQuery !== "string" || actualQuery.trim().length === 0) {
      return jsonResponse({ error: "Missing required field: query" }, 400, this.corsOrigin);
    }

    const classification = this.classifyQuery(actualQuery);
    const websiteUrl: string = body.websiteUrl ?? body.website_url ?? "";
    const userEmail: string = body.userEmail ?? body.user_email ?? "";
    const context: string = body.context ?? "";
    const filePaths: string[] = Array.isArray(body.file_paths) ? body.file_paths : [];
    const systemInstructions = await this.getSystemInstructions();

    const title = `[AUTO-FIX ${classification.toUpperCase()}] ${actualQuery.slice(0, 80)}${actualQuery.length > 80 ? "..." : ""}`;
    const issueBody = this.buildIssueBody(actualQuery, websiteUrl, userEmail, context, classification, systemInstructions);

    let issue: { number: number; url: string };
    try {
      issue = await this.github.createIssue(title, issueBody, ["api-query", classification, "auto-fix"]);
    } catch (e: any) {
      return jsonResponse({ error: "Failed to create GitHub issue", message: e.message }, 502, this.corsOrigin);
    }

    let workflowDispatched = false;
    try {
      if (await this.github.workflowExists(`.github/workflows/${AUTO_FIX_WORKFLOW}`, "main")) {
        const safeBranch = `auto-fix/issue-${issue.number}`.replace(/[^a-zA-Z0-9/-]/g, "-").replace(/--+/g, "-").slice(0, 128);
        await this.github.dispatchWorkflow(AUTO_FIX_WORKFLOW, "main", {
          issue_url: issue.url,
          query: actualQuery,
          website_url: websiteUrl,
          context,
          file_paths: filePaths.join(","),
          branch_name: safeBranch,
        });
        workflowDispatched = true;
      }
    } catch (e: any) {
      console.error("Auto-fix workflow dispatch failed:", e);
    }

    const response = workflowDispatched
      ? "Aapki auto-fix request submit ho gayi hai. AI workflow trigger ho gaya hai aur jaldi ek PR ban jayega."
      : "Aapki query ke liye GitHub issue ban gayi hai. Auto-fix workflow abhi available nahi hai.";
    this.logQuery(
      { type: "auto-fix", query: actualQuery, websiteUrl, userEmail, context, classification, filePaths, workflowDispatched },
      String(issue.number),
      issue.url,
      null,
      response,
    );

    return jsonResponse(
      {
        success: true,
        classification,
        issue_url: issue.url,
        issue_number: issue.number,
        workflow_dispatched: workflowDispatched,
        workflow_file: `.github/workflows/${AUTO_FIX_WORKFLOW}`,
        workflow_setup_required: !workflowDispatched,
        workflow_setup_guide: workflowDispatched ? undefined : this.buildAutoFixWorkflowGuide(),
        reply: response,
      },
      200,
      this.corsOrigin,
    );
  }

  private buildAutoFixWorkflowGuide(): string {
    return [
      "## Auto-fix workflow setup",
      "",
      "1. Create .github/workflows/developer-api-auto-fix.yml on the main branch.",
      "2. Listen for workflow_dispatch and accept inputs: issue_url, query, website_url, context, file_paths, branch_name.",
      "3. Use an AI model with a repo secret to read the issue, inspect files, generate a fix, and open a PR referencing issue_url.",
      "4. Once the file is on main, /api/v1/auto-fix will dispatch it automatically.",
    ].join("\n");
  }

  private async handleSetInstructions(request: Request): Promise<Response> {
    const body = await this.bodyJson(request);
    if (typeof body.instructions !== "string" || body.instructions.trim().length === 0) {
      return jsonResponse({ error: "Missing required field: instructions" }, 400, this.corsOrigin);
    }
    this.setConfig("systemInstructions", body.instructions.trim());
    return jsonResponse({ success: true, message: "System instructions updated" }, 200, this.corsOrigin);
  }

  private async handleCreateApiKey(request: Request): Promise<Response> {
    const body = await this.bodyJson(request);
    if (!body.name || typeof body.name !== "string") {
      return jsonResponse({ error: "Missing required field: name" }, 400, this.corsOrigin);
    }
    const key = generateKey();
    const hash = await sha256Hex(key);
    this.ctx.storage.sql.exec("INSERT INTO api_keys (key_hash, name, created_at, active) VALUES (?, ?, ?, 1)", hash, body.name, Date.now());
    return jsonResponse({ success: true, name: body.name, key }, 200, this.corsOrigin);
  }

  private async handleListApiKeys(): Promise<Response> {
    const rows = this.ctx.storage.sql.exec("SELECT key_hash, name, created_at, active FROM api_keys ORDER BY created_at DESC").toArray();
    return jsonResponse({ keys: rows.map((r) => ({ hash: r.key_hash, name: r.name, created_at: r.created_at, active: r.active === 1 })) }, 200, this.corsOrigin);
  }

  private async handleRevokeApiKey(request: Request): Promise<Response> {
    const body = await this.bodyJson(request);
    if (!body.hash) return jsonResponse({ error: "Missing required field: hash" }, 400, this.corsOrigin);
    this.ctx.storage.sql.exec("UPDATE api_keys SET active = 0 WHERE key_hash = ?", body.hash);
    return jsonResponse({ success: true, message: "API key revoked" }, 200, this.corsOrigin);
  }

  private async handleListQueries(): Promise<Response> {
    const rows = this.ctx.storage.sql.exec("SELECT id, payload, created_at, issue_id, issue_url, pr_url, response FROM queries ORDER BY created_at DESC LIMIT 100").toArray();
    return jsonResponse(
      {
        queries: rows.map((r) => ({
          id: r.id,
          payload: JSON.parse(String(r.payload)),
          created_at: r.created_at,
          issue_id: r.issue_id,
          issue_url: r.issue_url,
          pr_url: r.pr_url,
          response: r.response,
        })),
      },
      200,
      this.corsOrigin,
    );
  }

  private async handleDocs(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const systemInstructions = await this.getSystemInstructions();
    return jsonResponse(
      {
        endpoints: [
          { method: "POST", path: "/api/v1/query", auth: "X-API-Key header", body: { query: "string", websiteUrl: "string?", userEmail: "string?", context: "string?" }, response: { success: true, classification: "string", issue_url: "string", reply: "string" } },
          { method: "POST", path: "/api/v1/fix", auth: "X-API-Key header", body: { file_path: "string", new_content: "string", issue_url: "string?", message: "string?", branch_name: "string?" }, response: { success: true, pull_request_url: "string", branch: "string" } },
          { method: "POST", path: "/api/v1/analyze", auth: "X-API-Key header", body: { query: "string", websiteUrl: "string?" }, response: { success: true, classification: "string", possible_problems: ["string"], next_step: "string" } },
          { method: "POST", path: "/api/v1/auto-fix", auth: "X-API-Key header", body: { query: "string", websiteUrl: "string?", userEmail: "string?", context: "string?", file_paths: ["string?"] }, response: { success: true, issue_url: "string", workflow_dispatched: "boolean" } },
          { method: "GET", path: "/api/v1/health", auth: "none", response: { status: "ok" } },
        ],
        integration_example: { query: `fetch("${origin}/api/v1/query", { method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": "YOUR_API_KEY" }, body: JSON.stringify({ query: "My checkout page shows a 500 error", websiteUrl: "https://example.com" }) }).then(r => r.json()).then(console.log);` },
        current_system_instructions: systemInstructions,
      },
      200,
      this.corsOrigin,
    );
  }
}

export default {
  async fetch(request, env, ctx) {
    const id = env.DEVELOPER_API_GATEWAY.idFromName("default");
    const stub = env.DEVELOPER_API_GATEWAY.get(id);
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Cloudflare.Env>;
