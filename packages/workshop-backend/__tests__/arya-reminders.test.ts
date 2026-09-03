import { describe, expect, it } from "vitest";

import {
  buildNotificationsHint,
  normalizeSetReminderArgs,
  summarizeReminder,
} from "../src/aarya/aarya-reminders";

describe("normalizeSetReminderArgs", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");

  it("accepts a message with delayMinutes", () => {
    expect(normalizeSetReminderArgs({ message: "call mom", delayMinutes: 10 }, now)).toEqual({
      message: "call mom",
      dueAt: now + 10 * 60_000,
    });
  });

  it("accepts a message with an ISO dueAt", () => {
    const dueAt = Date.parse("2026-01-01T00:10:00Z");
    expect(
      normalizeSetReminderArgs({ message: "call mom", dueAt: "2026-01-01T00:10:00Z" }, now),
    ).toEqual({ message: "call mom", dueAt });
  });

  it("rejects empty messages", () => {
    expect(() => normalizeSetReminderArgs({ message: "   " }, now)).toThrow(/non-empty/);
  });

  it("rejects missing time inputs", () => {
    expect(() => normalizeSetReminderArgs({ message: "call mom" }, now)).toThrow(
      /dueAt|delayMinutes/,
    );
  });

  it("rejects past times", () => {
    expect(() =>
      normalizeSetReminderArgs({ message: "call mom", dueAt: "2025-12-31T00:00:00Z" }, now),
    ).toThrow(/future/);
  });
});

describe("summarizeReminder", () => {
  it("describes a delay", () => {
    expect(summarizeReminder({ message: "call mom", delayMinutes: 10 })).toBe(
      'Set a reminder to "call mom" in 10 minute(s)',
    );
  });

  it("describes an absolute time", () => {
    expect(summarizeReminder({ message: "call mom", dueAt: "2026-01-01T00:10:00Z" })).toBe(
      'Set a reminder to "call mom" at 2026-01-01T00:10:00Z',
    );
  });
});

describe("buildNotificationsHint", () => {
  it("is empty when there are no notifications", () => {
    expect(buildNotificationsHint([])).toBe("");
  });

  it("lists notification details", () => {
    const hint = buildNotificationsHint([
      { id: "n1", kind: "reminder", title: "Reminder", detail: "call mom", createdAt: 0 },
    ]);
    expect(hint).toContain("- Reminder: call mom");
  });
});
