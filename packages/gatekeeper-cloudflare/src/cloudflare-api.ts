// Thin client over the Cloudflare REST API used by the gatekeeper. Every call uses the
// connected account's OAuth access token (obtained lazily through the token getter). The token
// never leaves the gatekeeper Durable Object.

import { VENDOR_ID } from "./vendor.js";
import { obsContext } from "./observability.js";

const API_BASE = "https://api.cloudflare.com/client/v4";

const logger = obsContext.createLogger({
  component: "gatekeeper.cloudflare", vendorId: VENDOR_ID,
});

export class CloudflareApiError extends Error {
  status: number;
  isAuthError: boolean;

  constructor(status: number, message: string, isAuthError = false) {
    super(message);
    this.name = "CloudflareApiError";
    this.status = status;
    this.isAuthError = isAuthError;
  }
}

interface CfEnvelope<T> {
  success: boolean;
  result?: T;
  errors?: Array<{ code?: number; message?: string }>;
  messages?: Array<{ code?: number; message?: string }>;
  result_info?: CfResultInfo;
}

export interface CfResultInfo {
  page: number;
  per_page: number;
  total_pages: number;
  count: number;
  total_count: number;
}

export interface CfList<T> {
  result: T[];
  resultInfo: CfResultInfo | null;
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class CloudflareApi {
  #getToken: () => Promise<string>;

  constructor(getToken: () => Promise<string>) {
    this.#getToken = getToken;
  }

  async #request<T>(method: HttpMethod, path: string, opts?: {
    query?: Record<string, string | number | boolean | undefined>;
    json?: unknown;
    body?: string;
    contentType?: string;
  }): Promise<T> {
    const token = await this.#getToken();
    const url = new URL(API_BASE + path);
    if (opts?.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {
      "Authorization": `Bearer ${token}`,
      "Accept": "application/json",
    };
    let body: string | undefined;
    if (opts?.json !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(opts.json);
    } else if (opts?.body !== undefined) {
      headers["Content-Type"] = opts.contentType ?? "text/plain";
      body = opts.body;
    }

    let resp: Response;
    try {
      resp = await fetch(url.toString(), { method, headers, body });
    } catch (err) {
      throw new CloudflareApiError(0, `Cloudflare API request failed: ${(err as Error).message}`);
    }

    if (resp.status === 401 || resp.status === 403) {
      const message = await safeStatusText(resp);
      throw new CloudflareApiError(resp.status, message, true);
    }

    let data: CfEnvelope<T>;
    try {
      data = await resp.json() as CfEnvelope<T>;
    } catch {
      if (resp.ok) {
        // Some endpoints (e.g. worker script content) return non-JSON success bodies; callers handle
        // those with dedicated methods rather than this helper.
        throw new CloudflareApiError(resp.status, "Unexpected non-JSON response from Cloudflare API.");
      }
      const message = await safeStatusText(resp);
      throw new CloudflareApiError(resp.status, message);
    }

    if (!resp.ok || !data.success) {
      const messages = data.errors ?? data.messages ?? [];
      const detail = messages.map(m => m.message ?? String(m.code ?? "")).filter(Boolean).join("; ");
      const statusText = resp.status ? ` (${resp.status})` : "";
      throw new CloudflareApiError(resp.status, detail || `Cloudflare API error${statusText}`);
    }

    return data.result as T;
  }

  #get<T>(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<T> {
    return this.#request<T>("GET", path, { query });
  }
  #post<T>(path: string, json?: unknown): Promise<T> {
    return this.#request<T>("POST", path, json === undefined ? undefined : { json });
  }
  #put<T>(path: string, opts?: { json?: unknown; body?: string; contentType?: string }): Promise<T> {
    return this.#request<T>("PUT", path, opts);
  }
  #patch<T>(path: string, json: unknown): Promise<T> {
    return this.#request<T>("PATCH", path, { json });
  }
  #delete<T>(path: string): Promise<T> {
    return this.#request<T>("DELETE", path);
  }

  async #requestEnvelope<T>(path: string, page: number, extra?: Record<string, string | number | boolean | undefined>): Promise<CfList<T>> {
    const token = await this.#getToken();
    const url = new URL(API_BASE + path);
    url.searchParams.set("page", String(page));
    url.searchParams.set("per_page", "50");
    if (extra) for (const [k, v] of Object.entries(extra)) if (v !== undefined) url.searchParams.set(k, String(v));
    const resp = await fetch(url.toString(), { headers: { "Authorization": `Bearer ${token}`, "Accept": "application/json" } });
    if (resp.status === 401 || resp.status === 403) {
      throw new CloudflareApiError(resp.status, await safeStatusText(resp), true);
    }
    const data = await resp.json() as CfEnvelope<T[]>;
    if (!resp.ok || !data.success) {
      const detail = (data.errors ?? []).map(e => e.message ?? "").filter(Boolean).join("; ");
      throw new CloudflareApiError(resp.status, detail || `Cloudflare API error (${resp.status})`);
    }
    return { result: data.result ?? [], resultInfo: data.result_info ?? null };
  }

  // -------------------------------------------------------------------------
  // Identity / accounts

  async getUser(): Promise<{ id: string; email: string; displayName: string } | null> {
    const r = await this.#get<{ id?: string; email?: string; first_name?: string; last_name?: string }>("/user");
    if (!r || !r.id || !r.email) return null;
    const name = [r.first_name, r.last_name].filter(Boolean).join(" ").trim();
    return { id: String(r.id), email: r.email, displayName: name || r.email.split("@")[0] };
  }

  async listAccounts(): Promise<Array<{ id: string; name: string }>> {
    const r = await this.#get<Array<{ id: string; name: string }>>("/accounts");
    return (r ?? []).map(a => ({ id: a.id, name: a.name }));
  }

  async getAccount(accountId: string): Promise<{ id: string; name: string }> {
    return await this.#get<{ id: string; name: string }>(`/accounts/${accountId}`);
  }

  // -------------------------------------------------------------------------
  // Zones + DNS

  async listZones(accountId: string, page: number): Promise<CfList<ZoneRecord>> {
    return await this.#requestEnvelope<ZoneRecord>("/zones", page, { "account.id": accountId });
  }

  async getZone(zoneId: string): Promise<ZoneRecord> {
    return await this.#get<ZoneRecord>(`/zones/${zoneId}`);
  }

  async listDnsRecords(zoneId: string, page: number): Promise<CfList<DnsRecord>> {
    return await this.#requestEnvelope<DnsRecord>(`/zones/${zoneId}/dns_records`, page);
  }

  async getDnsRecord(zoneId: string, recordId: string): Promise<DnsRecord> {
    return await this.#get<DnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`);
  }

  async createDnsRecord(zoneId: string, record: DnsRecordInput): Promise<DnsRecord> {
    return await this.#post<DnsRecord>(`/zones/${zoneId}/dns_records`, record);
  }

  async updateDnsRecord(zoneId: string, recordId: string, record: Partial<DnsRecordInput>): Promise<DnsRecord> {
    return await this.#patch<DnsRecord>(`/zones/${zoneId}/dns_records/${recordId}`, record);
  }

  async deleteDnsRecord(zoneId: string, recordId: string): Promise<{ id: string }> {
    return await this.#delete<{ id: string }>(`/zones/${zoneId}/dns_records/${recordId}`);
  }

  // -------------------------------------------------------------------------
  // D1

  async listD1Databases(accountId: string): Promise<Array<D1DatabaseRecord>> {
    return await this.#get<Array<D1DatabaseRecord>>(`/accounts/${accountId}/d1/database`);
  }

  async getD1Database(accountId: string, databaseId: string): Promise<D1DatabaseRecord> {
    return await this.#get<D1DatabaseRecord>(`/accounts/${accountId}/d1/database/${databaseId}`);
  }

  async createD1Database(accountId: string, name: string): Promise<D1DatabaseRecord> {
    return await this.#post<D1DatabaseRecord>(`/accounts/${accountId}/d1/database`, { name });
  }

  async deleteD1Database(accountId: string, databaseId: string): Promise<unknown> {
    return await this.#delete(`/accounts/${accountId}/d1/database/${databaseId}`);
  }

  async queryD1(accountId: string, databaseId: string, sql: string, params?: unknown[]): Promise<D1QueryResult> {
    return await this.#post<D1QueryResult>(`/accounts/${accountId}/d1/database/${databaseId}/query`, { sql, params });
  }

  // -------------------------------------------------------------------------
  // R2 (bucket management via the REST API; object operations are S3-only and
  // out of scope for an OAuth-token-backed gatekeeper).

  async listR2Buckets(accountId: string): Promise<Array<R2BucketRecord>> {
    const r = await this.#get<Array<R2BucketRecord>>(`/accounts/${accountId}/r2/buckets`);
    return r ?? [];
  }

  async createR2Bucket(accountId: string, name: string): Promise<unknown> {
    return await this.#post(`/accounts/${accountId}/r2/buckets`, { name });
  }

  async deleteR2Bucket(accountId: string, bucketName: string): Promise<unknown> {
    return await this.#delete(`/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucketName)}`);
  }

  // -------------------------------------------------------------------------
  // Workers

  async listWorkers(accountId: string): Promise<Array<WorkerScriptRecord>> {
    return await this.#get<Array<WorkerScriptRecord>>(`/accounts/${accountId}/workers/scripts`);
  }

  async getWorker(accountId: string, scriptName: string): Promise<WorkerScriptRecord> {
    return await this.#get<WorkerScriptRecord>(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`);
  }

  // Upload a single-module Worker (no bindings). Uses the multipart "metadata + script" format so
  // the script is registered as an ES module.
  async uploadWorkerScript(accountId: string, scriptName: string, content: string): Promise<unknown> {
    const boundary = "----gk" + crypto.randomUUID().replace(/-/g, "");
    const metadata = { main_module: "worker.js", bindings: [] };
    const parts = [
      `--${boundary}`,
      `Content-Disposition: form-data; name="metadata"`,
      "Content-Type: application/json",
      "",
      JSON.stringify(metadata),
      `--${boundary}`,
      `Content-Disposition: form-data; name="worker.js"; filename="worker.js"`,
      "Content-Type: application/javascript+module",
      "",
      content,
      `--${boundary}--`,
      "",
    ];
    return await this.#request("PUT", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`, {
      body: parts.join("\r\n"),
      contentType: `multipart/form-data; boundary=${boundary}`,
    });
  }

  // Returns the deployed script's source. The content endpoint returns the script body as text.
  async getWorkerScriptContent(accountId: string, scriptName: string): Promise<string> {
    const token = await this.#getToken();
    const url = `${API_BASE}/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}/content/v2`;
    const resp = await fetch(url, { headers: { "Authorization": `Bearer ${token}`, "Accept": "text/plain" } });
    if (resp.status === 401 || resp.status === 403) {
      throw new CloudflareApiError(resp.status, await safeStatusText(resp), true);
    }
    if (!resp.ok) {
      throw new CloudflareApiError(resp.status, await safeStatusText(resp));
    }
    return await resp.text();
  }

  async deleteWorkerScript(accountId: string, scriptName: string): Promise<unknown> {
    return await this.#delete(`/accounts/${accountId}/workers/scripts/${encodeURIComponent(scriptName)}`);
  }

  // -------------------------------------------------------------------------
  // Pages

  async listPagesProjects(accountId: string): Promise<Array<PagesProjectRecord>> {
    return await this.#get<Array<PagesProjectRecord>>(`/accounts/${accountId}/pages/projects`);
  }

  async getPagesProject(accountId: string, projectName: string): Promise<PagesProjectRecord> {
    return await this.#get<PagesProjectRecord>(`/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`);
  }

  async createPagesProject(accountId: string, name: string, productionBranch?: string): Promise<PagesProjectRecord> {
    return await this.#post<PagesProjectRecord>(`/accounts/${accountId}/pages/projects`, {
      name,
      production_branch: productionBranch ?? "main",
    });
  }

  async deletePagesProject(accountId: string, projectName: string): Promise<unknown> {
    return await this.#delete(`/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}`);
  }

  async listPagesDeployments(accountId: string, projectName: string, page: number): Promise<CfList<PagesDeploymentRecord>> {
    return await this.#requestEnvelope<PagesDeploymentRecord>(`/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments`, page);
  }

  async getPagesDeployment(accountId: string, projectName: string, deploymentId: string): Promise<PagesDeploymentRecord> {
    return await this.#get<PagesDeploymentRecord>(`/accounts/${accountId}/pages/projects/${encodeURIComponent(projectName)}/deployments/${deploymentId}`);
  }

  // -------------------------------------------------------------------------
  // Workers AI

  async listAiModels(accountId: string): Promise<Array<AiModelRecord>> {
    return await this.#get<Array<AiModelRecord>>(`/accounts/${accountId}/ai/models/search`);
  }

  async runAi(accountId: string, model: string, inputs: unknown): Promise<AiRunResult> {
    return await this.#post<AiRunResult>(`/accounts/${accountId}/ai/run/${encodeURIComponent(model)}`, inputs);
  }

  // -------------------------------------------------------------------------
  // Vectorize

  async listVectorIndexes(accountId: string): Promise<Array<VectorIndexRecord>> {
    return await this.#get<Array<VectorIndexRecord>>(`/accounts/${accountId}/vectorize/v2/indexes`);
  }

  async getVectorIndex(accountId: string, indexName: string): Promise<VectorIndexRecord> {
    return await this.#get<VectorIndexRecord>(`/accounts/${accountId}/vectorize/v2/indexes/${encodeURIComponent(indexName)}`);
  }

  async createVectorIndex(accountId: string, name: string, dimensions: number, metric?: string): Promise<VectorIndexRecord> {
    return await this.#post<VectorIndexRecord>(`/accounts/${accountId}/vectorize/v2/indexes`, {
      name,
      dimensions,
      metric: metric ?? "cosine",
    });
  }

  async deleteVectorIndex(accountId: string, indexName: string): Promise<unknown> {
    return await this.#delete(`/accounts/${accountId}/vectorize/v2/indexes/${encodeURIComponent(indexName)}`);
  }

  async queryVectorIndex(accountId: string, indexName: string, vector: number[], topK: number, returnValues?: boolean): Promise<VectorQueryResult> {
    return await this.#post<VectorQueryResult>(`/accounts/${accountId}/vectorize/v2/indexes/${encodeURIComponent(indexName)}/query`, {
      vector, topK, returnValues: returnValues ?? false,
    });
  }

  async getVectorByIds(accountId: string, indexName: string, ids: string[]): Promise<VectorRecord[]> {
    return await this.#post<VectorRecord[]>(`/accounts/${accountId}/vectorize/v2/indexes/${encodeURIComponent(indexName)}/get-by-ids`, { ids });
  }

  async upsertVectors(accountId: string, indexName: string, vectors: VectorRecord[]): Promise<unknown> {
    return await this.#post(`/accounts/${accountId}/vectorize/v2/indexes/${encodeURIComponent(indexName)}/upsert`, { vectors });
  }

  async deleteVectorByIds(accountId: string, indexName: string, ids: string[]): Promise<unknown> {
    return await this.#post(`/accounts/${accountId}/vectorize/v2/indexes/${encodeURIComponent(indexName)}/delete-by-ids`, { ids });
  }

  // -------------------------------------------------------------------------
  // Cloudflare Tunnel

  async listTunnels(accountId: string): Promise<Array<TunnelRecord>> {
    return await this.#get<Array<TunnelRecord>>(`/accounts/${accountId}/cfd_tunnel`);
  }

  async getTunnel(accountId: string, tunnelId: string): Promise<TunnelRecord> {
    return await this.#get<TunnelRecord>(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
  }

  async createTunnel(accountId: string, name: string, secret: string): Promise<TunnelRecord> {
    return await this.#post<TunnelRecord>(`/accounts/${accountId}/cfd_tunnel`, { name, tunnel_secret: secret });
  }

  async deleteTunnel(accountId: string, tunnelId: string): Promise<unknown> {
    return await this.#delete(`/accounts/${accountId}/cfd_tunnel/${tunnelId}`);
  }

  async listTunnelConnections(accountId: string, tunnelId: string): Promise<Array<TunnelConnectionRecord>> {
    return await this.#get<Array<TunnelConnectionRecord>>(`/accounts/${accountId}/cfd_tunnel/${tunnelId}/connections`);
  }

  // -------------------------------------------------------------------------
  // Email Routing

  async getEmailRoutingSettings(zoneId: string): Promise<EmailRoutingSettings> {
    return await this.#get<EmailRoutingSettings>(`/zones/${zoneId}/email/routing`);
  }

  async listEmailRoutingRules(zoneId: string): Promise<Array<EmailRoutingRule>> {
    return await this.#get<Array<EmailRoutingRule>>(`/zones/${zoneId}/email/routing/rules`);
  }

  async createEmailRoutingRule(zoneId: string, rule: EmailRoutingRuleInput): Promise<EmailRoutingRule> {
    return await this.#post<EmailRoutingRule>(`/zones/${zoneId}/email/routing/rules`, rule);
  }

  async deleteEmailRoutingRule(zoneId: string, ruleId: string): Promise<unknown> {
    return await this.#delete(`/zones/${zoneId}/email/routing/rules/${ruleId}`);
  }

  async listEmailRoutingAddresses(accountId: string): Promise<Array<EmailRoutingAddress>> {
    return await this.#get<Array<EmailRoutingAddress>>(`/accounts/${accountId}/email/routing/addresses`);
  }

  async setEmailRoutingAddressEnabled(accountId: string, addressId: string, enabled: boolean): Promise<unknown> {
    const action = enabled ? "enable" : "disable";
    return await this.#post(`/accounts/${accountId}/email/routing/addresses/${addressId}/${action}`);
  }
}

async function safeStatusText(resp: Response): Promise<string> {
  try {
    const text = await resp.text();
    return text ? text.slice(0, 500) : `HTTP ${resp.status}`;
  } catch {
    return `HTTP ${resp.status}`;
  }
}

// ---------------------------------------------------------------------------
// Raw shapes returned by the Cloudflare API.

export interface ZoneRecord {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  type: string;
  development_mode?: number;
  name_servers?: string[];
  original_name_servers?: string[] | null;
  created_on?: string;
  modified_on?: string;
  plan?: { name?: string };
}

export interface DnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  proxiable?: boolean;
  locked?: boolean;
  created_on?: string;
  modified_on?: string;
  priority?: number;
  data?: Record<string, unknown>;
}

export type DnsRecordInput = {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
  data?: Record<string, unknown>;
};

export interface D1DatabaseRecord {
  uuid: string;
  name: string;
  version?: string;
  created_at?: string;
  updated_at?: string;
  num_tables?: number;
}

export interface D1QueryResult {
  success: boolean;
  results?: Array<Record<string, unknown>>;
  meta?: unknown;
  errors?: Array<{ code: number; message: string }>;
}

export interface R2BucketRecord {
  name: string;
  creation_date?: string;
}

export interface WorkerScriptRecord {
  id: string;
  etag: string;
  modified_on?: string;
  created_on?: string;
  usage_model?: string;
}

export interface PagesProjectRecord {
  name: string;
  subdomain?: string;
  domains?: string[];
  source?: Record<string, unknown>;
  production_branch?: string;
  created_on?: string;
}

export interface PagesDeploymentRecord {
  id: string;
  project_name?: string;
  environment?: string;
  url?: string;
  short_id?: string;
  created_on?: string;
  modified_on?: string;
  latest_stage?: { name?: string; status?: string };
  deployment_trigger?: { type?: string; metadata?: Record<string, unknown> };
}

export interface AiModelRecord {
  name: string;
  task?: { name?: string };
  source?: string;
}

export type AiRunResult = {
  success: boolean;
  result?: unknown;
  errors?: unknown[];
};

export interface VectorIndexRecord {
  name: string;
  dimensions?: number;
  metric?: string;
  description?: string;
  created_on?: string;
  modified_on?: string;
}

export interface VectorRecord {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface VectorQueryResult {
  count?: number;
  matches?: Array<{ id: string; score: number; values?: number[]; metadata?: Record<string, unknown> }>;
}

export interface TunnelRecord {
  id: string;
  name: string;
  created_at?: string;
  deleted_at?: string | null;
  connections?: Array<TunnelConnectionRecord>;
}

export interface TunnelConnectionRecord {
  id: string;
  client_id?: string;
  client_version?: string;
  conns?: Array<Record<string, unknown>>;
  opened_at?: string;
  is_pending_reconnect?: boolean;
}

export interface EmailRoutingSettings {
  enabled?: boolean;
  status?: string;
  name?: string;
  skip_wizard?: boolean;
}

export type EmailRoutingRuleMatcher = {
  type: "literal" | "all";
  field: "to";
  value?: string;
};

export type EmailRoutingRuleAction = {
  type: "forward" | "drop" | "worker";
  value?: string[];
};

export interface EmailRoutingRule {
  tag?: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  matchers?: EmailRoutingRuleMatcher[];
  actions?: EmailRoutingRuleAction[];
}

export type EmailRoutingRuleInput = {
  name?: string;
  enabled?: boolean;
  priority?: number;
  matchers: EmailRoutingRuleMatcher[];
  actions: EmailRoutingRuleAction[];
};

export interface EmailRoutingAddress {
  id: string;
  email?: string;
  verified?: boolean;
  enabled?: boolean;
}
