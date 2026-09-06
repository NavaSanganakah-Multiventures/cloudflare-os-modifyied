# Google Jules gatekeeper

A first-class Cloudflare OS gatekeeper for Google Jules, Google's asynchronous coding agent.

This package wraps the Jules REST API (https://jules.googleapis.com/v1alpha, authenticated with an X-Goog-Api-Key header). It lets gadgets and agents:

- list and get Jules sources (GitHub repositories connected to Jules);
- create, get, and list Jules sessions;
- send messages and approve plans;
- archive, unarchive, and delete sessions;
- list and get session activities (generated plans, progress updates, and pull requests).

Read-only operations are authorized as observations after the data is fetched. Side-effecting operations go through the approval queue as actions and are only applied once approved.

## Connection

The account is connected with a Jules API key. Create one at https://jules.google.com under Settings, API. The key is stored in the UserAccount Durable Object and never leaves the gatekeeper worker.

## Resources

The gatekeeper offers two resource types when attaching to a user account:

- **Google Jules** (whole account) - the entire account: every source, session, and activity. URL pattern `https://*`.
- **Google Jules Repository** (single repository) - one GitHub repository connected to Jules (a Jules "source"). URL pattern `https://jules.google.com/sources/:source`. Its configurator lists the account's sources so the user can pick one, and the resulting binding is scoped to that source only.


## Structure

- src/jules.ts - fetch handler, connect flow, vendor/user/gatekeeper Durable Objects, and the JulesSession implementation.
- src/jules-api.ts - typed REST client for the Jules API.
- src/types.d.ts and src/types.txt - TypeScript interfaces exposed to gadgets and agents.
- src/configurator/account-configurator-ui.tsx - whole-account resource configurator UI.
- src/configurator/repo-configurator-ui.tsx - single-repository resource configurator UI.
- src/configurator/repo-configurator-types.d.ts - option/values/RPC contract shared by the repo configurator UI and jules.ts.

## Build

    pnpm install
    pnpm --filter @gadgets/jules-gatekeeper build
    pnpm --filter @gadgets/jules-gatekeeper types:check
