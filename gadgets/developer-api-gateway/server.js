import { DurableObject } from "cloudflare:workers";

const DEFAULT_INSTRUCTIONS = [
  "You are a helpful developer-support assistant integrated into a website.",
  "1. Identify whether the message is about a bug, feature, question, or general feedback.",
  "2. For bugs, prepare a precise GitHub issue with details.",
  "3. For questions, give a concise actionable reply.",
  "Be polite and clear."
].join("\n");

const BUGS = ["error", "bug", "fail", "crash", "broken", "not working", "exception", "timeout", "404", "500"];
const FEATURES = ["feature", "add", "support", "implement"];
const QUESTIONS = ["how", "what", "why", "question"];

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
}

function makeKey() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "dev_" + Array.from(bytes).map(b => b.toString(36)).join("").slice(0, 40);
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization" } });
}

export class Gadget extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.ctx = ctx; this.env = env; this.bindings = new Map(); this.discoverPromise = null; this.initDb(); }

  async discoverBindings() {
    if (this.discoverPromise) return this.discoverPromise;
    this.discoverPromise = (async () => {
      const map = new Map();
      for (const key of Object.keys(this.env)) {
        const c = this.env[key];
        if (!c || typeof c.getMetadata !== "function") continue;
        try {
          const m = await c.getMetadata();
          if (m && m.owner && m.name) map.set(m.owner + "/" + m.name, c);
        } catch (e) {}
      }
      this.bindings = map;
      return map;
    })();
    return this.discoverPromise;
  }

  async getRepo(owner, name) {
    const map = await this.discoverBindings();
    const key = owner && name ? owner + "/" + name : null;
    if (key && map.has(key)) return map.get(key);
    if (map.size === 1) return Array.from(map.values())[0];
    throw new Error("No bound repo. Connect a GitHub repo to this Gadget.");
  }

  initDb() {
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS api_keys (key_hash TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, active INTEGER DEFAULT 1);`);
    this.ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS queries (id INTEGER PRIMARY KEY AUTOINCREMENT, payload TEXT, created_at INTEGER, issue_id TEXT, issue_url TEXT, pr_url TEXT, response TEXT);`);
  }

  cfg(k) { const r = this.ctx.storage.sql.exec("SELECT value FROM config WHERE key = ?", k).toArray(); return r.length ? r[0].value : null; }
  setCfg(k, v) { this.ctx.storage.sql.exec("INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)", k, v); }
  async check(key) { if (!key) return false; const h = await sha256(key); const r = this.ctx.storage.sql.exec("SELECT active FROM api_keys WHERE key_hash = ?", h).toArray(); return r.length && r[0].active === 1; }
  log(p, iid, iurl, prurl, resp) { this.ctx.storage.sql.exec("INSERT INTO queries (payload, created_at, issue_id, issue_url, pr_url, response) VALUES (?, ?, ?, ?, ?, ?)", JSON.stringify(p), Date.now(), iid, iurl, prurl, resp); }

  classify(q) { const l = q.toLowerCase(); for (const w of BUGS) if (l.includes(w)) return "bug"; for (const w of FEATURES) if (l.includes(w)) return "feature"; for (const w of QUESTIONS) if (l.includes(w)) return "question"; return "general"; }

  issueBody(q, url, email, ctx, cls, inst) {
    return ["## User Query", "", q, "", `## Classification: ${cls}`, `## Website URL: ${url || "Not provided"}`, `## User Email: ${email || "Not provided"}`, `## Context: ${ctx || "None"}`, "", "## System Instructions", "", "```", inst, "```"].join("\n");
  }

  reply(cls) {
    if (cls === "bug") return "Aapki report ke liye dhanyavaad. Bug report ke roop mein issue create kar di gayi hai.";
    if (cls === "feature") return "Aapka suggestion liya gaya hai. Feature request create kar di gayi hai.";
    if (cls === "question") return "Aapka prashna record kar liya gaya hai.";
    return "Aapki query record kar li gayi hai.";
  }

  async fetch(req) {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, GET, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-API-Key, Authorization" } });
    const u = new URL(req.url);
    try {
      if (u.pathname === "/api/v1/health") return json({ status: "ok" });
      if (u.pathname === "/api/v1/query" && req.method === "POST") return this.query(req);
      if (u.pathname === "/api/v1/fix" && req.method === "POST") return this.fix(req);
      if (u.pathname === "/api/v1/analyze" && req.method === "POST") return this.analyze(req);
      if (u.pathname === "/admin/system-instructions" && req.method === "GET") return json({ instructions: this.cfg("inst") || DEFAULT_INSTRUCTIONS });
      if (u.pathname === "/admin/system-instructions" && req.method === "POST") { const b = await req.json(); this.setCfg("inst", b.instructions); return json({ success: true }); }
      if (u.pathname === "/admin/api-keys" && req.method === "GET") { const rows = this.ctx.storage.sql.exec("SELECT key_hash, name, created_at, active FROM api_keys ORDER BY created_at DESC").toArray(); return json({ keys: rows.map(r => ({ hash: r.key_hash, name: r.name, created_at: r.created_at, active: r.active === 1 })) }); }
      if (u.pathname === "/admin/api-keys" && req.method === "POST") { const b = await req.json(); const k = makeKey(); this.ctx.storage.sql.exec("INSERT INTO api_keys (key_hash, name, created_at, active) VALUES (?, ?, ?, 1)", await sha256(k), b.name, Date.now()); return json({ success: true, key: k, name: b.name }); }
      if (u.pathname === "/admin/api-keys/revoke" && req.method === "POST") { const b = await req.json(); this.ctx.storage.sql.exec("UPDATE api_keys SET active = 0 WHERE key_hash = ?", b.hash); return json({ success: true }); }
      if (u.pathname === "/admin/repos" && req.method === "GET") { const map = await this.discoverBindings(); return json({ repos: Array.from(map.keys()) }); }
      return json({ error: "Not found" }, 404);
    } catch (e) { console.error(e); return json({ error: "Internal error", message: e.message }, 500); }
  }

  async requireKey(req) {
    const h = req.headers.get("X-API-Key") || req.headers.get("Authorization")?.replace("Bearer ", "");
    if (!h || !(await this.check(h))) throw new Error("Invalid or missing API key");
  }

  async query(req) {
    await this.requireKey(req);
    const b = await req.json();
    const q = b.query || b.message || b.text;
    if (!q || typeof q !== "string") return json({ error: "Missing query" }, 400);
    const owner = b.repoOwner || b.repo_owner || "";
    const name = b.repoName || b.repo_name || "";
    const repo = await this.getRepo(owner, name);
    const cls = this.classify(q);
    const inst = this.cfg("inst") || DEFAULT_INSTRUCTIONS;
    const title = `[${cls.toUpperCase()}] ${q.slice(0, 80)}${q.length > 80 ? "..." : ""}`;
    const body = this.issueBody(q, b.websiteUrl || b.website_url || "", b.userEmail || b.user_email || "", b.context || "", cls, inst);
    const issue = await repo.createIssue({ title, bodyMarkdown: body, labels: ["api-query", cls] });
    const d = await issue.getDetails();
    const r = this.reply(cls);
    this.log({ query: q, websiteUrl: b.websiteUrl, classification: cls }, d.id, d.url, null, r);
    return json({ success: true, classification: cls, issue_url: d.url, issue_number: d.id, reply: r });
  }

  async fix(req) {
    await this.requireKey(req);
    const b = await req.json();
    const owner = b.repoOwner || b.repo_owner || "";
    const name = b.repoName || b.repo_name || "";
    const repo = await this.getRepo(owner, name);
    const path = b.file_path;
    const content = b.new_content;
    if (!path || !content) return json({ error: "file_path and new_content required" }, 400);
    let sha = null;
    try { sha = (await repo.readFile(path, "main")).sha; } catch (e) {}
    const branch = b.branch_name || `api-fix/${path.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40)}-${Date.now()}`;
    const msg = b.message || `Fix via developer API: ${path}`;
    const result = await repo.proposeFileChange({ branchName: branch, path, message: msg, content, sha: sha || undefined, prTitle: msg, prBody: b.issue_url ? `Fix for ${b.issue_url}` : "Fix via developer API" });
    const pd = await result.pullRequest.getDetails();
    this.log({ type: "fix", filePath: path, branch, message: msg }, null, b.issue_url || null, pd.url, null);
    return json({ success: true, pull_request_url: pd.url, pull_request_number: pd.id, branch: result.branch.name });
  }

  async analyze(req) {
    await this.requireKey(req);
    const b = await req.json();
    if (!b.query) return json({ error: "Missing query" }, 400);
    const cls = this.classify(b.query);
    const lines = cls === "bug" ? ["Yeh bug report jaisa dikh raha hai.", "Typical wajah: galat file path, missing dependency, ya JS error."] : cls === "feature" ? ["Yeh feature request lag raha hai."] : cls === "question" ? ["Yeh question/support request hai."] : ["Yeh general feedback hai."];
    return json({ success: true, classification: cls, possible_problems: lines, next_step: "/api/v1/query par issue banayein" });
  }
}
