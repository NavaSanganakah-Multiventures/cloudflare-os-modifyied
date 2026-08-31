// Session API exposed to Gadgets/agents by the Cloudflare gatekeeper.
//
// Cloudflare is an account-scoped platform; every resource lives under an account. The gatekeeper
// exposes a broad CloudflareAccount session plus focused sessions for each grantable service:
//
//   - CloudflareAccount       â€” one account: zones, D1, R2, Workers, Pages, AI, Vectorize,
//                              Tunnels and email routing.
//   - CloudflareZone          â€” a DNS zone and its records.
//   - CloudflareD1Database    â€” a serverless SQLite database.
//   - CloudflareR2Bucket      â€” an object storage bucket.
//   - CloudflareWorker        â€” a Workers script.
//   - CloudflarePagesProject  â€” a Pages project and its deployments.
//   - CloudflareAi            â€” Workers AI inference.
//   - CloudflareVectorIndex   â€” a Vectorize index.
//   - CloudflareEmailRouting  â€” email routing for a zone.
//   - CloudflareTunnel        â€” a Cloudflare Tunnel.
//
// Read-only methods are authorized as observations before data is returned. Mutations are
// submitted to the approval queue and applied when approved.

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

/**
 * Access to everything under one Cloudflare account: zones, D1, R2, Workers, Pages, AI,
 * Vectorize, Tunnels and email routing.
 */
export interface CloudflareAccount {
  /** Returns basic information about the account. */
  getMetadata(): Promise<CloudflareAccountMetadata>;

  /** Lists DNS zones in the account. Results stream through the returned cursor. */
  listZones(): Promise<Cursor<CloudflareZoneSummary>>;

  /** Lists D1 databases in the account. */
  listD1Databases(): Promise<CloudflareD1DatabaseSummary[]>;

  /** Lists R2 buckets in the account. */
  listR2Buckets(): Promise<CloudflareR2BucketSummary[]>;

  /** Lists Workers scripts in the account. */
  listWorkers(): Promise<CloudflareWorkerSummary[]>;

  /** Lists Pages projects in the account. */
  listPagesProjects(): Promise<CloudflarePagesProjectSummary[]>;

  /** Lists Vectorize indexes in the account. */
  listVectorIndexes(): Promise<CloudflareVectorIndexSummary[]>;

  /** Lists Cloudflare Tunnels in the account. */
  listTunnels(): Promise<CloudflareTunnelSummary[]>;

  /** Lists the Workers AI models available to the account. */
  listAiModels(): Promise<CloudflareAiModel[]>;

  /** Runs inference against a Workers AI model. `inputs` is the model-specific request body. */
  runAi(model: string, inputs: unknown): Promise<CloudflareAiRunResult>;

  /** Opens a specific DNS zone by id. */
  getZone(zoneId: string): Promise<CloudflareZone>;

  /** Opens a specific D1 database by id. */
  getD1Database(databaseId: string): Promise<CloudflareD1Database>;

  /** Opens a specific R2 bucket by name. */
  getR2Bucket(bucketName: string): Promise<CloudflareR2Bucket>;

  /** Opens a specific Worker by script name. */
  getWorker(scriptName: string): Promise<CloudflareWorker>;

  /** Opens a specific Pages project by name. */
  getPagesProject(projectName: string): Promise<CloudflarePagesProject>;

  /** Opens a specific Vectorize index by name. */
  getVectorIndex(indexName: string): Promise<CloudflareVectorIndex>;

  /** Opens a specific Cloudflare Tunnel by id. */
  getTunnel(tunnelId: string): Promise<CloudflareTunnel>;

  /** Creates a D1 database. */
  createD1Database(name: string): Promise<CloudflareD1DatabaseSummary>;

  /** Creates an R2 bucket. */
  createR2Bucket(name: string): Promise<CloudflareR2BucketSummary>;

  /** Creates (or replaces) a Worker from a single JavaScript module (no bindings). */
  createWorker(scriptName: string, scriptContent: string): Promise<CloudflareWorkerSummary>;

  /** Creates a Pages project. */
  createPagesProject(name: string, productionBranch?: string): Promise<CloudflarePagesProjectSummary>;

  /** Creates a Vectorize index. `metric` defaults to `"cosine"`. */
  createVectorIndex(name: string, dimensions: number, metric?: string): Promise<CloudflareVectorIndexSummary>;

  /** Creates a Cloudflare Tunnel. */
  createTunnel(name: string, secret: string): Promise<CloudflareTunnelSummary>;
}

/** Access to a single DNS zone and its records. */
export interface CloudflareZone {
  /** Returns basic information about the zone. */
  getMetadata(): Promise<CloudflareZoneMetadata>;

  /** Lists DNS records. Results stream through the returned cursor. */
  listDnsRecords(filter?: CloudflareDnsRecordFilter): Promise<Cursor<CloudflareDnsRecord>>;

  /** Gets one DNS record by id. */
  getDnsRecord(recordId: string): Promise<CloudflareDnsRecord>;

  /** Creates a DNS record. */
  createDnsRecord(record: CloudflareDnsRecordInput): Promise<CloudflareDnsRecord>;

  /** Updates an existing DNS record (only the fields present in `record` are changed). */
  updateDnsRecord(recordId: string, record: Partial<CloudflareDnsRecordInput>): Promise<CloudflareDnsRecord>;

  /** Deletes a DNS record. */
  deleteDnsRecord(recordId: string): Promise<void>;
}

/** Access to a single D1 (SQLite) database. */
export interface CloudflareD1Database {
  /** Returns basic information about the database. */
  getMetadata(): Promise<CloudflareD1DatabaseSummary>;

  /**
   * Runs a read-only SQL statement (e.g. `SELECT`) and returns the rows. Submit write statements
   * with `execute()` instead.
   */
  query(sql: string, params?: unknown[]): Promise<CloudflareD1QueryResult>;

  /** Lists the tables in the database (via sqlite_master). */
  listTables(): Promise<CloudflareD1Table[]>;

  /** Runs a SQL statement that may mutate data (`INSERT`, `UPDATE`, `DELETE`, DDL). */
  execute(sql: string, params?: unknown[]): Promise<CloudflareD1QueryResult>;
}

/** Access to a single R2 bucket. Bucket management is available; object-level I/O needs S3 keys. */
export interface CloudflareR2Bucket {
  /** Returns basic information about the bucket. */
  getMetadata(): Promise<CloudflareR2BucketSummary>;

  /** Deletes the bucket. */
  delete(): Promise<void>;
}

/** Access to a single Workers script. */
export interface CloudflareWorker {
  /** Returns basic information about the script. */
  getMetadata(): Promise<CloudflareWorkerSummary>;

  /** Returns the deployed script's source code. */
  getScriptContent(): Promise<string>;

  /** Replaces the deployed script with a new single-module script (no bindings). */
  updateScript(scriptContent: string): Promise<void>;

  /** Deletes the script. */
  delete(): Promise<void>;
}

/** Access to a single Pages project. */
export interface CloudflarePagesProject {
  /** Returns basic information about the project. */
  getMetadata(): Promise<CloudflarePagesProjectSummary>;

  /** Lists deployments. Results stream through the returned cursor. */
  listDeployments(): Promise<Cursor<CloudflarePagesDeployment>>;

  /** Gets one deployment by id. */
  getDeployment(deploymentId: string): Promise<CloudflarePagesDeployment>;

  /** Deletes the project. */
  delete(): Promise<void>;
}

/** Access to Workers AI inference for an account. */
export interface CloudflareAi {
  /** Runs inference against a Workers AI model. `inputs` is the model-specific request body. */
  run(model: string, inputs: unknown): Promise<CloudflareAiRunResult>;

  /** Lists the Workers AI models available to the account. */
  listModels(): Promise<CloudflareAiModel[]>;
}

/** Access to a single Vectorize index. */
export interface CloudflareVectorIndex {
  /** Returns basic information about the index. */
  getMetadata(): Promise<CloudflareVectorIndexSummary>;

  /** Queries the index for the nearest vectors to `vector`. */
  query(vector: number[], topK: number, returnValues?: boolean): Promise<CloudflareVectorQueryResult>;

  /** Fetches vectors by id. */
  getByIds(ids: string[]): Promise<CloudflareVector[]>;

  /** Inserts or updates vectors. */
  upsert(vectors: CloudflareVector[]): Promise<void>;

  /** Deletes vectors by id. */
  deleteByIds(ids: string[]): Promise<void>;

  /** Deletes the whole index. */
  delete(): Promise<void>;
}

/** Access to email routing for a single zone. */
export interface CloudflareEmailRouting {
  /** Returns the routing settings (whether routing is enabled, etc.). */
  getSettings(): Promise<CloudflareEmailRoutingSettings>;

  /** Lists routing rules. */
  listRules(): Promise<CloudflareEmailRoutingRule[]>;

  /** Creates a routing rule. */
  createRule(rule: CloudflareEmailRoutingRuleInput): Promise<CloudflareEmailRoutingRule>;

  /** Deletes a routing rule. */
  deleteRule(ruleId: string): Promise<void>;

  /** Lists destination addresses (account-wide). */
  listDestinations(): Promise<CloudflareEmailRoutingAddress[]>;

  /** Enables or disables a destination address. */
  setDestinationEnabled(addressId: string, enabled: boolean): Promise<void>;
}

/** Access to a single Cloudflare Tunnel. */
export interface CloudflareTunnel {
  /** Returns basic information about the tunnel. */
  getMetadata(): Promise<CloudflareTunnelSummary>;

  /** Lists the tunnel's live connections. */
  listConnections(): Promise<CloudflareTunnelConnection[]>;

  /** Deletes the tunnel. */
  delete(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface CloudflareAccountMetadata {
  id: string;
  name: string;
}

export interface CloudflareZoneSummary {
  id: string;
  name: string;
  status: string;
  paused: boolean;
  plan?: string;
  nameServers?: string[];
  createdOn?: string;
  modifiedOn?: string;
}

export interface CloudflareZoneMetadata extends CloudflareZoneSummary {
  type?: string;
}

export interface CloudflareDnsRecordFilter {
  type?: string;
  name?: string;
  content?: string;
}

export interface CloudflareDnsRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  ttl: number;
  proxied?: boolean;
  priority?: number;
  createdOn?: string;
  modifiedOn?: string;
}

export interface CloudflareDnsRecordInput {
  type: string;
  name: string;
  content: string;
  ttl?: number;
  proxied?: boolean;
  priority?: number;
}

export interface CloudflareD1DatabaseSummary {
  id: string;
  name: string;
  version?: string;
  numTables?: number;
  createdAt?: string;
  updatedAt?: string;
}

export interface CloudflareD1QueryResult {
  success: boolean;
  results?: Array<Record<string, unknown>>;
  meta?: unknown;
  errors?: Array<{ code: number; message: string }>;
}

export interface CloudflareD1Table {
  name: string;
  type: string;
  sql?: string;
}

export interface CloudflareR2BucketSummary {
  name: string;
  creationDate?: string;
}

export interface CloudflareWorkerSummary {
  id: string;
  etag?: string;
  modifiedOn?: string;
  createdOn?: string;
}

export interface CloudflarePagesProjectSummary {
  name: string;
  subdomain?: string;
  domains?: string[];
  productionBranch?: string;
  createdOn?: string;
}

export interface CloudflarePagesDeployment {
  id: string;
  projectName?: string;
  environment?: string;
  url?: string;
  shortId?: string;
  createdOn?: string;
  modifiedOn?: string;
  stage?: { name?: string; status?: string };
}

export interface CloudflareAiModel {
  name: string;
  task?: string;
  source?: string;
}

export interface CloudflareAiRunResult {
  success: boolean;
  result?: unknown;
  errors?: unknown[];
}

export interface CloudflareVectorIndexSummary {
  name: string;
  dimensions?: number;
  metric?: string;
  description?: string;
  createdOn?: string;
  modifiedOn?: string;
}

export interface CloudflareVector {
  id: string;
  values: number[];
  metadata?: Record<string, unknown>;
}

export interface CloudflareVectorQueryResult {
  count?: number;
  matches?: CloudflareVectorMatch[];
}

export interface CloudflareVectorMatch {
  id: string;
  score: number;
  values?: number[];
  metadata?: Record<string, unknown>;
}

export interface CloudflareTunnelSummary {
  id: string;
  name: string;
  createdAt?: string;
  deletedAt?: string | null;
}

export interface CloudflareTunnelConnection {
  id: string;
  clientId?: string;
  clientVersion?: string;
  openedAt?: string;
  isPendingReconnect?: boolean;
}

export interface CloudflareEmailRoutingSettings {
  enabled?: boolean;
  status?: string;
  name?: string;
}

export interface CloudflareEmailRoutingRule {
  tag?: string;
  name?: string;
  enabled?: boolean;
  priority?: number;
  matchers?: CloudflareEmailRoutingRuleMatcher[];
  actions?: CloudflareEmailRoutingRuleAction[];
}

export type CloudflareEmailRoutingRuleMatcher = {
  type: "literal" | "all";
  field: "to";
  value?: string;
};

export type CloudflareEmailRoutingRuleAction = {
  type: "forward" | "drop" | "worker";
  value?: string[];
};

export interface CloudflareEmailRoutingRuleInput {
  name?: string;
  enabled?: boolean;
  priority?: number;
  matchers: CloudflareEmailRoutingRuleMatcher[];
  actions: CloudflareEmailRoutingRuleAction[];
}

export interface CloudflareEmailRoutingAddress {
  id: string;
  email?: string;
  verified?: boolean;
  enabled?: boolean;
}
