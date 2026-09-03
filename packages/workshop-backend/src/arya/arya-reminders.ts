// Reminder and notification types + pure helpers for the Arya voice assistant.
//
// Reminders are stored per-user in UserDurableObject (not in a separate Durable Object) and are
// delivered the next time the user talks to Arya: the call room sweeps due reminders into the
// user's notification inbox, then hands the pending notifications to the AI's system prompt at
// the start of the call. A later trigger slice (email / background push) can build a global sweep
// on top of these same per-user records.

/** One reminder the user asked Arya to deliver later. */
export interface AryaReminder {
  id: string;
  message: string;
  /** Epoch milliseconds when the reminder becomes due. */
  dueAt: number;
  /** Epoch milliseconds when the reminder was created. */
  createdAt: number;
}

/** A pending notification surfaced to Arya (today only swept reminders). */
export interface AryaNotification {
  id: string;
  kind: "reminder";
  title: string;
  detail: string;
  /** Epoch milliseconds when the notification was swept into the inbox. */
  createdAt: number;
}

/** Normalized, validated input for the `set_reminder` tool. */
export interface SetReminderInput {
  message: string;
  dueAt: number;
}

const MIN_DELAY_MINUTES = 1;
const MAX_DELAY_MINUTES = 60 * 24 * 365; // one year

/**
 * Parse tool args into a validated reminder. Accepts either `dueAt` (an ISO-8601 datetime) or
 * `delayMinutes` (a relative delay from now), plus a non-empty `message`. Throws on invalid
 * input so the model receives a corrective error rather than a bad reminder.
 */
export function normalizeSetReminderArgs(
  args: Record<string, unknown>,
  now: number,
): SetReminderInput {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  if (!message) throw new Error("A non-empty reminder message is required.");

  let dueAt: number | undefined;
  if (typeof args.dueAt === "string" && args.dueAt.trim()) {
    const parsed = Date.parse(args.dueAt.trim());
    if (!Number.isFinite(parsed)) {
      throw new Error(
        "Could not understand the reminder time. Use an ISO-8601 datetime or a delay in minutes.",
      );
    }
    dueAt = parsed;
  } else if (typeof args.delayMinutes === "number" && Number.isFinite(args.delayMinutes)) {
    if (args.delayMinutes < MIN_DELAY_MINUTES || args.delayMinutes > MAX_DELAY_MINUTES) {
      throw new Error(`delayMinutes must be between ${MIN_DELAY_MINUTES} and ${MAX_DELAY_MINUTES}.`);
    }
    dueAt = now + Math.round(args.delayMinutes * 60_000);
  } else {
    throw new Error("Provide either dueAt (an ISO-8601 datetime) or delayMinutes.");
  }

  if (dueAt <= now) {
    throw new Error("The reminder time must be in the future.");
  }

  return { message, dueAt };
}

/** Human-readable summary of a pending `set_reminder` call, shown in the confirmation prompt. */
export function summarizeReminder(args: Record<string, unknown>): string {
  const message = typeof args.message === "string" ? args.message.trim() : "";
  const when =
    typeof args.delayMinutes === "number"
      ? `in ${args.delayMinutes} minute(s)`
      : typeof args.dueAt === "string" && args.dueAt.trim()
        ? `at ${args.dueAt.trim()}`
        : "later";
  return message ? `Set a reminder to "${message}" ${when}` : "Set a reminder";
}

/**
 * Build a short system-prompt hint listing pending notifications so Arya can announce them
 * naturally. Returns "" when there is nothing to announce.
 */
export function buildNotificationsHint(notifications: AryaNotification[]): string {
  if (notifications.length === 0) return "";
  const lines = notifications.map((n) => `- ${n.title}: ${n.detail}`);
  return (
    "The user has these pending reminders (mention them naturally in your first reply):\n" +
    lines.join("\n")
  );
}
