# Security Alerts

When a security-relevant failure occurs on the backend (a misconfigured `ADMINS`
binding, an unhandled server crash, a gatekeeper delivery failure, or an
unhandled frontend error), the deployment can email the admin via the
Cloudflare Email Service `send_email` binding.

## Enable

Alerts are **off by default**. To enable them, set these bindings/vars on the
worker(s) that should send alerts:

| Binding / var | Example | Notes |
|---------------|---------|-------|
| `send_email` binding named `EMAIL` | (wrangler.jsonc) | Requires Workers Paid plan |
| `ALERTS_ENABLED` | `true` | Master switch; any other value keeps alerts off |
| `ADMIN_ALERT_EMAIL` | `admin@example.com` | Recipient; must be a verified destination address |
| `ALERT_FROM_EMAIL` | `alerts@yourdomain.com` | Verified sending address on your domain |

Set vars via `wrangler secret put` or `vars` in wrangler.jsonc. The
`ADMIN_ALERT_EMAIL` address must be verified as a destination address in
Cloudflare Email Routing.

## Where alerts fire

| Event type | Source | Severity |
|------------|--------|----------|
| `admin_config_misparse` | `workshop-backend` `#isAdmin()` | error |
| `unhandled_server_error` | `workshop-backend` fetch handler | fatal |
| `frontend_security_error` | `workshop-backend` client-errors endpoint | error/fatal |
| `email_delivery_failed` | `gatekeeper-email` inbound delivery | error |
| `context_skill_load_failed` | `gatekeeper-context` skill load | warn |

Each worker calls the shared `@gadgets/workshop-shared/security-alerts`
module, which is a safe no-op where the `EMAIL` binding is not configured. Add
the `send_email` binding + vars to a worker to enable its alerts.

## Safety properties

- Alerts never block the request path (fire-and-forget via `ctx.waitUntil`).
- Alert bodies are sanitized: emails and long tokens are redacted before
  sending. No secrets, env values, or full stack traces are included.
- Each event type is rate-limited to one email per 15 minutes per isolate.
