// Jules Flow gatekeeper.
//
// Auto-provisioned singleton gatekeeper (like the Context Library) that tracks the
// "GitHub -> Google Jules" coding workflow as a durable state machine. The agent (Aarya)
// drives the workflow with its own GitHub and Jules connections and records progress here;
// the gatekeeper validates phase transitions and keeps the single source of truth for a run.
//
// Single-approval model: startFlow() is the only manually-approved write. updateWorkflow()
// and cancelFlow() are auto-approvable action kinds, so after the workflow is started the
// agent can advance it without further approvals.

import { DurableObject, RpcStub, RpcTarget, WorkerEntrypoint } from "cloudflare:workers";
import { skipRpcValidation, validateRpc } from "capnweb-validate";
import {
  ApprovalQueue,
  type AccountDescription,
  type ActionDescription,
  type ActionKind,
  type AvatarImage,
  type Gatekeeper,
  type GatekeeperConnectCallback,
  type GatekeeperConnectOptions,
  type GatekeeperUser,
  type GatekeeperUserVerifier,
  type GatekeeperVendor as GatekeeperVendorIface,
  type ResourceDescription,
  type SupportedResource,
  type VendorDescription,
} from "@gadgets/workshop-shared/gatekeeper";
import type { FlowPhase, JulesFlowSession, StartFlowInput, WorkflowInfo, WorkflowPatch } from "./types";
import TYPES_CODE from "./types.txt";

type Env = Cloudflare.Env;

// --- Branding ---

const FLOW_ICON: AvatarImage = {
  url: "data:image/svg+xml," + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 256 256' fill='currentColor'>" +
    "<path d='M64,80H192a8,8,0,0,1,8,8v16a8,8,0,0,1-8,8H64a8,8,0,0,1-8-8V88A8,8,0,0,1,64,80Z'/>" +
    "<path d='M64,144H192a8,8,0,0,1,8,8v16a8,8,0,0,1-8,8H64a8,8,0,0,1-8-8V152A8,8,0,0,1,64,144Z'/>" +
    "<path d='M208,56l-16,24H168l-16-24H104L88,80H64l16-24a16,16,0,0,1,14-8H194A16,16,0,0,1,208,56Z' opacity='0.35'/>" +
    "<path d='M208,200l-16-24H168l-16,24H104l-16-24H64l16,24a16,16,0,0,0,14,8H194A16,16,0,0,0,208,200Z' opacity='0.35'/>" +
    "<circle cx='48' cy='136' r='16'/>" +
    "<circle cx='208' cy='136' r='16'/>" +
    "</svg>"),
};

// --- Action model + storage ---

const FLOW_UPDATE_ACTION: ActionKind = { tag: "flow.update", label: "Update a Jules Flow workflow" };
const FLOW_CANCEL_ACTION: ActionKind = { tag: "flow.cancel", label: "Cancel a Jules Flow workflow" };

type SubmitWriteBody =
  | { type: "start"; workflowId: string; input: StartFlowInput }
  | { type: "update"; workflowId: string; patch: WorkflowPatch }
  | { type: "cancel"; workflowId: string };

type JulesFlowAction = SubmitWriteBody & { id: number };

type PendingActionRow = { id: number; action: JulesFlowAction; submittedAt: number };

const WORKFLOW_INDEX_KEY = "workflowIds";
const TERMINAL_PHASES = new Set<FlowPhase>(["DONE", "CANCELLED"]);

function workflowKey(id: string): string {
  return "workflow:" + id;
}

function nowIso(): string {
  return new Date().toISOString();
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "...";
}

function describeAction(action: JulesFlowAction): ActionDescription {
  switch (action.type) {
    case "start":
      return {
        title: "Start Jules Flow workflow",
        description: "Starts the GitHub -> Jules workflow: \"" + truncate(action.input.request, 120) + "\".",
        implementsRevert: false,
        awaitDecision: true,
      };
    case "update":
      return {
        title: "Update Jules Flow workflow",
        description: "Updates workflow " + action.workflowId + ".",
        implementsRevert: false,
        awaitDecision: true,
        actionKind: FLOW_UPDATE_ACTION,
        autoApprovable: true,
      };
    case "cancel":
      return {
        title: "Cancel Jules Flow workflow",
        description: "Cancels workflow " + action.workflowId + ".",
        implementsRevert: false,
        awaitDecision: true,
        actionKind: FLOW_CANCEL_ACTION,
        autoApprovable: true,
      };
  }
}

function validateStartFlowInput(input: StartFlowInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("startFlow() expects a single input object.");
  }
  if (typeof input.request !== "string" || input.request.trim().length === 0) {
    throw new TypeError("startFlow() requires a non-empty string \"request\".");
  }
  if (typeof input.planSummary !== "string" || input.planSummary.trim().length === 0) {
    throw new TypeError("startFlow() requires a non-empty string \"planSummary\".");
  }
  if (typeof input.julesPrompt !== "string" || input.julesPrompt.trim().length === 0) {
    throw new TypeError("startFlow() requires a non-empty string \"julesPrompt\".");
  }
  if (typeof input.githubRepo !== "string" || input.githubRepo.trim().length === 0) {
    throw new TypeError("startFlow() requires a non-empty string \"githubRepo\" (owner/repo).");
  }
  if (typeof input.julesSource !== "string" || input.julesSource.trim().length === 0) {
    throw new TypeError("startFlow() requires a non-empty string \"julesSource\".");
  }
  if (input.officialDocs !== undefined && !Array.isArray(input.officialDocs)) {
    throw new TypeError("startFlow() requires \"officialDocs\" to be an array.");
  }
}

function applyPatch(existing: WorkflowInfo, patch: WorkflowPatch): WorkflowInfo {
  if (TERMINAL_PHASES.has(existing.phase)) {
    throw new Error("Workflow " + existing.id + " is already " + existing.phase + "; it cannot be updated.");
  }
  let next = { ...existing };
  if (patch.phase !== undefined) {
    if (patch.phase === "AWAITING_APPROVAL") {
      throw new Error("AWAITING_APPROVAL can only be set when a workflow is started.");
    }
    next = { ...next, phase: patch.phase };
  }
  if (patch.title !== undefined) next = { ...next, title: patch.title };
  if (patch.julesSessionId !== undefined) next = { ...next, julesSessionId: patch.julesSessionId };
  if (patch.reviewSessionId !== undefined) next = { ...next, reviewSessionId: patch.reviewSessionId };
  if (patch.prNumber !== undefined) next = { ...next, prNumber: patch.prNumber };
  if (patch.prUrl !== undefined) next = { ...next, prUrl: patch.prUrl };
  if (patch.ci !== undefined) next = { ...next, ci: patch.ci };
  if (patch.review !== undefined) next = { ...next, review: patch.review };
  if (patch.conflicts !== undefined) next = { ...next, conflicts: patch.conflicts };
  if (patch.error !== undefined) next = { ...next, error: patch.error };
  if (patch.archived !== undefined) next = { ...next, archived: patch.archived };
  return { ...next, updatedAt: nowIso() };
}

interface SessionContext {
  approvalQueue: RpcStub<ApprovalQueue>;
  getWorkflow: (id: string) => WorkflowInfo | undefined;
  listWorkflows: () => WorkflowInfo[];
  assertWorkflowExists: (id: string) => void;
  submitWrite: (body: SubmitWriteBody) => Promise<void>;
  dispose: () => void;
}

// --- Gatekeeper DO (the per-account singleton) ---

type JulesFlowAccountProps = { accountId: string };

@validateRpc()
export class JulesFlowGatekeeperImpl extends DurableObject<Env, JulesFlowAccountProps> implements Gatekeeper<JulesFlowSession> {
  async describe(): Promise<ResourceDescription> {
    return {
      url: "jules-flow://workflow",
      title: "Jules Flow",
      snippet: "Tracks and advances the GitHub -> Google Jules coding workflow (plan, PR, CI, review, merge).",
      suggestedBindingName: "JULES_FLOW",
      tsType: "JulesFlowSession",
      hasSlashCommands: false,
    };
  }

  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }

  async getAutoApprovableActions(): Promise<ActionKind[]> {
    return [FLOW_UPDATE_ACTION, FLOW_CANCEL_ACTION];
  }

  async startSession(approvalQueue: RpcStub<ApprovalQueue>): Promise<JulesFlowSession> {
    const ctx = await this.#buildSessionContext(approvalQueue.dup());
    return new JulesFlowSessionImpl(ctx);
  }

  async addObserver(_id: string, _user: Fetcher<GatekeeperUserVerifier>): Promise<void> {}
  async removeObserver(_id: string): Promise<void> {}

  async applyAction(actionId: number): Promise<void> {
    const pending = this.#getPending(actionId);
    if (!pending) throw new Error("No queued Jules Flow action exists with id " + actionId + ".");
    const action = pending.action;
    switch (action.type) {
      case "start": {
        const workflow: WorkflowInfo = {
          id: action.workflowId,
          phase: "AWAITING_APPROVAL",
          title: action.input.title,
          request: action.input.request,
          planSummary: action.input.planSummary,
          githubRepo: action.input.githubRepo,
          julesSource: action.input.julesSource,
          updatedAt: nowIso(),
        };
        this.ctx.storage.kv.put(workflowKey(action.workflowId), workflow);
        this.#addWorkflow(action.workflowId);
        break;
      }
      case "update": {
        const existing = this.#getWorkflow(action.workflowId);
        if (!existing) throw new Error("No Jules Flow workflow exists with id " + action.workflowId + ".");
        this.ctx.storage.kv.put(workflowKey(action.workflowId), applyPatch(existing, action.patch));
        break;
      }
      case "cancel": {
        const existing = this.#getWorkflow(action.workflowId);
        if (!existing) throw new Error("No Jules Flow workflow exists with id " + action.workflowId + ".");
        this.ctx.storage.kv.put(workflowKey(action.workflowId), { ...existing, phase: "CANCELLED", updatedAt: nowIso() });
        break;
      }
    }
    this.#deletePending(actionId);
  }

  async rejectAction(actionId: number): Promise<void | { restart?: boolean }> {
    this.#deletePending(actionId);
  }

  async revertAction(_actionId: number): Promise<void | { message?: string; canRetry?: boolean; restart?: boolean }> {
    throw new Error("This action cannot be reverted.");
  }

  async #buildSessionContext(approvalQueue: RpcStub<ApprovalQueue>): Promise<SessionContext> {
    const self = this;
    let disposed = false;
    return {
      approvalQueue,
      getWorkflow: (id) => self.#getWorkflow(id),
      listWorkflows: () => self.#listWorkflows(),
      assertWorkflowExists: (id) => {
        if (!self.#getWorkflow(id)) throw new Error("No Jules Flow workflow exists with id \"" + id + "\".");
      },
      async submitWrite(body) {
        const id = self.#nextActionId();
        const action = { ...body, id } as JulesFlowAction;
        self.ctx.storage.kv.put<PendingActionRow>("pending:" + id, { id, action, submittedAt: Date.now() });
        const description = describeAction(action);
        try {
          await approvalQueue.submitAction(id, description);
        } catch (e) {
          self.ctx.storage.kv.delete("pending:" + id);
          throw e;
        }
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        approvalQueue[Symbol.dispose]();
      },
    };
  }

  #nextActionId(): number {
    const counter = this.ctx.storage.kv.get<number>("counter:nextActionId") ?? 0;
    const next = counter + 1;
    this.ctx.storage.kv.put("counter:nextActionId", next);
    return next;
  }

  #getPending(id: number): PendingActionRow | undefined {
    return this.ctx.storage.kv.get<PendingActionRow>("pending:" + id);
  }

  #deletePending(id: number): void {
    this.ctx.storage.kv.delete("pending:" + id);
  }

  #getWorkflow(id: string): WorkflowInfo | undefined {
    return this.ctx.storage.kv.get<WorkflowInfo>(workflowKey(id));
  }

  #listWorkflows(): WorkflowInfo[] {
    const ids = this.ctx.storage.kv.get<string[]>(WORKFLOW_INDEX_KEY) ?? [];
    const out: WorkflowInfo[] = [];
    for (const id of ids) {
      const workflow = this.#getWorkflow(id);
      if (workflow) out.push(workflow);
    }
    out.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
    return out;
  }

  #addWorkflow(id: string): void {
    const ids = this.ctx.storage.kv.get<string[]>(WORKFLOW_INDEX_KEY) ?? [];
    if (!ids.includes(id)) {
      ids.push(id);
      this.ctx.storage.kv.put(WORKFLOW_INDEX_KEY, ids);
    }
  }
}

// --- Session RpcTarget exposed to gadgets ---

@validateRpc()
class JulesFlowSessionImpl extends RpcTarget implements JulesFlowSession {
  #ctx: SessionContext;

  constructor(ctx: SessionContext) {
    super();
    this.#ctx = ctx;
  }

  [Symbol.dispose](): void {
    this.#ctx.dispose();
  }

  async startFlow(input: StartFlowInput): Promise<WorkflowInfo> {
    validateStartFlowInput(input);
    const workflowId = crypto.randomUUID();
    const provisional: WorkflowInfo = {
      id: workflowId,
      phase: "AWAITING_APPROVAL",
      title: input.title,
      request: input.request,
      planSummary: input.planSummary,
      githubRepo: input.githubRepo,
      julesSource: input.julesSource,
      updatedAt: nowIso(),
    };
    await this.#ctx.submitWrite({ type: "start", workflowId, input });
    return provisional;
  }

  async getWorkflow(id: string): Promise<WorkflowInfo> {
    const workflow = this.#ctx.getWorkflow(id);
    if (!workflow) throw new Error("No Jules Flow workflow exists with id \"" + id + "\".");
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "Read Jules Flow workflow",
      description: "Read workflow \"" + id + "\" (phase: " + workflow.phase + ").",
    });
    return workflow;
  }

  async listWorkflows(): Promise<WorkflowInfo[]> {
    const list = this.#ctx.listWorkflows();
    await this.#ctx.approvalQueue.authorizeObservation({
      title: "List Jules Flow workflows",
      description: "Listed " + list.length + " workflow" + (list.length === 1 ? "" : "s") + ".",
    });
    return list;
  }

  async refresh(id: string): Promise<WorkflowInfo> {
    return this.getWorkflow(id);
  }

  async updateWorkflow(id: string, patch: WorkflowPatch): Promise<WorkflowInfo> {
    this.#ctx.assertWorkflowExists(id);
    await this.#ctx.submitWrite({ type: "update", workflowId: id, patch });
    return this.#ctx.getWorkflow(id)!;
  }

  async cancelFlow(id: string): Promise<WorkflowInfo> {
    this.#ctx.assertWorkflowExists(id);
    await this.#ctx.submitWrite({ type: "cancel", workflowId: id });
    return this.#ctx.getWorkflow(id)!;
  }
}

// --- Per-user account entrypoint ---

@validateRpc()
export class JulesFlowAccount extends WorkerEntrypoint<Env, JulesFlowAccountProps> implements GatekeeperUser {
  async describe(): Promise<AccountDescription> {
    return {
      displayName: "Jules Flow",
      avatar: FLOW_ICON,
      singleton: { tsType: "JulesFlowSession" },
    };
  }

  async getSingletonGatekeeperClass(): Promise<DurableObjectClass<Gatekeeper<any>>> {
    return this.ctx.exports.JulesFlowGatekeeperImpl({
      props: { accountId: this.ctx.props.accountId },
    });
  }

  async getSupportedResources(): Promise<SupportedResource[]> {
    return [];
  }
  getGatekeeperClassFor(_url: string): never {
    throw new Error("Jules Flow is a singleton gatekeeper; it has no URL-addressed resources.");
  }
  startResourceConfigurator(_resourceUrlPattern: string): never {
    throw new Error("Jules Flow is a singleton gatekeeper; it has no URL-addressed resources.");
  }
  async ensureResources(_resourceUrlPatterns: string[]): Promise<{ url?: string }> {
    return {};
  }
  async revoke(): Promise<void> {
    // Workflow records are non-sensitive run bookkeeping; revoking the account drops access.
  }
  reconnect(): never {
    throw new Error("Jules Flow is a singleton gatekeeper; it has no connect flow.");
  }
  async getAuthenticatedEmail(): Promise<string | null> {
    return null;
  }

  @skipRpcValidation()
  async getVerifier(): Promise<Fetcher<GatekeeperUserVerifier>> {
    return this.ctx.exports.JulesFlowVerifier({});
  }
}

@validateRpc()
export class JulesFlowVerifier extends WorkerEntrypoint<Env> implements GatekeeperUserVerifier {
  verify(): void {}
}

// --- Vendor entrypoint ---

@validateRpc()
export class GatekeeperVendor extends WorkerEntrypoint<Env> implements GatekeeperVendorIface {
  async describe(): Promise<VendorDescription> {
    return {
      displayName: "Jules Flow",
      url: "https://jules.google.com",
      logo: FLOW_ICON,
      tagline: "Run the GitHub -> Google Jules coding workflow automatically.",
      description: "Tracks and advances a plan -> PR -> CI -> review -> merge workflow. Always available; no connection needed.",
      autoProvisionsAccount: true,
      providesAuth: false,
    };
  }

  @skipRpcValidation()
  async createAccount(): Promise<Fetcher<GatekeeperUser>> {
    return this.ctx.exports.JulesFlowAccount({
      props: { accountId: crypto.randomUUID() },
    }) as unknown as Fetcher<GatekeeperUser>;
  }

  connectAccount(_callback: Fetcher<GatekeeperConnectCallback>, _options?: GatekeeperConnectOptions): Promise<{ url: string }> {
    throw new Error("Jules Flow is auto-provisioned; it has no connect flow.");
  }
  async getSupportedResources(_options?: { userId?: string }): Promise<SupportedResource[]> {
    return [];
  }
  async getTypeScriptTypes(): Promise<string> {
    return TYPES_CODE;
  }
}
