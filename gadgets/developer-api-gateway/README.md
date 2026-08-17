# Developer API Gateway Gadget Template

This folder contains a reusable Gadget template for Cloudflare OS.

## What it does

- Exposes a public HTTP API (/api/v1/*) that website/app users can call.
- Creates GitHub issues from user queries in a bound repository.
- Accepts fixes and turns them into pull requests.
- Supports multiple GitHub repositories: bind each repo in Cloudflare OS and add its binding name in the Bindings tab.
- Optional callbackUrl: dispatches a GitHub Actions workflow that POSTs the result back to your website.

## Setup

1. Create a new Gadget in your Cloudflare OS workspace.
2. Replace the Gadget files with server.js, client.js, and this README.md.
3. Bind one or more GitHub repositories to the Gadget using Cloudflare OS resource introduction.
4. Open the Gadget UI, go to the Bindings tab, and enter the environment binding names (default: CLOUDFLARE_OS_CONFIG).
5. Set system instructions and create an API key.
6. Send queries from your website/app using the generated API key.

## Optional callback workflow

Copy .github/workflows/developer-api-callback.yml into your target repo and adjust the POST logic. When an API request includes callbackUrl, the Gadget dispatches this workflow to notify your website.

## Public endpoints

- POST /api/v1/query — create a GitHub issue
- POST /api/v1/fix — propose a fix PR
- POST /api/v1/analyze — heuristic diagnosis
- GET /api/v1/health — health check

All endpoints except health require X-API-Key header.