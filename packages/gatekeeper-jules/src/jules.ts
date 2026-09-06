// Google Jules gatekeeper.
//
// A first-class Cloudflare OS gatekeeper for Google Jules (Google's async coding agent).
// It follows the gatekeeper contract in packages/workshop-shared/src/gatekeeper.ts.
//
// Connect flow: an API key created at https://jules.google.com (Settings -> API) is entered
// into a small HTML form and stored in the UserAccount Durable Object. There is no OAuth.
//
// Reads are authorized as observations; writes are queued for approval via the ApprovalQueue
// and applied/reverted through the JulesGatekeeperImpl DO callbacks.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  type AccountDescription,
  type ActionDescription,
  type ActionKind,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceConfiguratorFrame,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import ACCOUNT_CONFIGURATOR_HTML from "./generated/account-configurator-ui.txt";
import type { JulesAccountConfiguratorRpc } from "./configurator/account-configurator-types";
import REPO_CONFIGURATOR_HTML from "./generated/repo-configurator-ui.txt";
import type { JulesConfiguratorOption, JulesRepoConfiguratorRpc } from "./configurator/repo-configurator-types";
import { JulesError, JulesRest, type JulesCredentials } from "./jules-api";
import type {
  JulesActivity,
  JulesCreateSessionInput,
  JulesListActivitiesOptions,
  JulesListSessionsOptions,
  JulesListSourcesOptions,
  JulesSession as JulesSessionIface,
  JulesSessionInfo,
  JulesSource,
} from "./types";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env & { BASE_URL?: string };

// --- Nonce / URL helpers ---

const NONCE_BYTES = 32;
const NONCE_LIFETIME_MS = 10 * 60 * 1000;
const CONNECT_ALARM_MS = 60 * 60 * 1000;

function generateNonce(): string {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  // Fold the length comparison into the accumulator instead of returning early, so the
  // timing of nonce validation does not reveal whether a candidate had the right length.
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/jules");
}

function getBasePath(env: Env): string {
  try {
    return new URL(getBaseUrl(env)).pathname;
  } catch {
    return "/gatekeeper/jules";
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(text: string): string {
  return escapeHtml(text);
}

// --- Branding / resources ---

const JULES_URL = "https://jules.google.com";

const JULES_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" rx="112" fill="#1a73e8"/>' +
  '<text x="256" y="352" font-family="Arial, Helvetica, sans-serif" font-size="300" font-weight="700" fill="#ffffff" text-anchor="middle">J</text>' +
  '</svg>';

const JULES_ICON: AvatarImage = {
  url: "data:image/svg+xml;utf8," + encodeURIComponent(JULES_LOGO_SVG),
};

// Whole-account resource. We deliberately use `https://*` as a catch-all pattern (the same
// technique gatekeeper-homeassistant and gatekeeper-notion use) so the resource picker treats it
// as the "any URL / whole account" option and still offers the finer-grained repository resource.
const JULES_INSTANCE_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Google Jules",
  description: "Access to your whole Google Jules account: every source, coding session, plan, activity, and pull request.",
  icon: JULES_ICON,
};

// A single GitHub repository connected to Jules (a Jules "source"). Its URL uses a
// jules.google.com marker so it routes separately from the whole-instance catch-all above.
const JULES_REPO_RESOURCE: SupportedResource = {
  urlPattern: "https://jules.google.com/sources/:source",
  title: "Google Jules Repository",
  description: "Access to a single GitHub repository connected to Jules: its sessions, plans, activities, and pull requests.",
  icon: JULES_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [JULES_INSTANCE_RESOURCE, JULES_REPO_RESOURCE];

// --- Connect form ---

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }): string => {
  const errorHtml = params.error
    ? '<div class="error">' + escapeHtml(params.error) + '</div>'
    : "";
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title>Connect Google Jules</title>",
    "<style>",
    "body{font-family:system-ui,-apple-system,sans-serif;background:#f1f5f9;margin:0;padding:2rem;display:flex;justify-content:center;align-items:center;min-height:100vh;box-sizing:border-box;}",
    ".card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:2rem;max-width:420px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.06);}",
    "h1{font-size:1.35rem;margin:0 0 .5rem;}",
    "p{color:#475569;line-height:1.5;margin:0 0 1rem;}",
    "label{display:block;font-weight:600;margin-bottom:.35rem;}",
    "input{width:100%;box-sizing:border-box;padding:.6rem .75rem;border:1px solid #cbd5e1;border-radius:8px;font:inherit;}",
    ".hint{color:#64748b;font-size:.85rem;margin:.5rem 0 1rem;}",
    ".hint a{color:#1a73e8;}",
    "button{background:#1a73e8;color:#fff;border:0;border-radius:8px;padding:.65rem 1rem;font:inherit;font-weight:600;cursor:pointer;}",
    "button:hover{background:#1765cc;}",
    ".error{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:.65rem .75rem;margin-bottom:1rem;}",
    "</style>",
    "</head>",
    "<body>",
    '<div class="card">',
    "<h1>Connect Google Jules</h1>",
    "<p>Paste a Google Jules API key. It is stored in the gatekeeper and used only for this account.</p>",
    errorHtml,
    '<form method="POST" action="' + escapeAttr(params.actionUrl) + '">',
    '<label for="apiKey">Jules API key</label>',
    '<input id="apiKey" name="apiKey" type="password" required placeholder="AIza..." autofocus>',
    '<div class="hint">Create one at <a href="https://jules.google.com">jules.google.com</a> under Settings &rarr; API.</div>',
    '<button type="submit">Connect</button>',
    "</form>",
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
};

const SELF_CLOSING_HTML = "<!DOCTYPE html><html><body><script>window.close()</script><p>Google Jules is connected. You may close this window.</p></body></html>";
const INVALID_LINK_HTML = "<!DOCTYPE html><html><body><h1>Invalid link</h1><p>This connection link is invalid or expired.</p></body></html>";

// --- Fetch handler for the connect flow ---

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext & { exports: any }) {
    const url = new URL(req.url);
    const basePath = getBasePath(env);
    if (url.pathname !== basePath && !url.pathname.startsWith(basePath + "/")) {
      return new Response("Not found", { status: 404 });
    }
    const relPath = url.pathname.slice(basePath.length);
    const path = relPath.slice(1).split("/");
    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      const doId = path[0];
      const nonce = path[1];
      const stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));

      if (req.method === "GET") {
        const valid = await stub.verifyNonceWithoutConsuming(nonce);
        if (!valid) {
          return new Response(INVALID_LINK_HTML, { status: 400, headers: { "Content-Type": "text/html" } });
        }
        return new Response(CONNECT_FORM_HTML({ actionUrl: req.url }), { headers: { "Content-Type": "text/html" } });
      }

      if (req.method === "POST") {
        const form = await req.formData();
        const apiKey = String(form.get("apiKey") ?? "").trim();
        if (!apiKey) {
          return new Response(CONNECT_FORM_HTML({ actionUrl: req.url, error: "An API key is required." }), { headers: { "Content-Type": "text/html" } });
        }
        const result = await stub.completeConnection(nonce, apiKey);
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, { status: 400, headers: { "Content-Type": "text/html" } });
        }
        if (result.kind === "error") {
          return new Response(CONNECT_FORM_HTML({ actionUrl: req.url, error: result.message }), { headers: { "Content-Type": "text/html" } });
        }
        return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html" } });
      }
    }
    return new Response("Not found", { status: 404 });
  },
};

// --- Vendor entrypoint ---

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Google Jules",
      url: JULES_URL,
      logo: JULES_ICON,
      tagline: "Run asynchronous coding agents on your repositories.",
      description: "Connect Google Jules to let gadgets create coding sessions, approve plans, and read back pull requests and change sets.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    _options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    const userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(userObjectId).setCallback(callback, nonce);
    return { url: getBaseUrl(this.env) + "/" + userObjectId.toString() + "/" + nonce };
  }

  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// --- UserAccount Durable Object (stores the API key + connect callback) ---

interface StoredNonce {
  value: string;
  expiresAt: number;
}

type CompleteConnectionResult =
  | { kind: "ok" }
  | { kind: "invalid_nonce" }
  | { kind: "error"; message: string };

export class UserAccount extends DurableObject<Env> {
  async setCallback(callback: Fetcher<GatekeeperConnectCallback>, nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<JulesCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_ALARM_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<JulesCredentials>("credentials")) {
      throw new Error("This Google Jules account is not connected.");
    }
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
    await this.ctx.storage.setAlarm(Date.now() + CONNECT_ALARM_MS);
  }

  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    return !!stored && Date.now() < stored.expiresAt && constantTimeEqual(stored.value, nonce);
  }

  async completeConnection(nonce: string, apiKey: string): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return { kind: "invalid_nonce" };
    }

    try {
      await new JulesRest({ apiKey }).ping();
    } catch (e: any) {
      return {
        kind: "error",
        message: e instanceof JulesError ? e.message : ("Unable to reach Google Jules: " + (e?.message ?? e)),
      };
    }

    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.delete("expired");
    this.ctx.storage.kv.put<JulesCredentials>("credentials", { apiKey });

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      this.ctx.storage.kv.delete("credentials");
      return { kind: "error", message: "Connection callback expired. Please start over." };
    }

    try {
      const user = this.ctx.exports.JulesUserImpl({ props: { userObjectId: this.ctx.id.toString() } });
      if (this.ctx.storage.kv.get<boolean>("reconnecting")) {
        this.ctx.storage.kv.delete("reconnecting");
        await callback.credentialsRestored();
      } else {
        await callback.complete(user);
      }
    } catch (e: any) {
      this.ctx.storage.kv.delete("credentials");
      return { kind: "error", message: "Failed to complete the connection: " + (e?.message ?? e) };
    }

    await this.ctx.storage.deleteAlarm();
    return { kind: "ok" };
  }

  getCredentials(): JulesCredentials {
    return this.ctx.storage.kv.get<JulesCredentials>("credentials")!;
  }

  async noteCredentialsExpired(): Promise<void> {
    // Keep the credential record so prepareReconnect() still recognizes this account; the
    // stale API key keeps failing auth until the user replaces it through the reconnect flow.
    if (this.ctx.storage.kv.get<boolean>("expired")) return;
    this.ctx.storage.kv.put("expired", true);
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (callback) await callback.credentialsExpired();
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) return;
    await callback.credentialsExpired();
    await this.ctx.storage.deleteAlarm();
  }

  async revoke(): Promise<void> {
    this.ctx.storage.kv.delete("credentials");
    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.delete("callback");
    this.ctx.storage.kv.delete("reconnecting");
    this.ctx.storage.kv.delete("expired");
    await this.ctx.storage.deleteAlarm();
  }
}

// --- Per-user account entrypoint ---

type JulesUserImplProps = { userObjectId: string };

@validateRpc()
export class JulesUserImpl extends WorkerEntrypoint<Env, JulesUserImplProps> implements GatekeeperUser {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #getApiKey(): Promise<string> {
    return (await this.#userAccount().getCredentials()).apiKey;
  }

  async describe(): Promise<AccountDescription> {
    let uniqueName = "Google Jules account";
    try {
      const apiKey = await this.#getApiKey();
      const sources = await new JulesRest({ apiKey }).listSources({ pageSize: 100 });
      if (sources.length > 0 && sources[0].githubRepo) {
        const g = sources[0].githubRepo;
        const repo = g.owner && g.repo ? g.owner + "/" + g.repo : undefined;
        if (repo) {
          uniqueName = sources.length > 1
            ? "Google Jules (" + repo + " + " + (sources.length - 1) + " more)"
            : "Google Jules (" + repo + ")";
        }
      }
    } catch (e) {
      if (e instanceof JulesError && e.isAuthError) await this.#userAccount().noteCredentialsExpired();
    }
    return { displayName: "Google Jules", uniqueName, avatar: JULES_ICON };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // The API key is project-level; it does not prove a sign-in email.
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === JULES_INSTANCE_RESOURCE.urlPattern) {
      return { iframeHtml: ACCOUNT_CONFIGURATOR_HTML, ui: new RpcStub(new AccountConfiguratorUI()) };
    }
    if (resourceUrlPattern === JULES_REPO_RESOURCE.urlPattern) {
      const credsGetter = async () => await this.#userAccount().getCredentials();
      return { iframeHtml: REPO_CONFIGURATOR_HTML, ui: new RpcStub(new JulesRepoConfiguratorUI(credsGetter)) };
    }
    throw new Error("Unsupported resource configurator type: " + resourceUrlPattern);
  }

  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<any>>; resource: SupportedResource }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e: any) {
      throw new Error("Invalid Google Jules URL \"" + url + "\": " + (e?.message ?? e), { cause: e });
    }
    const userObjectId = this.ctx.props.userObjectId;

    if (parsed.hostname === "jules.google.com") {
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments[0] === "sources" && segments.length >= 2) {
        const sourceName = "sources/" + decodeURIComponent(segments[1]);
        return {
          class: this.ctx.exports.JulesGatekeeperImpl({ props: { userObjectId, resourceKind: "source", sourceName } }),
          resource: JULES_REPO_RESOURCE,
        };
      }
    }

    // Any other URL (or a jules.google.com URL without a source path) is whole-account access.
    return {
      class: this.ctx.exports.JulesGatekeeperImpl({ props: { userObjectId, resourceKind: "instance" } }),
      resource: JULES_INSTANCE_RESOURCE,
    };
  }

  async revoke(): Promise<void> {
    await this.#userAccount().revoke();
  }

  async reconnect(): Promise<{ url: string }> {
    const id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    const nonce = generateNonce();
    await this.ctx.exports.UserAccount.get(id).prepareReconnect(nonce);
    return { url: getBaseUrl(this.env) + "/" + this.ctx.props.userObjectId + "/" + nonce };
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.JulesVerifier({});
  }
}

// --- Configurator UI capability passed into the account configurator iframe ---

@validateRpc()
class AccountConfiguratorUI extends RpcTarget implements JulesAccountConfiguratorRpc {
  async resourceUrl(): Promise<string> {
    return JULES_URL;
  }

  async describeAccount(): Promise<{ name: string; url: string }> {
    return { name: "Google Jules", url: JULES_URL };
  }
}

// --- Configurator UI capability passed into the repository configurator iframe ---

const julesRepoConfiguratorCreds = new WeakMap<object, () => Promise<JulesCredentials>>();

@validateRpc()
class JulesRepoConfiguratorUI extends RpcTarget implements JulesRepoConfiguratorRpc {
  constructor(getCredentials: () => Promise<JulesCredentials>) {
    super();
    julesRepoConfiguratorCreds.set(this, getCredentials);
  }

  async listSources(query: string): Promise<JulesConfiguratorOption[]> {
    const creds = await julesRepoConfiguratorCreds.get(this)!();
    const sources = await new JulesRest(creds).listSources({ pageSize: 100 });
    const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return sources
      .filter((source) => {
        const g = source.githubRepo;
        const fullName = g?.owner && g?.repo ? g.owner + "/" + g.repo : source.name;
        const haystack = [source.name, source.id, g?.owner, g?.repo, fullName]
          .filter(Boolean).join(" ").toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .slice(0, 100)
      .map((source) => {
        const g = source.githubRepo;
        const fullName = g?.owner && g?.repo ? g.owner + "/" + g.repo : source.name;
        return {
          value: source.name,
          title: fullName,
          subtitle: source.name === fullName ? undefined : "Source: " + source.id,
          meta: g ? (g.isPrivate ? "private" : "public") : undefined,
        };
      });
  }

  async resourceUrl(sourceName: string | null | undefined): Promise<string> {
    if (!sourceName) throw new Error("No repository selected.");
    const id = sourceName.startsWith("sources/") ? sourceName.slice("sources/".length) : sourceName;
    return JULES_URL + "/sources/" + encodeURIComponent(id);
  }
}

// --- Verifier (API key is all-or-nothing, so no per-user checks) ---

@validateRpc()
export class JulesVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// --- Action model + storage ---

type JulesAction =
  | { id: number; type: "createSession"; input: JulesCreateSessionInput }
  | { id: number; type: "sendMessage"; session: string; prompt: string }
  | { id: number; type: "approvePlan"; session: string };

type SubmitWriteBody =
  | { type: "createSession"; input: JulesCreateSessionInput }
  | { type: "sendMessage"; session: string; prompt: string }
  | { type: "approvePlan"; session: string };

type JulesRevertInfo = { type: "noRevert" };

type PendingActionRow = { id: number; action: JulesAction; submittedAt: number };
type AppliedActionRow = { id: number; action: JulesAction; revertInfo: JulesRevertInfo; appliedAt: number };

function expandResourceName(input: string, collection: "sources" | "sessions"): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError("Expected a " + collection + " resource name or id, but got " + JSON.stringify(input) + ".");
  }
  if (input.startsWith(collection + "/")) return input;
  if (input.includes("/")) return input;
  return collection + "/" + input;
}

function expandActivityName(input: string): string {
  if (typeof input !== "string" || input.length === 0) {
    throw new TypeError("Expected an activity resource name, but got " + JSON.stringify(input) + ".");
  }
  if (input.startsWith("sessions/") && input.includes("/activities/")) return input;
  throw new TypeError(
    "getActivity() requires the full activity resource name (sessions/{session}/activities/{activity}), but got " + JSON.stringify(input) + "."
  );
}

function validateCreateSessionInput(input: JulesCreateSessionInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("createSession() expects a single input object with a \"prompt\" field, but got " + typeof input + ".");
  }
  if (typeof input.prompt !== "string" || input.prompt.trim().length === 0) {
    throw new TypeError("createSession() requires a non-empty string \"prompt\" field.");
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "\u2026";
}

function describeAction(action: JulesAction): ActionDescription {
  switch (action.type) {
    case "createSession": {
      const prompt = truncate(action.input.prompt, 160);
      const title = action.input.title ? " (title: " + truncate(action.input.title, 80) + ")" : "";
      const source = " against source " + truncate(action.input.sourceContext.source, 80);
      return {
        title: "Create Google Jules session",
        description: "Starts a new Jules session with prompt \"" + prompt + "\"" + title + source + ".",
        implementsRevert: false,
        awaitDecision: true,
      };
    }
    case "sendMessage":
      return {
        title: "Send message to Jules session",
        description: "Sends a message to " + action.session + ": \"" + truncate(action.prompt, 160) + "\".",
        implementsRevert: false,
        awaitDecision: true,
      };
    case "approvePlan":
      return {
        title: "Approve Jules plan",
        description: "Approves the pending plan in " + action.session + ".",
        implementsRevert: false,
        awaitDecision: true,
      };
  }
}

interface SessionContext {
  approvalQueue: RpcStub<ApprovalQueue>;
  rest: JulesRest;
  noteAuthError: () => Promise<void>;
  dispose: () => void;
  submitWrite: (body: SubmitWriteBody) => Promise<void>;
  /** When the binding is scoped to a single source, that source's full resource name. */
  scopeSourceName?: string;
}

// --- Gatekeeper DO (per resource binding) ---

type JulesGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: "instance" | "source";
  /** For resourceKind "source": the full source resource name, e.g. "sources/<id>". */
  sourceName?: string;
};

@validateRpc()
export class JulesGatekeeperImpl extends DurableObject<Env, JulesGatekeeperImplProps> implements Gatekeeper<JulesSessionIface> {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #getApiKey(): Promise<string> {
    return (await this.#userAccount().getCredentials()).apiKey;
  }

  async #rest(): Promise<JulesRest> {
    return new JulesRest({ apiKey: await this.#getApiKey() });
  }

  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.resourceKind === "source") {
      const sourceName = this.ctx.props.sourceName!;
      const rest = await this.#rest();
      let title = "Google Jules Repository";
      let url = JULES_URL + "/sources/" + encodeURIComponent(sourceName.replace(/^sources\//, ""));
      let snippet = "A single GitHub repository connected to Jules: its sessions, plans, activities, and pull requests.";
      try {
        const source = await rest.getSource(sourceName);
        const g = source.githubRepo;
        if (g?.owner && g?.repo) {
          title = g.owner + "/" + g.repo;
          url = "https://github.com/" + encodeURIComponent(g.owner) + "/" + encodeURIComponent(g.repo);
          snippet = "Google Jules source \"" + sourceName + "\" (" + g.owner + "/" + g.repo + ").";
        } else {
          snippet = "Google Jules source \"" + sourceName + "\".";
        }
      } catch {
        // Best-effort decoration only; fall back to the source URL above.
      }
      return { url, title, snippet, suggestedBindingName: "JULES_REPO", tsType: "JulesSession" };
    }
    return {
      url: JULES_URL,
      title: "Google Jules",
      snippet: "Sources, coding sessions, plans, activities, and pull requests from Google Jules.",
      suggestedBindingName: "JULES",
      tsType: "JulesSession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<JulesSessionIface> {
    const ctx = await this.#buildSessionContext(approvalQueue.dup());
    return new JulesSessionImpl(ctx);
  }

  async #buildSessionContext(approvalQueue: RpcStub<ApprovalQueue>): Promise<SessionContext> {
    const self = this;
    let disposed = false;
    const sessionCtx: SessionContext = {
      approvalQueue,
      rest: await this.#rest(),
      scopeSourceName: this.ctx.props.resourceKind === "source" ? this.ctx.props.sourceName : undefined,
      noteAuthError: () => self.#userAccount().noteCredentialsExpired(),
      dispose() {
        if (disposed) return;
        disposed = true;
        approvalQueue[Symbol.dispose]();
      },
      async submitWrite(body) {
        const id = self.#nextActionId();
        const action = { ...body, id } as JulesAction;
        self.ctx.storage.kv.put<PendingActionRow>("pending:" + id, { id, action, submittedAt: Date.now() });
        const description = describeAction(action);
        try {
          await approvalQueue.submitAction(id, description);
        } catch (e) {
          self.ctx.storage.kv.delete("pending:" + id);
          throw e;
        }
      },
    };
    return sessionCtx;
  }

  async applyAction(actionId: number): Promise<void> {
    const pending = this.#getPending(actionId);
    if (!pending) throw new Error("No queued Google Jules action exists with id " + actionId + ".");
    const action = pending.action;
    const rest = await this.#rest();

    let revertInfo: JulesRevertInfo;
    try {
      switch (action.type) {
        case "createSession": {
          await rest.createSession(action.input);
          revertInfo = { type: "noRevert" };
          break;
        }
        case "sendMessage":
          await rest.sendMessage(action.session, action.prompt);
          revertInfo = { type: "noRevert" };
          break;
        case "approvePlan":
          await rest.approvePlan(action.session);
          revertInfo = { type: "noRevert" };
          break;
      }
    } catch (e) {
      if (e instanceof JulesError && e.isAuthError) await this.#userAccount().noteCredentialsExpired();
      throw e;
    }

    this.#storeApplied(action, revertInfo);
    this.#deletePending(actionId);
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    this.#deletePending(actionId);
  }

  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    const applied = this.#getApplied(actionId);
    if (!applied) throw new Error("No applied Google Jules action exists with id " + actionId + ".");
    // The documented Jules REST API has no undo endpoints (no delete/archive/unarchive), so no write is revertible.
    throw new Error("This action cannot be reverted.");
  }

  // Google Jules has no per-user ACL: a single API key grants all-or-nothing access to the
  // account. Like gatekeeper-homeassistant, observer exclusions are therefore a no-op here.
  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  #nextActionId(): number {
    const counter = this.ctx.storage.kv.get<number>("counter:nextActionId") ?? 0;
    const next = counter + 1;
    this.ctx.storage.kv.put("counter:nextActionId", next);
    return next;
  }

  #getPending(id: number): PendingActionRow | undefined {
    return this.ctx.storage.kv.get<PendingActionRow>("pending:" + id);
  }

  #deletePending(id: number): void {
    this.ctx.storage.kv.delete("pending:" + id);
  }

  #storeApplied(action: JulesAction, revertInfo: JulesRevertInfo): void {
    this.ctx.storage.kv.put<AppliedActionRow>("applied:" + action.id, {
      id: action.id,
      action,
      revertInfo,
      appliedAt: Date.now(),
    });
  }

  #getApplied(id: number): AppliedActionRow | undefined {
    return this.ctx.storage.kv.get<AppliedActionRow>("applied:" + id);
  }
}

// --- Session RpcTarget exposed to gadgets ---

@validateRpc()
class JulesSessionImpl extends RpcTarget implements JulesSessionIface {
  #ctx: SessionContext;

  constructor(ctx: SessionContext) {
    super();
    this.#ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  async #call<T>(fn: (rest: JulesRest) => Promise<T>): Promise<T> {
    try {
      return await fn(this.#ctx.rest);
    } catch (e) {
      if (e instanceof JulesError && e.isAuthError) await this.#ctx.noteAuthError();
      throw e;
    }
  }

  #scopeSourceName(): string | undefined {
    return this.#ctx.scopeSourceName;
  }

  #assertSourceInScope(sourceName: string): void {
    const scope = this.#scopeSourceName();
    if (scope && sourceName !== scope) {
      throw new Error("This binding is scoped to Google Jules source \"" + scope + "\", not \"" + sourceName + "\".");
    }
  }

  async #assertSessionInScope(sessionName: string): Promise<void> {
    const scope = this.#scopeSourceName();
    if (!scope) return;
    const session = await this.#call((r) => r.getSession(sessionName));
    if (session.sourceContext?.source !== scope) {
      throw new Error("Google Jules session \"" + sessionName + "\" does not belong to the scoped source \"" + scope + "\".");
    }
  }

  async listSources(options?: JulesListSourcesOptions): Promise<JulesSource[]> {
    const scope = this.#scopeSourceName();
    if (scope) {
      const result = await this.#call((r) => r.getSource(scope));
      await this.#ctx.approvalQueue.authorizeObservation({
        title: "List Google Jules sources",
        description: "Listed the scoped source \"" + scope + "\".",
      });
      return [result];
    }
    const result = await this.#call((r) => r.listSources(options));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Google Jules sources",
      description: "Listed " + result.length + " source" + (result.length === 1 ? "" : "s") + ".",
    });
    return result;
  }

  async getSource(name: string): Promise<JulesSource> {
    const fullName = expandResourceName(name, "sources");
    this.#assertSourceInScope(fullName);
    const result = await this.#call((r) => r.getSource(fullName));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Get Google Jules source",
      description: "Read source \"" + fullName + "\".",
    });
    return result;
  }

  async listSessions(options?: JulesListSessionsOptions): Promise<JulesSessionInfo[]> {
    const result = await this.#call((r) => r.listSessions(options));
    const scope = this.#scopeSourceName();
    const filtered = scope ? result.filter((s) => s.sourceContext?.source === scope) : result;
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Google Jules sessions",
      description: "Listed " + filtered.length + " session" + (filtered.length === 1 ? "" : "s") + ".",
    });
    return filtered;
  }

  async getSession(name: string): Promise<JulesSessionInfo> {
    const fullName = expandResourceName(name, "sessions");
    const result = await this.#call((r) => r.getSession(fullName));
    const scope = this.#scopeSourceName();
    if (scope && result.sourceContext?.source !== scope) {
      throw new Error("Google Jules session \"" + fullName + "\" does not belong to the scoped source \"" + scope + "\".");
    }
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Get Google Jules session",
      description: "Read session \"" + fullName + "\".",
    });
    return result;
  }

  async createSession(input: JulesCreateSessionInput): Promise<void> {
    validateCreateSessionInput(input);
    const scope = this.#scopeSourceName();
    if (scope) {
      if (input.sourceContext && input.sourceContext.source !== scope) {
        throw new Error("This binding is scoped to Google Jules source \"" + scope + "\"; cannot create a session against \"" + input.sourceContext.source + "\".");
      }
      if (!input.sourceContext) input = { ...input, sourceContext: { source: scope } };
    }
    const sourceName = input.sourceContext?.source;
    if (typeof sourceName !== "string" || sourceName.trim().length === 0) {
      throw new TypeError("createSession() requires a non-empty \"sourceContext.source\" (the Jules source to work against).");
    }

    // Ensure the source name is expanded to "sources/id" format if necessary.
    input = {
      ...input,
      sourceContext: {
        ...input.sourceContext,
        source: expandResourceName(sourceName, "sources"),
      },
    };

    await this.#ctx.submitWrite({ type: "createSession", input });
  }

  async sendMessage(session: string, prompt: string): Promise<void> {
    if (typeof prompt !== "string" || prompt.trim().length === 0) {
      throw new TypeError("sendMessage() requires a non-empty string prompt.");
    }
    const fullName = expandResourceName(session, "sessions");
    await this.#assertSessionInScope(fullName);
    await this.#ctx.submitWrite({ type: "sendMessage", session: fullName, prompt });
  }

  async approvePlan(session: string): Promise<void> {
    const fullName = expandResourceName(session, "sessions");
    await this.#assertSessionInScope(fullName);
    await this.#ctx.submitWrite({ type: "approvePlan", session: fullName });
  }

  async listActivities(session: string, options?: JulesListActivitiesOptions): Promise<JulesActivity[]> {
    const fullName = expandResourceName(session, "sessions");
    await this.#assertSessionInScope(fullName);
    const result = await this.#call((r) => r.listActivities(fullName, options));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Google Jules activities",
      description: "Listed " + result.length + " activit" + (result.length === 1 ? "y" : "ies") + " for session \"" + fullName + "\".",
    });
    return result;
  }

  async getActivity(name: string): Promise<JulesActivity> {
    const fullName = expandActivityName(name);
    const sessionName = fullName.slice(0, fullName.indexOf("/activities/"));
    await this.#assertSessionInScope(sessionName);
    const result = await this.#call((r) => r.getActivity(fullName));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Get Google Jules activity",
      description: "Read activity \"" + fullName + "\".",
    });
    return result;
  }
}
