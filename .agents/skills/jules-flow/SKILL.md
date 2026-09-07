---
name: jules-flow
description: Autonomous code-change workflow that takes a GitHub repository change from request to merged PR with a single upfront approval. Google Jules implements the change and publishes a PR, the agent drives CI green, a second Jules session reviews the PR, and it is merged to main automatically. Load when the user asks for a code change to be planned, implemented, CI-green, reviewed, and merged end-to-end with one approval.
---

# Jules Flow (single-approval autonomous code changes)

`gatekeeper-jules-flow` is an auto-provisioned, ambient **singleton** gatekeeper. It is a durable
**workflow ledger**, not a credential holder: it records and validates the phases of a
GitHub → Google Jules coding workflow. The actual GitHub and Jules work is performed through
the agent's own `GitHubRepo` and `JulesSource` connections; the ledger tracks progress so the
whole run needs exactly **one** manual approval at the start.

In the agent's `executeCode` env it appears as the ambient chat binding `JULES_FLOW`
(a `JulesFlowSession` stub). There is no connect flow and no resource URL; it is always available.

## When to use it

Use this flow when the user wants a repository change carried out end-to-end automatically:

understand the request → plan in **Hindi** → **single approval** → Jules implements and
publishes a PR → CI is driven green → a second Jules session reviews the PR → merge to
`main` automatically → archive the Jules sessions and report. The agent and Jules act as one
combined agent; after the first approval there is no further user checkpoint.

## Official documentation is mandatory

Before writing the plan or the Jules prompt, pull **official documentation for the technologies
the change touches** — for example Cloudflare Workers / Durable Objects, GitHub Actions,
Google Jules, or whatever the code change involves. These are the **vendor/technology** docs,
**NOT Aarya Smart's own docs**. Record each one as a `FlowOfficialDoc` (`{ title, url, note? }`),
include the link(s) in `julesPrompt`, and instruct Jules to read them (and any other related
official docs it can find) before planning or writing code.

## Ledger API

The ambient `JULES_FLOW` binding implements `JulesFlowSession`:

- `startFlow(input: StartFlowInput): Promise<WorkflowInfo>` — **the single manual approval.**
  Submits a manual `start` write action (no auto-approval kind). Returns a provisional workflow in
  phase `AWAITING_APPROVAL`; the record is persisted once the user approves.
- `getWorkflow(id)`, `listWorkflows()`, `refresh(id)` — observations (read-only).
- `updateWorkflow(id, patch: WorkflowPatch): Promise<WorkflowInfo>` — records progress; action
  kind `flow.update`, auto-approvable.
- `cancelFlow(id): Promise<WorkflowInfo>` — cancels a run; action kind `flow.cancel`,
  auto-approvable.

`StartFlowInput` fields: `request`, `planSummary` (the Hindi plan shown for approval),
`julesPrompt` (full Jules prompt including official doc links), `officialDocs?`,
`title?`, `githubRepo` (`"owner/repo"`, record-keeping), `julesSource` (`"sources/<id>"`,
record-keeping). `WorkflowPatch` can set `phase`, `title`, `julesSessionId`,
`reviewSessionId`, `prNumber`, `prUrl`, `ci`, `review`, `conflicts`, `error`, or
`archived`.

## Phase guide

The ledger stores `phase`. The intended progression is:

`AWAITING_APPROVAL` (set only by `startFlow`) → `RUNNING` (Jules implementing) →
`CI_RUNNING` (PR published; driving CI green) → `PR_REVIEW` (second Jules session reviewing)
→ `MERGING` (review passed; merging) → `DONE` (merged + verified).

Use `FIXING_CONFLICTS` when a merge is blocked (record `conflicts[]`) and loop back through
`PR_REVIEW` after the fix. Use `FAILED` to record a non-fatal failure (`error`), and
`CANCELLED` to abandon a run.

`DONE` and `CANCELLED` are **terminal** — `updateWorkflow` rejects further patches to them.
`AWAITING_APPROVAL` cannot be set via `updateWorkflow` (only by `startFlow`). Other than that,
the ledger records what you tell it; keep the phases honest so `listWorkflows` stays meaningful.

## Workflow runbook

1. **Understand.** Read the relevant repository code. Pull official docs for the technologies the
   change touches (see above). Do not proceed on guesses.
2. **Plan in Hindi.** Write a concrete plan in Hindi and show it to the user. Explain what will
   change and how. **Wait for the single approval** — the user confirming you understood the
   request correctly and approving the plan.
3. **Start the run.** On that approval, call
   `await env.JULES_FLOW.startFlow({ request, planSummary, julesPrompt, officialDocs, title, githubRepo, julesSource })`.
   This is the only manual approval in the whole flow.
4. **Create the Jules session.** Using the agent's own `JulesSource` connection, create a session
   with the `julesPrompt` (use the auto-publish-PR option so Jules opens a PR itself; also upload
   the plan). Record the session id via `updateWorkflow(id, { phase: "RUNNING", julesSessionId })`.
5. **Poll and intervene.** Poll the Jules session every ~2 minutes (via the agent's scheduler /
   self-callback loop). If anything looks wrong, send corrective instructions to Jules. Record
   meaningful progress with `updateWorkflow`.
6. **CI.** When Jules publishes a PR, record `prNumber`/`prUrl` and set `phase: "CI_RUNNING"`.
   Run the repo's CI with `repo.dispatchWorkflow(workflowId, branch)` and poll
   `listWorkflowRuns`/`getWorkflowRun` until green; fix failures by committing to the branch and
   re-dispatching. Remember: the agent's own repo edits still follow the branch-first workflow, and
   `.github/workflows/*` edits are a separate approval category.
7. **Review the PR.** When CI is green, create a **new** Jules session to review the PR by number:
   verify every change against the original request and the official docs, and report what is
   correct and incorrect. Record `reviewSessionId`, `phase: "PR_REVIEW"`, and the review
   `verdict`/`summary`.
8. **Merge automatically.** When the review verdict is `all-correct`, set `phase: "MERGING"` and
   call `pullRequest.merge()`. There is **no second approval** for the merge.
9. **Conflicts / merge-block.** If the merge is blocked, set `phase: "FIXING_CONFLICTS"`, record
   `conflicts[]`, inspect the conflict, send it to Jules to fix, then re-review (back to step 7)
   and retry until it merges. The agent and Jules together resolve it; no extra user approval.
10. **Finish.** After merge + verification, archive/delete the Jules session(s) (Jules
    archive/delete kinds are auto-approvable), `updateWorkflow(id, { phase: "DONE", archived: true })`,
    and report completion to the user.

## Jules prompt template

Construct `julesPrompt` from this template (fill every placeholder; include the official docs):

```
You are implementing a code change in the repository <owner/repo>.

ORIGINAL REQUEST:
<request>

APPROVED PLAN (do not change the approach without asking):
<planSummary>

OFFICIAL DOCUMENTATION — read these, and any other related official docs you need, BEFORE
planning or writing any code:
- <doc title>: <url>
- ...

RULES:
1. Read the repository's AGENTS.md and follow it (branch-first workflow, pnpm, UTF-8, AARYA naming).
2. Read the relevant code first, then the official documentation.
3. Implement the change on a new branch created from the latest default-branch SHA. Never write
   directly to the default branch.
4. Publish a pull request when the change is ready (auto-publish the PR).
5. Keep the change scoped to the request.
6. When the PR is published, report the PR number, the branch name, and a summary of the changes.
```
