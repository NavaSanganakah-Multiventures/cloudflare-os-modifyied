This project is building a platform for "vibe coded" personal applications and AI agents that run inside a strong sandbox.

## Naming: AARYA (not Arya)

The voice assistant's canonical name is **AARYA** (all caps, double A), not "Arya".

* User-facing strings must use **AARYA** (persona prompts, UI labels, error messages).
* Code identifiers and file names use idiomatic double-A casing: `AaryaReminder`, `aarya-voice.ts`, `getAaryaGeminiKey()`, `mintAaryaVoiceToken()`, and the API path `/api/aarya/`.
* Env vars use the `AARYA_*` prefix (e.g. `AARYA_GEMINI_API_KEY`).
* The Durable Object class name `AryaCallRoom` is **frozen** (single A) — it is baked into `packages/workshop-backend/worker-configuration.d.ts` (`durableNamespaces`) and `scripts/testdata/golden-manifest.json` (release-manifest golden test). Renaming it would require regenerating those generated files and would break the golden release-manifest test, so leave it as-is.
* The platform/product name "Aarya Smart" (double A) is already correct.

## Encoding Requirement

All text files, code, documentation, and records in this repository must be encoded and decoded using **UTF-8**.
When reading or writing files, converting buffers, generating strings, serializing records, or serving text responses,
always use UTF-8. Do not use Latin-1, Windows-1252, ASCII-only fallbacks, or any other single-byte encoding.
This prevents mojibake / garbage characters for symbols, em-dashes, Unicode arrows, and non-English text.

The following files are commonly important to reference:

* packages/workshop-shared/node_modules/capnweb/README.md: Explains how to use Cap'n Web RPC, which is used extensively for client-server communications.
* packages/workshop-shared/src/api.ts: Defines the RPC API used between the frontend and backend.

The project structure is:

* packages/workshop-frontend: The Gadgets Workshop UI.
    * This is a pure single-page app, running entirely client-side.
    * It speaks to the backend using an RPC API over a persistent WebSocket connection.
    * Uses React, Kumo UI (https://kumo-ui.com/api/component-registry), Phosphor icons, and Vite.
* packages/workshop-backend: The Gadgets Workshop server.
    * Runs on Cloudflare Workers.
    * This is the **kernel**: it defines the architecture and is held to a higher bar than UI/gatekeeper code. Reviewers read *every line* of `workshop-backend` and of API changes in `workshop-shared`, so keep diffs here small and elegant. Concretely: doc-comment **every** exported member of the `workshop-shared` public API (types, consts, and functions — not just interfaces); never introduce a hand-written interface that mirrors an RPC interface plus an `as unknown as` cast (derive from the real type instead, or rethink the design); and prefer reusing existing mechanisms over adding parallel ones. Capability-based security note: a resource becomes "ambient" (auto-injected) only by user/admin configuration — a gatekeeper must never assert its own ambience. When a change to this package is large, split it by concern into separate PRs (and at minimum group commits so `workshop-backend`/`workshop-shared` can be reviewed apart from UI), since fewer kernel lines = easier review.
    * `format-blueprints/` holds the **output format** blueprints the deployment ships with, committed as data: a `<name>.gadget` archive plus a `<name>.json` sidecar giving its `blueprintId`, prose, and `output` presentation. `scripts/build-format-blueprints.mjs` globs that directory (override with `FORMAT_BLUEPRINTS_DIR`, which lets a fork ship its own set without touching this submodule) into the gitignored `src/generated/format-blueprints.ts`, so `build`, `types:check` and `test` all run the generator first. Replace one with `pnpm import:format-blueprint <export.gadget> <blueprintId>`, or add one with `pnpm import:format-blueprint <export.gadget> --new <name>`; never edit a `blueprintId` after deploy, since the install and promotion are keyed on it and a rename orphans the old entry. See `format-blueprints/README.md`.
* packages/workshop-shared: Shared API definitions between client and server.
    * This defines the application's RPC interface.
    * The RPC protocol is Cap'n Web, which has similar semantics to Cloudflare's Worker-to-Worker RPC system, while being able to run in a browser over WebSocket. Read the readme for details.
* packages/configurator-ui: Type-only component helpers used by optional gatekeeper resource configurator UI modules.
    * Gatekeeper configurator UI modules are compiled by `scripts/build-gatekeeper-configurator.mjs` as part of package builds.
* packages/gatekeeper-*: Gatekeeper workers for external service integrations.
    * Each gatekeeper runs as a separate Cloudflare Worker.
    * Gatekeepers handle OAuth flows and provide sandboxed access to external APIs.
    * A gatekeeper may declare `VendorDescription.autoProvisionsAccount`: it can mint a connected account with no OAuth flow (via `GatekeeperVendor.createAccount()`, which takes no user identity). For such gatekeepers the deployment admin picks a per-vendor mode in the admin Gatekeepers panel — **disabled** / **optional** / **enabled** (default **optional**) — resolved in `provisioning-policy.ts`: `enabled` auto-provisions the account for every user (forced, and hidden from the Connectors list), `optional` lets each user opt in from the Connectors page, and `disabled` offers it to no one (existing accounts go dormant). The Workshop persists the account in the user DO like any connected account (the account capability — not an asserted identity — is the authority thereafter). The **account** (a `GatekeeperUser`) declares in its `AccountDescription` whether it provides an agent **singleton** (`singleton: { tsType }`) and/or a **management UI** (`providesUi`). The Workshop auto-provides the singleton to the owner's workspaces as an **ambient gatekeeper record**, folded into each chat's env as a **named chat binding** (named by the gatekeeper's `suggestedBindingName`; see `prepareChatBindings` in overseer.ts) that the agent reads in `executeCode` (`getSession`/`getAgentCatalog`), each read recorded as an observation. It is not bound to any gadget by default — most gadgets never call it programmatically — but the agent may wire it into a gadget's binding list with `setGadgetBinding` when the gadget's persistent code needs it. The UI is hosted at `/gatekeepers/$appId` (the gatekeeper's vendor id, e.g. `/gatekeepers/context`) via `startAppUi({ isAdmin })`. The two are orthogonal — an account can declare either, both, or neither.
* packages/mcp-shared: Shared implementation behind the two MCP gatekeepers — `gatekeeper-mcp` (endpoints a user pastes) and `gatekeeper-mcp-portal` (one admin-configured portal). Not a Worker; a library both import, holding the MCP client, the OAuth chain, the account DO base, the resource-URL scope grammar, and the queued-action store. See `packages/mcp-shared/README.md` and each connector's README.
    * The trust boundary is `tools.ts`, and nothing outside it reads a tool's annotations: a tool the server declares `readOnlyHint: true` runs as an observation, everything else is queued for approval, and auto-*applying* a write additionally requires a `vetted` endpoint — which only the portal can produce, via `MCP_PORTAL_TRUST_ANNOTATIONS`.
    * OAuth uses the official `@modelcontextprotocol/client`; always give SDK OAuth operations `sdkFetch(...)` so every request and redirect retains endpoint and SSRF checks.
* packages/gatekeeper-context: The Context Library — a gatekeeper whose account provides a singleton read session + a management UI, for authoring collections of context documents that agents read as observations. Collections have one of two visibilities: **private** (owned by a single account, readable/writable only by that account) and **public** (created/edited only by deployment admins, readable by everyone and auto-enabled for all users). It owns its state in three Durable Objects (`ContextCollectionDurableObject` for content, `UserLibraryDurableObject` for each account's own private collections, `LibraryRegistryDurableObject` for the domain's public set) plus a KV namespace. All data is namespaced by a `sharingDomain` (from the binding's props, see `domain.ts`) so multiple workshops sharing one gatekeeper instance stay isolated.
    * Its `GatekeeperVendor` entrypoint (bound as `GATEKEEPER_CONTEXT`) declares `autoProvisionsAccount` and mints a `ContextAccount` via `createAccount()` (no user identity is passed in; the account keys its private data by its own generated `accountId`). The account exposes the agent read session (`getSession()`), collection discovery metadata (`getAgentCatalog()`), and a management UI (`startAppUi({ isAdmin })`). The UI is a single-file React SPA in `app/` (Vite + Tailwind + Kumo) bundled by `build-app.mjs` into `src/generated/app.txt`.
* packages/gatekeeper-scheduler: Scheduled Tasks — an auto-provisioned gatekeeper whose account provides an ambient singleton for registering persistent workspace callbacks plus a read-only management UI. One account-scoped `ScheduleDriver` Durable Object stores enabled schedules and delivers them from a shared alarm; hook enablement remains in the Workshop Connections UI.
* packages/router: The public origin of a deployed gadgets instance. Serves the workshop-frontend assets and routes by path prefix: `/api/*` and `/blueprint-screenshot/*` to the workshop backend, `/gatekeeper/<name>/*` to whichever gatekeepers are bound (discovered by scanning its own `GATEKEEPER_*` service bindings, so installing a gatekeeper is purely a binding change). The same worker doubles as the dev router (`pnpm dev-server`): with no `ASSETS` binding it proxies frontend requests to the Vite dev server instead.

Deployment admin settings (the `/admin` panel) follow a few conventions worth knowing when extending them:

* `packages/workshop-backend/src/admin-config.ts` defines `AdminConfig` — the deployment's "soft" customizations: agent instructions, banners/theme, and which gatekeeper connectors/resources are offered (plus the three-state mode for auto-provisioning gatekeepers, see `provisioning-policy.ts`). Connectors/resources default to enabled and the admin UI opts them *out*; auto-provisioning gatekeepers default to *optional*. **Authentication/authorization config (sign-in providers via `AUTH_GATEKEEPERS`, password login via `DISABLE_PASSWORD_AUTH`) is deliberately NOT here** — it stays env-var driven (`auth/config.ts`) so it can't be changed by a compromised admin session.
* The `AdminSettings` durable object owns the authoritative `AdminConfig` and mirrors it to a single reserved KV key (`.adminConfig`, see `isReservedBlueprintKey()`), so hot-path code (connect/agent) reads it with one cheap KV get via `readAdminConfig(env)`. The DO is the only writer (`updateAdminConfig(patch)`).
* Admin operations are exposed as an `AdminApi` capability obtained via `AuthenticatedApi.getAdminApi()` (returns null for non-admins). The `#isAdmin()` check happens once when the capability is minted, so the individual methods don't re-check.
* `user.ts:getGatekeeperClassFor()` is the single core chokepoint where disabled gatekeepers/resources are enforced before a capability is minted (gadget/agent code can't reach it directly).

Release pipeline (`scripts/release/`) — how customer instances get deployed:

* `build-release.mjs` bundles every deployable worker byte-identically (wrangler dry-run with the pinned wrangler), builds the Access-mode frontend asset build, and generates the release manifest — the contract between this repo's CI and the deploy service, produced by `manifest-lib.mjs` from each package's wrangler.jsonc with account-specific values replaced by placeholders (`$ACCOUNT_ID`, `$WORKER_NAME(...)`, `$SECRET(...)`, `$PUBLIC_BASE_URL`, ...).
* `upload-release.mjs` mirrors the release to R2 content-addressed, manifest last; with `--candidate` the manifest lands under `candidates/<id>/` (invisible to the deploy service) so e2e can verify it, and `promote-release.mjs` then copies it to `releases/<id>/` — publishing is that single all-or-nothing manifest copy. The copy is not isolated against concurrent promotions, so CI serializes promote runs (a GitLab resource group) and the script's newer-release guard skips candidates that a later release has already superseded.
* The manifest is covered by a golden-file test; after an intentional manifest change, regenerate with `UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js` and review the golden diff.
* Running the flow by hand (upload and promote need `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`):
    * `node scripts/release/build-release.mjs --out release-out` — build everything into `release-out/` (id defaults to `r<CI_PIPELINE_IID>-<sha7>` in CI, `dev-<timestamp>` locally; override with `--release-id <id>`).
    * `node scripts/release/upload-release.mjs --release release-out --candidate` — mirror to R2; omit `--candidate` to publish directly (bypasses the gate — CI never does this).
    * `node scripts/release/promote-release.mjs --release-id <id>` — copy the verified candidate's manifest into `releases/<id>/`.
* Deploy-wizard configuration: an installable gatekeeper's user-supplied inputs default to OAuth `CLIENT_ID`/`CLIENT_SECRET` secrets; a per-package `deploy-inputs.json` overrides them, and `NO_DEFAULT_CRED_INPUTS` in `manifest-lib.mjs` opts out gatekeepers that take no third-party OAuth app credentials (the wizard blocks Install on unfilled secret inputs, so a spurious default makes a gatekeeper uninstallable). Backend instance-state vars (`ADMINS`, `DEPLOY_URL`, ...) are injected by the deploy service at PUT time, never manifest-templated.

To test changes:
- Run `pnpm build` (optionally narrowed to a particular package) to run TypeScript type checks.
- Run `pnpm test` to run unit tests, though as of this writing most packages don't have tests yet.

Linting (oxlint):
- `pnpm lint` runs what CI currently enforces: `lint:check` (oxlint) and `types:check` (recursive `tsc --noEmit`). Run this before pushing.
- Individual scripts:
    * `pnpm lint:check` / `pnpm lint:fix` — oxlint (config in `.oxlintrc.json`; `correctness` + `suspicious` as errors).
    * `pnpm types:check` — recursive `tsc --noEmit`.
- Unused function parameters and caught errors are not lint-enforced; unused imports and local variables are still errors.
- Some rules are kept as warnings (e.g. `no-shadow`) for incremental cleanup; warnings don't block CI.
- Type-aware oxlint rules are intentionally not enabled. The type-aware engine (tsgo) requires an explicit `rootDir` under declaration emit and drops `baseUrl`, which is incompatible with this monorepo's cross-package source imports. Among other things this means `no-floating-promises` is not enforced — which is just as well, since RPC promise pipelining (below) intentionally leaves promises unawaited. Type safety is still enforced by `tsc` through `pnpm types:check` and `pnpm build`.

IMPORTANT: This repository uses pnpm, not npm. Always use pnpm.

IMPORTANT: Remember when using RPC to use promise pipelining whenever possible. Cap'n Web implements promise pipelining (similar to Cap'n Proto). This means that if an RPC returns a stub, it's not necessary to await the RPC -- the promise itself can be used in place of the stub. Also, Cap'n Web lets you use the promise for a future result (even if it isn't a stub) in the arguments for another call; the promise will be replaced with its resolution on the server side before delivering the arguments. See the Cap'n Web README.md for more details.

IMPORTANT: When using React's useState(), the state value cannot be an RPC stub. At runtime, all stubs appear to be callable (because the system doesn't actually know if the stub points to a function on the server side or not). But the setter returned by useState() has different behavior if passed a function (including any callable object): it calls the function in order to get the state. In order to avoid this problem, whenever a useState() state will contain an RpcStub, it's important to wrap the stub in an object, and set the state to that object instead.

IMPORTANT: RPC stubs must be disposed to prevent resource leaks on the server side. Call `stub[Symbol.dispose]()` when the stub is no longer needed (or use a `using` declaration where possible). In particular, when a React component obtains a stub in a useEffect, the cleanup function should dispose the stub.

IMPORTANT: Server-side logging uses `@gadgets/backend-utils/logger` (frontend browser `console.*` is out of scope):
- Define a package-owned field type and module-scoped logger with a stable dot-separated `component`
  and, for gatekeepers, `vendorId`:
  `const logger = createLogger<GitHubLogFields>({ component: "gatekeeper.github", vendorId: VENDOR_ID });`.
- Emit concrete event names and relevant typed fields, for example:
  `logger.warn("failed to notify credential expiry", { event: "credentials.expiry.notify.failed", error: err });`.
  Each call emits one indexed object; module/child fields such as `vendorId` are inherited.
- Use immutable `logger.with(fields)` for object-owned or nearby context. Prefer module/object loggers
  over logger parameters, and do not replace a shallow child logger with ambient context just to
  remove a local variable.
- For bounded operation context needed by deep helpers, independent loggers, or other observability
  consumers, use `createObservabilityContext` from `@gadgets/backend-utils/observability-context`.
  Re-establish it per operation;
  it does not cross RPC, hibernation, or restart, and requires `nodejs_als` or `nodejs_compat`.
- Pass caught values as `error`. The helper stringifies `Error` instances and primitives, uses an
  own string `message` for plain objects, omits `undefined`, and adds stacks to all `Error` logs.
  Keep this normalization deliberately small; do not traverse causes or copy arbitrary properties.
- Extend field vocabularies locally. Levels: `error` needs attention, `warn` continues best-effort,
  `info` is notable lifecycle, and `debug` is noisy breadcrumbs. Never log secrets, prompts, headers,
  tokens, or request/response bodies.
- To also dispatch a failure to the optional external issue Reporter (in addition to logging it),
  call `reportIssue(failureSite, caught, options?)` from
  `@gadgets/backend-utils/error-reporting`. Attach ambient fields from the package's observability
  context and augment them with capture-site fields:
  `reportIssue("overseer.catalog-fallback", err, { handled: true, attributes: { ...obsContext.get(), gatekeeperId } });`.
  It is a no-op when the `ERROR_REPORTER` binding is absent (local dev / deployments without an issue
  destination). Only bounded scalars are retained as attributes; reported context obeys the same
  no-secrets rules as log fields.

IMPORTANT: Frontend error reporting is a separate, opt-in path:
- `@gadgets/error-reporting` owns the vendor-neutral browser/Worker event contract and tolerant,
  bounded normalization. `VITE_FRONTEND_ERROR_REPORTING=true` enables trusted frontend producers
  and their hidden source maps at build time; deployments without reporting should leave it unset.
- The Workshop browser sends best-effort reports to the same-origin `POST /api/client-errors`
  endpoint. The backend dispatches only when both `FRONTEND_ERROR_REPORTER` and
  `FRONTEND_ERROR_RATE_LIMITER` are bound; otherwise the endpoint is an intentional no-op.
- Gatekeeper management/configurator UIs run as Workshop-owned opaque-origin `srcDoc` frames. They
  send bounded reports with `postMessage`; the host accepts them only from the known frame window
  with origin `null`, adds host-owned surface/vendor context, and performs the same-origin POST.
  Do not add direct cross-origin reporting from a gatekeeper Worker domain.
- Frontend reports and frame metadata are diagnostic only and never convey identity or authority.
  Install automatic capture only in trusted first-party surfaces, never gadget/user-authored code.
  Exception messages and stacks reach the external Reporter, so never intentionally put secrets,
  prompts, tokens, headers, or request/response bodies in thrown errors or report metadata.

## GitHub Repository File Edits

When working with a connected `GitHubRepo` binding, **never write or delete files directly on the
default branch**. The gatekeeper rejects direct default-branch `writeFile()` and `deleteFile()`
calls.

Keep changes scoped: one task = one feature branch = one pull request. Do not mix unrelated
changes in a single branch or PR; split them into separate branches.

### MANDATORY branch-first workflow

You MUST follow this exact step-by-step workflow for every change. Do NOT use
`proposeFileChange()` or `proposeFileDeletion()` — those bundle everything into the approval
queue with no verification, and the agent has no way to confirm that the branch was actually
pushed. Instead, drive each step yourself so you can verify each one succeeded before moving on.

**Step 1 — Create a new feature branch (always, before any change).**

- Get the default branch's current commit SHA: `const main = await repo.getBranch(defaultBranch);`
  (use `getMetadata()` to learn `defaultBranch` if you don't know it). Re-read this SHA
  immediately before creating the branch so it is based on the latest default branch, not a stale
  snapshot.
- Choose a meaningful branch name that describes the change (for example `feature/add-login`,
  `fix/compile-error`, or `refactor/db-layer`). The name should reflect the user requirement,
  not a hard-coded issue-based template.
- Create the branch from that SHA: `await repo.createBranch(name, main.sha);`
  This makes the new branch an exact copy of the default branch at that commit — you do NOT need
  to copy files manually.
- A branch that already exists is fine to reuse ONLY when it is based on the latest default
  branch. Confirm its SHA with `getBranch(name)` before writing to it; if it has fallen behind
  the default branch, create a fresh branch from the latest default-branch SHA instead (or
  merge/rebase first).

**Step 2 — Make the change on that branch.**

- For an existing file, first read it on the feature branch to obtain its current blob `sha`
  and content: `const f = await repo.readFile(path, name);`
  Only read it on the default branch if you specifically need the original pre-change copy — for
  example to compare against a version that is no longer visible on the branch because you have
  already edited it there.
- Write the file to your feature branch (NOT the default branch) with
  `await repo.writeFile({ path, message, content, sha: f.sha, branch: name });`
  (omit `sha` only when creating a brand-new file).
- To delete a file: `await repo.deleteFile({ path, message, sha: f.sha, branch: name });`

**Step 3 — Verify the change was actually pushed to the branch. Do not skip this.**

- `writeFile`/`deleteFile` return a `GitHubCommitHandle`. Call
  `const commit = await handle.getResult();` and loop/poll until it returns a real commit (not
  `null`) — `null` means the action is still awaiting approval or hasn't been applied yet.
  If it resolves to an error, the change was rejected: STOP, report the error, and do not open a
  PR.
- Independently re-read the branch tip to confirm it advanced:
  `const b = await repo.getBranch(name);` and check that `b.sha` changed from the pre-write SHA,
  i.e. the commit actually landed on the branch on GitHub. If `b.sha` is unchanged, the push did
  NOT happen — do not proceed to a PR; report the discrepancy and retry.
- Re-read the changed file on the feature branch (`readFile(path, name)`) and confirm its content
  is the intended content, not just that the branch SHA advanced.

**Step 4 — Create the pull request, only after verification passes.**

- `await repo.createPullRequest({ title, head: name, base: defaultBranch, bodyMarkdown });`
- If verification in Step 3 failed or is inconclusive, you MUST NOT open a PR. Fix or retry the
  push first.

**Summary of the rule:** new branch → change on that branch → verify the commit landed on the
branch (handle resolved AND branch SHA advanced) → only then open the PR. Never open a PR for an
unverified push.

### Read discipline: which ref to read from

Once the feature branch exists, it is the source of truth for your task. Read and check files on
the branch you are working on, by passing its name as `ref`:

- `repo.readFile(path, name)`
- `repo.listDirectory(path, name)`

Read from the default branch (`main`) ONLY for these reasons:

1. Getting the base commit SHA to create the branch (Step 1).
2. Reading the original/pre-change version of a file that is no longer visible on the feature
   branch because you have already edited it there.
3. Verifying that a GitHub Actions workflow file exists on `main` before `dispatchWorkflow()`
   (see below).

Do not mix default-branch and feature-branch reads when deciding what to edit. If you read a file
on `main`, re-read it on the feature branch before editing it, so you edit the branch's actual
current state.

### Editing GitHub Actions workflow files is a distinct approval category

Editing a file under `.github/workflows/*.{yml,yaml}` is **not** the same as an ordinary file
write. The GitHub gatekeeper automatically detects workflow file paths and routes them to a
separate approval action kind ("Edit GitHub Actions workflow files", tag
`githubEditWorkflowFile`), distinct from the regular "Write repository files" / "Delete
repository files" kinds. This means:

* The user sees a **separate approval card** for workflow edits, and can enable or disable
  **auto-approval for workflow edits independently** from regular file writes.
* You still call the same `writeFile()` / `deleteFile()` methods — the categorization is
  automatic based on the file path. There is no separate "edit workflow" method.
* **Never assume** that because regular file writes are auto-approved, a workflow edit will
  also be auto-approved. It may require explicit manual approval depending on the user's
  settings for that action kind.

### `dispatchWorkflow()` requires `workflow_dispatch` on `main`

`dispatchWorkflow(workflowId, ref)` triggers a GitHub Actions workflow on a given branch.
It will **fail** unless **both** of the following are true:

1. The workflow file exists on the **default branch** (`main`) — not just on your feature
   branch. Verify with `readFile(path, "main")`.
2. The workflow's `on:` section includes the **`workflow_dispatch:`** trigger. A workflow
   that only runs on `push` or `pull_request` **cannot** be dispatched manually. Read the
   file content to confirm `workflow_dispatch:` is present.

If either condition is missing, you must first create an isolated branch and PR to add/fix the
workflow (including the `workflow_dispatch` trigger), merge it into `main`, and only then
dispatch it. Feature code changes that the workflow should test must be in a **separate** branch.

## Running Builds for Connected GitHub Repositories

When you need to build/test code in a connected GitHub repository (for example Flutter or C++
projects), do not try to build inside the agent sandbox. Instead, use the repository build
executor feature exposed by the GitHubRepo binding.

1. Call `repo.getResolvedBuildStrategy()` to determine whether builds go to **GitHub Actions**
   or **Cloudflare Containers**. Default policy (Phase 1): public repos use GitHub Actions;
   private/internal repos use Cloudflare Containers. The user can override this per repo
   from the resource connection UI.
2. If the resolved strategy is `githubActions`, trigger the appropriate workflow with
   `repo.dispatchWorkflow()`. Provide the branch name and any required workflow inputs.
3. If the resolved strategy is `cloudflareContainers`, run commands directly with
   `repo.executeBuild(branch, commands)`. Pass an array of `{ command, label? }` objects.
   The commands execute in a Cloudflare Container that includes Flutter, Android tools, and a
   C/C++ toolchain (`build-essential`, `cmake`, `clang`, `ninja-build`).
4. Always propose code changes first, then run the build on the resulting feature branch, and
   report the build result (exit code, stdout, stderr) back to the user.

## Autonomous Jules Flow (single-approval code changes)

When the user asks to carry a repository change end-to-end automatically — plan in Hindi,
implement via Google Jules, drive CI green, review, and merge — load and follow the
`jules-flow` skill at `.agents/skills/jules-flow/SKILL.md`. Core rules:

* **Exactly one manual approval.** `startFlow()` on the ambient `JULES_FLOW` binding is the only
  manual action. After it, `updateWorkflow()` (`flow.update`) and `cancelFlow()`
  (`flow.cancel`) are auto-approvable, and the underlying GitHub + Jules work is performed through
  the agent's own `GitHubRepo` / `JulesSource` connections (whose write kinds must also be
  auto-approvable for a fully hands-off run). There is **no second approval** for CI runs or for
  merging the PR — the merge is automatic.
* **Official documentation, not Aarya docs.** Before planning or writing the Jules prompt, pull
  official documentation for the technologies the change touches (Cloudflare Workers / Durable
  Objects / GitHub / Google Jules / etc.) — **not** Aarya Smart's own docs — and pass those
  link(s) to Jules with an instruction to read them (and any other related official docs) before
  planning or working.
* **Repo-edit rules still apply.** Any repo edits the agent makes itself still follow the
  branch-first workflow above, and `.github/workflows/*` edits remain a distinct approval category
  — never assume they are auto-approved.
