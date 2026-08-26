import "cloudflare:workers";

/**
 * Thin wrapper around the Firebase Management REST API, Firestore REST API, Realtime Database
 * REST API, and Firebase Auth REST API, plus helpers for the Google OAuth2 authorization-code
 * flow. All access is performed with an OAuth bearer access token (same Google OAuth2 endpoints
 * as the Google gatekeeper).
 */

// ---------------------------------------------------------------------------
// OAuth2 endpoints (Google — Firebase is a Google service)

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const USERINFO_URL = "https://www.googleapis.com/oauth2/v3/userinfo";
const USER_AGENT = "Cloudflare-Gadgets";
const REQUEST_TIMEOUT_MS = 30_000;

// Firestore REST API base.
const FIRESTORE_API_BASE = "https://firestore.googleapis.com/v1";

// Firebase Management REST API base.
const FIREBASE_MGMT_BASE = "https://firebase.googleapis.com/v1beta1";

// Firebase Auth REST API base.
const FIREBASE_AUTH_BASE = "https://identitytoolkit.googleapis.com/v2";

// Cap on list results to protect the RPC channel.
const MAX_LIST_RESULTS = 1000;

// ---------------------------------------------------------------------------
// Types

/** Result of an OAuth token exchange or refresh. */
export type FirebaseOAuthGrant = {
  accessToken: string;
  refreshToken: string;
  /** Seconds until the access token expires. */
  expiresIn: number;
  tokenType: string;
  /** Scopes actually granted by the user. */
  grantedScopes: string[];
};

export class FirebaseApiError extends Error {
  status: number;
  details?: unknown;
  isAuthError: boolean;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "FirebaseApiError";
    this.status = status;
    this.details = details;
    const invalidGrant = status === 400
      && typeof (details as { error?: string } | undefined)?.error === "string"
      && (details as { error?: string }).error === "invalid_grant";
    this.isAuthError = status === 401 || status === 403 || invalidGrant;
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204) return undefined;
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return await response.json();
  }
  return await response.text();
}

function errorMessage(status: number, statusText: string, parsed: unknown): string {
  if (typeof parsed === "string" && parsed.length > 0) return parsed;
  if (parsed && typeof parsed === "object") {
    const obj = parsed as {
      message?: string;
      error?: { message?: string } | string;
      error_description?: string;
    };
    const msg = obj.message
      ?? (typeof obj.error === "object" ? obj.error?.message : obj.error)
      ?? obj.error_description;
    if (msg) return msg;
  }
  return `${status} ${statusText}`;
}

// ---------------------------------------------------------------------------
// Firestore field codec

/**
 * Firestore stores values in a typed envelope (e.g. { stringValue: "x" }).
 * These converters translate between that format and plain JSON.
 */

export type FirestoreFieldValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { bytesValue: string }
  | { referenceValue: string }
  | { geoPointValue: { latitude: number; longitude: number } }
  | { arrayValue: { values: FirestoreFieldValue[] } }
  | { mapValue: { fields: { [key: string]: FirestoreFieldValue } } };

/** Encode a plain JSON value into Firestore's typed field value format. */
export function encodeFirestoreValue(value: unknown): FirestoreFieldValue {
  if (value === null) return { nullValue: null };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    if (Number.isInteger(value)) return { integerValue: String(value) };
    return { doubleValue: value };
  }
  if (typeof value === "string") return { stringValue: value };
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(encodeFirestoreValue) } };
  }
  if (value instanceof Date) {
    return { timestampValue: value.toISOString() };
  }
  if (typeof value === "object" && value !== null) {
    const fields: { [key: string]: FirestoreFieldValue } = {};
    for (const [k, v] of Object.entries(value)) {
      fields[k] = encodeFirestoreValue(v);
    }
    return { mapValue: { fields } };
  }
  throw new Error(`Cannot encode value of type ${typeof value} for Firestore`);
}

/** Decode Firestore's typed field value format back into plain JSON. */
export function decodeFirestoreValue(field: FirestoreFieldValue): unknown {
  if ("nullValue" in field) return null;
  if ("booleanValue" in field) return field.booleanValue;
  if ("integerValue" in field) return Number(field.integerValue);
  if ("doubleValue" in field) return field.doubleValue;
  if ("stringValue" in field) return field.stringValue;
  if ("timestampValue" in field) return new Date(field.timestampValue);
  if ("bytesValue" in field) return field.bytesValue;
  if ("referenceValue" in field) return field.referenceValue;
  if ("geoPointValue" in field) return field.geoPointValue;
  if ("arrayValue" in field) return field.arrayValue.values.map(decodeFirestoreValue);
  if ("mapValue" in field) {
    const result: { [key: string]: unknown } = {};
    for (const [k, v] of Object.entries(field.mapValue.fields)) {
      result[k] = decodeFirestoreValue(v);
    }
    return result;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Firestore document type

export type FirestoreDocumentResponse = {
  name: string;
  fields: { [key: string]: FirestoreFieldValue };
  createTime?: string;
  updateTime?: string;
};

export type FirestoreDocumentData = {
  id: string;
  path: string;
  data: { [field: string]: unknown };
  createTime?: Date;
  updateTime?: Date;
};

/** Convert a Firestore REST API document response to our simplified format. */
export function toFirestoreDocument(
  doc: FirestoreDocumentResponse,
  collectionPath: string,
): FirestoreDocumentData {
  const id = doc.name.split("/").pop() ?? "";
  const data: { [key: string]: unknown } = {};
  for (const [k, v] of Object.entries(doc.fields ?? {})) {
    data[k] = decodeFirestoreValue(v);
  }
  return {
    id,
    path: `${collectionPath}/${id}`,
    data,
    createTime: doc.createTime ? new Date(doc.createTime) : undefined,
    updateTime: doc.updateTime ? new Date(doc.updateTime) : undefined,
  };
}

// ---------------------------------------------------------------------------
// OAuth2 functions (Google OAuth — same as the Google gatekeeper)

/** Exchange an authorization code for access + refresh tokens. */
export async function exchangeAuthCode(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
): Promise<FirebaseOAuthGrant> {
  const params = new URLSearchParams();
  params.set("code", code);
  params.set("client_id", clientId);
  params.set("client_secret", clientSecret);
  params.set("redirect_uri", redirectUri);
  params.set("grant_type", "authorization_code");

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: params,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const parsed = await parseBody(response);
  if (!response.ok) {
    throw new FirebaseApiError(
      response.status,
      errorMessage(response.status, response.statusText, parsed),
      parsed,
    );
  }

  const body = parsed as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  if (!body.access_token || !body.refresh_token) {
    throw new FirebaseApiError(400, "Firebase OAuth token response was missing tokens.", parsed);
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresIn: body.expires_in ?? 3600,
    tokenType: body.token_type ?? "Bearer",
    grantedScopes: typeof body.scope === "string"
      ? body.scope.split(" ").filter(Boolean)
      : [],
  };
}

/** Refresh an access token using a refresh token. */
export async function refreshAccessToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<FirebaseOAuthGrant> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const parsed = await parseBody(response);
  if (!response.ok) {
    throw new FirebaseApiError(
      response.status,
      errorMessage(response.status, response.statusText, parsed),
      parsed,
    );
  }

  const body = parsed as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
    scope?: string;
  };
  if (!body.access_token) {
    throw new FirebaseApiError(400, "Firebase token refresh response was missing access token.", parsed);
  }

  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? refreshToken,
    expiresIn: body.expires_in ?? 3600,
    tokenType: body.token_type ?? "Bearer",
    grantedScopes: typeof body.scope === "string"
      ? body.scope.split(" ").filter(Boolean)
      : [],
  };
}

/** Revoke a refresh token. Best-effort. */
export async function revokeToken(refreshToken: string): Promise<void> {
  const body = new URLSearchParams();
  body.append("token", refreshToken);

  await fetch(REVOKE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": USER_AGENT,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

export type FirebaseAccountDescription = {
  displayName: string;
  uniqueName: string;
  avatar: { url: string };
};

/** Fetch account info (name, email, avatar) using the access token. */
export async function getAccountDescription(
  accessToken: string,
): Promise<FirebaseAccountDescription> {
  const response = await fetch(USERINFO_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new FirebaseApiError(
      response.status,
      `Failed to fetch user info: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json() as {
    name?: string;
    email?: string;
    picture?: string;
  };

  return {
    displayName: data.name ?? data.email ?? "Firebase User",
    uniqueName: data.email ?? "",
    avatar: { url: data.picture ?? "" },
  };
}

/** Fetch the verified email for sign-in identity. Returns null if unverified. */
export async function getVerifiedEmail(accessToken: string): Promise<string | null> {
  const response = await fetch(USERINFO_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) return null;

  const data = await response.json() as {
    email?: string;
    email_verified?: boolean;
  };
  if (!data.email || data.email_verified !== true) return null;
  return data.email;
}

// ---------------------------------------------------------------------------
// Firebase Management API

export type FirebaseProjectResponse = {
  projectId: string;
  displayName: string;
  resources?: {
    hosting?: string;
    realtimeDatabase?: string;
    firestore?: string;
  };
  state?: string;
};

export type FirestoreDatabaseResponse = {
  name: string;
  uid: string;
  locationId: string;
  type: string;
  createTime?: string;
};

export class FirebaseManagementApi {
  constructor(private token: string) {}

  private async request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${FIREBASE_MGMT_BASE}/${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...init?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = await parseBody(response);
    if (!response.ok) {
      throw new FirebaseApiError(
        response.status,
        errorMessage(response.status, response.statusText, parsed),
        parsed,
      );
    }
    return parsed;
  }

  /** Lists all Firebase projects the user has access to. */
  async listProjects(): Promise<FirebaseProjectResponse[]> {
    const result = await this.request("projects") as {
      results?: FirebaseProjectResponse[];
    };
    return result.results ?? [];
  }

  /** Gets a single Firebase project by ID. */
  async getProject(projectId: string): Promise<FirebaseProjectResponse> {
    return await this.request(`projects/${projectId}`) as FirebaseProjectResponse;
  }
}

// ---------------------------------------------------------------------------
// Firestore REST API

export type FirestoreFilter = {
  field: string;
  op: string;
  value: unknown;
};

export type FirestoreQuery = {
  where?: FirestoreFilter[];
  orderBy?: { field: string; direction: "asc" | "desc" }[];
  limit?: number;
};

export class FirestoreApi {
  constructor(
    private token: string,
    private projectId: string,
    private databaseId: string,
  ) {}

  private get documentsBase(): string {
    return `${FIRESTORE_API_BASE}/projects/${this.projectId}/databases/${this.databaseId}/documents`;
  }

  private async request(url: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        ...init?.headers,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = await parseBody(response);
    if (!response.ok) {
      throw new FirebaseApiError(
        response.status,
        errorMessage(response.status, response.statusText, parsed),
        parsed,
      );
    }
    return parsed;
  }

  /** Lists documents in a collection. */
  async listDocuments(
    collectionPath: string,
    limit: number,
  ): Promise<FirestoreDocumentData[]> {
    const params = new URLSearchParams();
    params.set("pageSize", String(Math.min(limit, MAX_LIST_RESULTS)));
    const result = await this.request(`${this.documentsBase}/${collectionPath}?${params}`) as {
      documents?: FirestoreDocumentResponse[];
    };
    return (result.documents ?? []).map(doc => toFirestoreDocument(doc, collectionPath));
  }

  /** Gets a single document by full path (collection/docId). */
  async getDocument(documentPath: string): Promise<FirestoreDocumentData> {
    const collectionPath = documentPath.split("/").slice(0, -1).join("/");
    const doc = await this.request(`${this.documentsBase}/${documentPath}`) as FirestoreDocumentResponse;
    return toFirestoreDocument(doc, collectionPath);
  }

  /** Creates a document. */
  async createDocument(
    collectionPath: string,
    data: { [field: string]: unknown },
    documentId?: string,
  ): Promise<FirestoreDocumentData> {
    const fields: { [key: string]: FirestoreFieldValue } = {};
    for (const [k, v] of Object.entries(data)) {
      fields[k] = encodeFirestoreValue(v);
    }
    const params = new URLSearchParams();
    if (documentId) params.set("documentId", documentId);
    const url = `${this.documentsBase}/${collectionPath}${params.toString() ? "?" + params : ""}`;
    const doc = await this.request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    }) as FirestoreDocumentResponse;
    return toFirestoreDocument(doc, collectionPath);
  }

  /** Updates (or replaces) a document. */
  async updateDocument(
    documentPath: string,
    data: { [field: string]: unknown },
    merge: boolean,
  ): Promise<FirestoreDocumentData> {
    const fields: { [key: string]: FirestoreFieldValue } = {};
    for (const [k, v] of Object.entries(data)) {
      fields[k] = encodeFirestoreValue(v);
    }
    const collectionPath = documentPath.split("/").slice(0, -1).join("/");
    const params = new URLSearchParams();
    if (merge) {
      const fieldPaths = Object.keys(data).map(encodeURIComponent).join(",");
      params.set("updateMask.fieldPaths", fieldPaths);
    }
    const url = `${this.documentsBase}/${documentPath}${params.toString() ? "?" + params : ""}`;
    const doc = await this.request(url, {
      method: merge ? "PATCH" : "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fields }),
    }) as FirestoreDocumentResponse;
    return toFirestoreDocument(doc, collectionPath);
  }

  /** Deletes a document. */
  async deleteDocument(documentPath: string): Promise<void> {
    await this.request(`${this.documentsBase}/${documentPath}`, {
      method: "DELETE",
    });
  }

  /** Runs a structured query against a collection. */
  async runQuery(
    collectionPath: string,
    query: FirestoreQuery,
  ): Promise<FirestoreDocumentData[]> {
    const structuredQuery: Record<string, unknown> = {
      from: [{ collectionId: collectionPath.split("/").pop() }],
    };

    if (query.where && query.where.length > 0) {
      if (query.where.length === 1) {
        structuredQuery.where = this.buildFilter(query.where[0]);
      } else {
        structuredQuery.where = {
          compositeFilter: {
            op: "AND",
            filters: query.where.map(f => this.buildFilter(f)),
          },
        };
      }
    }

    if (query.orderBy && query.orderBy.length > 0) {
      structuredQuery.orderBy = query.orderBy.map(o => ({
        field: { fieldPath: o.field },
        direction: o.direction === "asc" ? "ASCENDING" : "DESCENDING",
      }));
    }

    if (query.limit) {
      structuredQuery.limit = { value: query.limit };
    }

    const result = await this.request(
      `${this.documentsBase}:runQuery`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ structuredQuery }),
      },
    ) as Array<{
      document?: FirestoreDocumentResponse;
    }>;

    return (Array.isArray(result) ? result : [])
      .filter(entry => entry.document)
      .map(entry => toFirestoreDocument(entry.document!, collectionPath));
  }

  private buildFilter(filter: FirestoreFilter): Record<string, unknown> {
    return {
      fieldFilter: {
        field: { fieldPath: filter.field },
        op: this.mapOperator(filter.op),
        value: encodeFirestoreValue(filter.value),
      },
    };
  }

  private mapOperator(op: string): string {
    const operators: Record<string, string> = {
      "==": "EQUAL",
      "!=": "NOT_EQUAL",
      "<": "LESS_THAN",
      "<=": "LESS_THAN_OR_EQUAL",
      ">": "GREATER_THAN",
      ">=": "GREATER_THAN_OR_EQUAL",
      "array-contains": "ARRAY_CONTAINS",
      "array-contains-any": "ARRAY_CONTAINS_ANY",
      "in": "IN",
      "not-in": "NOT_IN",
    };
    return operators[op] ?? op.toUpperCase();
  }
}

// ---------------------------------------------------------------------------
// Firestore Admin API (list databases)

export class FirestoreAdminApi {
  constructor(private token: string, private projectId: string) {}

  /** Lists Firestore databases in the project. */
  async listDatabases(): Promise<FirestoreDatabaseResponse[]> {
    const response = await fetch(
      `${FIRESTORE_API_BASE}/projects/${this.projectId}/databases`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    if (response.status === 404) return [];
    const parsed = await parseBody(response);
    if (!response.ok) {
      throw new FirebaseApiError(
        response.status,
        errorMessage(response.status, response.statusText, parsed),
        parsed,
      );
    }
    const body = parsed as { databases?: FirestoreDatabaseResponse[] };
    return body.databases ?? [];
  }
}

// ---------------------------------------------------------------------------
// Realtime Database REST API

export class RealtimeDatabaseApi {
  constructor(
    private token: string,
    private instanceUrl: string,
  ) {
    // Normalize: remove trailing slash
    this.instanceUrl = instanceUrl.replace(/\/+$/, "");
  }

  private url(path: string): string {
    const cleanPath = path.replace(/^\/+/, "");
    const base = this.instanceUrl;
    const separator = cleanPath ? "/" : "";
    return `${base}${separator}${cleanPath}.json?auth=${encodeURIComponent(this.token)}`;
  }

  async get(path: string): Promise<unknown> {
    const response = await fetch(this.url(path), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return null;
    const parsed = await parseBody(response);
    if (!response.ok) {
      throw new FirebaseApiError(
        response.status,
        errorMessage(response.status, response.statusText, parsed),
        parsed,
      );
    }
    return parsed;
  }

  async set(path: string, value: unknown): Promise<void> {
    const response = await fetch(this.url(path), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const parsed = await parseBody(response);
      throw new FirebaseApiError(
        response.status,
        errorMessage(response.status, response.statusText, parsed),
        parsed,
      );
    }
  }

  async update(path: string, value: { [key: string]: unknown }): Promise<void> {
    const response = await fetch(this.url(path), {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const parsed = await parseBody(response);
      throw new FirebaseApiError(
        response.status,
        errorMessage(response.status, response.statusText, parsed),
        parsed,
      );
    }
  }

  async push(path: string, value: unknown): Promise<string> {
    const response = await fetch(this.url(path), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
      },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const parsed = await parseBody(response);
    if (!response.ok) {
      throw new FirebaseApiError(
        response.status,
        errorMessage(response.status, response.statusText, parsed),
        parsed,
      );
    }
    return (parsed as { name: string }).name;
  }

  async remove(path: string): Promise<void> {
    const response = await fetch(this.url(path), {
      method: "DELETE",
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const parsed = await parseBody(response);
      throw new FirebaseApiError(
        response.status,
        errorMessage(response.status, response.statusText, parsed),
        parsed,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Firebase Auth REST API

export type AuthUserResponse = {
  localId: string;
  email?: string;
  displayName?: string;
  disabled?: boolean;
  createdAt?: string;
  lastLoginAt?: string;
};

export class FirebaseAuthApi {
  constructor(private token: string, private projectId: string) {}

  /** Lists Firebase Auth users. */
  async listUsers(maxResults: number): Promise<AuthUserResponse[]> {
    const limit = Math.min(maxResults, 1000);
    const response = await fetch(
      `${FIREBASE_AUTH_BASE}/projects/${this.projectId}/accounts:batchGet?maxResults=${limit}`,
      {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: "application/json",
          "User-Agent": USER_AGENT,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    );
    const parsed = await parseBody(response);
    if (!response.ok) {
      throw new FirebaseApiError(
        response.status,
        errorMessage(response.status, response.statusText, parsed),
        parsed,
      );
    }
    const body = parsed as { users?: AuthUserResponse[] };
    return body.users ?? [];
  }
}
