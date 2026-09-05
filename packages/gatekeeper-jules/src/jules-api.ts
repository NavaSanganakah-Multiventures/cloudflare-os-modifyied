// Typed REST client for the Google Jules API (v1alpha).
//
// Endpoint:  https://jules.googleapis.com/v1alpha
// Auth:      X-Goog-Api-Key header (the API key created at https://jules.google.com).
//
// The client returns the camelCase shapes declared in ./types. Google's discovery document
// describes the REST wire format in camelCase, but we defensively normalize snake_case keys too
// (toCamelKeys is idempotent on already-camelCase input), so either wire convention works.

import type {
  JulesActivity,
  JulesCreateSessionInput,
  JulesSessionInfo,
  JulesSource,
  JulesSourceContext,
} from "./types";

/** Credentials for the Jules API. The API key is all-or-nothing for the connected account. */
export type JulesCredentials = {
  apiKey: string;
};

export class JulesError extends Error {
  readonly status?: number;
  /** When true, this error indicates the API key is invalid or revoked. */
  readonly isAuthError: boolean;

  constructor(message: string, opts: { status?: number; isAuthError?: boolean } = {}) {
    super(message);
    this.status = opts.status;
    this.isAuthError = opts.isAuthError ?? false;
  }
}

const JULES_BASE_URL = "https://jules.googleapis.com/";
const JULES_TIMEOUT_MS = 30_000;
const JULES_ERROR_BODY_MAX_BYTES = 400;

/** Converts a snake_case key to camelCase. Already-camelCase keys are unchanged. */
function toCamelKey(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_match, c: string) => c.toUpperCase());
}

/** Recursively converts snake_case object keys to camelCase (idempotent). */
function toCamelKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toCamelKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[toCamelKey(k)] = toCamelKeys(v);
    }
    return out;
  }
  return value;
}

/** Percent-encodes each path segment of a resource name (e.g. "sessions/a b"). */
function encodeName(name: string): string {
  return name.split("/").map((segment) => encodeURIComponent(segment)).join("/");
}

function sanitizeErrorBody(text: string, apiKey: string): string {
  let clean = text.slice(0, JULES_ERROR_BODY_MAX_BYTES).replace(/\s+/g, " ").trim();
  if (apiKey) clean = clean.split(apiKey).join("[redacted-api-key]");
  return clean;
}

/** Maps the exposed camelCase SourceContext to the wire shape the Jules REST API expects. */
function toWireSourceContext(ctx: JulesSourceContext): Record<string, unknown> {
  const out: Record<string, unknown> = { source: ctx.source };
  if (ctx.githubRepoContext) {
    out.githubRepoContext = { startingBranch: ctx.githubRepoContext.startingBranch };
  }
  if (ctx.workingBranch != null) out.workingBranch = ctx.workingBranch;
  if (ctx.environmentVariablesEnabled != null) {
    out.environmentVariablesEnabled = ctx.environmentVariablesEnabled;
  }
  return out;
}

export class JulesRest {
  constructor(private readonly creds: JulesCredentials) {}

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    const url = JULES_BASE_URL + path;
    const headers = new Headers(init.headers ?? {});
    headers.set("X-Goog-Api-Key", this.creds.apiKey);
    if (init.body != null && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), JULES_TIMEOUT_MS);
    const signal = init.signal;
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener("abort", () => controller.abort(signal.reason));
    }

    let response: Response;
    try {
      response = await fetch(url, { ...init, headers, signal: controller.signal });
    } catch (e: any) {
      if (controller.signal.aborted && e?.name === "AbortError") {
        throw new JulesError("Google Jules did not respond within " + JULES_TIMEOUT_MS + "ms.");
      }
      throw new JulesError("Failed to reach Google Jules: " + (e?.message ?? e));
    } finally {
      clearTimeout(timeoutHandle);
    }

    if (response.status === 401 || response.status === 403) {
      throw new JulesError(
        "Google Jules rejected the API key. It may be invalid or revoked.",
        { status: response.status, isAuthError: true },
      );
    }

    if (!response.ok) {
      const rawText = await response.text().catch(() => "");
      const safeText = sanitizeErrorBody(rawText, this.creds.apiKey);
      throw new JulesError(
        "Google Jules returned HTTP " + response.status + ": " + (safeText || response.statusText),
        { status: response.status },
      );
    }

    if (response.status === 204) return undefined;

    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      return toCamelKeys(await response.json());
    }
    return toCamelKeys(await response.text());
  }

  private get(path: string): Promise<unknown> {
    return this.request(path, { method: "GET" });
  }

  private post(path: string, body?: unknown): Promise<unknown> {
    return this.request(path, {
      method: "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private del(path: string): Promise<unknown> {
    return this.request(path, { method: "DELETE" });
  }

  /** Quick reachability/auth check used by the connect flow. */
  async ping(): Promise<void> {
    await this.get("v1alpha/sources?pageSize=1");
  }

  async listSources(options?: { pageSize?: number; filter?: string }): Promise<JulesSource[]> {
    const params = new URLSearchParams();
    if (options?.pageSize != null) params.set("pageSize", String(options.pageSize));
    if (options?.filter) params.set("filter", options.filter);
    const qs = params.toString();
    const data = await this.get("v1alpha/sources" + (qs ? "?" + qs : ""));
    return ((data as any)?.sources ?? []) as JulesSource[];
  }

  async getSource(name: string): Promise<JulesSource> {
    return (await this.get("v1alpha/" + encodeName(name))) as JulesSource;
  }

  async listSessions(options?: { pageSize?: number; filter?: string }): Promise<JulesSessionInfo[]> {
    const params = new URLSearchParams();
    if (options?.pageSize != null) params.set("pageSize", String(options.pageSize));
    if (options?.filter) params.set("filter", options.filter);
    const qs = params.toString();
    const data = await this.get("v1alpha/sessions" + (qs ? "?" + qs : ""));
    return ((data as any)?.sessions ?? []) as JulesSessionInfo[];
  }

  async createSession(input: JulesCreateSessionInput): Promise<JulesSessionInfo> {
    const body: Record<string, unknown> = { prompt: input.prompt };
    if (input.title != null) body.title = input.title;
    if (input.automationMode != null) body.automationMode = input.automationMode;
    if (input.requirePlanApproval != null) body.requirePlanApproval = input.requirePlanApproval;
    if (input.sourceContext) body.sourceContext = toWireSourceContext(input.sourceContext);
    return (await this.post("v1alpha/sessions", body)) as JulesSessionInfo;
  }

  async getSession(name: string): Promise<JulesSessionInfo> {
    return (await this.get("v1alpha/" + encodeName(name))) as JulesSessionInfo;
  }

  async sendMessage(session: string, prompt: string): Promise<void> {
    await this.post("v1alpha/" + encodeName(session) + ":sendMessage", { prompt });
  }

  async approvePlan(session: string): Promise<void> {
    await this.post("v1alpha/" + encodeName(session) + ":approvePlan", {});
  }

  async archiveSession(session: string): Promise<void> {
    await this.post("v1alpha/" + encodeName(session) + ":archive", {});
  }

  async unarchiveSession(session: string): Promise<void> {
    await this.post("v1alpha/" + encodeName(session) + ":unarchive", {});
  }

  async deleteSession(session: string): Promise<void> {
    await this.del("v1alpha/" + encodeName(session));
  }

  async listActivities(
    session: string,
    options?: { pageSize?: number; filter?: string },
  ): Promise<JulesActivity[]> {
    const params = new URLSearchParams();
    if (options?.pageSize != null) params.set("pageSize", String(options.pageSize));
    if (options?.filter) params.set("filter", options.filter);
    const qs = params.toString();
    const data = await this.get("v1alpha/" + encodeName(session) + "/activities" + (qs ? "?" + qs : ""));
    return ((data as any)?.activities ?? []) as JulesActivity[];
  }

  async getActivity(name: string): Promise<JulesActivity> {
    return (await this.get("v1alpha/" + encodeName(name))) as JulesActivity;
  }
}
