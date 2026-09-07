// Tool registry for the Aarya voice assistant. Read-only tools execute directly; mutating tools are
// executed only after the room asks the user for confirmation (the confirmation gate).

import type { AaryaAiBackend, AaryaAiState } from "./aarya-types";
import type { AaryaNotification, AaryaReminder } from "./aarya-reminders";
import { normalizeSetReminderArgs, summarizeReminder } from "./aarya-reminders";
import { normalizeSendEmailArgs } from "./aarya-email";
import { normalizeGithubPrNumberArg, normalizeGithubRepoArg, normalizeReviewPrArgs } from "./aarya-github";
import type { AaryaEmailSummary } from "./aarya-email";
import type { AaryaGithubPrReadResult, AaryaGithubPrSummary, AaryaReviewDecision } from "./aarya-github";

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

/** Mutating capabilities exposed to gated tools. Each call is user-confirmed before execution. */
export interface AaryaMutations {
  /** Update the room owner's display name. */
  setOwnerDisplayName(name: string): Promise<void>;
  /** Store a new reminder for the room owner. */
  setReminder(message: string, dueAt: number): Promise<AaryaReminder>;
  /** Cancel one of the room owner's reminders. Returns true when it existed. */
  cancelReminder(id: string): Promise<boolean>;
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
