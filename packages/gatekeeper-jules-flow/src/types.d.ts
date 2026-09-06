/** Jules Flow workflow phases. */
export type FlowPhase =
  | "AWAITING_APPROVAL"
  | "RUNNING"
  | "CI_RUNNING"
  | "PR_REVIEW"
  | "FIXING_CONFLICTS"
  | "MERGING"
  | "DONE"
  | "FAILED"
  | "CANCELLED";

export interface FlowOfficialDoc {
  title: string;
  url: string;
  note?: string;
}

export interface StartFlowInput {
  /** The user's original request. */
  request: string;
  /** The plan summary shown to the user for the single approval. */
  planSummary: string;
  /** The full prompt given to Google Jules (including official documentation links). */
  julesPrompt: string;
  /** Official documentation related to the code changes being made in the repository. */
  officialDocs?: FlowOfficialDoc[];
  title?: string;
  /** GitHub repository as "owner/repo". */
  githubRepo: string;
  /** Google Jules source name (e.g. "sources/<id>"). */
  julesSource: string;
}

export interface FlowCiStatus {
  workflow?: string;
  conclusion?: string;
  checkedAt?: string;
}

export interface FlowReviewStatus {
  verdict?: "all-correct" | "issues-found" | "pending";
  summary?: string;
}

export interface WorkflowInfo {
  id: string;
  phase: FlowPhase;
  title?: string;
  request: string;
  planSummary: string;
  julesPrompt?: string;
  officialDocs?: FlowOfficialDoc[];
  githubRepo: string;
  julesSource: string;
  julesSessionId?: string;
  reviewSessionId?: string;
  prNumber?: number;
  prUrl?: string;
  ci?: FlowCiStatus;
  review?: FlowReviewStatus;
  conflicts?: string[];
  error?: string;
  updatedAt: string;
  archived?: boolean;
}

export interface WorkflowPatch {
  phase?: FlowPhase;
  title?: string;
  julesSessionId?: string;
  reviewSessionId?: string;
  prNumber?: number;
  prUrl?: string;
  ci?: FlowCiStatus;
  review?: FlowReviewStatus;
  conflicts?: string[];
  error?: string;
  archived?: boolean;
}

export interface JulesFlowSession {
  /** The single manually-approved action: starts a workflow run. */
  startFlow(input: StartFlowInput): Promise<WorkflowInfo>;
  getWorkflow(id: string): Promise<WorkflowInfo>;
  listWorkflows(): Promise<WorkflowInfo[]>;
  refresh(id: string): Promise<WorkflowInfo>;
  /** Auto-approvable: records progress (phase, session ids, PR, CI, review, conflicts). */
  updateWorkflow(id: string, patch: WorkflowPatch): Promise<WorkflowInfo>;
  /** Auto-approvable: cancels a workflow run. */
  cancelFlow(id: string): Promise<WorkflowInfo>;
}
