// Navasanganakah Astrology gatekeeper.
//
// A first-class Cloudflare OS gatekeeper for the Navasanganakah Astrology API
// (https://astro.navasanganakah.com/docs). It follows the gatekeeper contract in
// packages/workshop-shared/src/gatekeeper.ts.
//
// Connect flow: the user's x-api-key (created at astro.navasanganakah.com) and API base URL
// are entered into a small HTML form and stored in the UserAccount Durable Object. There is no
// deployment-level secret. Reads are authorized as observations; the session is fully read-only
// (there are no write actions to approve or revert).

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  stripTrailingSlashes,
  type AccountDescription,
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
import type { AstrologyAccountConfiguratorRpc } from "./configurator/account-configurator-types";
import { AstrologyError, AstrologyRest, toDateString, type AstrologyCredentials } from "./astrology-api";
import type {
  AshtakvargaReport,
  AstrologySession,
  BirthChart,
  BirthDetails,
  BhriguYogasReport,
  CareerMarriageReport,
  DashaPeriod,
  DashaReport,
  GocharReport,
  KundliAnalysis,
  NumerologyReport,
  PanchangReport,
  PlanetPosition,
  PlanetReading,
  ShadbalaReport,
  VargaReport,
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
  let diff = a.length ^ b.length;
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/astrology");
}

function getBasePath(env: Env): string {
  try {
    return new URL(getBaseUrl(env)).pathname;
  } catch {
    return "/gatekeeper/astrology";
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

const ASTROLOGY_LOGO_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">' +
  '<rect width="512" height="512" rx="112" fill="#4f46e5"/>' +
  '<circle cx="305" cy="190" r="118" fill="#facc15"/>' +
  '<circle cx="342" cy="155" r="98" fill="#4f46e5"/>' +
  '<path d="M258 330l14 36 36 14-36 14-14 36-14-36-36-14 36-14z" fill="#facc15"/>' +
  '<circle cx="140" cy="368" r="9" fill="#e0e7ff"/>' +
  '<circle cx="196" cy="336" r="5" fill="#e0e7ff"/>' +
  '<circle cx="120" cy="300" r="6" fill="#e0e7ff"/>' +
  '</svg>';

const ASTROLOGY_ICON: AvatarImage = {
  url: "data:image/svg+xml;utf8," + encodeURIComponent(ASTROLOGY_LOGO_SVG),
};

// Whole-account resource. The single Astrology API account is addressed as a catch-all pattern
// (the same technique gatekeeper-jules and gatekeeper-homeassistant use for whole-account
// access); the canonical resource URL is the connected API base URL returned by the configurator.
const ASTROLOGY_RESOURCE: SupportedResource = {
  urlPattern: "https://*",
  title: "Astrology API",
  description: "Access to the Navasanganakah Astrology API: birth charts, dashas, transits, panchang, and Hindi Kundli analysis.",
  icon: ASTROLOGY_ICON,
};

const SUPPORTED_RESOURCES: SupportedResource[] = [ASTROLOGY_RESOURCE];

// --- Connect form ---

const CONNECT_FORM_HTML = (params: { actionUrl: string; error?: string }): string => {
  const errorHtml = params.error
    ? '<div class="error">' + escapeHtml(params.error) + '</div>'
    : "";
  return [
    "<!DOCTYPE html>",
    '<html lang="hi">',
    "<head>",
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    "<title>Connect Astrology API</title>",
    "<style>",
    "body{font-family:system-ui,-apple-system,sans-serif;background:#eef2ff;margin:0;padding:2rem;display:flex;justify-content:center;align-items:center;min-height:100vh;box-sizing:border-box;}",
    ".card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:2rem;max-width:440px;width:100%;box-shadow:0 10px 30px rgba(0,0,0,.06);}",
    "h1{font-size:1.35rem;margin:0 0 .5rem;}",
    "p{color:#475569;line-height:1.5;margin:0 0 1rem;}",
    "label{display:block;font-weight:600;margin-bottom:.35rem;margin-top:1rem;}",
    "label:first-of-type{margin-top:0;}",
    "input{width:100%;box-sizing:border-box;padding:.6rem .75rem;border:1px solid #cbd5e1;border-radius:8px;font:inherit;}",
    ".hint{color:#64748b;font-size:.85rem;margin:.5rem 0 1rem;}",
    ".hint a{color:#4f46e5;}",
    "button{background:#4f46e5;color:#fff;border:0;border-radius:8px;padding:.65rem 1rem;font:inherit;font-weight:600;cursor:pointer;margin-top:.5rem;}",
    "button:hover{background:#4338ca;}",
    ".error{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca;border-radius:8px;padding:.65rem .75rem;margin-bottom:1rem;}",
    "</style>",
    "</head>",
    "<body>",
    '<div class="card">',
    "<h1>Connect Astrology API</h1>",
    "<p>Paste your Navasanganakah Astrology API key. It is stored in this account and used only for your Kundli calculations.</p>",
    errorHtml,
    '<form method="POST" action="' + escapeAttr(params.actionUrl) + '">',
    '<label for="apiKey">Astrology API key</label>',
    '<input id="apiKey" name="apiKey" type="password" required placeholder="x-api-key" autofocus>',
    '<label for="baseUrl">API base URL</label>',
    '<input id="baseUrl" name="baseUrl" type="url" required value="https://astrology.navasanganakah.com">',
    '<div class="hint">Create an API key at <a href="https://astro.navasanganakah.com">astro.navasanganakah.com</a>. API docs: <a href="https://astro.navasanganakah.com/docs">/docs</a>.</div>',
    '<button type="submit">Connect</button>',
    "</form>",
    "</div>",
    "</body>",
    "</html>",
  ].join("\n");
};

const SELF_CLOSING_HTML = "<!DOCTYPE html><html><body><script>window.close()</script><p>Astrology API connected. You may close this window.</p></body></html>";
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
          return new Response(INVALID_LINK_HTML, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        return new Response(CONNECT_FORM_HTML({ actionUrl: req.url }), { headers: { "Content-Type": "text/html; charset=utf-8" } });
      }

      if (req.method === "POST") {
        let form: FormData;
        try {
          form = await req.formData();
        } catch {
          return new Response(CONNECT_FORM_HTML({ actionUrl: req.url, error: "Invalid form submission." }), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        const apiKey = String(form.get("apiKey") ?? "").trim();
        const baseUrlInput = String(form.get("baseUrl") ?? "").trim();

        if (!apiKey) {
          return new Response(CONNECT_FORM_HTML({ actionUrl: req.url, error: "An API key is required." }), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (!baseUrlInput) {
          return new Response(CONNECT_FORM_HTML({ actionUrl: req.url, error: "An API base URL is required." }), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }

        let baseUrl: string;
        try {
          const parsed = new URL(baseUrlInput);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw new Error("The base URL must use http:// or https://.");
          }
          baseUrl = parsed.protocol + "//" + parsed.host;
        } catch (e: any) {
          return new Response(CONNECT_FORM_HTML({ actionUrl: req.url, error: "Invalid API base URL: " + (e?.message ?? String(e)) }), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }

        const result = await stub.completeConnection(nonce, baseUrl, apiKey);
        if (result.kind === "invalid_nonce") {
          return new Response(INVALID_LINK_HTML, { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        if (result.kind === "error") {
          return new Response(CONNECT_FORM_HTML({ actionUrl: req.url, error: result.message }), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        return new Response(SELF_CLOSING_HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
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
      displayName: "Astrology",
      url: "https://astro.navasanganakah.com/docs",
      logo: ASTROLOGY_ICON,
      tagline: "Compute Vedic Kundli and Hindi astrological analysis from birth details.",
      description: "Connect the Navasanganakah Astrology API to compute birth charts, dashas, transits, panchang, ashtakvarga, shadbala, yogas, career/marriage analysis, numerology, and a structured Hindi Kundli report.",
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
    if (!this.ctx.storage.kv.get<AstrologyCredentials>("credentials")) {
      await this.ctx.storage.setAlarm(Date.now() + CONNECT_ALARM_MS);
    }
    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
  }

  async prepareReconnect(nonce: string): Promise<void> {
    if (!this.ctx.storage.kv.get<AstrologyCredentials>("credentials")) {
      throw new Error("This Astrology account is not connected.");
    }
    this.ctx.storage.kv.put("reconnecting", true);
    this.ctx.storage.kv.put<StoredNonce>("nonce", { value: nonce, expiresAt: Date.now() + NONCE_LIFETIME_MS });
    await this.ctx.storage.setAlarm(Date.now() + CONNECT_ALARM_MS);
  }

  async verifyNonceWithoutConsuming(nonce: string): Promise<boolean> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    return !!stored && Date.now() < stored.expiresAt && constantTimeEqual(stored.value, nonce);
  }

  async completeConnection(nonce: string, baseUrl: string, apiKey: string): Promise<CompleteConnectionResult> {
    const stored = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!stored || Date.now() >= stored.expiresAt || !constantTimeEqual(stored.value, nonce)) {
      return { kind: "invalid_nonce" };
    }

    try {
      await new AstrologyRest({ baseUrl, apiKey }).ping();
    } catch (e: any) {
      return {
        kind: "error",
        message: e instanceof AstrologyError ? e.message : ("Unable to reach the Astrology API: " + (e?.message ?? e)),
      };
    }

    this.ctx.storage.kv.delete("nonce");
    this.ctx.storage.kv.delete("expired");
    this.ctx.storage.kv.put<AstrologyCredentials>("credentials", { baseUrl, apiKey });

    const callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
    if (!callback) {
      this.ctx.storage.kv.delete("credentials");
      return { kind: "error", message: "Connection callback expired. Please start over." };
    }

    try {
      const user = this.ctx.exports.AstrologyUserImpl({ props: { userObjectId: this.ctx.id.toString() } });
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

  getCredentials(): AstrologyCredentials {
    return this.ctx.storage.kv.get<AstrologyCredentials>("credentials")!;
  }

  async noteCredentialsExpired(): Promise<void> {
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

type AstrologyUserImplProps = { userObjectId: string };

@validateRpc()
export class AstrologyUserImpl extends WorkerEntrypoint<Env, AstrologyUserImplProps> implements GatekeeperUser {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async describe(): Promise<AccountDescription> {
    const creds = await this.#userAccount().getCredentials();
    return { displayName: "Astrology", uniqueName: stripTrailingSlashes(creds.baseUrl), avatar: ASTROLOGY_ICON };
  }

  async getAuthenticatedEmail(): Promise<string | null> {
    // The API key is account-level; it does not prove a sign-in email.
    return null;
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(resourceUrlPattern: string): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === ASTROLOGY_RESOURCE.urlPattern) {
      const credsGetter = async () => await this.#userAccount().getCredentials();
      return { iframeHtml: ACCOUNT_CONFIGURATOR_HTML, ui: new RpcStub(new AccountConfiguratorUI(credsGetter)) };
    }
    throw new Error("Unsupported resource configurator type: " + resourceUrlPattern);
  }

  async getGatekeeperClassFor(url: string): Promise<{ class: DurableObjectClass<Gatekeeper<any>>; resource: SupportedResource }> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (e: any) {
      throw new Error("Invalid Astrology URL \"" + url + "\": " + (e?.message ?? e), { cause: e });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Unsupported URL scheme for Astrology: " + parsed.protocol);
    }
    return {
      class: this.ctx.exports.AstrologyGatekeeperImpl({ props: { userObjectId: this.ctx.props.userObjectId } }),
      resource: ASTROLOGY_RESOURCE,
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
    return this.ctx.exports.AstrologyVerifier({});
  }
}

// --- Configurator UI capability passed into the account configurator iframe ---

const accountConfiguratorCreds = new WeakMap<object, () => Promise<AstrologyCredentials>>();

@validateRpc()
class AccountConfiguratorUI extends RpcTarget implements AstrologyAccountConfiguratorRpc {
  constructor(getCredentials: () => Promise<AstrologyCredentials>) {
    super();
    accountConfiguratorCreds.set(this, getCredentials);
  }

  async resourceUrl(): Promise<string> {
    const creds = await accountConfiguratorCreds.get(this)!();
    return stripTrailingSlashes(creds.baseUrl);
  }

  async describeAccount(): Promise<{ name: string; url: string }> {
    const creds = await accountConfiguratorCreds.get(this)!();
    return { name: "Astrology", url: stripTrailingSlashes(creds.baseUrl) };
  }
}

// --- Verifier (the API key is all-or-nothing, so no per-user checks) ---

@validateRpc()
export class AstrologyVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// --- Session context ---

interface SessionContext {
  creds: AstrologyCredentials;
  approvalQueue: RpcStub<ApprovalQueue>;
  noteAuthError: () => Promise<void>;
  dispose: () => void;
}

// --- Gatekeeper DO (per resource binding) ---

type AstrologyGatekeeperImplProps = { userObjectId: string };

@validateRpc()
export class AstrologyGatekeeperImpl extends DurableObject<Env, AstrologyGatekeeperImplProps> implements Gatekeeper<AstrologySession> {
  #userAccount(): DurableObjectStub<UserAccount> {
    return this.ctx.exports.UserAccount.get(this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
  }

  async #getCreds(): Promise<AstrologyCredentials> {
    return await this.#userAccount().getCredentials();
  }

  async describe(): Promise<ResourceDescription> {
    const creds = await this.#getCreds();
    return {
      url: stripTrailingSlashes(creds.baseUrl),
      title: "Astrology API",
      snippet: "Vedic birth charts, dashas, transits, panchang, ashtakvarga, shadbala, yogas, and Hindi Kundli analysis from the Navasanganakah Astrology API.",
      suggestedBindingName: "ASTROLOGY",
      tsType: "AstrologySession",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<AstrologySession> {
    const creds = await this.#getCreds();
    const sessionCtx = this.#buildSessionContext(creds, approvalQueue.dup());
    return new AstrologySessionImpl(sessionCtx);
  }

  #buildSessionContext(creds: AstrologyCredentials, approvalQueue: RpcStub<ApprovalQueue>): SessionContext {
    const self = this;
    let disposed = false;
    return {
      creds,
      approvalQueue,
      noteAuthError: () => self.#userAccount().noteCredentialsExpired(),
      dispose() {
        if (disposed) return;
        disposed = true;
        approvalQueue[Symbol.dispose]();
      },
    };
  }

  async applyAction(_actionId: number): Promise<void> {
    throw new Error("The Astrology gatekeeper is read-only and has no actions to apply.");
  }

  async rejectAction(_actionId: number): Promise<void | { restart?: boolean }> {
    throw new Error("The Astrology gatekeeper is read-only and has no actions to reject.");
  }

  async revertAction(_actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("The Astrology gatekeeper is read-only and has no actions to revert.");
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}
}

// --- Session RpcTarget exposed to gadgets ---

@validateRpc()
class AstrologySessionImpl extends RpcTarget implements AstrologySession {
  #ctx: SessionContext;

  constructor(ctx: SessionContext) {
    super();
    this.#ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  async #call<T>(fn: (rest: AstrologyRest) => Promise<T>): Promise<T> {
    try {
      return await fn(new AstrologyRest(this.#ctx.creds));
    } catch (e) {
      if (e instanceof AstrologyError && e.isAuthError) await this.#ctx.noteAuthError();
      throw e;
    }
  }

  async getBirthChart(details: BirthDetails): Promise<BirthChart> {
    validateBirthDetails(details);
    const result = await this.#call((r) => r.getAstro(details));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Compute birth chart",
      description: "Computed the Vedic birth chart (Kundli) for " + describeBirth(details) + ".",
    });
    return result;
  }

  async getDasha(details: BirthDetails, targetDate?: string): Promise<DashaReport> {
    validateBirthDetails(details);
    const result = await this.#call((r) => r.getDasha(details, targetDate));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Compute Vimshottari dasha",
      description: "Computed the Vimshottari dasha periods for " + describeBirth(details) + ".",
    });
    return result;
  }

  async getGochar(details: BirthDetails, targetDate?: string): Promise<GocharReport> {
    validateBirthDetails(details);
    const result = await this.#call((r) => r.getGochar(details, targetDate));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Compute planetary transits",
      description: "Computed the gochar (planetary transits) for " + describeBirth(details) + ".",
    });
    return result;
  }

  async getPanchang(details: BirthDetails): Promise<PanchangReport> {
    validateBirthDetails(details);
    const result = await this.#call((r) => r.getPanchang(details));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Compute panchang",
      description: "Computed the panchang (tithi, vaar, nakshatra, yoga, karana) for " + describeBirth(details) + ".",
    });
    return result;
  }

  async getAshtakvarga(details: BirthDetails): Promise<AshtakvargaReport> {
    validateBirthDetails(details);
    const result = await this.#call((r) => r.getAshtakvarga(details));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Compute ashtakvarga",
      description: "Computed the ashtakvarga (bhinna and sarva) for " + describeBirth(details) + ".",
    });
    return result;
  }

  async getShadbala(details: BirthDetails): Promise<ShadbalaReport> {
    validateBirthDetails(details);
    const result = await this.#call((r) => r.getShadbala(details));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Compute shadbala",
      description: "Computed the six-fold planetary strengths (shadbala) for " + describeBirth(details) + ".",
    });
    return result;
  }

  async getVargas(details: BirthDetails): Promise<VargaReport> {
    validateBirthDetails(details);
    const result = await this.#call((r) => r.getVarga(details));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Compute divisional charts",
      description: "Computed the divisional charts (vargas) for " + describeBirth(details) + ".",
    });
    return result;
  }

  async getBhriguYogas(details: BirthDetails): Promise<BhriguYogasReport> {
    validateBirthDetails(details);
    const result = await this.#call((r) => r.getBhriguYogas(toDateString(details)));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Compute Bhrigu-Nandi-Nadi yogas",
      description: "Computed the BNN yogas for birth date " + toDateString(details) + ".",
    });
    return result;
  }

  async getCareerMarriage(details: BirthDetails, gender?: "male" | "female"): Promise<CareerMarriageReport> {
    validateBirthDetails(details);
    const g = gender === "female" ? "female" : "male";
    const result = await this.#call((r) => r.getCareerMarriage(toDateString(details), g));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Analyze career and marriage",
      description: "Computed the BNN career and marriage analysis for birth date " + toDateString(details) + " (gender: " + g + ").",
    });
    return result;
  }

  async getNumerology(details: BirthDetails, name?: string): Promise<NumerologyReport> {
    validateBirthDetails(details);
    const result = await this.#call((r) => r.getNumerology({ year: details.year, month: details.month, day: details.day, ...(name ? { name } : {}) }));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Compute numerology",
      description: "Computed the Chaldean numerology numbers for birth date " + toDateString(details) + (name ? " (name: " + name + ")" : "") + ".",
    });
    return result;
  }

  async getChartSvg(details: BirthDetails, options?: { style?: "north" | "south"; varga?: string }): Promise<string> {
    validateBirthDetails(details);
    const result = await this.#call((r) => r.getChartSvg(details, options));
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Render Kundli chart",
      description: "Rendered the " + (options?.varga ?? "D1") + " Kundli chart (style: " + (options?.style ?? "north") + ") for " + describeBirth(details) + ".",
    });
    return result;
  }

  async analyzeKundli(details: BirthDetails, options?: { gender?: "male" | "female"; name?: string }): Promise<KundliAnalysis> {
    validateBirthDetails(details);
    const gender = options?.gender === "female" ? "female" : "male";
    const dateString = toDateString(details);
    const rest = new AstrologyRest(this.#ctx.creds);
    const [chartR, dashaR, panchangR, ashtakR, shadbalaR, yogasR, careerR] = await Promise.allSettled([
      rest.getAstro(details),
      rest.getDasha(details),
      rest.getPanchang(details),
      rest.getAshtakvarga(details),
      rest.getShadbala(details),
      rest.getBhriguYogas(dateString),
      rest.getCareerMarriage(dateString, gender),
    ]);

    for (const r of [chartR, dashaR, panchangR, ashtakR, shadbalaR, yogasR, careerR]) {
      if (r.status === "rejected" && r.reason instanceof AstrologyError && r.reason.isAuthError) {
        await this.#ctx.noteAuthError();
        throw r.reason;
      }
    }

    const chart = chartR.status === "fulfilled" ? chartR.value : undefined;
    const dasha = dashaR.status === "fulfilled" ? dashaR.value : undefined;
    const panchang = panchangR.status === "fulfilled" ? panchangR.value : undefined;
    const ashtak = ashtakR.status === "fulfilled" ? ashtakR.value : undefined;
    const shadbala = shadbalaR.status === "fulfilled" ? shadbalaR.value : undefined;
    const yogas = yogasR.status === "fulfilled" ? yogasR.value : undefined;
    const career = careerR.status === "fulfilled" ? careerR.value : undefined;

    const analysis = buildAnalysis(details, chart, dasha, panchang, ashtak, shadbala, yogas, career);

    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Analyze Kundli (Hindi)",
      description: "Composed a Hindi Kundli analysis for " + describeBirth(details) + ".",
    });
    return analysis;
  }
}

// --- Analysis helpers (Hindi) ---

const PLANET_KEYS = ["sun", "moon", "mars", "mercury", "jupiter", "venus", "saturn", "rahu", "ketu"] as const;

const PLANET_HINDI: Record<string, string> = {
  sun: "सूर्य",
  moon: "चंद्र",
  mars: "मंगल",
  mercury: "बुध",
  jupiter: "गुरु",
  venus: "शुक्र",
  saturn: "शनि",
  rahu: "राहु",
  ketu: "केतु",
};

const SHADBALA_KEYS = ["sun", "moon", "mars", "mercury", "jupiter", "venus", "saturn"] as const;

function text(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function describeBirth(details: BirthDetails): string {
  const hh = String(details.hour ?? 12).padStart(2, "0");
  const mm = String(details.minute ?? 0).padStart(2, "0");
  return toDateString(details) + " " + hh + ":" + mm;
}

function validateBirthDetails(details: BirthDetails): void {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    throw new TypeError("Birth details must be a BirthDetails object.");
  }
  for (const key of ["year", "month", "day", "latitude", "longitude"] as const) {
    if (typeof details[key] !== "number" || !Number.isFinite(details[key])) {
      throw new TypeError("BirthDetails." + key + " must be a finite number.");
    }
  }
  if (!Number.isInteger(details.year) || !Number.isInteger(details.month) || !Number.isInteger(details.day)) {
    throw new TypeError("BirthDetails year, month, and day must be integers.");
  }
  if (details.month < 1 || details.month > 12 || details.day < 1 || details.day > 31) {
    throw new TypeError("BirthDetails month must be 1-12 and day must be 1-31.");
  }
  if (details.latitude < -90 || details.latitude > 90) {
    throw new TypeError("BirthDetails latitude must be between -90 and 90.");
  }
  if (details.longitude < -180 || details.longitude > 180) {
    throw new TypeError("BirthDetails longitude must be between -180 and 180.");
  }
  if (details.hour !== undefined && (typeof details.hour !== "number" || details.hour < 0 || details.hour > 23)) {
    throw new TypeError("BirthDetails hour must be a number between 0 and 23.");
  }
  if (details.minute !== undefined && (typeof details.minute !== "number" || details.minute < 0 || details.minute > 59)) {
    throw new TypeError("BirthDetails minute must be a number between 0 and 59.");
  }
  if (details.timezoneOffset !== undefined && typeof details.timezoneOffset !== "number") {
    throw new TypeError("BirthDetails timezoneOffset must be a number.");
  }
}

function planetReading(name: string, p: PlanetPosition): string {
  const rashi = text(p?.rashiName);
  const nakshatra = text(p?.nakshatraName);
  const bhav = num(p?.bhav);
  const parts: string[] = [];
  if (rashi) parts.push(rashi + " राशि में");
  if (nakshatra) parts.push(nakshatra + " नक्षत्र में");
  if (bhav != null) parts.push(bhav + " भाव में");
  if (parts.length === 0) return name + " की स्थिति उपलब्ध नहीं है।";
  return name + " " + parts.join(", ") + " स्थित है।";
}

function summarizePanchang(p: PanchangReport | undefined): string | undefined {
  if (!p) return undefined;
  const parts: string[] = [];
  const tithiName = text(p.tithi?.name);
  const tithiPaksha = text(p.tithi?.paksha);
  if (tithiName) parts.push("तिथि " + tithiName + (tithiPaksha ? " (" + tithiPaksha + ")" : ""));
  const vaarName = text(p.vaar?.name);
  if (vaarName) parts.push("वार " + vaarName);
  const nakshatraName = text(p.nakshatra?.name);
  if (nakshatraName) parts.push("नक्षत्र " + nakshatraName);
  const yogaName = text(p.yoga?.name);
  if (yogaName) parts.push("योग " + yogaName);
  const karanaName = text(p.karana?.name);
  if (karanaName) parts.push("करण " + karanaName);
  if (parts.length === 0) return undefined;
  return "जन्म पंचांग: " + parts.join(", ") + "।";
}

function savSummary(a: AshtakvargaReport | undefined): string | undefined {
  const sav = a?.sarvashtakvarga;
  if (!sav || typeof sav !== "object") return undefined;
  let bestSign: string | undefined;
  let bestPoints: number | undefined;
  let worstSign: string | undefined;
  let worstPoints: number | undefined;
  for (const [sign, v] of Object.entries(sav)) {
    const points = num((v as { points?: unknown })?.points);
    if (points == null) continue;
    if (bestPoints == null || points > bestPoints) { bestPoints = points; bestSign = sign; }
    if (worstPoints == null || points < worstPoints) { worstPoints = points; worstSign = sign; }
  }
  if (bestSign == null || worstSign == null) return undefined;
  return "सर्वाष्टकवर्ग में सर्वाधिक बिंदु " + bestSign + " (" + bestPoints + ") और न्यूनतम " + worstSign + " (" + worstPoints + ") में हैं।";
}

function shadbalaSummary(s: ShadbalaReport | undefined): string | undefined {
  if (!s) return undefined;
  let bestPlanet: string | undefined;
  let bestRupas: number | undefined;
  let worstPlanet: string | undefined;
  let worstRupas: number | undefined;
  for (const key of SHADBALA_KEYS) {
    const v = s[key];
    if (!v) continue;
    const rupas = num(v.total_rupas);
    if (rupas == null) continue;
    const label = text(v.name) ?? PLANET_HINDI[key] ?? key;
    if (bestRupas == null || rupas > bestRupas) { bestRupas = rupas; bestPlanet = label; }
    if (worstRupas == null || rupas < worstRupas) { worstRupas = rupas; worstPlanet = label; }
  }
  if (bestPlanet == null || worstPlanet == null) return undefined;
  return "षड्बल में " + bestPlanet + " सबसे बलवान (रूप " + bestRupas + ") और " + worstPlanet + " सबसे निर्बल (रूप " + worstRupas + ") है।";
}

function buildRecommendations(chart: BirthChart | undefined, shadbala: ShadbalaReport | undefined): string[] {
  const recs: string[] = [];
  let weakest: string | undefined;
  let weakestRupas: number | undefined;
  for (const key of SHADBALA_KEYS) {
    const v = shadbala?.[key];
    if (!v) continue;
    const rupas = num(v.total_rupas);
    if (rupas == null) continue;
    if (weakestRupas == null || rupas < weakestRupas) { weakestRupas = rupas; weakest = text(v.name) ?? PLANET_HINDI[key] ?? key; }
  }
  if (weakest) recs.push("निर्बल ग्रह " + weakest + " को बल देने हेतु उससे संबंधित मंत्र जप, दान और उपाय करें।");
  if (chart?.planets?.moon) recs.push("चंद्रमा की स्थिति को ध्यान में रखते हुए मन की शांति के लिए नियमित ध्यान और सात्विक दिनचर्या अपनाएं।");
  recs.push("यह विश्लेषण सामान्य ज्योतिषीय गणना पर आधारित है; सटीक फलादेश हेतु किसी अनुभवी ज्योतिषी से परामर्श अवश्य करें।");
  return recs;
}

function buildAnalysis(
  details: BirthDetails,
  chart: BirthChart | undefined,
  dasha: DashaReport | undefined,
  panchang: PanchangReport | undefined,
  ashtak: AshtakvargaReport | undefined,
  shadbala: ShadbalaReport | undefined,
  yogas: BhriguYogasReport | undefined,
  career: CareerMarriageReport | undefined,
): KundliAnalysis {
  const lagna = chart?.planets?.lagna;
  const moon = chart?.planets?.moon;
  const sun = chart?.planets?.sun;

  const lagnaRashi = text(lagna?.rashiName);
  const lagnaNakshatra = text(lagna?.nakshatraName);
  const moonRashi = text(moon?.rashiName);
  const sunRashi = text(sun?.rashiName);

  const planets: PlanetReading[] = PLANET_KEYS.map((key): PlanetReading | null => {
    const p = chart?.planets?.[key];
    const rashi = text(p?.rashiName);
    const nakshatra = text(p?.nakshatraName);
    const bhav = num(p?.bhav);
    if (!rashi && !nakshatra && bhav == null) return null;
    return {
      planet: PLANET_HINDI[key],
      rashiName: rashi,
      nakshatraName: nakshatra,
      bhav,
      reading: p ? planetReading(PLANET_HINDI[key], p) : undefined,
    };
  }).filter((r): r is PlanetReading => r !== null);

  const dashas: DashaPeriod[] = (dasha && Array.isArray(dasha.dashas)) ? dasha.dashas : [];
  const activeDasha = dashas.find((d) => d && d.isActive);
  const activeLord = text(activeDasha?.lord);

  const yogaList: Array<{ yogaName?: string; prediction?: string }> = (yogas && Array.isArray(yogas.bhriguYogas))
    ? yogas.bhriguYogas.map((y) => ({ yogaName: text(y?.yogaName), prediction: text(y?.prediction) }))
    : [];

  const summaryParts: string[] = [];
  summaryParts.push("जन्म तिथि " + toDateString(details) + " के आधार पर तैयार वैदिक कुण्डली विश्लेषण।");
  if (lagnaRashi) summaryParts.push("लग्न " + lagnaRashi + (lagnaNakshatra ? " राशि तथा " + lagnaNakshatra + " नक्षत्र में है" : " राशि में है") + "।");
  if (moonRashi) summaryParts.push("जन्म राशि (चंद्र राशि) " + moonRashi + " है।");
  if (sunRashi) summaryParts.push("सूर्य " + sunRashi + " राशि में स्थित है।");
  if (activeLord) summaryParts.push("वर्तमान में " + activeLord + " की महादशा चल रही है।");
  if (yogaList.length > 0) {
    const names = yogaList.map((y) => y.yogaName).filter((n): n is string => typeof n === "string" && n.length > 0).slice(0, 3);
    if (names.length > 0) summaryParts.push("कुण्डली में " + names.join(", ") + " जैसे योग बन रहे हैं।");
  }

  return {
    summary: summaryParts.join(" "),
    lagna: lagna ? { rashiName: lagnaRashi, nakshatraName: lagnaNakshatra, bhav: num(lagna.bhav) } : undefined,
    planets,
    dasha: dasha ? { startingNakshatra: num(dasha.startingNakshatra), active: activeLord, dashas } : undefined,
    panchangSummary: summarizePanchang(panchang),
    ashtakvargaSummary: savSummary(ashtak),
    shadbalaSummary: shadbalaSummary(shadbala),
    yogas: yogaList,
    career: career?.career ? { karaka: text(career.career.karaka), prediction: text(career.career.prediction) } : undefined,
    marriage: career?.marriage ? { karaka: text(career.marriage.karaka), prediction: text(career.marriage.prediction) } : undefined,
    recommendations: buildRecommendations(chart, shadbala),
  };
}
