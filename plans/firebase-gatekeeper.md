# Firebase Gatekeeper — Implementation Plan

> **Goal:** Add a new `gatekeeper-firebase` package that bridges Gadgets to Google Firebase
> (Firestore, Realtime Database, Firebase Auth, and project management) via the Firebase REST
> APIs, using Google OAuth 2.0 for authentication.

---

## 1. Background: Why a Separate Package

Firebase is a **Google service**, so it uses the same Google OAuth 2.0 endpoints as the existing
`gatekeeper-google` package (`accounts.google.com` for authorization, `oauth2.googleapis.com`
for token exchange). However, it is a **distinct product family** with its own APIs, resource
types, and OAuth scopes. The existing Google gatekeeper has **zero** references to Firebase and
handles Gmail, Docs, Sheets, Calendar, and BigQuery. Adding Firebase there would bloat that
package. Instead, we create a separate `packages/gatekeeper-firebase/` package.

The OAuth client app can be **shared** with the Google gatekeeper (same `CLIENT_ID` /
`CLIENT_SECRET`) or a **separate** Firebase-specific OAuth app. The gatekeeper reads
`CLIENT_ID` / `CLIENT_SECRET` from its own env vars, so either approach works.

---

## 2. Firebase REST APIs to Use

All Firebase APIs accept a Google OAuth 2.0 **Bearer access token** (obtained via the standard
Google refresh-token flow).

| Surface | REST Endpoint | Purpose |
|---|---|---|
| **Firebase Management** | `firebase.googleapis.com/v1beta1/projects` | List Firebase projects, get project info, list web apps |
| **Firestore** | `firestore.googleapis.com/v1/projects/{p}/databases/{db}/documents/{c}` | Document CRUD (get, list, create, update, delete) |
| **Firestore Query** | `firestore.googleapis.com/v1/.../documents:runQuery` | Structured queries (where, orderBy, limit) |
| **Firestore Admin** | `firestore.googleapis.com/v1/.../databases` | List databases in a project |
| **Realtime Database** | `https://{projectId}-default-rtdb.firebaseio.com/.json` | JSON CRUD (GET/PUT/PATCH/DELETE) |
| **Firebase Auth** | `identitytoolkit.googleapis.com/v2/projects/{p}/accounts` | List/search auth users |

### OAuth Scopes (requested per resource type)

| Scope | Used For |
|---|---|
| `openid`, `userinfo.profile`, `userinfo.email` | Account identity (always) |
| `https://www.googleapis.com/auth/firebase` | Firebase Management API (list projects, databases) |
| `https://www.googleapis.com/auth/datastore` | Firestore read + write |
| `https://www.googleapis.com/auth/firebase.database` | Realtime Database read + write |

---

## 3. Resource Granularities (SupportedResource)

Three resource URL patterns, modeled on the Supabase project/org split:

### 3a. Firebase Project (broad)
- **Pattern:** `https://console.firebase.google.com/project/:projectId/*`
- **Description:** "Discover and manage a Firebase project — its Firestore databases, Realtime
  Database instances, and auth users."
- **Session API:** `FirebaseProject` — list databases, open a Firestore database, open an RTDB
  instance, list auth users.

### 3b. Firestore Database (narrow, recommended)
- **Pattern:** `https://firestore.googleapis.com/projects/:projectId/databases/:databaseId/*`
- **Description:** "Read and write documents in a Firestore database."
- **Session API:** `FirestoreDatabase` — document CRUD, collection listing, structured queries.
- This is the primary capability (analogous to Supabase's `SupabaseDatabase`).

### 3c. Realtime Database (narrow)
- **Pattern:** `https://:projectId-default-rtdb.firebaseio.com/*`
- **Description:** "Read and write JSON data in a Firebase Realtime Database."
- **Session API:** `RealtimeDatabase` — JSON path CRUD, listen (optional hook).

---

## 4. Files to Create

### `packages/gatekeeper-firebase/` directory structure

```
packages/gatekeeper-firebase/
├── package.json
├── wrangler.jsonc
├── tsconfig.json
├── worker-configuration.d.ts
├── README.md
└── src/
    ├── firebase.ts                 # Main: Vendor, UserAccount, UserImpl, GatekeeperImpl, SessionImpl, fetch handler
    ├── firebase-api.ts             # Firebase Management + Firestore REST API wrapper
    ├── firebase-introspection.ts   # (optional) Firestore collection/schema listing helpers
    ├── types.d.ts                  # Agent-facing Session types (FirestoreDatabase, FirebaseProject, RealtimeDatabase)
    ├── types.txt → types.d.ts      # Symlink for runtime getTypeScriptTypes()
    ├── firebase-logo.svg           # Firebase logo as data URL
    ├── observability.ts            # createObservabilityContext + logger
    └── configurator/
        ├── firebase-project-configurator-types.d.ts
        └── firebase-project-configurator-ui.tsx
```

### 4a. `package.json`
```json
{
  "name": "@gadgets/firebase-gatekeeper",
  "version": "1.0.0",
  "type": "module",
  "main": "./src/firebase.ts",
  "scripts": {
    "dev": "echo \"run 'pnpm dev-server' in the root directory instead\" >&2 && exit 1",
    "build:configurator": "node ../../scripts/build-gatekeeper-configurator.mjs .",
    "deploy": "pnpm run build:configurator && wrangler deploy",
    "build": "pnpm run build:configurator && tsc",
    "types:check": "pnpm run build:configurator && tsc --noEmit",
    "clean": "rm -rf dist src/generated"
  },
  "dependencies": {
    "@gadgets/backend-utils": "workspace:*",
    "@gadgets/configurator-ui": "workspace:*",
    "@gadgets/workshop-shared": "workspace:*",
    "capnweb": "^0.8.0",
    "capnweb-validate": "0.2.1"
  },
  "devDependencies": {
    "typescript": "^5.9.3",
    "wrangler": "^4.119.0"
  }
}
```

### 4b. `wrangler.jsonc`
```jsonc
{
  "name": "cloudflareos-gk-firebase",
  "main": ".wrangler/validate/src/firebase.ts",
  "build": {
    "command": "pnpm exec capnweb-validate build --out .wrangler/validate",
    "watch_dir": "src"
  },
  "compatibility_date": "2026-02-02",
  "compatibility_flags": ["allow_irrevocable_stub_storage", "nodejs_als"],
  "rules": [
    { "type": "Text", "globs": ["**/*.txt", "**/*.svg"], "fallthrough": false }
  ],
  "migrations": [
    {
      "tag": "v0",
      "new_sqlite_classes": ["UserAccount", "FirebaseGatekeeperImpl"]
    }
  ],
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "logs": { "invocation_logs": false }
  }
}
```
> If multiple GatekeeperImpl classes are added (one per resource type), add each to
> `new_sqlite_classes` in a new migration tag.

### 4c. `tsconfig.json`
Copy from `packages/gatekeeper-supabase/tsconfig.json` verbatim (same paths, same settings).

### 4d. `worker-configuration.d.ts`
```typescript
interface Cloudflare.Env {
  BASE_URL?: string;
  CLIENT_ID?: string;
  CLIENT_SECRET?: string;
}
```

### 4e. `src/observability.ts`
```typescript
import { createObservabilityContext } from "@gadgets/backend-utils/observability-context";

export type FirebaseObservabilityFields = { vendorId: string };
export const obsContext = createObservabilityContext<FirebaseObservabilityFields>();
```

### 4f. `src/types.d.ts` — Agent-Facing Session API

This is the most important file. Design it carefully and **STOP for review before implementing**
(per the write-gatekeeper SKILL.md Phase 1 Step 3).

```typescript
/**
 * Firebase API for Gadgets.
 *
 * A connection is to a single Firebase **project** (`FirebaseProject`), from which individual
 * Firestore databases and Realtime Database instances can be opened. For fine-grained access,
 * connect directly to a specific **Firestore database** (`FirestoreDatabase`) or **Realtime
 * Database** (`RealtimeDatabase`).
 */

/** A JSON value stored in a Firestore document or Realtime Database path. */
export type FirebaseValue =
  | string | number | boolean | null
  | FirebaseValue[]
  | { [key: string]: FirebaseValue };

/** A Firestore document: a map of field names to values. */
export type FirestoreDocument = {
  /** Document ID (last path segment). */
  id: string;
  /** Full collection path (e.g. `"users"` or `"groups/abc/members"`). */
  path: string;
  /** Field data. Nested objects and arrays map naturally to JSON. */
  data: { [field: string]: FirebaseValue };
  /** Server-assigned creation timestamp, if available. */
  createTime?: Date;
  /** Server-assigned last-update timestamp, if available. */
  updateTime?: Date;
};

/** A Firebase project with its Firestore and Realtime Database surfaces. */
export interface FirebaseProject {
  /** Returns basic metadata about this project (name, ID, region). */
  getInfo(): Promise<FirebaseProjectInfo>;

  /** Lists Firestore databases in this project. */
  listFirestoreDatabases(): Promise<FirestoreDatabaseInfo[]>;

  /**
   * Opens a specific Firestore database by its database ID (defaults to `(default)`).
   * Dispose it when finished.
   */
  getFirestoreDatabase(databaseId?: string): Promise<FirestoreDatabase>;

  /** Lists Realtime Database instances in this project. */
  listRealtimeDatabases(): Promise<RealtimeDatabaseInfo[]>;

  /**
   * Opens a Realtime Database by its instance URL.
   * Dispose it when finished.
   */
  getRealtimeDatabase(instanceUrl: string): Promise<RealtimeDatabase>;

  /** Lists Firebase Auth users (read-only). */
  listAuthUsers(maxResults?: number): Promise<AuthUser[]>;
}

export type FirebaseProjectInfo = {
  projectId: string;
  displayName: string;
  /** Firebase resources region (e.g. `"us-central1"`). */
  region: string;
  url: string;
};

export type FirestoreDatabaseInfo = {
  databaseId: string;
  /** Location/region (e.g. `"nam5"`). */
  location: string;
  /** Database type: `firestore-native` or `datastore-mode`. */
  type: string;
};

/** A single Firestore database for document CRUD and queries. */
export interface FirestoreDatabase {
  /**
   * Lists documents in a collection. Read-only.
   * @param collectionPath e.g. `"users"` or `"groups/abc/members"`
   * @param limit Maximum documents to return (default 100, max 1000).
   */
  listDocuments(collectionPath: string, limit?: number): Promise<FirestoreDocument[]>;

  /**
   * Reads a single document. Read-only. Throws if not found.
   * @param path Full document path: `"collection/docId"` or `"groups/abc/members/xyz"`
   */
  getDocument(path: string): Promise<FirestoreDocument>;

  /**
   * Creates a document. Requires human approval before it takes effect.
   * @param collectionPath e.g. `"users"`
   * @param documentId Optional explicit ID. If omitted, Firestore auto-generates one.
   * @param data Field values.
   */
  createDocument(collectionPath: string, data: { [field: string]: FirebaseValue }, documentId?: string): Promise<void>;

  /**
   * Updates (merges) a document. Requires human approval.
   * @param path Full document path.
   * @param data Fields to set or merge.
   * @param merge If true (default), merges fields; if false, replaces the whole document.
   */
  updateDocument(path: string, data: { [field: string]: FirebaseValue }, merge?: boolean): Promise<void>;

  /**
   * Deletes a document. Requires human approval.
   */
  deleteDocument(path: string): Promise<void>;

  /**
   * Runs a structured query against a collection. Read-only.
   * @param collectionPath The root collection to query.
   * @param query Filter, order, and limit specifications.
   */
  runQuery(collectionPath: string, query: FirestoreQuery): Promise<FirestoreDocument[]>;
}

export type FirestoreQuery = {
  /** Filter conditions (ANDed together). */
  where?: FirestoreFilter[];
  /** Field paths to order by, with direction. */
  orderBy?: { field: string; direction: "asc" | "desc" }[];
  /** Maximum documents to return. */
  limit?: number;
};

export type FirestoreFilter = {
  field: string;
  /** Comparison operator. */
  op: "==" | "!=" | "<" | "<=" | ">" | ">=" | "array-contains" | "array-contains-any" | "in" | "not-in";
  value: FirebaseValue;
};

/** Realtime Database (JSON tree) access. */
export interface RealtimeDatabase {
  /**
   * Reads JSON at a path. Read-only.
   * @param path e.g. `"users/abc"` or `""` for root.
   */
  get(path: string): Promise<FirebaseValue>;

  /**
   * Sets JSON at a path (replaces). Requires human approval.
   */
  set(path: string, value: FirebaseValue): Promise<void>;

  /**
   * Updates (merges) JSON at a path. Requires human approval.
   */
  update(path: string, value: { [key: string]: FirebaseValue }): Promise<void>;

  /**
   * Pushes a new child under a path (auto-generated key). Requires human approval.
   * Returns the generated key.
   */
  push(path: string, value: FirebaseValue): Promise<string>;

  /**
   * Deletes JSON at a path. Requires human approval.
   */
  remove(path: string): Promise<void>;
}

export type RealtimeDatabaseInfo = {
  /** Full instance URL (e.g. `"https://myproj-default-rtdb.firebaseio.com"`). */
  url: string;
  /** Database name (e.g. `"myproj-default-rtdb"`). */
  name: string;
  /** Region (e.g. `"us-central1"`). */
  region: string;
};

export type AuthUser = {
  uid: string;
  email?: string;
  displayName?: string;
  disabled: boolean;
  createdAt?: Date;
  lastSignInAt?: Date;
};
```

> **IMPORTANT:** Per the write-gatekeeper SKILL.md, present this API design to the operator for
> review BEFORE implementing the rest. The API is the most delicate part.

### 4g. `src/firebase-api.ts` — REST API Wrapper

Model on `packages/gatekeeper-supabase/src/supabase-api.ts`. Key functions:

- `exchangeAuthCode(code, clientId, clientSecret, redirectUri)` → Google OAuth2 token exchange
  (same as Google gatekeeper's `google-api.ts` — can copy the pattern)
- `refreshAccessToken(refreshToken, clientId, clientSecret)` → token refresh
- `revokeToken(refreshToken)` → token revocation
- `getAccountDescription(accessToken)` → fetch from `googleapis.com/oauth2/v3/userinfo`
- `class FirebaseManagementApi` → wraps `firebase.googleapis.com` calls (listProjects, etc.)
- `class FirestoreApi` → wraps `firestore.googleapis.com` calls (document CRUD, runQuery)
- `class RealtimeDatabaseApi` → wraps `firebaseio.com` calls

### 4h. `src/firebase.ts` — Main Implementation

Follow the SKELETON.md template closely, with these specifics:

**Exports needed (all must be exported for `ctx.exports.*` to resolve):**
- `GatekeeperVendor` (WorkerEntrypoint) — top-level vendor
- `UserAccount` (DurableObject) — stores OAuth refresh token, handles token refresh
- `GatekeeperUserImpl` (WorkerEntrypoint) — per-user resource router
- `FirebaseVerifier` (WorkerEntrypoint) — observer access check
- `FirebaseGatekeeperImpl` (DurableObject) — per-resource facet
- Default export `fetch` handler — serves the OAuth browser flow

**Key patterns to copy from the Google gatekeeper (`google.ts`):**
- Two-phase nonce OAuth flow (initiation nonce → OAuth nonce with `state` param)
- `UserAccount` with credential mutex (`#credentialUpdate` promise chain)
- Token caching with expiry skew (`TOKEN_REFRESH_SKEW_MS`)
- Reconnect flow (`prepareReconnect`)
- `connectAccount` with per-resource scope mapping

**OAuth flow (same as Google, different scopes):**
1. User visits `{BASE_URL}/{doId}/{nonce}` → `fetch` handler redirects to
   `https://accounts.google.com/o/oauth2/v2/auth?...`
2. Google redirects back to `{BASE_URL}/oauth?code=...&state=...`
3. `acceptAuthCode` exchanges code for tokens via `oauth2.googleapis.com/token`
4. Store refresh token in `UserAccount` KV; notify Workshop via callback

**Per-resource scope mapping:**
```typescript
const IDENTITY_SCOPES = ["openid", "userinfo.profile", "userinfo.email"];

const PROJECT_SCOPES = [
  "https://www.googleapis.com/auth/firebase",
];

const FIRESTORE_SCOPES = [
  "https://www.googleapis.com/auth/datastore",
];

const RTDB_SCOPES = [
  "https://www.googleapis.com/auth/firebase.database",
];
```

**Observer strategy:**
- **Firestore Database & Realtime Database** → Strategy B (single-unit ACL):
  `FirebaseVerifier.hasResourceAccess(projectId)` checks the observer's token can access the
  project. `addObserver` throws if not.
- **Firebase Project** → Strategy B as well (project-level access check).

### 4i. Configurator UI files

`src/configurator/firebase-project-configurator-types.d.ts`:
```typescript
export type ConfiguratorOption = {
  value: string;
  title: string;
  subtitle?: string;
  meta?: string;
}

export type FirebaseProjectConfiguratorValues = {
  /** The selected Firebase project ID. Matches the `:projectId` group of the resource URL pattern. */
  projectId?: string | null;
}

export interface FirebaseProjectConfiguratorRpc {
  /** Searches the connected account's Firebase projects. Returns options whose `value` is a project ID. */
  listProjects(query: string): Promise<ConfiguratorOption[]>;
}
```

`src/configurator/firebase-project-configurator-ui.tsx`:
Model on `bigquery-configurator-ui.tsx` — an `Autocomplete` that calls `ui.listProjects()`
to populate options. The `resourceUrl()` function returns the Firestore or Project URL pattern
based on the selected project.

### 4j. `README.md`
Document:
- What the gatekeeper does (Firestore, RTDB, Auth, project management)
- How to create the Google OAuth app (Firebase scopes)
- Redirect URI: `${PUBLIC_BASE_URL}/gatekeeper/firebase/oauth`
- Env vars: `FIREBASE_CLIENT_ID`, `FIREBASE_CLIENT_SECRET`
- Read vs. write (approval queue) model

---

## 5. Registration Touchpoints — Where Changes Are Needed

### 5a. `run-dev-server.js` — **CHANGES NEEDED**

Add Firebase to `SHARED_GATEKEEPER_CREDS` (around line where other gatekeepers are listed):

```javascript
const SHARED_GATEKEEPER_CREDS = {
  "gatekeeper-github": { id: "GITHUB_CLIENT_ID", secret: "GITHUB_CLIENT_SECRET" },
  "gatekeeper-google": { id: "GOOGLE_CLIENT_ID", secret: "GOOGLE_CLIENT_SECRET" },
  // ...existing entries...
  "gatekeeper-firebase": { id: "FIREBASE_CLIENT_ID", secret: "FIREBASE_CLIENT_SECRET" },  // <-- ADD THIS
};
```

Everything else in `run-dev-server.js` is auto-discovered:
- `findGatekeepers()` scans `packages/gatekeeper-*` directories → picks up `gatekeeper-firebase`
- `bindingName()` converts `gatekeeper-firebase` → `GATEKEEPER_FIREBASE`
- Backend gets `{ binding: "GATEKEEPER_FIREBASE", service: "gatekeeper-firebase", entrypoint: "GatekeeperVendor" }`
- Router gets `{ binding: "GATEKEEPER_FIREBASE", service: "gatekeeper-firebase" }`
- Configurator UI auto-built if `src/configurator/` exists

### 5b. `scripts/release/manifest-lib.mjs` — **NO CHANGES NEEDED**

- `findDeployablePackages()` auto-discovers any `packages/*/wrangler.jsonc`
- `gatekeeper-firebase` will be classified as kind `"gatekeeper` by `workerKind()`
- It is NOT in `NO_DEFAULT_CRED_INPUTS` (it uses OAuth), so it defaults to
  `CLIENT_ID` / `CLIENT_SECRET` deploy inputs automatically
- It is NOT in `NOT_INSTALLABLE`, `PREINSTALL`, or `SINGLETON` (correct — it's a normal
  installable gatekeeper)

### 5c. `.github/workflows/deploy.yml` — **NO CHANGES NEEDED**

- The `inject-bindings.mjs` script scans `packages/gatekeeper-*` → auto-discovers Firebase
- Secret injection uses prefix: `shortName.toUpperCase().replace("-", "_")` → `FIREBASE`
  → checks `FIREBASE_CLIENT_ID`, `FIREBASE_CLIENT_SECRET` in GitHub Secrets
- `BASE_URL` auto-set to `${PUBLIC_BASE_URL}/gatekeeper/firebase`
- Gatekeeper deployed in the `for gk in packages/gatekeeper-*/` loop

### 5d. `.github/workflows/ci.yml` — **NO CHANGES NEEDED**

- `pnpm build` runs recursively across all packages (including new ones)
- `pnpm lint` runs oxlint across all packages

### 5e. `pnpm-workspace.yaml` — **NO CHANGES NEEDED**

- Already globs `packages/*`

### 5f. `packages/workshop-backend/wrangler.jsonc` — **NO CHANGES NEEDED**

- Service bindings are injected dynamically by `run-dev-server.js` (dev) and
  `deploy.yml`'s `inject-bindings.mjs` (prod)
- Backend auto-discovers vendors from `GATEKEEPER_`-prefixed bindings

### 5g. `packages/router/wrangler.jsonc` — **NO CHANGES NEEDED**

- Router bindings injected dynamically (same as above)
- Router routes `/gatekeeper/firebase/*` by scanning its own `GATEKEEPER_*` bindings

### Summary of changes:

| File | Change |
|---|---|
| `run-dev-server.js` | **Add 1 line** to `SHARED_GATEKEEPER_CREDS` |
| `packages/gatekeeper-firebase/**` | **New package** (all files from Section 4) |
| Everything else | Auto-discovered — no changes |

---

## 6. GitHub Secrets to Configure

For production deployment, add these GitHub repository secrets:
- `FIREBASE_CLIENT_ID` — Google OAuth client ID (Firebase project)
- `FIREBASE_CLIENT_SECRET` — Google OAuth client secret

For local development, add to `.dev.vars`:
```
FIREBASE_CLIENT_ID=<oauth client id>
FIREBASE_CLIENT_SECRET=<oauth client secret>
```

### Creating the OAuth App
1. Go to Google Cloud Console → APIs & Services → Credentials
2. Create an OAuth 2.0 Client ID (Web application)
3. Add redirect URI: `https://<your-domain>/gatekeeper/firebase/oauth`
   (local: `http://localhost:8787/gatekeeper/firebase/oauth`)
4. Enable the Firebase Management API and Cloud Firestore API in your GCP project
5. Copy Client ID and Client Secret

---

## 7. AI Agent Implementation Instructions

> The following is a step-by-step guide for an AI agent to implement this plan. It follows the
> write-gatekeeper skill (`.agents/skills/write-gatekeeper/SKILL.md`).

### Phase 1: Core Implementation (Responsibilities 1-3)

**Step 1 — Understand the Firebase APIs**
- Study the Firebase Management REST API, Firestore REST API, and Realtime Database REST API.
- Auth model: Google OAuth 2.0 (authorization code flow with refresh tokens).
- Resources: Firebase Project (broad), Firestore Database (narrow), Realtime Database (narrow).
- Operations: reads (list projects, list/get documents, query, RTDB get) vs. actions (create/
  update/delete documents, RTDB set/update/push/remove).

**Step 2 — Design the Session types (`src/types.d.ts`)**
- Use the API design in Section 4f above as a starting point.
- One interface per logical resource: `FirebaseProject`, `FirestoreDatabase`,
  `RealtimeDatabase`.
- Capability-based: `FirebaseProject.getFirestoreDatabase()` returns a new `FirestoreDatabase`
  that can be independently authorized.
- Use JSDoc as agent-facing API documentation (no approval-queue or implementation details).
- **IMPORTANT:** Use UTF-8 encoding. No mojibake. All em-dashes as `—` not `â`.

**Step 3 — STOP: Present the `types.d.ts` for operator review**
- Do NOT proceed without approval. Getting the API right is the most important step.

**Step 4 — Implement (`src/firebase.ts`, `src/firebase-api.ts`)**
- Follow SKELETON.md and copy patterns from `gatekeeper-google/src/google.ts` (OAuth) and
  `gatekeeper-supabase/src/supabase.ts` (resource router, configurator).
- Implement the fetch handler (OAuth redirect flow), `GatekeeperVendor`, `UserAccount`,
  `GatekeeperUserImpl`, `FirebaseVerifier`, `FirebaseGatekeeperImpl`, `SessionImpl`.
- For the `firebase-api.ts`, wrap the REST endpoints listed in Section 2.

**Step 5 — Configure and register**
- Add the 1 line to `run-dev-server.js` `SHARED_GATEKEEPER_CREDS` (Section 5a).
- All other registration is automatic.

**Step 6 — Add resource selection UI**
- Create `src/configurator/firebase-project-configurator-ui.tsx` using
  `@gadgets/configurator-ui` components.
- The UI shows an `Autocomplete` listing the user's Firebase projects.

**Step 7 — STOP: Ask operator whether to proceed to Phase 2**

### Phase 2: Logging, Approvals, Caching, Simulation, Observers (Responsibilities 4-7)

**Logging and approvals:**
- `getDocument`, `listDocuments`, `runQuery`, RTDB `get`, `listAuthUsers`,
  `listFirestoreDatabases` → call `authorizeObservation()` before returning.
- `createDocument`, `updateDocument`, `deleteDocument`, RTDB `set`/`update`/`push`/`remove`
  → call `submitAction()`; do NOT perform until `applyAction()`.
- Implement `applyAction()`, `rejectAction()`, `revertAction()` on `FirebaseGatekeeperImpl`.

**Caching:**
- Cache project metadata and database lists in DO storage with TTLs (like Supabase).
- Cache Firestore document reads with short TTLs for repeated reads.
- Invalidate cache on action apply.

**Simulation:**
- For `createDocument`: store the pending document in DO storage; `listDocuments` and
  `getDocument` include it in results until rejected.
- For `updateDocument`: overlay the merge on cached data.
- For `deleteDocument`: mark as deleted in simulation; exclude from list results.
- RTDB `set`/`update`/`remove` can use overlay at read time (cleaner for JSON trees).

**Observer verification:**
- `FirebaseVerifier.hasResourceAccess(projectId)` → call Firebase Management API with the
  observer's own token to check they can access the project.
- `addObserver()` → Strategy B: verify observer has project access, throw if not.
- `removeObserver()` → no-op (idempotent).

### Phase 3: Testing and CI

- Run `pnpm build` (narrowed to `packages/gatekeeper-firebase` if possible) for type checks.
- Run `pnpm lint` for oxlint + tsc checks.
- Create a PR with the branch-first workflow (per AGENTS.md):
  1. Create branch `feature/firebase-gatekeeper` from `main`
  2. Write all files to that branch
  3. Verify commits landed (handle resolved + SHA advanced)
  4. Open PR
  5. Dispatch CI workflow (`ci.yml` has `workflow_dispatch`)

---

## 8. Implementation Order (Recommended)

1. Create the package skeleton (package.json, wrangler.jsonc, tsconfig.json, worker-configuration.d.ts)
2. Write `src/types.d.ts` → **STOP for review**
3. Write `src/firebase-api.ts` (REST API wrapper)
4. Write `src/firebase.ts` (main implementation — Vendor, UserAccount, UserImpl, GatekeeperImpl, SessionImpl, fetch handler)
5. Write `src/observability.ts`
6. Write configurator UI files
7. Add the 1 line to `run-dev-server.js`
8. Write `README.md`
9. Run `pnpm build` and `pnpm lint` to verify
10. Create PR

---

## 9. Key Reference Files in the Repo

| Reference | File | Why |
|---|---|---|
| OAuth flow (Google OAuth2) | `packages/gatekeeper-google/src/google.ts` | Firebase uses the same Google OAuth endpoints |
| Token exchange/refresh | `packages/gatekeeper-google/src/google-api.ts` | Copy `exchangeAuthCode`, `getAccessToken`, `revokeToken` patterns |
| Resource router + configurator | `packages/gatekeeper-supabase/src/supabase.ts` | Clean project/org resource split (closest to Firebase project/database) |
| REST API wrapper | `packages/gatekeeper-supabase/src/supabase-api.ts` | Pattern for wrapping REST endpoints with bearer auth |
| Configurator UI | `packages/gatekeeper-google/src/configurator/bigquery-configurator-ui.tsx` | Autocomplete + resourceUrl pattern |
| Skeleton template | `.agents/skills/write-gatekeeper/SKELETON.md` | Full implementation template |
| Skill guide | `.agents/skills/write-gatekeeper/SKILL.md` | Seven responsibilities, phases, observer strategies |
| Project conventions | `AGENTS.md` | Encoding, branch workflow, RPC, logging |
