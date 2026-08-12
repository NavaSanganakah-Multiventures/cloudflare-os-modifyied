// Security alert notifier (shared across all workers).
//
// When a security-relevant failure happens (a misconfigured ADMINS binding, an
// unhandled server crash, a gatekeeper delivery failure, or an unhandled
// frontend error), this module sends a *sanitized* email to the deployment
// admin via the Cloudflare Email Service send_email (EMAIL) binding.
//
// Design rules (enforced here so callers cannot accidentally violate them):
//   1. Alerts never block the request path. Sending is fire-and-forget via
//      ctx.waitUntil; a send failure is logged via console.warn, never thrown.
//   2. Alert bodies never contain secrets, env values, raw emails, full stack
//      traces, or long tokens. sanitizeAlertText() scrubs these first.
//   3. Alerts are off by default (ALERTS_ENABLED !== "true") and additionally
//      require EMAIL, ADMIN_ALERT_EMAIL and ALERT_FROM_EMAIL. Where a worker
//      lacks the send_email binding, this is a safe no-op, so call sites can be
//      wired everywhere and enabled per-worker as bindings are added.
//   4. Each event type is rate-limited per isolate to one email per 15 minutes,
//      so a hot loop cannot flood the admin inbox.

export type SecurityAlertType =
  | "admin_config_misparse"
  | "unhandled_server_error"
  | "email_delivery_failed"
  | "context_skill_load_failed"
  | "frontend_security_error";

export type SecurityAlertSeverity = "info" | "warn" | "error" | "fatal";

export type SecurityAlert = {
  type: SecurityAlertType;
  severity: SecurityAlertSeverity;
  // Short, already-sanitized human summary. Must NOT carry secrets or env values.
  summary: string;
  // Optional extra sanitized line. Also scrubbed before sending.
  detail?: string;
};

// Bindings this module needs. Kept narrow so callers can pass a stub in tests.
export type SecurityAlertEnv = Readonly<{
  EMAIL?: SendEmail;
  ADMIN_ALERT_EMAIL?: string;
  ALERT_FROM_EMAIL?: string;
  ALERTS_ENABLED?: string;
}>;

type WaitUntil = { waitUntil(promise: Promise<unknown>): void };

const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_TEXT_LEN = 500;

// Per-isolate, per-type last-sent timestamp. Resets when the isolate recycles,
// which is good enough to stop floods without cross-isolate storage complexity.
const lastSent = new Map<SecurityAlertType, number>();

// Matches an email address, or a long token-shaped string (hex/base64/url-safe),
// and redacts it so alert bodies never leak identifiers or credentials.
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const TOKEN_RE = /\b[A-Za-z0-9+/=_-]{20,}\b/g;

export function sanitizeAlertText(text: string): string {
  if (typeof text !== "string") return "";
  let scrubbed = text
    .replace(EMAIL_RE, "[redacted-email]")
    .replace(TOKEN_RE, "[redacted-token]");
  if (scrubbed.length > MAX_TEXT_LEN) scrubbed = scrubbed.slice(0, MAX_TEXT_LEN) + "...";
  return scrubbed;
}

// Report a security event by emailing the admin. Always returns synchronously;
// never throws. Safe to call from hot request paths (including #isAdmin()).
export function reportSecurityEvent(
  env: SecurityAlertEnv,
  alert: SecurityAlert,
  ctx?: WaitUntil,
): void {
  try {
    if (env.ALERTS_ENABLED !== "true") return;
    if (!env.EMAIL || !env.ADMIN_ALERT_EMAIL || !env.ALERT_FROM_EMAIL) return;

    // Per-type throttle within the rate window.
    let now = Date.now();
    let last = lastSent.get(alert.type) ?? 0;
    if (now - last < RATE_WINDOW_MS) return;
    lastSent.set(alert.type, now);

    let subject = "[Security Alert] " + alert.severity.toUpperCase() + ": " + alert.type;
    let body = [
      "Security alert from your Cloudflare OS deployment.",
      "",
      "Type: " + alert.type,
      "Severity: " + alert.severity,
      "Time: " + new Date(now).toISOString(),
      "",
      "Summary: " + sanitizeAlertText(alert.summary),
      alert.detail ? "Detail: " + sanitizeAlertText(alert.detail) : null,
      "",
      "This is an automated alert. Sensitive details are intentionally omitted.",
    ].filter((line): line is string => line !== null).join("\n");

    let send = env.EMAIL.send({
      to: env.ADMIN_ALERT_EMAIL,
      from: env.ALERT_FROM_EMAIL,
      subject,
      text: body,
    });

    let onFail = (err: unknown) => {
      console.warn("security alert email send failed", {
        event: "security_alert.send.failed", type: alert.type, error: err,
      });
    };
    if (ctx) ctx.waitUntil(send.catch(onFail));
    else send.catch(onFail);
  } catch (err) {
    console.warn("security alert report failed", {
      event: "security_alert.report.failed", type: alert.type, error: err,
    });
  }
}
