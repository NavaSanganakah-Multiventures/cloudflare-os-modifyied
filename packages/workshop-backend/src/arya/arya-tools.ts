// Tool registry for the Arya voice assistant. Read-only tools execute directly; mutating tools are
// executed only after the room asks the user for confirmation (the confirmation gate).

import type { AryaAiBackend, AryaAiState } from "./arya-types";
import type { AryaNotification, AryaReminder } from "./arya-reminders";
import { normalizeSetReminderArgs, summarizeReminder } from "./arya-reminders";
import { normalizeSendEmailArgs } from "./arya-email";

/** A function call requested by the AI model. */
export interface AryaToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** The result of executing one tool call. `response` is what gets sent back to the model. */
export interface AryaToolResult {
  id: string;
  name: string;
  response: unknown;
}

/** Mutating capabilities exposed to gated tools. Each call is user-confirmed before execution. */
export interface AryaMutations {
  /** Update the room owner's display name. */
  setOwnerDisplayName(name: string): Promise<void>;
  /** Store a new reminder for the room owner. */
  setReminder(message: string, dueAt: number): Promise<AryaReminder>;
  /** Cancel one of the room owner's reminders. Returns true when it existed. */
  cancelReminder(id: string): Promise<boolean>;
}

/** A recent email thread, for display to the model. */
export interface AryaEmailSummary {
  id: string;
  subject: string;
  snippet?: string;
}

/** Email capabilities exposed to tools. Confirmation for sends is provided by the Gmail gatekeeper's
 * ApprovalQueue (AryaApprovalQueue), so these are not gated by the room's confirmation flow. */
export interface AryaEmailRuntime {
  sendEmail(to: string[], subject: string, body: string): Promise<void>;
  listEmails(query?: string): Promise<AryaEmailSummary[]>;
  replyEmail(threadId: string, body: string): Promise<void>;
}

/** Runtime hooks tools can touch. */
export interface AryaToolRuntime {
  now(): Date;
  voiceStatus(): { state: AryaAiState; backend?: AryaAiBackend };
  mutations: AryaMutations;
  /** Read the owner's pending reminders, soonest first. */
  readReminders(): Promise<AryaReminder[]>;
  /** Read the owner's pending notifications. */
  readNotifications(): Promise<AryaNotification[]>;
  /** Email capabilities, or absent when no Gmail account is connected. */
  email?: AryaEmailRuntime;
}

/** A tool the Arya assistant can execute. */
export interface AryaToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  /** True when executing the tool changes external state and requires user confirmation. */
  mutating?: boolean;
  /** Human-readable summary of a pending call, shown in the confirmation prompt. */
  summarize?: (args: Record<string, unknown>) => string;
  execute(args: Record<string, unknown>, runtime: AryaToolRuntime): unknown | Promise<unknown>;
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
export function geminiFunctionDeclarations(tools: AryaToolDefinition[]): GeminiTool[] {
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

const DEFAULT_ARYA_TOOLS: AryaToolDefinition[] = [
  {
    name: "get_current_time",
    description: "Return the current date and time as an ISO-8601 string.",
    parameters: { type: "object", properties: {} },
    execute: (_args, runtime) => ({ time: runtime.now().toISOString() }),
  },
  {
    name: "get_voice_status",
    description: "Return the live state of the Arya voice assistant.",
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
export async function executeAryaTool(
  call: AryaToolCall,
  runtime: AryaToolRuntime,
): Promise<AryaToolResult> {
  const tool = DEFAULT_ARYA_TOOLS.find((candidate) => candidate.name === call.name);
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
export class AryaToolRegistry {
  constructor(private readonly runtime: AryaToolRuntime) {}

  definitions(): AryaToolDefinition[] {
    return DEFAULT_ARYA_TOOLS;
  }

  find(name: string): AryaToolDefinition | undefined {
    return DEFAULT_ARYA_TOOLS.find((candidate) => candidate.name === name);
  }

  execute(call: AryaToolCall): Promise<AryaToolResult> {
    return executeAryaTool(call, this.runtime);
  }
}
