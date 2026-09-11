// Tool registry for the Aarya voice assistant. Read-only tools execute directly; mutating tools are
// executed only after the room asks the user for confirmation (the confirmation gate).

import type { AaryaAiBackend, AaryaAiState } from "./aarya-types";
import type { AaryaNotification, AaryaReminder } from "./aarya-reminders";
import { normalizeSetReminderArgs, summarizeReminder } from "./aarya-reminders";
import { normalizeSendEmailArgs } from "./aarya-email";
import {
  normalizeGithubPrNumberArg,
  normalizeGithubRepoArg,
  normalizeRepoFilePathArg,
  normalizeRepoPathArg,
  normalizeRepoRefArg,
  normalizeReviewPrArgs,
} from "./aarya-github";
import type { AaryaEmailSummary } from "./aarya-email";
import type {
  AaryaGithubPrReadResult,
  AaryaGithubPrSummary,
  AaryaRepoDirectoryResult,
  AaryaRepoFileResult,
  AaryaReviewDecision,
} from "./aarya-github";
import {
  normalizeApprovePlanArgs,
  normalizeJulesActivitiesArgs,
  normalizeJulesFlowIdArg,
  normalizeStartJulesFlowArgs,
  normalizeStartJulesSessionArgs,
} from "./aarya-jules";
import type {
  AaryaJulesActivitySummary,
  AaryaJulesFlowStartInput,
  AaryaJulesFlowWorkflow,
  AaryaJulesSessionSummary,
  AaryaJulesSourceSummary,
  StartJulesSessionInput,
} from "./aarya-jules";

/** A function call requested by the AI model. */
export interface AaryaToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** The result of executing one tool call. `response` is what gets sent back to the model. */
export interface AaryaToolResult {
  id: string;
  name: string;
  response: unknown;
}

/** A workspace created on the owner's behalf. */
export interface AaryaWorkspaceSummary {
  workspaceId: string;
  title: string;
}

/** Mutating capabilities exposed to gated tools. Each call is user-confirmed before execution. */
export interface AaryaMutations {
  /** Update the room owner's display name. */
  setOwnerDisplayName(name: string): Promise<void>;
  /** Store a new reminder for the room owner. */
  setReminder(message: string, dueAt: number): Promise<AaryaReminder>;
  /** Cancel one of the room owner's reminders. Returns true when it existed. */
  cancelReminder(id: string): Promise<boolean>;
  /** Create a new workspace for the room owner. */
  createWorkspace(title: string): Promise<AaryaWorkspaceSummary>;
}

/** Email capabilities exposed to tools. Confirmation for sends is provided by the Gmail gatekeeper's
 * ApprovalQueue (AaryaApprovalQueue), so these are not gated by the room's confirmation flow. */
export interface AaryaEmailRuntime {
  sendEmail(to: string[], subject: string, body: string): Promise<void>;
  listEmails(query?: string): Promise<AaryaEmailSummary[]>;
  replyEmail(threadId: string, body: string): Promise<void>;
}

/** GitHub capabilities exposed to tools. Confirmation for reviews is provided by the GitHub
 * gatekeeper's ApprovalQueue (AaryaApprovalQueue), so these are not gated by the room's flow. */
export interface AaryaGithubRuntime {
  listPrs(repo: string): Promise<AaryaGithubPrSummary[]>;
  readPr(repo: string, prNumber: number): Promise<AaryaGithubPrReadResult>;
  reviewPr(repo: string, prNumber: number, decision: AaryaReviewDecision, body: string): Promise<void>;
  listRepoFiles(repo: string, path: string, ref?: string): Promise<AaryaRepoDirectoryResult>;
  readRepoFile(repo: string, path: string, ref?: string): Promise<AaryaRepoFileResult>;
}

/** Google Jules capabilities exposed to tools. Confirmation for writes is provided by the Jules
 * gatekeeper's ApprovalQueue (AaryaApprovalQueue), so these are not gated by the room's flow. */
export interface AaryaJulesRuntime {
  listSources(): Promise<AaryaJulesSourceSummary[]>;
  listSessions(): Promise<AaryaJulesSessionSummary[]>;
  listActivities(sessionId: string): Promise<AaryaJulesActivitySummary[]>;
  createSession(input: StartJulesSessionInput): Promise<unknown>;
  approvePlan(sessionId: string): Promise<unknown>;
}

/** Jules Flow tracker capabilities exposed to tools. Confirmation for writes is provided by the
 * Jules Flow gatekeeper's ApprovalQueue (AaryaApprovalQueue). */
export interface AaryaJulesFlowRuntime {
  startFlow(input: AaryaJulesFlowStartInput): Promise<AaryaJulesFlowWorkflow>;
  listWorkflows(): Promise<AaryaJulesFlowWorkflow[]>;
  getWorkflow(id: string): Promise<AaryaJulesFlowWorkflow>;
  cancelFlow(id: string): Promise<AaryaJulesFlowWorkflow>;
}

/** Runtime hooks tools can touch. */
export interface AaryaToolRuntime {
  now(): Date;
  voiceStatus(): { state: AaryaAiState; backend?: AaryaAiBackend };
  mutations: AaryaMutations;
  /** Read the owner's pending reminders, soonest first. */
  readReminders(): Promise<AaryaReminder[]>;
  /** Read the owner's pending notifications. */
  readNotifications(): Promise<AaryaNotification[]>;
  /** Email capabilities, or absent when no Gmail account is connected. */
  email?: AaryaEmailRuntime;
  /** GitHub capabilities, or absent when no GitHub account is connected. */
  github?: AaryaGithubRuntime;
  /** Google Jules capabilities, or absent when no Jules account is connected. */
  jules?: AaryaJulesRuntime;
  /** Jules Flow tracker capabilities, or absent when the connector isn't provisioned. */
  julesFlow?: AaryaJulesFlowRuntime;
}

/** A tool the Aarya assistant can execute. */
export interface AaryaToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** True when executing the tool changes external state and requires user confirmation. */
  mutating?: boolean;
  /** Human-readable summary of a pending call, shown in the confirmation prompt. */
  summarize?: (args: Record<string, unknown>) => string;
  execute(args: Record<string, unknown>, runtime: AaryaToolRuntime): unknown | Promise<unknown>;
}

/** Gemini function declaration shape (subset the Live API accepts). */
export interface GeminiFunctionDeclaration {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** A single Gemini tool entry. */
export interface GeminiTool {
  functionDeclarations?: GeminiFunctionDeclaration[];
}

/** Build the Gemini tools array from tool definitions (empty when there are none). */
export function geminiFunctionDeclarations(tools: AaryaToolDefinition[]): GeminiTool[] {
  if (tools.length === 0) return [];
  return [
    {
      functionDeclarations: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      })),
    },
  ];
}

const DEFAULT_AARYA_TOOLS: AaryaToolDefinition[] = [
  {
    name: "get_current_time",
    description: "Return the current date and time as an ISO-8601 string.",
    parameters: { type: "object", properties: {} },
    execute: (_args, runtime) => ({ time: runtime.now().toISOString() }),
  },
  {
    name: "get_voice_status",
    description: "Return the live state of the AARYA voice assistant.",
    parameters: { type: "object", properties: {} },
    execute: (_args, runtime) => runtime.voiceStatus(),
  },
  {
    name: "set_reminder",
    description:
      "Set a reminder to tell the user something later. Provide a short message and either dueAt (an ISO-8601 datetime) or delayMinutes (a relative delay from now).",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string", description: "What to remind the user about." },
        dueAt: { type: "string", description: "Absolute due time as an ISO-8601 datetime." },
        delayMinutes: { type: "number", description: "Relative delay from now, in minutes." },
      },
      required: ["message"],
    },
    mutating: true,
    summarize: summarizeReminder,
    execute: async (args, runtime) => {
      const input = normalizeSetReminderArgs(args, runtime.now().getTime());
      const reminder = await runtime.mutations.setReminder(input.message, input.dueAt);
      return { reminder };
    },
  },
  {
    name: "cancel_reminder",
    description: "Cancel a pending reminder by its id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The reminder id to cancel." } },
      required: ["id"],
    },
    mutating: true,
    summarize: (args) =>
      typeof args.id === "string" && args.id.trim()
        ? `Cancel the reminder "${args.id.trim()}"`
        : "Cancel a reminder",
    execute: async (args, runtime) => {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) throw new Error("A reminder id is required.");
      const cancelled = await runtime.mutations.cancelReminder(id);
      return { cancelled };
    },
  },
  {
    name: "list_reminders",
    description: "List the user's pending reminders.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, runtime) => ({ reminders: await runtime.readReminders() }),
  },
  {
    name: "get_notifications",
    description: "Return the user's pending notifications (for example, due reminders).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, runtime) => ({ notifications: await runtime.readNotifications() }),
  },
  {
    name: "send_email",
    description:
      "Send an email from the user's connected Gmail account. Ask the user for the recipients, subject, and body first. The user must approve before it is actually sent.",
    parameters: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient email addresses." },
        subject: { type: "string", description: "Email subject line." },
        body: { type: "string", description: "Plain-text email body." },
      },
      required: ["to", "subject", "body"],
    },
    execute: async (args, runtime) => {
      const email = runtime.email;
      if (!email) throw new Error("Email is not configured for this call.");
      const input = normalizeSendEmailArgs(args);
      await email.sendEmail(input.to, input.subject, input.body);
      return { sent: true, to: input.to, subject: input.subject };
    },
  },
  {
    name: "list_emails",
    description:
      "List the most recent emails from the user's connected Gmail inbox, or search them with a Gmail query. Returns thread ids, subjects, and snippets. Use reply_email to reply to a thread by its id.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional Gmail search query to narrow results (e.g. \"from:boss@company.com\")." },
      },
    },
    execute: async (args, runtime) => {
      const email = runtime.email;
      if (!email) throw new Error("Email is not configured for this call.");
      const query = typeof args.query === "string" ? args.query.trim() || undefined : undefined;
      return { threads: await email.listEmails(query) };
    },
  },
  {
    name: "reply_email",
    description:
      "Reply to an email thread by its id. Ask the user what to say, then reply. The user must approve before it is actually sent. Use list_emails first to get a thread id.",
    parameters: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "The id of the thread to reply to (from list_emails)." },
        body: { type: "string", description: "The plain-text reply body." },
      },
      required: ["threadId", "body"],
    },
    execute: async (args, runtime) => {
      const email = runtime.email;
      if (!email) throw new Error("Email is not configured for this call.");
      const threadId = typeof args.threadId === "string" ? args.threadId.trim() : "";
      const body = typeof args.body === "string" ? args.body : "";
      if (!threadId) throw new Error("A threadId is required to reply to an email.");
      if (!body.trim()) throw new Error("A reply body is required.");
      await email.replyEmail(threadId, body);
      return { replied: true, threadId };
    },
  },
  {
    name: "list_prs",
    description:
      "List the most recent open pull requests in a GitHub repository the user can access. Returns PR numbers, titles, authors, and states. Use read_pr to review one, then review_pr to post a review.",
    parameters: {
      type: "object",
      properties: { repo: { type: "string", description: 'Repository as "owner/repo".' } },
      required: ["repo"],
    },
    execute: async (args, runtime) => {
      const github = runtime.github;
      if (!github) throw new Error("GitHub is not configured for this call.");
      const repo = normalizeGithubRepoArg(args);
      return { pullRequests: await github.listPrs(repo) };
    },
  },
  {
    name: "read_pr",
    description:
      "Read a pull request's details and diff so you can review it. Returns the title, state, author, body, and a summarized diff. Use review_pr afterwards to post your review.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'Repository as "owner/repo".' },
        prNumber: { type: "number", description: "The pull request number." },
      },
      required: ["repo", "prNumber"],
    },
    execute: async (args, runtime) => {
      const github = runtime.github;
      if (!github) throw new Error("GitHub is not configured for this call.");
      const repo = normalizeGithubRepoArg(args);
      const prNumber = normalizeGithubPrNumberArg(args);
      return await github.readPr(repo, prNumber);
    },
  },
  {
    name: "review_pr",
    description:
      "Post a pull request review (approve / comment / request changes) on the user's behalf. Ask the user which decision and what to write first; they must approve before it is posted. Use read_pr first to see the diff.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'Repository as "owner/repo".' },
        prNumber: { type: "number", description: "The pull request number." },
        decision: { type: "string", enum: ["approve", "comment", "requestChanges"], description: "The review decision." },
        body: { type: "string", description: "The review body in Markdown." },
      },
      required: ["repo", "prNumber", "decision"],
    },
    execute: async (args, runtime) => {
      const github = runtime.github;
      if (!github) throw new Error("GitHub is not configured for this call.");
      const input = normalizeReviewPrArgs(args);
      await github.reviewPr(input.repo, input.prNumber, input.decision, input.body);
      return { reviewed: true, repo: input.repo, prNumber: input.prNumber, decision: input.decision };
    },
  },
  {
    name: "list_repo_files",
    description:
      "List files and directories in a GitHub repository folder the user can access. Pass path \"\" or \"/\" for the repository root. Returns entry names, paths, and types. Use read_repo_file to read a specific file.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'Repository as "owner/repo".' },
        path: { type: "string", description: 'Directory path within the repo ("" or "/" for the root).' },
        ref: { type: "string", description: "Optional branch, tag, or commit SHA. Defaults to the default branch." },
      },
      required: ["repo"],
    },
    execute: async (args, runtime) => {
      const github = runtime.github;
      if (!github) throw new Error("GitHub is not configured for this call.");
      const repo = normalizeGithubRepoArg(args);
      const path = normalizeRepoPathArg(args);
      const ref = normalizeRepoRefArg(args);
      return await github.listRepoFiles(repo, path, ref);
    },
  },
  {
    name: "read_repo_file",
    description:
      "Read a file from a GitHub repository as text so you can analyze its code or contents. Large files are truncated. Use list_repo_files first to discover paths.",
    parameters: {
      type: "object",
      properties: {
        repo: { type: "string", description: 'Repository as "owner/repo".' },
        path: { type: "string", description: "File path within the repo (e.g. \"src/index.ts\")." },
        ref: { type: "string", description: "Optional branch, tag, or commit SHA. Defaults to the default branch." },
      },
      required: ["repo", "path"],
    },
    execute: async (args, runtime) => {
      const github = runtime.github;
      if (!github) throw new Error("GitHub is not configured for this call.");
      const repo = normalizeGithubRepoArg(args);
      const path = normalizeRepoFilePathArg(args);
      const ref = normalizeRepoRefArg(args);
      return await github.readRepoFile(repo, path, ref);
    },
  },
  {
    name: "create_workspace",
    description:
      "Create a new workspace in the user's account. Ask the user what title they want first. The user must approve before it is created.",
    parameters: {
      type: "object",
      properties: { title: { type: "string", description: "The title of the new workspace." } },
      required: ["title"],
    },
    mutating: true,
    summarize: (args) =>
      typeof args.title === "string" && args.title.trim()
        ? `Create a workspace titled "${args.title.trim()}"`
        : "Create a workspace",
    execute: async (args, runtime) => {
      const title = typeof args.title === "string" ? args.title.trim() : "";
      if (!title) throw new Error("A non-empty workspace title is required.");
      return { workspace: await runtime.mutations.createWorkspace(title) };
    },
  },
  {
    name: "list_jules_sources",
    description:
      "List the GitHub repositories connected to the user's Google Jules account. Returns source ids you can pass to start_jules_session.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, runtime) => {
      const jules = runtime.jules;
      if (!jules) throw new Error("Google Jules is not configured for this call.");
      return { sources: await jules.listSources() };
    },
  },
  {
    name: "list_jules_sessions",
    description:
      "List the user's Google Jules coding sessions (non-archived). Returns session ids, titles, and states. Use list_jules_activities to read a session's progress.",
    parameters: { type: "object", properties: {} },
    execute: async (_args, runtime) => {
      const jules = runtime.jules;
      if (!jules) throw new Error("Google Jules is not configured for this call.");
      return { sessions: await jules.listSessions() };
    },
  },
  {
    name: "list_jules_activities",
    description:
      "List the activities (plans, messages, progress updates) for a Google Jules session. Use list_jules_sessions to find a session id.",
    parameters: {
      type: "object",
      properties: { sessionId: { type: "string", description: "The Jules session id or name." } },
      required: ["sessionId"],
    },
    execute: async (args, runtime) => {
      const jules = runtime.jules;
      if (!jules) throw new Error("Google Jules is not configured for this call.");
      const session = normalizeJulesActivitiesArgs(args);
      return { activities: await jules.listActivities(session) };
    },
  },
  {
    name: "start_jules_session",
    description:
      "Start a new Google Jules coding session. Ask the user what they want built and which source to use first. The user must approve before the session is created.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "The task to hand to Jules (e.g. \"Fix the failing tests\")." },
        title: { type: "string", description: "Optional session title. Jules generates one if omitted." },
        source: { type: "string", description: "The Jules source to work against (from list_jules_sources)." },
        startingBranch: { type: "string", description: "Optional branch the session should start from." },
        requirePlanApproval: { type: "boolean", description: "Whether generated plans need approval before running (default true)." },
        automationMode: { type: "string", enum: ["AUTO_CREATE_PR"], description: "Optional automation mode." },
      },
      required: ["prompt", "source"],
    },
    execute: async (args, runtime) => {
      const jules = runtime.jules;
      if (!jules) throw new Error("Google Jules is not configured for this call.");
      const input = normalizeStartJulesSessionArgs(args);
      return await jules.createSession(input);
    },
  },
  {
    name: "approve_jules_plan",
    description:
      "Approve the currently pending plan of a Google Jules session so it can proceed. The user must approve before it is sent.",
    parameters: {
      type: "object",
      properties: { sessionId: { type: "string", description: "The Jules session id or name." } },
      required: ["sessionId"],
    },
    execute: async (args, runtime) => {
      const jules = runtime.jules;
      if (!jules) throw new Error("Google Jules is not configured for this call.");
      const session = normalizeApprovePlanArgs(args);
      return await jules.approvePlan(session);
    },
  },
  {
    name: "jules_flow_start",
    description:
      "Start a tracked GitHub -> Google Jules coding workflow. Provide the request, a plan summary, and the full Jules prompt. The user must approve before the workflow is recorded.",
    parameters: {
      type: "object",
      properties: {
        request: { type: "string", description: "The user's original request." },
        planSummary: { type: "string", description: "A short plan summary for the approval prompt." },
        julesPrompt: { type: "string", description: "The full prompt to give Google Jules." },
        githubRepo: { type: "string", description: 'GitHub repository as "owner/repo".' },
        julesSource: { type: "string", description: "The Jules source name (from list_jules_sources)." },
        title: { type: "string", description: "Optional workflow title." },
      },
      required: ["request", "planSummary", "julesPrompt", "githubRepo", "julesSource"],
    },
    execute: async (args, runtime) => {
      const flow = runtime.julesFlow;
      if (!flow) throw new Error("Jules Flow is not configured for this call.");
      const input = normalizeStartJulesFlowArgs(args);
      return { workflow: await flow.startFlow(input) };
    },
  },
  {
    name: "jules_flow_list",
    description: "List the user's Jules Flow workflows (GitHub -> Jules tracked runs).",
    parameters: { type: "object", properties: {} },
    execute: async (_args, runtime) => {
      const flow = runtime.julesFlow;
      if (!flow) throw new Error("Jules Flow is not configured for this call.");
      return { workflows: await flow.listWorkflows() };
    },
  },
  {
    name: "jules_flow_status",
    description: "Return one Jules Flow workflow's current status by id.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The workflow id." } },
      required: ["id"],
    },
    execute: async (args, runtime) => {
      const flow = runtime.julesFlow;
      if (!flow) throw new Error("Jules Flow is not configured for this call.");
      const id = normalizeJulesFlowIdArg(args);
      return { workflow: await flow.getWorkflow(id) };
    },
  },
  {
    name: "jules_flow_cancel",
    description:
      "Cancel a running Jules Flow workflow by id. Ask the user first; they must approve before it is cancelled.",
    parameters: {
      type: "object",
      properties: { id: { type: "string", description: "The workflow id." } },
      required: ["id"],
    },
    execute: async (args, runtime) => {
      const flow = runtime.julesFlow;
      if (!flow) throw new Error("Jules Flow is not configured for this call.");
      const id = normalizeJulesFlowIdArg(args);
      return { workflow: await flow.cancelFlow(id) };
    },
  },
  {
    name: "update_display_name",
    description:
      "Change the room owner's display name. Ask the caller what name they want before using this tool.",
    parameters: {
      type: "object",
      properties: { name: { type: "string", description: "The new display name." } },
      required: ["name"],
    },
    mutating: true,
    summarize: (args) =>
      typeof args.name === "string" && args.name.trim()
        ? `Update your display name to "${args.name.trim()}"`
        : "Update your display name",
    execute: async (args, runtime) => {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) throw new Error("A non-empty display name is required.");
      await runtime.mutations.setOwnerDisplayName(name);
      return { name };
    },
  },
];

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Execute a single tool call against the given runtime. Never throws. */
export async function executeAaryaTool(
  call: AaryaToolCall,
  runtime: AaryaToolRuntime,
): Promise<AaryaToolResult> {
  const tool = DEFAULT_AARYA_TOOLS.find((candidate) => candidate.name === call.name);
  if (!tool) {
    return {
      id: call.id,
      name: call.name,
      response: { ok: false, error: "Unknown tool: " + call.name },
    };
  }
  try {
    const result = await tool.execute(call.args, runtime);
    return { id: call.id, name: call.name, response: { ok: true, result } };
  } catch (error) {
    return { id: call.id, name: call.name, response: { ok: false, error: errorMessage(error) } };
  }
}

/** Registry that owns the built-in tool set. */
export class AaryaToolRegistry {
  constructor(private readonly runtime: AaryaToolRuntime) {}

  definitions(): AaryaToolDefinition[] {
    return DEFAULT_AARYA_TOOLS;
  }

  find(name: string): AaryaToolDefinition | undefined {
    return DEFAULT_AARYA_TOOLS.find((candidate) => candidate.name === name);
  }

  execute(call: AaryaToolCall): Promise<AaryaToolResult> {
    return executeAaryaTool(call, this.runtime);
  }
}
