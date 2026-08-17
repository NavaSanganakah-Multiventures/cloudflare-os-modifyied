# Developer API Gateway

A standalone Cloudflare Worker package that exposes an HTTP API for end-user website/app queries. Queries become GitHub issues, fixes become pull requests, and responses are sent back to caller-supplied callback URLs.

## Deploy

```bash
cd packages/developer-api-gateway
wrangler secret put GITHUB_TOKEN         # GitHub PAT with repo scope
wrangler deploy
```

Optional vars in `wrangler.jsonc`:
- `GITHUB_OWNER` / `GITHUB_REPO` — default target repository

Optional secret:
- `CALLBACK_SECRET` — sent as `X-Callback-Secret` header to callback URLs so your website can verify the request

## API endpoints

- `POST /api/v1/query` — create a GitHub issue
- `POST /api/v1/fix` — propose a fix PR
- `POST /api/v1/analyze` — heuristic diagnosis
- `POST /api/v1/auto-fix` — create issue and optionally dispatch `.github/workflows/developer-api-auto-fix.yml`
- `GET /api/v1/health` — health check

## Multi-repo

Pass `repoOwner` and `repoName` in the request body. If omitted, the worker falls back to `GITHUB_OWNER`/`GITHUB_REPO`. The token must have access to the requested repo.

## Callbacks

Pass `callbackUrl` in any request. The worker will immediately POST a JSON payload to that URL containing the issue/PR details. Your server can verify the `X-Callback-Secret` header if `CALLBACK_SECRET` is configured.

## Admin

- `GET/POST /admin/system-instructions`
- `GET/POST /admin/api-keys`
- `POST /admin/api-keys/revoke`
- `GET /admin/queries`
- `GET /admin/docs`

## Note on GitHub Gatekeeper

This standalone worker uses a direct GitHub token so it can operate without a user OAuth session and can POST callbacks to arbitrary URLs. For UI-driven, approval-queue workflows, continue using the `gatekeeper-github` Gadget workflow.