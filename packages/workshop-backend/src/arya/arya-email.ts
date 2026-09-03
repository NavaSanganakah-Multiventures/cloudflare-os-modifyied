// Email support for the Arya voice assistant. Arya sends mail through the owner's connected
// Google/Gmail gatekeeper: the Gmail gatekeeper's mutating operations call submitAction() on an
// AryaApprovalQueue, which routes the action through Arya's live voice-call confirmation gate, then
// calls the gatekeeper's applyAction() to actually send the email. Reads (authorizeObservation)
// are auto-approved — the owner is reading their own mailbox.

import { RpcTarget } from "cloudflare:workers";
import type {
  ApprovalQueue,
  ActionDescription,
  Gatekeeper,
  HookController,
  HookDescription,
  ObservationDescription,
} from "@gadgets/workshop-shared/gatekeeper";

/** A decision returned by Arya's confirmation gate. */
export type AryaConfirmationDecision = "approved" | "rejected" | "timeout";

/**
 * Routes Gmail gatekeeper actions through Arya's live voice-call confirmation gate.
 *
 * The Gmail session's mutating operations (send / reply / forward) call submitAction() on this
 * queue. We ask the room owner to approve, then call the gatekeeper's applyAction() to actually
 * send the email, or rejectAction() on denial. authorizeObservation() auto-approves: the owner is
 * reading their own mailbox. Hooks are not supported from a voice call.
 *
 * This makes the single confirmation the owner sees for an email show the rich outbound message
 * (From / To / Subject / Body) produced by the gatekeeper, rather than a generic tool summary.
 */
export class AryaApprovalQueue extends RpcTarget implements ApprovalQueue {
  constructor(
    private readonly gatekeeper: Fetcher<Gatekeeper<any>>,
    private readonly requestConfirmation: (tool: string, summary: string) => Promise<AryaConfirmationDecision>,
  ) {
    super();
  }

  authorizeObservation(_description: ObservationDescription): Promise<void> {
    // The owner reading their own Gmail data — always permitted.
    return Promise.resolve();
  }

  async submitAction(action: number, description: ActionDescription): Promise<void> {
    const decision = await this.requestConfirmation(description.title, description.description);
    if (decision === "approved") {
      await this.gatekeeper.applyAction(action);
      return;
    }
    try {
      await this.gatekeeper.rejectAction(action);
    } catch {
      // The pending action may already be gone; a reject failure must not mask the denial.
    }
    throw new Error(
      decision === "timeout" ? "Email confirmation timed out" : "You rejected sending this email",
    );
  }

  bindHook<Hook extends RpcTarget>(
    _controller: Fetcher<HookController<Hook>>,
    _callback: RpcStub<Hook>,
    _description: HookDescription,
  ): Promise<void> {
    return Promise.reject(new Error("Arya does not support hooks from a voice call."));
  }
}

// ---------------------------------------------------------------------------
// Minimal shapes of the Gmail gatekeeper session Arya uses. The full types live in the
// gatekeeper-google package (surfaced to agents via getTypeScriptTypes()); we only need a handful
// of methods here, and the session is returned to us as `any` (Gatekeeper<any>).

/** One thread returned by a Gmail cursor page. */
export interface AryaGmailThreadEntry {
  info: { id: string; subject: string; snippet?: string };
  thread: AryaGmailThread;
}

/** A page cursor over Gmail threads. */
export interface AryaGmailCursor {
  next(): Promise<AryaGmailThreadEntry[] | null>;
}

/** A single Gmail message capability. */
export interface AryaGmailMessage {
  reply(body: string): Promise<void>;
}

/** A Gmail thread capability. */
export interface AryaGmailThread {
  messages(): Promise<AryaGmailMessage[]>;
}

/** The subset of the Gmail session Arya uses. */
export interface AryaGmailSession {
  send(to: string[], subject: string, body: string): Promise<void>;
  listThreads(): Promise<AryaGmailCursor>;
  search(query: string): Promise<AryaGmailCursor>;
}

// ---------------------------------------------------------------------------
// Tool input validation. The Gmail gatekeeper enforces its own hard limits (recipient count,
// subject/body byte length) inside send(); these checks give the model an early, friendly error
// before any confirmation or network round trip.

export interface SendEmailInput {
  to: string[];
  subject: string;
  body: string;
}

/** Normalize and validate arguments for the send_email tool. */
export function normalizeSendEmailArgs(args: Record<string, unknown>): SendEmailInput {
  const rawTo = args.to;
  let to: string[];
  if (Array.isArray(rawTo)) {
    to = rawTo
      .filter((r): r is string => typeof r === "string")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  } else if (typeof rawTo === "string" && rawTo.trim()) {
    to = [rawTo.trim()];
  } else {
    to = [];
  }
  const subject = typeof args.subject === "string" ? args.subject : "";
  const body = typeof args.body === "string" ? args.body : "";
  if (to.length === 0) throw new Error("At least one recipient ('to') is required to send an email.");
  if (!subject.trim()) throw new Error("An email subject is required.");
  if (!body.trim()) throw new Error("An email body is required.");
  return { to, subject, body };
}
