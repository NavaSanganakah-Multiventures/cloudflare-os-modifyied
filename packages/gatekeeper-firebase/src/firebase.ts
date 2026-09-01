import { WorkerEntrypoint, DurableObject, RpcTarget, RpcStub } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  type AccountDescription,
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
  type ApprovalQueue,
  type ObservationDescription,
  stripTrailingSlashes,
} from "@gadgets/workshop-shared/gatekeeper";
import {
  exchangeAuthCode,
  refreshAccessToken,
  revokeToken,
  getAccountDescription,
  getVerifiedEmail,
  FirebaseManagementApi,
  FirestoreApi,
  FirestoreAdminApi,
  RealtimeDatabaseApi,
  FirebaseAuthApi,
  FirebaseApiError,
  type FirebaseOAuthGrant,
  type FirestoreDocumentData,
  type FirestoreQuery,
  type FirestoreDatabaseResponse,
  type FirebaseProjectResponse,
  type AuthUserResponse,
} from "./firebase-api";
import {
  FirebaseProjectConfiguratorUI,
} from "./firebase-configurators";
import {
  FirebaseProjectSessionImpl,
  FirestoreDatabaseSessionImpl,
  RealtimeDatabaseSessionImpl,
} from "./session-impl";
import type {
  FirebaseProject,
  FirebaseProjectInfo,
  FirebaseValue,
  FirestoreDatabase,
  FirestoreDatabaseInfo,
  FirestoreDocument,
  FirestoreFilter,
  FirestoreQuery as FirestoreQueryType,
  RealtimeDatabase,
  RealtimeDatabaseInfo,
  AuthUser,
} from "./types";
import TYPES_CODE from "./types.txt";
import FIREBASE_LOGO_SVG from "./firebase-logo.svg";
import FIREBASE_PROJECT_CONFIGURATOR_HTML from "./generated/firebase-project-configurator-ui.txt";
import { obsContext } from "./observability.js";

const VENDOR_ID = "firebase";

const logger = obsContext.createLogger({
  component: "gatekeeper.firebase", vendorId: VENDOR_ID,
});

type Env = Cloudflare.Env & {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
};

// ---------------------------------------------------------------------------
// Nonces & helpers

const NONCE_BYTES = 32;
const INITIATION_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const OAUTH_NONCE_LIFETIME_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_SKEW_MS = 60 * 1000;
const CONNECT_TIMEOUT_MS = 60 * 60 * 1000;

type StoredNonce = {
  value: string;
  expiresAt: number;
  stage: "initiation" | "oauth";
};

type StoredToken = {
  token: string;
  expiresAt: number;
};

// Cache TTLs.
const METADATA_CACHE_TTL_MS = 60 * 1000;
const SESSION_TOKEN_TTL_MS = 30 * 1000;

// A pending Firestore action queued for human approval.
type StoredFirestoreAction = {
  kind: "create" | "update" | "delete";
  collectionPath: string;
  documentPath?: string;
  data?: { [field: string]: unknown };
  documentId?: string;
  merge?: boolean;
  submittedAt: number;
};

// A pending Realtime Database action queued for human approval.
type StoredRealtimeAction = {
  kind: "set" | "update" | "push" | "remove";
  path: string;
  value?: unknown;
  submittedAt: number;
};

function hexEncode(bytes: Uint8Array): string {
  return [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function generateNonce(): string {
  return hexEncode(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return crypto.subtle.timingSafeEqual(bufA, bufB);
}

function getBaseUrl(env: Env): string {
  return stripTrailingSlashes(env.BASE_URL ?? "http://localhost:8787/gatekeeper/firebase");
}

function getBasePath(env: Env): string {
  const path = new URL(getBaseUrl(env)).pathname;
  return path === "/" ? "" : path;
}

// ---------------------------------------------------------------------------
// OAuth scopes

const IDENTITY_SCOPES = [
  "openid",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/userinfo.email",
];

const PROJECT_SCOPES = [
  "https://www.googleapis.com/auth/firebase",
  "https://www.googleapis.com/auth/datastore",
];

const FIRESTORE_SCOPES = [
  "https://www.googleapis.com/auth/datastore",
];

const RTDB_SCOPES = [
  "https://www.googleapis.com/auth/firebase.database",
  "https://www.googleapis.com/auth/firebase",
];

const ALL_SCOPES = [...new Set([...IDENTITY_SCOPES, ...PROJECT_SCOPES, ...RTDB_SCOPES])];

function resourceUrlPatternsToScopes(
  patterns?: string[],
): string[] {
  if (!patterns || patterns.length === 0) {
    return ALL_SCOPES;
  }
  const scopes = new Set<string>(IDENTITY_SCOPES);
  for (const pattern of patterns) {
    if (pattern === FIREBASE_PROJECT_RESOURCE.urlPattern) {
      PROJECT_SCOPES.forEach(s => scopes.add(s));
    }
    if (pattern === FIRESTORE_RESOURCE.urlPattern) {
      FIRESTORE_SCOPES.forEach(s => scopes.add(s));
    }
    if (pattern === RTDB_RESOURCE.urlPattern) {
      RTDB_SCOPES.forEach(s => scopes.add(s));
    }
  }
  return [...scopes];
}

// ---------------------------------------------------------------------------
// Resources

const FIREBASE_LOGO_URL = `data:image/svg+xml,${encodeURIComponent(FIREBASE_LOGO_SVG)}`;

const FIREBASE_PROJECT_RESOURCE: SupportedResource = {
  urlPattern: "https://console.firebase.google.com/project/:projectId/*",
  title: "Firebase Project",
  description:
    "Discover and manage a Firebase project — its Firestore databases, Realtime Database instances, and Auth users.",
  icon: { url: FIREBASE_LOGO_URL },
};

const FIRESTORE_RESOURCE: SupportedResource = {
  urlPattern: "https://firestore.googleapis.com/projects/:projectId/databases/:databaseId/*",
  title: "Firestore Database",
  description: "Read and write documents in a Firestore database.",
  icon: { url: FIREBASE_LOGO_URL },
};

const RTDB_RESOURCE: SupportedResource = {
  urlPattern: "https://:projectId-default-rtdb.firebaseio.com/*",
  title: "Realtime Database",
  description: "Read and write JSON data in a Firebase Realtime Database.",
  icon: { url: FIREBASE_LOGO_URL },
};

const SUPPORTED_RESOURCES: SupportedResource[] = [
  FIREBASE_PROJECT_RESOURCE,
  FIRESTORE_RESOURCE,
  RTDB_RESOURCE,
];

// ---------------------------------------------------------------------------
// HTML pages

const SELF_CLOSING_HTML = `<!DOCTYPE html>
<html lang="en">
  <body>
    <script type="text/javascript">window.close();</script>
    <p>Authorization complete. You may close this tab and return to Cloudflare OS.</p>
  </body>
</html>`;

const INVALID_LINK_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Authorization Link Expired</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #b45309; font-size: 1.5rem;">Authorization Link Expired</h1>
      <p style="color: #555; line-height: 1.6;">This authorization link is invalid or has expired. Please return to Cloudflare OS and try again.</p>
    </div>
  </body>
</html>`;

const NOT_CONFIGURED_HTML = `<!DOCTYPE html>
<html lang="en">
  <head><meta charset="UTF-8"><title>Configuration Required</title></head>
  <body style="font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5;">
    <div style="max-width: 520px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); text-align: center;">
      <h1 style="color: #b45309; font-size: 1.5rem;">Firebase Gatekeeper Not Configured</h1>
      <p style="color: #555; line-height: 1.6;">Please configure a Google OAuth client ID and secret for this gatekeeper.</p>
    </div>
  </body>
</html>`;

// ---------------------------------------------------------------------------
// fetch handler — serves the OAuth browser flow

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    let url = new URL(req.url);
    let basePath = getBasePath(env);
    if (!url.pathname.startsWith(basePath + "/") && url.pathname !== basePath) {
      throw new Error(`Request path ${url.pathname} does not match BASE_URL path ${basePath}`);
    }
    let relPath = url.pathname.slice(basePath.length);
    let path = relPath.slice(1).split("/");

    if (path.length === 2 && path[0].length === 64 && path[1].length === NONCE_BYTES * 2) {
      // Auth initiation.
      if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
        return new Response(NOT_CONFIGURED_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      let doId = path[0];
      let initiationNonce = path[1];
      let stub = ctx.exports.UserAccount.get(ctx.exports.UserAccount.idFromString(doId));
      let begun = await stub.beginOAuthFlow(initiationNonce);
      if (begun === null) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      let newUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      newUrl.searchParams.set("client_id", env.CLIENT_ID);
      newUrl.searchParams.set("redirect_uri", getBaseUrl(env) + "/oauth");
      newUrl.searchParams.set("response_type", "code");
      newUrl.searchParams.set("scope", begun.scopes.join(" "));
      newUrl.searchParams.set("access_type", "offline");
      newUrl.searchParams.set("prompt", "consent");
      newUrl.searchParams.set("include_granted_scopes", "true");
      newUrl.searchParams.set("state", `${doId}:${begun.oauthNonce}`);

      return Response.redirect(newUrl.toString(), 302);
    } else if (relPath === "/oauth") {
      // Completion redirect.
      let error = url.searchParams.get("error");
      if (error) {
        return new Response(`${error}: ${url.searchParams.get("error_description")}`);
      }

      let state = url.searchParams.get("state");
      if (!state) return new Response("Error: no 'state' provided");
      let colonIdx = state.indexOf(":");
      if (colonIdx < 0) return new Response("Error: malformed state");
      let doId = state.slice(0, colonIdx);
      let oauthNonce = state.slice(colonIdx + 1);

      let code = url.searchParams.get("code");
      if (!code) return new Response("Error: no 'code' provided");

      let userObjectId = ctx.exports.UserAccount.idFromString(doId);
      let stub = ctx.exports.UserAccount.get(userObjectId);
      if (!await stub.acceptAuthCode(code, oauthNonce)) {
        return new Response(INVALID_LINK_HTML, {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
      return new Response(SELF_CLOSING_HTML, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    } else {
      return new Response("Not Found", { status: 404 });
    }
  },
};

// ---------------------------------------------------------------------------
// GatekeeperVendor — top-level API exposed to the Workshop

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  status() {
    return "Firebase Gatekeeper";
  }

  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Firebase",
      url: "https://firebase.google.com",
      logo: { url: FIREBASE_LOGO_URL },
      color: "#fff8e1",
      tagline: "Query Firestore, read/write Realtime Database, and manage Firebase projects",
      description:
        "Connect your Google account to give Cloudflare OS access to Firebase. Build agents " +
        "that query and manage Firestore databases, read and write Realtime Database JSON, " +
        "and inspect Firebase Auth users across your projects.",
    };
  }

  async connectAccount(
    callback: Fetcher<GatekeeperConnectCallback>,
    options?: GatekeeperConnectOptions,
  ): Promise<{ url: string }> {
    let userObjectId = this.ctx.exports.UserAccount.newUniqueId();
    let initiationNonce = generateNonce();

    let authOnly = options?.scopes === "auth";
    let requestedScopes = authOnly ? IDENTITY_SCOPES : resourceUrlPatternsToScopes(options?.resourceUrlPatterns);
    await this.ctx.exports.UserAccount.get(userObjectId)
      .setCallback(callback, initiationNonce, requestedScopes, authOnly);

    return {
      url: `${getBaseUrl(this.env)}/${userObjectId.toString()}/${initiationNonce}`,
    };
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}

// ---------------------------------------------------------------------------
// UserAccount DO — stores OAuth credentials

export class UserAccount extends DurableObject<Env> {
  #credentialUpdate: Promise<void> = Promise.resolve();
  #mintFailure: { error: Error; at: number } | undefined;

  async #updateCredentials<T>(operation: () => Promise<T>): Promise<T> {
    let previous = this.#credentialUpdate;
    let release!: () => void;
    this.#credentialUpdate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async setCallback(
    callback: Fetcher<GatekeeperConnectCallback>,
    initiationNonce: string,
    requestedScopes: string[],
    ephemeral: boolean,
  ) {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.setAlarm(Date.now() + CONNECT_TIMEOUT_MS);
    }

    this.ctx.storage.kv.put("callback", callback);
    this.ctx.storage.kv.put<string[]>("requestedScopes", requestedScopes);
    this.ctx.storage.kv.put<boolean>("ephemeral", ephemeral);
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: initiationNonce,
      expiresAt: Date.now() + INITIATION_NONCE_LIFETIME_MS,
      stage: "initiation",
    });
  }

  // Begin the OAuth flow: consume the initiation nonce and generate the OAuth nonce + scopes.
  async beginOAuthFlow(
    initiationNonce: string,
  ): Promise<{ scopes: string[]; oauthNonce: string } | null> {
    let nonce = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!nonce || nonce.stage !== "initiation" || Date.now() >= nonce.expiresAt
        || !constantTimeEqual(nonce.value, initiationNonce)) {
      return null;
    }
    let oauthNonce = generateNonce();
    let scopes = this.ctx.storage.kv.get<string[]>("requestedScopes") ?? ALL_SCOPES;
    this.ctx.storage.kv.put<StoredNonce>("nonce", {
      value: oauthNonce,
      expiresAt: Date.now() + OAUTH_NONCE_LIFETIME_MS,
      stage: "oauth",
    });
    return { scopes, oauthNonce };
  }

  // Accept the OAuth callback: exchange the code for tokens.
  async acceptAuthCode(code: string, oauthNonce: string): Promise<boolean> {
    let nonce = this.ctx.storage.kv.get<StoredNonce>("nonce");
    if (!nonce || nonce.stage !== "oauth" || Date.now() >= nonce.expiresAt
        || !constantTimeEqual(nonce.value, oauthNonce)) {
      return false;
    }

    let env = this.env;
    if (!env.CLIENT_ID || !env.CLIENT_SECRET) return false;

    try {
      let grant = await this.#updateCredentials(() =>
        exchangeAuthCode(code, env.CLIENT_ID!, env.CLIENT_SECRET!, getBaseUrl(env) + "/oauth"),
      );
      this.ctx.storage.kv.delete("nonce");
      this.ctx.storage.kv.put<string>("refreshToken", grant.refreshToken);
      this.ctx.storage.kv.put<string[]>("grantedScopes", grant.grantedScopes);
      this.ctx.storage.deleteAlarm();

      let ephemeral = this.ctx.storage.kv.get<boolean>("ephemeral") ?? false;
      let callback = this.ctx.storage.kv.get<Fetcher<GatekeeperConnectCallback>>("callback");
      if (!callback) {
        throw new Error("Authorization timed out. Please try again.");
      }

      if (ephemeral) {
        // Auth-only: extract email, then clean up.
        try {
          let email = await getVerifiedEmail(grant.accessToken);
          if (email) {
            await callback.complete(undefined, email);
          }
        } finally {
          this.ctx.storage.deleteAll();
        }
        return true;
      }

      let props: FirebaseUserImplProps = { userObjectId: this.ctx.id.toString() };
      await callback.complete(this.ctx.exports.FirebaseUserImpl({ props }));
      return true;
    } catch (err) {
      logger.error("failed to complete Firebase auth", { event: "auth.complete.failed", error: err });
      this.ctx.storage.deleteAll();
      throw err;
    }
  }

  async getAccessToken(): Promise<string> {
    let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (!refreshToken) throw new Error("No credentials set.");

    // Return cached token if still fresh.
    let cached = this.ctx.storage.kv.get<StoredToken>("accessToken");
    if (cached && Date.now() < cached.expiresAt - TOKEN_REFRESH_SKEW_MS) {
      return cached.token;
    }

    // Suppress retries during cooldown.
    if (this.#mintFailure && Date.now() - this.#mintFailure.at < 60_000) {
      throw this.#mintFailure.error;
    }

    let env = this.env;
    if (!env.CLIENT_ID || !env.CLIENT_SECRET) {
      throw new Error("Firebase gatekeeper not configured (missing CLIENT_ID/CLIENT_SECRET).");
    }

    return await this.#updateCredentials(async () => {
      try {
        let grant = await refreshAccessToken(refreshToken, env.CLIENT_ID!, env.CLIENT_SECRET!);
        this.ctx.storage.kv.put<StoredToken>("accessToken", {
          token: grant.accessToken,
          expiresAt: Date.now() + grant.expiresIn * 1000,
        });
        if (grant.grantedScopes.length > 0) {
          this.ctx.storage.kv.put<string[]>("grantedScopes", grant.grantedScopes);
        }
        this.#mintFailure = undefined;
        return grant.accessToken;
      } catch (err) {
        if (err instanceof FirebaseApiError && err.isAuthError) {
          this.#mintFailure = { error: err as Error, at: Date.now() };
        }
        throw err;
      }
    });
  }

  async getGrantedScopes(): Promise<string[]> {
    return this.ctx.storage.kv.get<string[]>("grantedScopes") ?? [];
  }

  async revoke(): Promise<void> {
    let refreshToken = this.ctx.storage.kv.get<string>("refreshToken");
    if (refreshToken) {
      try {
        await revokeToken(refreshToken);
      } catch (err) {
        logger.warn("failed to revoke Firebase token", { event: "token.revoke.failed", error: err });
      }
    }
    this.ctx.storage.deleteAlarm();
    this.ctx.storage.deleteAll();
  }

  async alarm() {
    if (!this.ctx.storage.kv.get<string>("refreshToken")) {
      this.ctx.storage.deleteAll();
    }
  }
}

// ---------------------------------------------------------------------------
// FirebaseUserImpl — maps resource URLs to gatekeeper DO classes

type FirebaseUserImplProps = {
  userObjectId: string;
};

type ResourceKind = "project" | "firestore" | "rtdb";

type FirebaseGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: ResourceKind;
  projectId?: string;
  databaseId?: string;
  instanceUrl?: string;
};

@validateRpc()
export class FirebaseUserImpl extends WorkerEntrypoint<Env, FirebaseUserImplProps>
  implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    let token = await this.ctx.exports.UserAccount.get(id).getAccessToken();
    return await getAccountDescription(token);
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return SUPPORTED_RESOURCES;
  }

  async startResourceConfigurator(
    resourceUrlPattern: string,
  ): Promise<ResourceConfiguratorFrame> {
    if (resourceUrlPattern === FIREBASE_PROJECT_RESOURCE.urlPattern) {
      let getToken = async () => {
        let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
        return await this.ctx.exports.UserAccount.get(id).getAccessToken();
      };
      return {
        iframeHtml: FIREBASE_PROJECT_CONFIGURATOR_HTML,
        ui: new RpcStub(new FirebaseProjectConfiguratorUI(getToken)),
      };
    }
    throw new Error(`Unsupported resource configurator type: ${resourceUrlPattern}`);
  }

  async getGatekeeperClassFor(url: string): Promise<{
    class: DurableObjectClass<Gatekeeper<any>>;
    resource: SupportedResource;
  }> {
    let parsed = new URL(url);

    if (parsed.hostname === "console.firebase.google.com"
        && parsed.pathname.startsWith("/project/")) {
      let projectId = decodeURIComponent(parsed.pathname.split("/")[2] ?? "");
      if (!projectId) throw new Error("Invalid Firebase Project URL: no project ID found");
      let props: FirebaseGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        resourceKind: "project",
        projectId,
      };
      return {
        class: this.ctx.exports.FirebaseGatekeeperImpl({ props }),
        resource: FIREBASE_PROJECT_RESOURCE,
      };
    }

    if (parsed.hostname === "firestore.googleapis.com") {
      let segments = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean)
        .map(s => decodeURIComponent(s));
      // Expected: projects/:projectId/databases/:databaseId/...
      if (segments[0] !== "projects" || segments[2] !== "databases") {
        throw new Error("Invalid Firestore URL: expected /projects/:projectId/databases/:databaseId/");
      }
      let projectId = segments[1];
      let databaseId = segments[3] ?? "(default)";
      let props: FirebaseGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        resourceKind: "firestore",
        projectId,
        databaseId,
      };
      return {
        class: this.ctx.exports.FirebaseGatekeeperImpl({ props }),
        resource: FIRESTORE_RESOURCE,
      };
    }

    if (parsed.hostname.endsWith(".firebaseio.com")) {
      let projectId = parsed.hostname.replace(/\.firebaseio\.com$/, "").replace(/-default-rtdb$/, "");
      let instanceUrl = `${parsed.protocol}//${parsed.host}`;
      let props: FirebaseGatekeeperImplProps = {
        userObjectId: this.ctx.props.userObjectId,
        resourceKind: "rtdb",
        projectId,
        instanceUrl,
      };
      return {
        class: this.ctx.exports.FirebaseGatekeeperImpl({ props }),
        resource: RTDB_RESOURCE,
      };
    }

    throw new Error(`Unsupported Firebase resource URL: ${url}`);
  }

  async revoke(): Promise<void> {
    let id = this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId);
    await this.ctx.exports.UserAccount.get(id).revoke();
  }

  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }

  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    let props: FirebaseVerifierProps = { userObjectId: this.ctx.props.userObjectId };
    return this.ctx.exports.FirebaseVerifier({ props });
  }
}

// ---------------------------------------------------------------------------
// Verifier — answers "can this observer access X?"

export interface FirebaseVerifierApi extends GatekeeperUserVerifier {
  hasProjectAccess(projectId: string): Promise<boolean>;
}

type FirebaseVerifierProps = {
  userObjectId: string;
};

@validateRpc()
export class FirebaseVerifier extends WorkerEntrypoint<Env, FirebaseVerifierProps>
  implements FirebaseVerifierApi {
  async hasProjectAccess(projectId: string): Promise<boolean> {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    try {
      let token = await account.getAccessToken();
      let mgmt = new FirebaseManagementApi(token);
      await mgmt.getProject(projectId);
      return true;
    } catch (err) {
      if (err instanceof FirebaseApiError && (err.status === 401 || err.status === 403 || err.status === 404)) {
        return false;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------
// FirebaseGatekeeperImpl DO — per-resource instance

export class FirebaseGatekeeperImpl extends DurableObject<Env, FirebaseGatekeeperImplProps>
  implements Gatekeeper<any> {

  async describe(): Promise<ResourceDescription> {
    if (this.ctx.props.resourceKind === "project") {
      return {
        url: `https://console.firebase.google.com/project/${this.ctx.props.projectId}`,
        title: `Firebase Project: ${this.ctx.props.projectId}`,
        snippet: "Firestore, Realtime Database, and Auth access for a Firebase project.",
        suggestedBindingName: "FIREBASE_PROJECT",
        tsType: "FirebaseProject",
      };
    }
    if (this.ctx.props.resourceKind === "firestore") {
      return {
        url: `https://firestore.googleapis.com/projects/${this.ctx.props.projectId}/databases/${this.ctx.props.databaseId}`,
        title: `Firestore: ${this.ctx.props.databaseId}`,
        snippet: `Firestore database (${this.ctx.props.databaseId}) in project ${this.ctx.props.projectId}`,
        suggestedBindingName: "FIRESTORE_DB",
        tsType: "FirestoreDatabase",
      };
    }
    return {
      url: this.ctx.props.instanceUrl ?? "",
      title: "Realtime Database",
      snippet: `Realtime Database in project ${this.ctx.props.projectId}`,
      suggestedBindingName: "RTDB",
      tsType: "RealtimeDatabase",
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions() {
    return [];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<any> {
    let tokenGetter = () => this.getToken();
    let dup = approvalQueue.dup();

    if (this.ctx.props.resourceKind === "project") {
      return new FirebaseProjectSessionImpl(
        dup, this.ctx, tokenGetter,
      );
    }
    if (this.ctx.props.resourceKind === "firestore") {
      return new FirestoreDatabaseSessionImpl(
        dup, this.ctx, tokenGetter,
      );
    }
    return new RealtimeDatabaseSessionImpl(
      dup, this.ctx, tokenGetter,
    );
  }

  private async getToken(): Promise<string> {
    let account = this.ctx.exports.UserAccount.get(
      this.ctx.exports.UserAccount.idFromString(this.ctx.props.userObjectId));
    return await account.getAccessToken();
  }

  async applyAction(actionId: number): Promise<void> {
    let stored = this.ctx.storage.kv.get<StoredFirestoreAction | StoredRealtimeAction>(`action:${actionId}`);
    if (!stored) throw new Error(`Unknown action: ${actionId}`);

    let token = await this.getToken();

    if ("collectionPath" in stored) {
      let firestore = new FirestoreApi(token, this.ctx.props.projectId!, this.ctx.props.databaseId ?? "(default)");
      if (stored.kind === "create") {
        await firestore.createDocument(stored.collectionPath, stored.data ?? {}, stored.documentId);
      } else if (stored.kind === "update") {
        await firestore.updateDocument(stored.documentPath!, stored.data ?? {}, stored.merge ?? true);
      } else if (stored.kind === "delete") {
        await firestore.deleteDocument(stored.documentPath!);
      }
    } else {
      let rtdb = new RealtimeDatabaseApi(token, this.ctx.props.instanceUrl!);
      if (stored.kind === "set") {
        await rtdb.set(stored.path, stored.value);
      } else if (stored.kind === "update") {
        await rtdb.update(stored.path, stored.value as { [key: string]: unknown });
      } else if (stored.kind === "push") {
        await rtdb.push(stored.path, stored.value);
      } else if (stored.kind === "remove") {
        await rtdb.remove(stored.path);
      }
    }

    this.ctx.storage.kv.delete(`action:${actionId}`);
    // Invalidate cache after action.
    this.ctx.storage.kv.delete("firestoreCache");
    this.ctx.storage.kv.delete("rtdbCache");
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    this.ctx.storage.kv.delete(`action:${actionId}`);
  }

  async revertAction(actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    // Firestore/RTDB operations are not auto-reversible.
    this.ctx.storage.kv.delete(`action:${actionId}`);
    return { message: "Revert not supported for Firebase operations.", canRetry: false };
  }

  // Observer verification — Strategy B.
  async addObserver(_id: string, user: Fetcher<GatekeeperUserVerifier>): Promise<void> {
    let verifier = user as unknown as Fetcher<FirebaseVerifierApi>;
    if (!(await verifier.hasProjectAccess(this.ctx.props.projectId ?? ""))) {
      throw new Error(
        "This collaborator does not have access to the bound Firebase project, so they cannot " +
        "observe data the Gadget read from it.",
      );
    }
  }

  async removeObserver(_id: string): Promise<void> {}
}
