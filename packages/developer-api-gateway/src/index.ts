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
