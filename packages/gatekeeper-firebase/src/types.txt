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
  | string
  | number
  | boolean
  | null
  | FirebaseValue[]
  | { [key: string]: FirebaseValue };

/** A Firestore document: a map of field names to values. */
export type FirestoreDocument = {
  /** Document ID (last path segment). */
  id: string;
  /** Full collection path (e.g. "users" or "groups/abc/members"). */
  path: string;
  /** Field data. Nested objects and arrays map naturally to JSON. */
  data: { [field: string]: FirebaseValue };
  /** Server-assigned creation timestamp, if available. */
  createTime?: Date;
  /** Server-assigned last-update timestamp, if available. */
  updateTime?: Date;
};

/**
 * A Firebase project: the container for its Firestore databases, Realtime Database instances,
 * and Firebase Auth.
 *
 * The Firestore database is the primary capability — obtain it with `getFirestoreDatabase()`.
 * Realtime Database and Auth access are read-only conveniences.
 */
export interface FirebaseProject {
  /** Returns metadata about this project (name, ID, region). */
  getInfo(): Promise<FirebaseProjectInfo>;

  /** Lists Firestore databases in this project. Read-only. */
  listFirestoreDatabases(): Promise<FirestoreDatabaseInfo[]>;

  /**
   * Opens a specific Firestore database by its database ID (defaults to "(default)").
   *
   * Returned as a promise you can pipeline against without awaiting (Cap'n Web promise
   * pipelining). Dispose it when finished.
   */
  getFirestoreDatabase(databaseId?: string): Promise<FirestoreDatabase>;

  /** Lists Realtime Database instances in this project. Read-only. */
  listRealtimeDatabases(): Promise<RealtimeDatabaseInfo[]>;

  /**
   * Opens a Realtime Database by its instance URL.
   * Dispose it when finished.
   */
  getRealtimeDatabase(instanceUrl: string): Promise<RealtimeDatabase>;

  /** Lists Firebase Auth users in this project. Read-only. */
  listAuthUsers(maxResults?: number): Promise<AuthUser[]>;
}

/** Basic project metadata returned by `FirebaseProject.getInfo()`. */
export type FirebaseProjectInfo = {
  /** Stable Firebase project identifier (e.g. "my-app-prod"). */
  projectId: string;
  /** Human-readable project name. */
  displayName: string;
  /** Firebase resources region (e.g. "us-central1"). */
  region: string;
  /** The project's Firebase console URL. */
  url: string;
};

/** A Firestore database discovered via `FirebaseProject.listFirestoreDatabases()`. */
export type FirestoreDatabaseInfo = {
  /** Database ID (e.g. "(default)"). */
  databaseId: string;
  /** Location/region (e.g. "nam5"). */
  location: string;
  /** Database type: "firestore-native" or "datastore-mode". */
  type: string;
};

/** A Realtime Database instance discovered via `FirebaseProject.listRealtimeDatabases()`. */
export type RealtimeDatabaseInfo = {
  /** Full instance URL (e.g. "https://myproj-default-rtdb.firebaseio.com"). */
  url: string;
  /** Database name (e.g. "myproj-default-rtdb"). */
  name: string;
  /** Region (e.g. "us-central1"). */
  region: string;
};

/**
 * A single Firestore database for document CRUD and structured queries.
 *
 * Reads and writes are cleanly separated:
 *   - `listDocuments()`, `getDocument()`, and `runQuery()` are **read-only**.
 *   - `createDocument()`, `updateDocument()`, and `deleteDocument()` require human approval
 *     before they take effect and aren't reflected by reads until then; see `createDocument()`.
 */
export interface FirestoreDatabase {
  /**
   * Lists documents in a collection. Read-only.
   *
   * @param collectionPath e.g. "users" or "groups/abc/members".
   * @param limit Maximum documents to return (default 100, max 1000). Include a limit for
   *   potentially large collections.
   */
  listDocuments(collectionPath: string, limit?: number): Promise<FirestoreDocument[]>;

  /**
   * Reads a single document. Read-only. Throws if not found.
   *
   * @param path Full document path: "collection/docId" or "groups/abc/members/xyz".
   */
  getDocument(path: string): Promise<FirestoreDocument>;

  /**
   * Creates a document. Requires human approval before it takes effect.
   *
   * Calling this **submits** the creation; it does not complete until a person approves it,
   * which may happen later. The document is **not** observed by a subsequent `listDocuments()`
   * or `getDocument()` until it has been approved and applied — this is expected, not a failure,
   * so don't retry or treat the not-yet-visible document as an error.
   *
   * @param collectionPath The parent collection (e.g. "users").
   * @param data Field values for the new document.
   * @param documentId Optional explicit ID. If omitted, Firestore auto-generates one.
   */
  createDocument(
    collectionPath: string,
    data: { [field: string]: FirebaseValue },
    documentId?: string,
  ): Promise<void>;

  /**
   * Updates (or replaces) a document. Requires human approval before it takes effect.
   *
   * @param path Full document path.
   * @param data Fields to set.
   * @param merge If true (default), merges fields into the existing document; if false, replaces
   *   the whole document.
   */
  updateDocument(
    path: string,
    data: { [field: string]: FirebaseValue },
    merge?: boolean,
  ): Promise<void>;

  /**
   * Deletes a document. Requires human approval before it takes effect.
   *
   * @param path Full document path.
   */
  deleteDocument(path: string): Promise<void>;

  /**
   * Runs a structured query against a collection. Read-only.
   *
   * @param collectionPath The root collection to query.
   * @param query Filter, order, and limit specifications.
   */
  runQuery(collectionPath: string, query: FirestoreQuery): Promise<FirestoreDocument[]>;
}

/** Query specification for `FirestoreDatabase.runQuery()`. */
export type FirestoreQuery = {
  /** Filter conditions (ANDed together). */
  where?: FirestoreFilter[];
  /** Field paths to order by, with direction. */
  orderBy?: { field: string; direction: "asc" | "desc" }[];
  /** Maximum documents to return. */
  limit?: number;
};

/** A single filter condition in a `FirestoreQuery`. */
export type FirestoreFilter = {
  field: string;
  /** Comparison operator. */
  op:
    | "=="
    | "!="
    | "<"
    | "<="
    | ">"
    | ">="
    | "array-contains"
    | "array-contains-any"
    | "in"
    | "not-in";
  value: FirebaseValue;
};

/**
 * A Firebase Realtime Database (JSON tree) for path-level CRUD.
 *
 * Reads and writes are cleanly separated:
 *   - `get()` is **read-only**.
 *   - `set()`, `update()`, `push()`, and `remove()` require human approval before they
 *     take effect and aren't reflected by reads until then.
 */
export interface RealtimeDatabase {
  /**
   * Reads JSON at a path. Read-only.
   *
   * @param path e.g. "users/abc" or "" for root.
   */
  get(path: string): Promise<FirebaseValue>;

  /**
   * Sets JSON at a path (replaces the entire value). Requires human approval.
   *
   * @param path e.g. "users/abc" or "" for root.
   * @param value The value to set.
   */
  set(path: string, value: FirebaseValue): Promise<void>;

  /**
   * Updates (merges) JSON at a path. Requires human approval.
   *
   * Only the specified child keys are written; siblings are untouched.
   *
   * @param path e.g. "users/abc".
   * @param value A map of child keys to new values.
   */
  update(path: string, value: { [key: string]: FirebaseValue }): Promise<void>;

  /**
   * Pushes a new child under a path (auto-generated key). Requires human approval.
   *
   * @returns The generated key.
   */
  push(path: string, value: FirebaseValue): Promise<string>;

  /**
   * Deletes JSON at a path. Requires human approval.
   *
   * @param path e.g. "users/abc" or "" for root.
   */
  remove(path: string): Promise<void>;
}

/** A Firebase Auth user. */
export type AuthUser = {
  uid: string;
  email?: string;
  displayName?: string;
  /** Whether the user account is disabled. */
  disabled: boolean;
  /** When the user was created, if available. */
  createdAt?: Date;
  /** When the user last signed in, if available. */
  lastSignInAt?: Date;
};
