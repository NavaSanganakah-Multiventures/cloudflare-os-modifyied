// Google Jules + Jules Flow support for the Aarya voice assistant. Aarya reads the owner's Jules
// sources/sessions/activities and can start coding sessions (and drive the Jules Flow tracker)
// through the owner's connected Google Jules gatekeeper. Mutating calls route through the
// gatekeeper's ApprovalQueue (AaryaApprovalQueue), so they reach the live voice-call confirmation
// gate exactly like email sends and GitHub reviews.

// ---------------------------------------------------------------------------
// Minimal shapes of the Jules gatekeeper session Aarya uses. The full types live in the
// gatekeeper-jules package; the session is returned to us as any (Gatekeeper<any>).

export interface AaryaJulesSource {
  name: string;
  id: string;
  githubRepo?: { owner?: string; repo?: string; defaultBranch?: { displayName: string } };
}

export interface AaryaJulesSessionInfo {
  name: string;
  id: string;
  title?: string;
  prompt?: string;
  state: string;
  archived?: boolean;
  url?: string;
  createTime?: string;
  updateTime?: string;
}

export interface AaryaJulesPlanStep {
  title?: string;
  description?: string;
}

export interface AaryaJulesActivity {
  name: string;
  id: string;
  createTime?: string;
  originator?: string;
  description?: string;
  planGenerated?: { plan?: { id: string; steps: AaryaJulesPlanStep[] } };
  planApproved?: { planId?: string };
  userMessaged?: { userMessage?: string };
  agentMessaged?: { agentMessage?: string };
  progressUpdated?: { title?: string; description?: string };
  sessionCompleted?: Record<string, unknown>;
  sessionFailed?: { reason?: string };
}

export interface AaryaJulesCreateSessionInput {
  prompt: string;
  title?: string;
  sourceContext: {
    source: string;
    githubRepoContext?: { startingBranch: string };
  };
  automationMode?: "AUTO_CREATE_PR";
  requirePlanApproval?: boolean;
}

/** The subset of the Jules session Aarya uses. */
export interface AaryaJulesSession {
  listSources(options?: { pageSize?: number }): Promise<AaryaJulesSource[]>;
  listSessions(options?: { pageSize?: number; filter?: string }): Promise<AaryaJulesSessionInfo[]>;
  createSession(input: AaryaJulesCreateSessionInput): Promise<void>;
  approvePlan(session: string): Promise<void>;
  listActivities(session: string, options?: { pageSize?: number }): Promise<AaryaJulesActivity[]>;
}

// ---------------------------------------------------------------------------
// Jules Flow session shapes.

export interface AaryaJulesFlowStartInput {
  request: string;
  planSummary: string;
  julesPrompt: string;
  officialDocs?: { title: string; url: string; note?: string }[];
  title?: string;
  githubRepo: string;
  julesSource: string;
}

export interface AaryaJulesFlowWorkflow {
  id: string;
  phase: string;
  title?: string;
  request: string;
  planSummary: string;
  githubRepo: string;
  julesSource: string;
  julesSessionId?: string;
  prNumber?: number;
  prUrl?: string;
  ci?: { workflow?: string; conclusion?: string };
  review?: { verdict?: string; summary?: string };
  conflicts?: string[];
  error?: string;
  updatedAt?: string;
}

/** The subset of the Jules Flow session Aarya uses. */
export interface AaryaJulesFlowSession {
  startFlow(input: AaryaJulesFlowStartInput): Promise<AaryaJulesFlowWorkflow>;
  getWorkflow(id: string): Promise<AaryaJulesFlowWorkflow>;
  listWorkflows(): Promise<AaryaJulesFlowWorkflow[]>;
  refresh(id: string): Promise<AaryaJulesFlowWorkflow>;
  cancelFlow(id: string): Promise<AaryaJulesFlowWorkflow>;
}

// ---------------------------------------------------------------------------
// Summaries returned to the model.

export interface AaryaJulesSourceSummary {
  id: string;
  name: string;
  repo?: string;
}

export interface AaryaJulesSessionSummary {
  id: string;
  title: string;
  state: string;
  url?: string;
  createTime?: string;
}

export interface AaryaJulesActivitySummary {
  id: string;
  createTime?: string;
  originator?: string;
  description?: string;
  message?: string;
  plan?: { id: string; steps: string[] };
  planApproved?: boolean;
  progress?: string;
  status?: string;
  reason?: string;
}

/** Collapse a Jules activity into the small JSON shape the model sees. Pure for testing. */
export function summarizeJulesActivity(activity: AaryaJulesActivity): AaryaJulesActivitySummary {
  const summary: AaryaJulesActivitySummary = { id: activity.id };
  if (activity.createTime) summary.createTime = activity.createTime;
  if (activity.originator) summary.originator = activity.originator;
  if (activity.description) summary.description = activity.description;

  if (activity.userMessaged?.userMessage) summary.message = activity.userMessaged.userMessage;
  else if (activity.agentMessaged?.agentMessage) summary.message = activity.agentMessaged.agentMessage;

  if (activity.planGenerated?.plan) {
    summary.plan = {
      id: activity.planGenerated.plan.id,
      steps: (activity.planGenerated.plan.steps ?? [])
        .map((s) => s.title ?? s.description ?? "")
        .filter((s) => s.length > 0),
    };
  }
  if (activity.planApproved) summary.planApproved = true;

  if (activity.progressUpdated) {
    summary.progress = activity.progressUpdated.title ?? activity.progressUpdated.description ?? "";
  }
  if (activity.sessionCompleted) summary.status = "completed";
  if (activity.sessionFailed) {
    summary.status = "failed";
    summary.reason = activity.sessionFailed.reason ?? "";
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Tool input validation.

export interface StartJulesSessionInput {
  prompt: string;
  title: string | undefined;
  /** Always in "sources/<id>" form. */
  source: string;
  startingBranch: string | undefined;
  requirePlanApproval: boolean;
  automationMode: "AUTO_CREATE_PR" | undefined;
}

const GITHUB_REPO_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

function requiredString(args: Record<string, unknown>, key: string, error: string): string {
  const raw = typeof args[key] === "string" ? (args[key] as string).trim() : "";
  if (!raw) throw new Error(error);
  return raw;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const raw = typeof args[key] === "string" ? (args[key] as string).trim() : "";
  return raw || undefined;
}

/** Expand a short Jules id into a full resource name ("sources/<id>", "sessions/<id>"). */
function expandJulesName(raw: string, kind: "sources" | "sessions"): string {
  const prefix = kind + "/";
  if (raw.startsWith(prefix)) return raw;
  return prefix + raw;
}

export function normalizeStartJulesSessionArgs(args: Record<string, unknown>): StartJulesSessionInput {
  const prompt = requiredString(args, "prompt", 'A prompt is required (e.g. "Fix the failing tests").');
  const title = optionalString(args, "title");
  const sourceRaw = requiredString(args, "source", "A source is required (from list_jules_sources).");
  const source = expandJulesName(sourceRaw, "sources");
  const startingBranch = optionalString(args, "startingBranch");
  const requirePlanApproval = args.requirePlanApproval !== false; // default true
  const automationMode = args.automationMode === "AUTO_CREATE_PR" ? "AUTO_CREATE_PR" : undefined;
  return { prompt, title, source, startingBranch, requirePlanApproval, automationMode };
}

export function normalizeApprovePlanArgs(args: Record<string, unknown>): string {
  const sessionRaw = requiredString(args, "sessionId", "A sessionId is required to approve its plan.");
  return expandJulesName(sessionRaw, "sessions");
}

export function normalizeJulesActivitiesArgs(args: Record<string, unknown>): string {
  const sessionRaw = requiredString(args, "sessionId", "A sessionId is required to list activities.");
  return expandJulesName(sessionRaw, "sessions");
}

export function normalizeStartJulesFlowArgs(args: Record<string, unknown>): AaryaJulesFlowStartInput {
  const request = requiredString(args, "request", "A request is required to start the Jules Flow.");
  const planSummary = requiredString(args, "planSummary", "A planSummary is required to start the Jules Flow.");
  const julesPrompt = requiredString(args, "julesPrompt", "A julesPrompt is required to start the Jules Flow.");
  const githubRepo = requiredString(args, "githubRepo", "A githubRepo is required (owner/repo).");
  if (!GITHUB_REPO_RE.test(githubRepo)) throw new Error('githubRepo must be in "owner/repo" form.');
  const julesSourceRaw = requiredString(args, "julesSource", "A julesSource is required (from list_jules_sources).");
  const julesSource = expandJulesName(julesSourceRaw, "sources");
  const title = optionalString(args, "title");

  const rawDocs = args.officialDocs;
  let officialDocs: AaryaJulesFlowStartInput["officialDocs"];
  if (Array.isArray(rawDocs)) {
    const docs = rawDocs
      .filter((d): d is Record<string, unknown> => !!d && typeof d === "object")
      .map((d) => ({
        title: typeof d.title === "string" ? d.title.trim() : "",
        url: typeof d.url === "string" ? d.url.trim() : "",
        ...(typeof d.note === "string" && d.note.trim() ? { note: d.note.trim() } : {}),
      }))
      .filter((d) => d.title && d.url);
    if (docs.length > 0) officialDocs = docs;
  }

  const result: AaryaJulesFlowStartInput = {
    request,
    planSummary,
    julesPrompt,
    githubRepo,
    julesSource,
    ...(title ? { title } : {}),
  };
  if (officialDocs) result.officialDocs = officialDocs;
  return result;
}

export function normalizeJulesFlowIdArg(args: Record<string, unknown>): string {
  return requiredString(args, "id", "A workflow id is required.");
}
