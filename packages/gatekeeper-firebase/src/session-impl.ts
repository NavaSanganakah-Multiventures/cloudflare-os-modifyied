import { RpcTarget, RpcStub } from "cloudflare:workers";
import type { ApprovalQueue } from "@gadgets/workshop-shared/gatekeeper";
import {
  FirestoreApi,
  FirestoreAdminApi,
  RealtimeDatabaseApi,
  FirebaseManagementApi,
  FirebaseAuthApi,
} from "./firebase-api";
import type {
  FirebaseProject,
  FirebaseProjectInfo,
  FirebaseValue,
  FirestoreDatabase,
  FirestoreDatabaseInfo,
  FirestoreDocument,
  FirestoreQuery as FirestoreQueryType,
  RealtimeDatabase,
  RealtimeDatabaseInfo,
  AuthUser,
} from "./types";

type FirebaseGatekeeperImplProps = {
  userObjectId: string;
  resourceKind: "project" | "firestore" | "rtdb";
  projectId?: string;
  databaseId?: string;
  instanceUrl?: string;
};


// ---------------------------------------------------------------------------
// FirebaseProjectSessionImpl

export class FirebaseProjectSessionImpl extends RpcTarget implements FirebaseProject {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #ctx: DurableObjectState<FirebaseGatekeeperImplProps>;
  #getToken: () => Promise<string>;

  constructor(
    approvalQueue: RpcStub<ApprovalQueue>,
    ctx: DurableObjectState<FirebaseGatekeeperImplProps>,
    getToken: () => Promise<string>,
  ) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#ctx = ctx;
    this.#getToken = getToken;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  async getInfo(): Promise<FirebaseProjectInfo> {
    let mgmt = new FirebaseManagementApi(await this.#getToken());
    let project = await mgmt.getProject(this.#ctx.props.projectId!);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Firebase project info",
      description: `Fetched metadata for project ${this.#ctx.props.projectId}.`,
    });
    return {
      projectId: project.projectId,
      displayName: project.displayName,
      region: "unknown",
      url: `https://console.firebase.google.com/project/${project.projectId}`,
    };
  }

  async listFirestoreDatabases(): Promise<FirestoreDatabaseInfo[]> {
    let admin = new FirestoreAdminApi(await this.#getToken(), this.#ctx.props.projectId!);
    let databases = await admin.listDatabases();
    await this.#approvalQueue.authorizeObservation({
      title: "List Firestore databases",
      description: `Listed Firestore databases in project ${this.#ctx.props.projectId}.`,
    });
    return databases.map(db => ({
      databaseId: db.name.split("/").pop() ?? "",
      location: db.locationId,
      type: db.type,
    }));
  }

  async getFirestoreDatabase(databaseId?: string): Promise<FirestoreDatabase> {
    let dbId = databaseId ?? "(default)";
    // Return a Firestore session with its own approval queue.
    let props: FirebaseGatekeeperImplProps = {
      ...this.#ctx.props,
      resourceKind: "firestore",
      databaseId: dbId,
    };
    let newGatekeeper = this.#ctx.exports.FirebaseGatekeeperImpl({ props });
    let session = await newGatekeeper.startSession(this.#approvalQueue.dup());
    return session as FirestoreDatabase;
  }

  async listRealtimeDatabases(): Promise<RealtimeDatabaseInfo[]> {
    // The Firebase Management API doesn't have a direct RTDB list endpoint.
    // We derive from the project ID.
    let projectId = this.#ctx.props.projectId!;
    await this.#approvalQueue.authorizeObservation({
      title: "List Realtime Databases",
      description: `Listed Realtime Database instances for project ${projectId}.`,
    });
    return [{
      url: `https://${projectId}-default-rtdb.firebaseio.com`,
      name: `${projectId}-default-rtdb`,
      region: "us-central1",
    }];
  }

  async getRealtimeDatabase(instanceUrl: string): Promise<RealtimeDatabase> {
    let props: FirebaseGatekeeperImplProps = {
      ...this.#ctx.props,
      resourceKind: "rtdb",
      instanceUrl,
    };
    let newGatekeeper = this.#ctx.exports.FirebaseGatekeeperImpl({ props });
    let session = await newGatekeeper.startSession(this.#approvalQueue.dup());
    return session as RealtimeDatabase;
  }

  async listAuthUsers(maxResults?: number): Promise<AuthUser[]> {
    let auth = new FirebaseAuthApi(await this.#getToken(), this.#ctx.props.projectId!);
    let users = await auth.listUsers(maxResults ?? 100);
    await this.#approvalQueue.authorizeObservation({
      title: "List Auth users",
      description: `Listed ${users.length} Firebase Auth users in project ${this.#ctx.props.projectId}.`,
    });
    return users.map(u => ({
      uid: u.localId,
      email: u.email,
      displayName: u.displayName,
      disabled: u.disabled ?? false,
      createdAt: u.createdAt ? new Date(Number(u.createdAt)) : undefined,
      lastSignInAt: u.lastLoginAt ? new Date(Number(u.lastLoginAt)) : undefined,
    }));
  }
}

// ---------------------------------------------------------------------------
// FirestoreDatabaseSessionImpl

export class FirestoreDatabaseSessionImpl extends RpcTarget implements FirestoreDatabase {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #ctx: DurableObjectState<FirebaseGatekeeperImplProps>;
  #getToken: () => Promise<string>;

  constructor(
    approvalQueue: RpcStub<ApprovalQueue>,
    ctx: DurableObjectState<FirebaseGatekeeperImplProps>,
    getToken: () => Promise<string>,
  ) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#ctx = ctx;
    this.#getToken = getToken;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  private async api(): Promise<FirestoreApi> {
    return new FirestoreApi(
      await this.#getToken(),
      this.#ctx.props.projectId!,
      this.#ctx.props.databaseId ?? "(default)",
    );
  }

  async listDocuments(collectionPath: string, limit?: number): Promise<FirestoreDocument[]> {
    let maxResults = limit ?? 100;
    let api = await this.api();
    let docs = await api.listDocuments(collectionPath, maxResults);
    await this.#approvalQueue.authorizeObservation({
      title: "List Firestore documents",
      description: `Listed ${docs.length} documents from ${collectionPath}.`,
    });
    return docs as FirestoreDocument[];
  }

  async getDocument(path: string): Promise<FirestoreDocument> {
    let api = await this.api();
    let doc = await api.getDocument(path);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Firestore document",
      description: `Read document at ${path}.`,
    });
    return doc as FirestoreDocument;
  }

  async createDocument(
    collectionPath: string,
    data: { [field: string]: FirebaseValue },
    documentId?: string,
  ): Promise<void> {
    let actionId = this.#nextActionId();
    this.#ctx.storage.kv.put(`action:${actionId}`, {
      kind: "create",
      collectionPath,
      data,
      documentId,
      submittedAt: Date.now(),
    });
    await this.#approvalQueue.submitAction(actionId, {
      title: "Create Firestore document",
      description: `Create document in ${collectionPath}${documentId ? ` with ID ${documentId}` : ""}.`,
      implementsRevert: false,
    });
  }

  async updateDocument(
    path: string,
    data: { [field: string]: FirebaseValue },
    merge?: boolean,
  ): Promise<void> {
    let actionId = this.#nextActionId();
    this.#ctx.storage.kv.put(`action:${actionId}`, {
      kind: "update",
      collectionPath: path.split("/").slice(0, -1).join("/"),
      documentPath: path,
      data,
      merge: merge ?? true,
      submittedAt: Date.now(),
    });
    await this.#approvalQueue.submitAction(actionId, {
      title: "Update Firestore document",
      description: `${merge === false ? "Replace" : "Update"} document at ${path}.`,
      implementsRevert: false,
    });
  }

  async deleteDocument(path: string): Promise<void> {
    let actionId = this.#nextActionId();
    this.#ctx.storage.kv.put(`action:${actionId}`, {
      kind: "delete",
      collectionPath: path.split("/").slice(0, -1).join("/"),
      documentPath: path,
      submittedAt: Date.now(),
    });
    await this.#approvalQueue.submitAction(actionId, {
      title: "Delete Firestore document",
      description: `Delete document at ${path}.`,
      implementsRevert: false,
    });
  }

  async runQuery(collectionPath: string, query: FirestoreQueryType): Promise<FirestoreDocument[]> {
    let api = await this.api();
    let docs = await api.runQuery(collectionPath, query);
    await this.#approvalQueue.authorizeObservation({
      title: "Run Firestore query",
      description: `Queried ${collectionPath}, returned ${docs.length} documents.`,
    });
    return docs as FirestoreDocument[];
  }

  #nextActionId(): number {
    let id = this.#ctx.storage.kv.get<number>("nextActionId") ?? 1;
    this.#ctx.storage.kv.put("nextActionId", id + 1);
    return id;
  }
}

// ---------------------------------------------------------------------------
// RealtimeDatabaseSessionImpl

export class RealtimeDatabaseSessionImpl extends RpcTarget implements RealtimeDatabase {
  #approvalQueue: RpcStub<ApprovalQueue>;
  #ctx: DurableObjectState<FirebaseGatekeeperImplProps>;
  #getToken: () => Promise<string>;

  constructor(
    approvalQueue: RpcStub<ApprovalQueue>,
    ctx: DurableObjectState<FirebaseGatekeeperImplProps>,
    getToken: () => Promise<string>,
  ) {
    super();
    this.#approvalQueue = approvalQueue;
    this.#ctx = ctx;
    this.#getToken = getToken;
  }

  [Symbol.dispose]() {
    this.#approvalQueue[Symbol.dispose]();
  }

  private async api(): Promise<RealtimeDatabaseApi> {
    return new RealtimeDatabaseApi(await this.#getToken(), this.#ctx.props.instanceUrl!);
  }

  async get(path: string): Promise<FirebaseValue> {
    let api = await this.api();
    let value = await api.get(path);
    await this.#approvalQueue.authorizeObservation({
      title: "Read Realtime Database",
      description: `Read JSON at path ${path || "(root)"}.`,
    });
    return value as FirebaseValue;
  }

  async set(path: string, value: FirebaseValue): Promise<void> {
    let actionId = this.#nextActionId();
    this.#ctx.storage.kv.put(`action:${actionId}`, {
      kind: "set",
      path,
      value,
      submittedAt: Date.now(),
    });
    await this.#approvalQueue.submitAction(actionId, {
      title: "Set Realtime Database value",
      description: `Set JSON at path ${path || "(root)"}.`,
      implementsRevert: false,
    });
  }

  async update(path: string, value: { [key: string]: FirebaseValue }): Promise<void> {
    let actionId = this.#nextActionId();
    this.#ctx.storage.kv.put(`action:${actionId}`, {
      kind: "update",
      path,
      value,
      submittedAt: Date.now(),
    });
    await this.#approvalQueue.submitAction(actionId, {
      title: "Update Realtime Database",
      description: `Update JSON at path ${path}.`,
      implementsRevert: false,
    });
  }

  async push(path: string, value: FirebaseValue): Promise<string> {
    // For push, we need the key immediately. We'll generate a placeholder and submit.
    let actionId = this.#nextActionId();
    this.#ctx.storage.kv.put(`action:${actionId}`, {
      kind: "push",
      path,
      value,
      submittedAt: Date.now(),
    });
    await this.#approvalQueue.submitAction(actionId, {
      title: "Push to Realtime Database",
      description: `Push new child at path ${path}.`,
      implementsRevert: false,
    });
    // Return a temporary key; the real key is generated on apply.
    return `pending-${actionId}`;
  }

  async remove(path: string): Promise<void> {
    let actionId = this.#nextActionId();
    this.#ctx.storage.kv.put(`action:${actionId}`, {
      kind: "remove",
      path,
      submittedAt: Date.now(),
    });
    await this.#approvalQueue.submitAction(actionId, {
      title: "Remove Realtime Database value",
      description: `Remove JSON at path ${path || "(root)"}.`,
      implementsRevert: false,
    });
  }

  #nextActionId(): number {
    let id = this.#ctx.storage.kv.get<number>("nextActionId") ?? 1;
    this.#ctx.storage.kv.put("nextActionId", id + 1);
    return id;
  }
}
