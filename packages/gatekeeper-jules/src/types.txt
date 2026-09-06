// TypeScript interface for the Google Jules gatekeeper. These types are exposed to gadgets
// and agents that have been granted access to a Google Jules account.
//
// Google Jules is an asynchronous coding agent. You connect GitHub repositories as "sources",
// then create "sessions" that plan and perform coding work against those sources. While a
// session runs you can read its activities (plans, progress updates, and messages), approve a
// generated plan, and read back pull requests and change sets the session produces.
//
// =====================================================================================
// API CONVENTIONS
// =====================================================================================
//
// 1. **All methods take POSITIONAL arguments. Never pass a single options object.**
//
//    Correct:
//      await session.sendMessage("sessions/abc123", "Fix the failing tests");
//
//    Incorrect (will throw a TypeError):
//      await session.sendMessage({ session: "sessions/abc123", prompt: "Fix tests" });
//
// 2. **Field names are camelCase, not snake_case**, even though the Jules REST API itself uses
//    snake_case internally. The gatekeeper handles the conversion. Examples:
//
//      JulesGitHubRepo.defaultBranch     (not default_branch)
//      JulesSession.requirePlanApproval  (not require_plan_approval)
//
// 3. **Resource names.** Methods that take a resource name accept either the full resource name
//    (for example "sources/source-id", "sessions/session-id", or
//    "sessions/session-id/activities/activity-id") or just the short id. The gatekeeper expands
//    short ids into full names automatically.
//
// =====================================================================================
// APPROVAL
// =====================================================================================
//
// Reads (listSources, getSource, listSessions, getSession, listActivities, getActivity) are
// authorized as observations.
//
// Writes (createSession, sendMessage, approvePlan, archiveSession, unarchiveSession,
// deleteSession) are queued for approval and do NOT execute against Jules until the user
// approves them. The write method's Promise resolves as soon as the action is queued; it does
// not wait for Jules to carry out the action. There is no simulation of pending writes, so
// after queuing a write you should wait for approval before relying on its effect (for example,
// call listSessions or listActivities only after the action has been applied).

import type { RpcTarget } from "cloudflare:workers";

// ---------------------------------------------------------------------------
// Enums

/** The lifecycle state of a Jules session. */
export type JulesSessionState =
  | "STATE_UNSPECIFIED"
  | "QUEUED"
  | "PLANNING"
  | "AWAITING_PLAN_APPROVAL"
  | "AWAITING_USER_FEEDBACK"
  | "IN_PROGRESS"
  | "PAUSED"
  | "FAILED"
  | "COMPLETED";

/** How much of the session's work Jules should automate. */
export type JulesAutomationMode =
  | "AUTOMATION_MODE_UNSPECIFIED"
  | "AUTO_CREATE_PR";

// ---------------------------------------------------------------------------
// Sources

/** A GitHub repository connected to Jules as an input source. */
export interface JulesSource {
  /** Full resource name, for example "sources/source-id". */
  name: string;
  /** The id of the source (the "{source}" part of the resource name). */
  id: string;
  /** The GitHub repository backing this source, if known. */
  githubRepo?: JulesGitHubRepo;
}

/** A GitHub repository. */
export interface JulesGitHubRepo {
  /** The owner (user or organization) of the repository. */
  owner?: string;
  /** The name of the repository. */
  repo?: string;
  /** Whether the repository is private. */
  isPrivate?: boolean;
  /** The repository's default branch. */
  defaultBranch?: JulesGitHubBranch;
  /** The repository's active branches. */
  branches?: JulesGitHubBranch[];
}

/** A GitHub branch. */
export interface JulesGitHubBranch {
  /** The name of the branch. */
  displayName: string;
}

// ---------------------------------------------------------------------------
// Sessions

/** A Jules coding session. */
export interface JulesSessionInfo {
  /** Full resource name, for example "sessions/session-id". */
  name: string;
  /** The id of the session (the "{session}" part of the resource name). */
  id: string;
  /** Optional human-readable title. Jules generates one if it is not provided. */
  title?: string;
  /** The prompt the session was started with. */
  prompt?: string;
  /** Current lifecycle state of the session. */
  state: JulesSessionState;
  /** Optional automation mode for the session. */
  automationMode?: JulesAutomationMode;
  /** Whether generated plans require explicit approval. */
  requirePlanApproval?: boolean;
  /** The source and context the session is working against. */
  sourceContext?: JulesSourceContext;
  /** Outputs produced by the session (pull requests, change sets). */
  outputs: JulesSessionOutput[];
  /** URL for viewing the session in the Jules web app. */
  url?: string;
  /** RFC 3339 timestamp when the session was created. */
  createTime?: string;
  /** RFC 3339 timestamp when the session was last updated. */
  updateTime?: string;
  /** Whether the session is archived. */
  archived?: boolean;
}

/** Context describing how a session uses a source. */
export interface JulesSourceContext {
  /** The name of the source to use, for example "sources/source-id". */
  source: string;
  /** Context specific to using a GitHub repository source. */
  githubRepoContext?: JulesGitHubRepoContext;
  /** Optional branch to push to when the session auto-creates a pull request. */
  workingBranch?: string;
  /** Whether environment variables configured for the source are enabled. */
  environmentVariablesEnabled?: boolean;
}

/** GitHub-specific context for a source. */
export interface JulesGitHubRepoContext {
  /** The branch the session should start from. */
  startingBranch: string;
}

/** One output produced by a session. */
export interface JulesSessionOutput {
  /** A pull request created by the session, if applicable. */
  pullRequest?: JulesPullRequest;
  /** A change set created by the session, if applicable. */
  changeSet?: JulesChangeSet;
}

/** A pull request. */
export interface JulesPullRequest {
  /** URL of the pull request. */
  url?: string;
  /** Title of the pull request. */
  title?: string;
  /** Description of the pull request. */
  description?: string;
  /** Base branch name (for example "main"). */
  baseRef?: string;
  /** Head branch name (for example "feature-x"). */
  headRef?: string;
}

/** A set of changes to be applied to a source. */
export interface JulesChangeSet {
  /** The name of the source this change set applies to. */
  source?: string;
  /** The change set as a Git patch. */
  gitPatch?: JulesGitPatch;
}

/** A patch in Git format. */
export interface JulesGitPatch {
  /** The commit id the patch should be applied to. */
  baseCommitId?: string;
  /** The patch in unidiff format. */
  unidiffPatch?: string;
  /** A suggested commit message for the patch, if one was generated. */
  suggestedCommitMessage?: string;
}

// ---------------------------------------------------------------------------
// Activities

/** A single unit of work within a session. */
export interface JulesActivity {
  /** Full resource name, for example "sessions/session-id/activities/activity-id". */
  name: string;
  /** The id of the activity (the "{activity}" part of the resource name). */
  id: string;
  /** RFC 3339 timestamp when this activity was created. */
  createTime?: string;
  /** The entity this activity originated from (for example "user", "agent", or "system"). */
  originator?: string;
  /** A description of this activity. */
  description?: string;
  /** Present when this activity generated a plan. */
  planGenerated?: JulesPlanGenerated;
  /** Present when this activity approved a plan. */
  planApproved?: JulesPlanApproved;
  /** Present when the user posted a message. */
  userMessaged?: JulesUserMessaged;
  /** Present when the agent posted a message. */
  agentMessaged?: JulesAgentMessaged;
  /** Present when there was a progress update. */
  progressUpdated?: JulesProgressUpdated;
  /** Present when the session completed. */
  sessionCompleted?: JulesSessionCompleted;
  /** Present when the session failed. */
  sessionFailed?: JulesSessionFailed;
  /** Artifacts produced by this activity. */
  artifacts?: JulesArtifact[];
}

/** An artifact is a single unit of data produced by an activity step. */
export interface JulesArtifact {
  /** Bash output produced by the step. */
  bashOutput?: JulesBashOutput;
  /** Media produced by the step. */
  media?: JulesMedia;
  /** A change set produced by the step. */
  changeSet?: JulesChangeSet;
}

/** Bash output. */
export interface JulesBashOutput {
  /** The bash command that was run. */
  command?: string;
  /** The combined stdout and stderr output. */
  output?: string;
  /** The exit code of the command. */
  exitCode?: number;
}

/** A media file. */
export interface JulesMedia {
  /** The media data, base64-encoded. */
  data?: string;
  /** The media MIME type. */
  mimeType?: string;
}

/** A plan generated by the agent. */
export interface JulesPlanGenerated {
  /** The plan that was generated. */
  plan?: JulesPlan;
}

/** A plan is a sequence of steps the agent will take to complete a task. */
export interface JulesPlan {
  /** Plan id, unique within a session. */
  id: string;
  /** RFC 3339 timestamp when the plan was created. */
  createTime?: string;
  /** The steps in the plan. */
  steps: JulesPlanStep[];
}

/** A step in a plan. */
export interface JulesPlanStep {
  /** Step id, unique within a plan. */
  id: string;
  /** 0-based index into the plan's steps. */
  index?: number;
  /** Title of the step. */
  title?: string;
  /** Description of the step. */
  description?: string;
}

/** A plan was approved. */
export interface JulesPlanApproved {
  /** The id of the plan that was approved. */
  planId?: string;
}

/** The user posted a message. */
export interface JulesUserMessaged {
  /** The message the user posted. */
  userMessage?: string;
}

/** The agent posted a message. */
export interface JulesAgentMessaged {
  /** The message the agent posted. */
  agentMessage?: string;
}

/** There was a progress update. */
export interface JulesProgressUpdated {
  /** Title of the progress update. */
  title?: string;
  /** Description of the progress update. */
  description?: string;
}

/** The session completed. */
export interface JulesSessionCompleted {}

/** The session failed. */
export interface JulesSessionFailed {
  /** The reason the session failed. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Filters and inputs

/** Options for listing Jules sources. */
export interface JulesListSourcesOptions {
  /** Number of results to return. The API caps this at 100. */
  pageSize?: number;
  /** Optional AIP-160 filter expression (for example "name=sources/source1"). */
  filter?: string;
}

/** Options for listing Jules sessions. */
export interface JulesListSessionsOptions {
  /** Number of results to return. The API caps this at 100. */
  pageSize?: number;
  /** Optional AIP-160 filter expression (for example "archived = false"). */
  filter?: string;
}

/** Options for listing activities for a session. */
export interface JulesListActivitiesOptions {
  /** Number of results to return. The API caps this at 100. */
  pageSize?: number;
  /** Optional AIP-160 filter expression on create_time. */
  filter?: string;
}

/** Input for creating a new Jules session. */
export interface JulesCreateSessionInput {
  /** The prompt to start the session with. */
  prompt: string;
  /** Optional title. If omitted, Jules generates one. */
  title?: string;
  /** Optional source context. If omitted, Jules starts from scratch. */
  sourceContext?: JulesSourceContext;
  /** Optional automation mode. */
  automationMode?: JulesAutomationMode;
  /** If true, plans generated by the agent require explicit approval. */
  requirePlanApproval?: boolean;
}

// ---------------------------------------------------------------------------
// Session capability

/** Capability for interacting with a connected Google Jules account. */
export interface JulesSession extends RpcTarget {
  /** List GitHub repositories connected to Jules.
   * @example const sources = await session.listSources(); */
  listSources(options?: JulesListSourcesOptions): Promise<JulesSource[]>;

  /** Get a single source by name or id.
   * @example const source = await session.getSource("sources/source-id"); */
  getSource(name: string): Promise<JulesSource>;

  /** List Jules sessions. Non-archived sessions are returned by default.
   * @example const sessions = await session.listSessions(); */
  listSessions(options?: JulesListSessionsOptions): Promise<JulesSessionInfo[]>;

  /** Get a single session by name or id.
   * @example const s = await session.getSession("sessions/session-id"); */
  getSession(name: string): Promise<JulesSessionInfo>;

  /** Create a new session. Queued for approval.
   * @example await session.createSession({ prompt: "Fix the failing tests" }); */
  createSession(input: JulesCreateSessionInput): Promise<void>;

  /** Send a message to a session. Queued for approval.
   * @example await session.sendMessage("sessions/session-id", "Keep going"); */
  sendMessage(session: string, prompt: string): Promise<void>;

  /** Approve the currently pending plan in a session. Queued for approval.
   * @example await session.approvePlan("sessions/session-id"); */
  approvePlan(session: string): Promise<void>;

  /** Archive a session. Queued for approval.
   * @example await session.archiveSession("sessions/session-id"); */
  archiveSession(session: string): Promise<void>;

  /** Unarchive a session. Queued for approval.
   * @example await session.unarchiveSession("sessions/session-id"); */
  unarchiveSession(session: string): Promise<void>;

  /** Delete a session. Queued for approval and not reversible.
   * @example await session.deleteSession("sessions/session-id"); */
  deleteSession(session: string): Promise<void>;

  /** List activities for a session.
   * @example const activities = await session.listActivities("sessions/session-id"); */
  listActivities(
    session: string,
    options?: JulesListActivitiesOptions,
  ): Promise<JulesActivity[]>;

  /** Get a single activity by full name.
   * @example const a = await session.getActivity("sessions/session-id/activities/activity-id"); */
  getActivity(name: string): Promise<JulesActivity>;
}
