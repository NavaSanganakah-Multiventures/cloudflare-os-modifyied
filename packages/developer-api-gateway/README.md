# Developer API Gateway

A standalone Cloudflare Worker that exposes a public HTTP API for end-user website/application support queries. Queries are turned into GitHub issues in the configured repository, and when a fix workflow is configured into auto-fix pull requests.

## Deployment

This package is part of the Cloudflare OS monorepo. To deploy it on its own:

```bash
cd packages/developer-api-gateway
wrangler secret put GITHUB_TOKEN
wrangler deploy
```

Set GITHUB_OWNER and GITHUB_REPO in wrangler.jsonc or via wrangler vars put.

## Public API

All external endpoints require an X-API-Key header.

### POST /api/v1/query

Submit a user question or problem report.

### POST /api/v1/analyze

Heuristic diagnosis without creating a GitHub issue.

### POST /api/v1/fix

Propose a code fix as a pull request.

### POST /api/v1/auto-fix

Create an issue and dispatch .github/workflows/developer-api-auto-fix.yml if it exists on main.

### GET /api/v1/health

Health check, no auth required.

## Future improvements

- Integrate with the GitHub Gatekeeper instead of a raw PAT so actions flow through the approval queue.
- Wire this worker into the main router so it serves under the instance public origin.
