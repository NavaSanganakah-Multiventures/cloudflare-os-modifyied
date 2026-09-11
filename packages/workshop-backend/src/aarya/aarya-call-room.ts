import { DurableObject } from "cloudflare:workers";
import { createWorkshopLogger } from "../observability";
import { isAuthorizedMember, verifyAaryaToken } from "./aarya-auth";
import { createAaryaAiSession, DEFAULT_AARYA_PERSONA } from "./aarya-ai";
import { AaryaToolRegistry, geminiFunctionDeclarations } from "./aarya-tools";
import { AaryaApprovalQueue } from "./aarya-email";
import type { AaryaEmailSummary, AaryaGmailSession, AaryaGmailThread } from "./aarya-email";
import {
  decodeRepoFileText,
  MAX_REPO_SEARCH_CANDIDATES,
  MAX_REPO_SEARCH_DIRS,
  selectRepoSearchMatches,
  summarizePrDiff,
} from "./aarya-github";
import type {
  AaryaGithubPrReadResult,
  AaryaGithubPrSummary,
  AaryaGithubRepoSession,
  AaryaRepoDirectoryResult,
  AaryaRepoFileResult,
  AaryaRepoSearchHit,
  AaryaReviewDecision,
} from "./aarya-github";
import { summarizeJulesActivity } from "./aarya-jules";
import type {
  AaryaJulesActivitySummary,
  AaryaJulesFlowSession,
  AaryaJulesFlowStartInput,
  AaryaJulesFlowWorkflow,
  AaryaJulesSession,
  AaryaJulesSessionSummary,
  AaryaJulesSourceSummary,
  StartJulesSessionInput,
} from "./aarya-jules";
import type { Gatekeeper } from "@gadgets/workshop-shared/gatekeeper";
import type { AaryaAiSession } from "./aarya-ai";
import type { AaryaAgentTaskQueued, AaryaToolCall, AaryaToolDefinition, AaryaToolResult, AaryaWorkspaceSummary, RunWorkspaceAgentInput } from "./aarya-tools";
import type { AaryaAiState, AaryaClientMessage, AaryaParticipantInfo, AaryaServerMessage } from "./aarya-types";
import { buildNotificationsHint } from "./aarya-reminders";
import type { AaryaNotification } from "./aarya-reminders";
import type { UserDurableObject } from "../user";

const logger = createWorkshopLogger("workshop.aarya.room");

interface Participant {
  id: string;
  ws: WebSocket;
  userId: string;
  name: string;
}

/** A background workspace-agent task spawned from this voice call. */
interface PendingAgentTask {
  agent: any;
  title: string;
  summary: string | null;
  status: "running" | "ready";
}

/**
 * One Aarya voice call. Participants connect over /api/aarya/ws; the room verifies each token, keeps
 * the live participant set, relays JSON signaling, and relays binary audio frames to every other
 * participant. The Gemini Live / Workers AI bridge joins as a server-side participant behind this
 * same relay: human audio is forwarded to the AI, and AI audio is broadcast back to every human.
 */
// NOTE: The class name `AryaCallRoom` (single "A") is FROZEN — it is referenced by
// worker-configuration.d.ts (`durableNamespaces`) and scripts/testdata/golden-manifest.json.
// Do NOT rename this class to `AaryaCallRoom`.
export class AryaCallRoom extends DurableObject<Cloudflare.Env> {
  private readonly participants = new Map<string, Participant>();

  private ai: AaryaAiSession | null = null;
  private aiState: AaryaAiState = "off";
  private ownerId: string | null = null;
  // In-memory is safe here: a confirmation only exists during a live call, and the call's open
  // WebSockets keep this Durable Object from hibernating. If the owner is not connected (or never
  // responds), requestConfirmation resolves to "timeout" after CONFIRMATION_TIMEOUT_MS.
  private readonly pendingConfirmations = new Map<string, (decision: "approved" | "rejected" | "timeout") => void>();
  // Lazy Gmail session for the owner, created on first email tool use. The session's ApprovalQueue
  // routes send/reply confirmations through requestConfirmation(); cached thread stubs let
  // reply_email reuse a thread listed by list_emails without re-fetching.
  private gmailSession: AaryaGmailSession | null = null;
  private readonly gmailThreads = new Map<string, AaryaGmailThread>();
  private readonly githubSessions = new Map<string, AaryaGithubRepoSession>();
  // In-memory only: a spawned agent task lives while the room is alive (open WebSockets keep it from
  // hibernating). Tasks that finish while the owner is offline are persisted as notifications.
  private readonly pendingAgentTasks = new Map<string, PendingAgentTask>();
  private julesSession: AaryaJulesSession | null = null;
  private julesFlowSession: AaryaJulesFlowSession | null = null;
  private readonly tools = new AaryaToolRegistry({
    now: () => new Date(),
    voiceStatus: () => ({ state: this.aiState, backend: this.ai?.backend }),
    mutations: {
      setOwnerDisplayName: (name: string) => this.setOwnerDisplayName(name),
      setReminder: async (message: string, dueAt: number) => {
        const user = this.ownerUser();
        if (!user) throw new Error("No owner is connected for this voice call.");
        return await user.addReminder(message, dueAt);
      },
      cancelReminder: async (id: string) => {
        const user = this.ownerUser();
        if (!user) throw new Error("No owner is connected for this voice call.");
        return await user.cancelReminder(id);
      },
      createWorkspace: (title: string) => this.createWorkspace(title),
    },
    readReminders: async () => {
      const user = this.ownerUser();
      return user ? await user.listReminders() : [];
    },
    readNotifications: async () => {
      const user = this.ownerUser();
      return user ? await user.listNotifications() : [];
    },
    email: {
      sendEmail: (to: string[], subject: string, body: string) => this.sendEmail(to, subject, body),
      listEmails: (query?: string) => this.listEmails(query),
      replyEmail: (threadId: string, body: string) => this.replyEmail(threadId, body),
    },
    github: {
      listPrs: (repo: string) => this.listPrs(repo),
      readPr: (repo: string, prNumber: number) => this.readPr(repo, prNumber),
      reviewPr: (repo: string, prNumber: number, decision: AaryaReviewDecision, body: string) =>
        this.reviewPr(repo, prNumber, decision, body),
      listRepoFiles: (repo: string, path: string, ref?: string) => this.listRepoFiles(repo, path, ref),
      readRepoFile: (repo: string, path: string, ref?: string) => this.readRepoFile(repo, path, ref),
      searchRepoFiles: (repo: string, query: string, path?: string, ref?: string) =>
        this.searchRepoFiles(repo, query, path, ref),
    },
    jules: {
      listSources: () => this.listJulesSources(),
      listSessions: () => this.listJulesSessions(),
      listActivities: (sessionId: string) => this.listJulesActivities(sessionId),
      createSession: (input: StartJulesSessionInput) => this.startJulesSession(input),
      approvePlan: (sessionId: string) => this.approveJulesPlan(sessionId),
    },
    julesFlow: {
      startFlow: (input: AaryaJulesFlowStartInput) => this.startJulesFlow(input),
      listWorkflows: () => this.listJulesFlowWorkflows(),
      getWorkflow: (id: string) => this.getJulesFlowWorkflow(id),
      cancelFlow: (id: string) => this.cancelJulesFlow(id),
    },
    agent: {
      runWorkspaceAgent: (input: RunWorkspaceAgentInput) => this.runWorkspaceAgent(input),
    },
  });

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const call = url.searchParams.get("call");
    const token = url.searchParams.get("token");
    const claims = await verifyAaryaToken(token, this.env);

    if (!claims?.sub || !claims.call || claims.call !== call) {
      return new Response("Invalid or expired voice-call token", { status: 401 });
    }
    if (!isAuthorizedMember(claims.sub, this.env)) {
      return new Response("Caller is not authorized for voice calls", { status: 403 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const participant: Participant = {
      id: crypto.randomUUID(),
      ws: server,
      userId: claims.sub,
      name: claims.name ?? claims.sub,
    };

    await this.addParticipant(participant, call);

    server.addEventListener("message", (event) => {
      void this.handleMessage(participant, event.data).catch((err) => {
        logger.warn("failed to handle aarya voice message", {
          event: "aarya.room.message.failed",
          error: err,
        });
      });
    });
    server.addEventListener("close", () => {
      void this.removeParticipant(participant.id);
    });
    server.addEventListener("error", () => {
      void this.removeParticipant(participant.id);
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  private async addParticipant(participant: Participant, roomId: string): Promise<void> {
    this.participants.set(participant.id, participant);

    // Remember the first joiner as the room owner so PR 2/PR 4 can anchor agent authorization and
    // outbound-call routing to it.
    const existingOwner = await this.ctx.storage.get<string>("ownerId");
    if (!existingOwner) {
      await this.ctx.storage.put("ownerId", participant.userId);
      this.ownerId = participant.userId;
    } else {
      this.ownerId = existingOwner;
    }

    await this.ensureAi();

    this.send(participant, {
      type: "welcome",
      roomId,
      selfId: participant.id,
      participants: this.peerList(participant.id),
    });
    this.send(participant, {
      type: "ai-status",
      state: this.aiState,
      backend: this.ai?.backend,
    });
    this.broadcast({ type: "peer-joined", peer: this.peerInfo(participant) }, participant.id);

    logger.info("aarya voice participant joined", { event: "aarya.room.join" });
  }

  private async removeParticipant(participantId: string): Promise<void> {
    const participant = this.participants.get(participantId);
    if (!participant) return;
    this.participants.delete(participantId);
    try {
      participant.ws.close();
    } catch {
      // Already closed.
    }
    this.broadcast({ type: "peer-left", peerId: participantId });
    logger.info("aarya voice participant left", { event: "aarya.room.leave" });

    if (this.participants.size === 0) {
      await this.stopAi();
    }
  }

  private async handleMessage(participant: Participant, data: unknown): Promise<void> {
    if (data instanceof ArrayBuffer) {
      // Binary audio frame: relay to every other participant and feed the AI bridge.
      this.broadcastBinary(data, participant.id);
      if (this.ai) {
        void this.ai.handleAudioChunk(data).catch((error) => {
          logger.warn("failed to route audio to aarya ai", {
            event: "aarya.room.ai.audio.failed",
            error,
          });
        });
      }
      return;
    }

    let message: AaryaClientMessage;
    try {
      message = JSON.parse(String(data));
    } catch {
      this.send(participant, {
        type: "error",
        code: "bad_json",
        message: "Message is not valid JSON",
      });
      return;
    }

    switch (message.type) {
      case "ping":
        this.send(participant, { type: "pong", ts: message.ts });
        return;
      case "signal":
        this.sendTo(message.target, { type: "signal", from: participant.id, data: message.data });
        return;
      case "ring":
        this.broadcast({ type: "ring", from: participant.id }, participant.id);
        return;
      case "accept":
        this.broadcast({ type: "accepted", by: participant.id }, participant.id);
        return;
      case "reject":
        this.broadcast({ type: "rejected", by: participant.id }, participant.id);
        return;
      case "hangup":
        this.broadcast({ type: "hangup", by: participant.id }, participant.id);
        return;
      case "ai-command":
        if (message.action === "start") {
          await this.ensureAi();
        } else {
          await this.stopAi();
        }
        return;
      case "tool-confirmation-response": {
        const resolve = this.pendingConfirmations.get(message.requestId);
        if (resolve) {
          this.pendingConfirmations.delete(message.requestId);
          resolve(message.approved ? "approved" : "rejected");
        }
        return;
      }
      case "agent-task-response":
        await this.handleAgentTaskResponse(message);
        return;
    }
  }

  private async ensureAi(): Promise<void> {
    if (this.ai) return;

    // Fetch the user's Gemini key from the user DO (if available); fall back to env-level key.
    let geminiKey: string | undefined;
    try {
      const user = this.ownerUser();
      if (user) {
        geminiKey = (await user.getAaryaGeminiKey()) ?? undefined;
      }
    } catch (error) {
      logger.warn("failed to fetch user gemini key from user DO", {
        event: "aarya.room.ai.key.fetch.failed",
        error,
      });
    }

    // Surface any due reminders in the AI's first reply. We only clear them from the inbox after
    // the session actually starts, so a failed start doesn't silently drop the user's reminders.
    const { hint, pending } = await this.collectNotificationHint();
    const basePersona = this.env.AARYA_GEMINI_SYSTEM_PROMPT ?? DEFAULT_AARYA_PERSONA;
    const systemPrompt = hint ? `${basePersona}\n\n${hint}` : undefined;

    const session = createAaryaAiSession(
      this.env,
      {
        onAudio: (audio) => this.broadcastBinary(audio),
        onTranscript: (transcript) => {
          this.broadcast({
            type: "transcript",
            role: transcript.role,
            text: transcript.text,
            final: transcript.final,
          });
        },
        onStatus: (status) => {
          this.aiState = status.state;
          this.broadcast({
            type: "ai-status",
            state: status.state,
            backend: status.backend,
            detail: status.detail,
          });
        },
        onToolCalls: (calls) => this.executeToolCalls(calls),
      },
      geminiFunctionDeclarations(this.tools.definitions()),
      geminiKey,
      systemPrompt,
    );
    try {
      await session.start();
    } catch (error) {
      logger.warn("failed to start aarya ai session", {
        event: "aarya.room.ai.start.failed",
        error,
      });
      this.aiState = "error";
      this.broadcast({
        type: "ai-status",
        state: "error",
        backend: session.backend,
        detail: errorMessage(error),
      });
      return;
    }
    this.ai = session;
    await this.clearNotifications(pending);
  }

  private async stopAi(): Promise<void> {
    const session = this.ai;
    this.ai = null;
    if (!session) {
      this.aiState = "off";
      this.broadcast({ type: "ai-status", state: "off" });
      return;
    }
    try {
      await session.stop();
    } catch (error) {
      logger.warn("failed to stop aarya ai session", {
        event: "aarya.room.ai.stop.failed",
        error,
      });
      this.aiState = "off";
      this.broadcast({ type: "ai-status", state: "off" });
    }
  }

  private async executeToolCalls(calls: AaryaToolCall[]): Promise<AaryaToolResult[]> {
    const results: AaryaToolResult[] = [];
    for (const call of calls) {
      const tool = this.tools.find(call.name);
      if (tool?.mutating) {
        const decision = await this.requestConfirmation(call.name, this.summarizeToolCall(call, tool));
        if (decision !== "approved") {
          results.push({
            id: call.id,
            name: call.name,
            response: {
              ok: false,
              error: decision === "timeout" ? "Confirmation timed out" : "User rejected the action",
            },
          });
          continue;
        }
      }
      results.push(await this.tools.execute(call));
    }
    return results;
  }

  private summarizeToolCall(call: AaryaToolCall, tool: AaryaToolDefinition): string {
    try {
      return tool.summarize?.(call.args) ?? describeToolCall(call);
    } catch {
      return describeToolCall(call);
    }
  }

  private requestConfirmation(tool: string, summary: string): Promise<"approved" | "rejected" | "timeout"> {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (this.pendingConfirmations.delete(requestId)) {
          resolve("timeout");
        }
      }, CONFIRMATION_TIMEOUT_MS);
      this.pendingConfirmations.set(requestId, (decision) => {
        clearTimeout(timer);
        resolve(decision);
      });
      this.sendToOwner({ type: "tool-confirmation-request", requestId, tool, summary });
    });
  }

  private sendToOwner(message: AaryaServerMessage): void {
    const ownerId = this.ownerId;
    if (!ownerId) {
      this.broadcast(message);
      return;
    }
    for (const participant of this.participants.values()) {
      if (participant.userId === ownerId) {
        this.send(participant, message);
      }
    }
  }

  private async setOwnerDisplayName(name: string): Promise<void> {
    const user = this.ownerUser();
    if (!user) {
      throw new Error("No owner is connected for this voice call.");
    }
    await user.setOwnDisplayName(name);
  }

  private ownerUser(): DurableObjectStub<UserDurableObject> | null {
    const ownerId = this.ownerId;
    if (!ownerId) return null;
    const userNs: DurableObjectNamespace<UserDurableObject> | undefined =
      this.ctx.exports.UserDurableObject;
    if (!userNs) return null;
    return userNs.get(userNs.idFromName(ownerId));
  }

  private async collectNotificationHint(): Promise<{ hint: string; pending: AaryaNotification[] }> {
    const user = this.ownerUser();
    if (!user) return { hint: "", pending: [] };
    try {
      await user.sweepDueReminders(Date.now());
      const pending = await user.listNotifications();
      return { hint: buildNotificationsHint(pending), pending };
    } catch (error) {
      logger.warn("failed to collect aarya notifications", {
        event: "aarya.room.notifications.collect.failed",
        error,
      });
      return { hint: "", pending: [] };
    }
  }

  private async clearNotifications(notifications: AaryaNotification[]): Promise<void> {
    const user = this.ownerUser();
    if (!user || notifications.length === 0) return;
    try {
      await user.clearNotifications(notifications.map((n) => n.id));
    } catch (error) {
      logger.warn("failed to clear aarya notifications", {
        event: "aarya.room.notifications.clear.failed",
        error,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Email (Gmail gatekeeper). Lazy session creation + the three email tool operations.

  /** Generic gatekeeper session start for a connected vendor + resource URL. Routes mutating
   * actions through Aarya's confirmation gate via AaryaApprovalQueue. Returns null when the owner
   * has no usable connected account or the session fails to start. */
  private async startAaryaGatekeeperSession(
    vendorId: string,
    url: string,
    facetKey: string,
  ): Promise<unknown> {
    const user = this.ownerUser();
    if (!user) return null;

    let resolved: { class: DurableObjectClass<Gatekeeper<any>>; accountId: number } | null;
    try {
      resolved = await user.getAaryaGatekeeperClass(vendorId, url);
    } catch (error) {
      logger.warn("failed to resolve owner gatekeeper class", {
        event: "aarya.room.gatekeeper.class.failed",
        vendorId,
        error,
      });
      return null;
    }
    if (!resolved) return null;

    const gatekeeperClass = resolved.class;
    const gatekeeper = this.ctx.facets.get(facetKey, () => ({ class: gatekeeperClass }));
    const approvalQueue = new AaryaApprovalQueue(
      gatekeeper,
      (tool, summary) => this.requestConfirmation(tool, summary),
    );
    try {
      return await gatekeeper.startSession(approvalQueue);
    } catch (error) {
      logger.warn("failed to start aarya gatekeeper session", {
        event: "aarya.room.gatekeeper.session.start.failed",
        vendorId,
        error,
      });
      return null;
    }
  }

  private async ensureGmailSession(): Promise<AaryaGmailSession | null> {
    if (this.gmailSession) return this.gmailSession;
    const session = await this.startAaryaGatekeeperSession(
      "google",
      "https://mail.google.com/mail/",
      `aarya-gmail-${this.ownerId}`,
    );
    this.gmailSession = session as AaryaGmailSession | null;
    return this.gmailSession;
  }

  private async sendEmail(to: string[], subject: string, body: string): Promise<void> {
    const session = await this.ensureGmailSession();
    if (!session) throw new Error("You haven't connected a Gmail account. Connect Gmail in Settings first.");
    await session.send(to, subject, body);
  }

  private async listEmails(query?: string): Promise<AaryaEmailSummary[]> {
    const session = await this.ensureGmailSession();
    if (!session) throw new Error("You haven't connected a Gmail account. Connect Gmail in Settings first.");
    const cursor = await (query ? session.search(query) : session.listThreads());
    const page = await cursor.next();
    if (!page) return [];
    const summaries: AaryaEmailSummary[] = [];
    for (const entry of page) {
      this.gmailThreads.set(entry.info.id, entry.thread);
      summaries.push({ id: entry.info.id, subject: entry.info.subject, snippet: entry.info.snippet });
    }
    return summaries;
  }

  private async replyEmail(threadId: string, body: string): Promise<void> {
    const session = await this.ensureGmailSession();
    if (!session) throw new Error("You haven't connected a Gmail account. Connect Gmail in Settings first.");

    let thread = this.gmailThreads.get(threadId) ?? null;
    if (!thread) {
      // Resolve a thread not seen in this call by paging the inbox.
      const cursor = await session.listThreads();
      let page = await cursor.next();
      while (page) {
        for (const entry of page) {
          this.gmailThreads.set(entry.info.id, entry.thread);
          if (entry.info.id === threadId) thread = entry.thread;
        }
        if (thread) break;
        page = await cursor.next();
      }
    }
    if (!thread) throw new Error("Couldn't find that email thread. Use list_emails first.");

    const messages = await thread.messages();
    if (messages.length === 0) throw new Error("That email thread has no messages to reply to.");
    // Reply to the most recent message in the thread.
    await messages[messages.length - 1].reply(body);
  }

  // ---------------------------------------------------------------------------
  // GitHub (gatekeeper). Per-repo lazy sessions + the three PR review tool operations.

  private async ensureGithubRepoSession(ownerRepo: string): Promise<AaryaGithubRepoSession | null> {
    const cached = this.githubSessions.get(ownerRepo);
    if (cached) return cached;
    const session = await this.startAaryaGatekeeperSession(
      "github",
      `https://github.com/${ownerRepo}`,
      `aarya-github-${ownerRepo.replaceAll("/", "-")}`,
    );
    if (!session) return null;
    const repo = session as AaryaGithubRepoSession;
    this.githubSessions.set(ownerRepo, repo);
    return repo;
  }

  private async listPrs(repo: string): Promise<AaryaGithubPrSummary[]> {
    const session = await this.ensureGithubRepoSession(repo);
    if (!session) throw new Error("You haven't connected a GitHub account. Connect GitHub in Settings first.");
    const cursor = await session.listPullRequests({ state: "open" });
    const page = await cursor.next();
    if (!page) return [];
    return page.map((pr) => ({
      number: Number(pr.id),
      title: pr.title,
      author: pr.author?.login ?? "",
      state: pr.state,
    }));
  }

  private async readPr(repo: string, prNumber: number): Promise<AaryaGithubPrReadResult> {
    const session = await this.ensureGithubRepoSession(repo);
    if (!session) throw new Error("You haven't connected a GitHub account. Connect GitHub in Settings first.");
    const pr = await session.getPullRequest(String(prNumber));
    const details = await pr.getDetails();
    const diff = await pr.readDiff();
    return {
      number: Number(details.id),
      title: details.title,
      state: details.state,
      author: details.author?.login ?? "",
      body: details.bodyMarkdown,
      additions: details.additions,
      deletions: details.deletions,
      changedFiles: details.changedFiles,
      mergeable: details.mergeable,
      diff: await summarizePrDiff(diff),
    };
  }

  private async reviewPr(
    repo: string,
    prNumber: number,
    decision: AaryaReviewDecision,
    body: string,
  ): Promise<void> {
    const session = await this.ensureGithubRepoSession(repo);
    if (!session) throw new Error("You haven't connected a GitHub account. Connect GitHub in Settings first.");
    const pr = await session.getPullRequest(String(prNumber));
    const diff = await pr.readDiff();
    await pr.postReview({ revision: diff.revision, decision, bodyMarkdown: body });
  }

  /** List files/directories in a repo folder for the model. */
  private async listRepoFiles(repo: string, path: string, ref?: string): Promise<AaryaRepoDirectoryResult> {
    const session = await this.ensureGithubRepoSession(repo);
    if (!session) throw new Error("You haven't connected a GitHub account. Connect GitHub in Settings first.");
    const entries = await session.listDirectory(path || "", ref);
    return {
      path: path || "",
      entries: entries.map((e) => ({ name: e.name, path: e.path, type: e.type, sha: e.sha })),
    };
  }

  /** Read a repo file as (capped) text for the model. */
  private async readRepoFile(repo: string, path: string, ref?: string): Promise<AaryaRepoFileResult> {
    const session = await this.ensureGithubRepoSession(repo);
    if (!session) throw new Error("You haven't connected a GitHub account. Connect GitHub in Settings first.");
    const file = await session.readFile(path, ref);
    const decoded = decodeRepoFileText(file.contentBase64);
    return { path: file.path, sha: file.sha, ...decoded };
  }

  /** Search a repo recursively for files/folders whose names fuzzy-match a query. */
  private async searchRepoFiles(
    repo: string,
    query: string,
    path?: string,
    ref?: string,
  ): Promise<AaryaRepoSearchHit[]> {
    const session = await this.ensureGithubRepoSession(repo);
    if (!session) throw new Error("You haven't connected a GitHub account. Connect GitHub in Settings first.");

    const root = path || "";
    const queue: string[] = [root];
    const visited = new Set<string>();
    const candidates: { name: string; path: string; type: string }[] = [];
    let dirsVisited = 0;

    while (
      queue.length > 0 &&
      dirsVisited < MAX_REPO_SEARCH_DIRS &&
      candidates.length < MAX_REPO_SEARCH_CANDIDATES
    ) {
      const dir = queue.shift()!;
      if (visited.has(dir)) continue;
      visited.add(dir);
      dirsVisited++;

      try {
        const entries = await session.listDirectory(dir, ref);
        for (const entry of entries) {
          candidates.push({ name: entry.name, path: entry.path, type: entry.type });
          if (entry.type === "dir") queue.push(entry.path);
          if (candidates.length >= MAX_REPO_SEARCH_CANDIDATES) break;
        }
      } catch (error) {
        logger.warn("failed to list repo directory during aarya search", {
          event: "aarya.room.github.search.listdir.failed",
          error,
        });
      }
    }

    return selectRepoSearchMatches(candidates, query);
  }

  /** Create a new workspace for the room owner (room-level mutation, user-confirmed). */
  private async createWorkspace(title: string): Promise<AaryaWorkspaceSummary> {
    const user = this.ownerUser();
    if (!user) throw new Error("No owner is connected for this voice call.");
    const overseers = this.ctx.exports.OverseerDurableObject;
    if (!overseers) throw new Error("Workspace creation is unavailable in this deployment.");
    const workspaceId = overseers.newUniqueId().toString();
    await user.newWorkspace(workspaceId, title);
    await user.setGadgetLastActive(workspaceId, new Date(), undefined);
    return { workspaceId, title };
  }

  // ---------------------------------------------------------------------------
  // Background workspace-agent tasks. run_workspace_agent returns immediately; the room rings
  // the owner when the agent finishes, then routes approve / disapprove / iterate back to it.

  /** Spawn a background agent in the owner's most recent workspace and start waiting for it. */
  private async runWorkspaceAgent(input: RunWorkspaceAgentInput): Promise<AaryaAgentTaskQueued> {
    const user = this.ownerUser();
    if (!user) throw new Error("No owner is connected for this voice call.");

    const targetWorkspaceId = input.workspaceId ?? (await this.mostRecentWorkspaceId(user));
    if (!targetWorkspaceId) {
      throw new Error("No workspace is available for this account. Create a workspace first.");
    }

    const modelId = await user.getPreferredModel();
    if (!modelId) throw new Error("No preferred AI model is configured for your account.");

    const overseers = this.ctx.exports.OverseerDurableObject;
    if (!overseers) throw new Error("Workspace agents are unavailable in this deployment.");
    const overseer = overseers.get(overseers.idFromString(targetWorkspaceId));

    const agent = await overseer.spawnAaryaAgent(input.title, buildAgentTaskPrompt(input.prompt), modelId);
    const taskId = crypto.randomUUID();
    this.pendingAgentTasks.set(taskId, { agent, title: input.title, summary: null, status: "running" });

    this.ctx.waitUntil(this.awaitAgentTaskCompletion(taskId));
    return { taskId, title: input.title, status: "queued" };
  }

  private async mostRecentWorkspaceId(user: DurableObjectStub<UserDurableObject>): Promise<string | null> {
    const workspaces = await user.listWorkspaces();
    if (workspaces.length === 0) return null;
    const sorted = workspaces.toSorted(
      (a, b) => new Date(b.lastActive).getTime() - new Date(a.lastActive).getTime(),
    );
    return sorted[0].id;
  }

  private async awaitAgentTaskCompletion(taskId: string): Promise<void> {
    const task = this.pendingAgentTasks.get(taskId);
    if (!task) return;

    try {
      const summary = normalizeAgentTaskSummary(await task.agent.run({}));
      task.summary = summary;
      task.status = "ready";
      if (this.ownerConnected()) {
        this.sendToOwner({ type: "agent-task-ready", taskId, title: task.title, summary });
      } else {
        await this.persistAgentTaskNotification(task.title, summary);
        this.pendingAgentTasks.delete(taskId);
      }
    } catch (error) {
      this.pendingAgentTasks.delete(taskId);
      if (this.ownerConnected()) {
        this.sendToOwner({
          type: "agent-task-status",
          taskId,
          status: "failed",
          message: errorMessage(error),
        });
      } else {
        await this.persistAgentTaskNotification(task.title, errorMessage(error));
      }
    }
  }

  private async handleAgentTaskResponse(
    message: Extract<AaryaClientMessage, { type: "agent-task-response" }>,
  ): Promise<void> {
    const task = this.pendingAgentTasks.get(message.taskId);
    if (!task || task.status !== "ready") {
      this.sendToOwner({
        type: "agent-task-status",
        taskId: message.taskId,
        status: "failed",
        message: "That background task is no longer active.",
      });
      return;
    }

    const feedback = typeof message.feedback === "string" ? message.feedback.trim() : "";
    try {
      if (message.decision === "approve") {
        await task.agent.approve(task.summary ?? "");
        this.pendingAgentTasks.delete(message.taskId);
        this.sendToOwner({ type: "agent-task-status", taskId: message.taskId, status: "approved" });
      } else if (message.decision === "disapprove") {
        await task.agent.disapprove(feedback);
        this.pendingAgentTasks.delete(message.taskId);
        this.sendToOwner({
          type: "agent-task-status",
          taskId: message.taskId,
          status: "disapproved",
          message: feedback || undefined,
        });
      } else {
        const summary = normalizeAgentTaskSummary(await task.agent.iterate(feedback));
        task.summary = summary;
        this.sendToOwner({
          type: "agent-task-ready",
          taskId: message.taskId,
          title: task.title,
          summary,
        });
      }
    } catch (error) {
      this.sendToOwner({
        type: "agent-task-status",
        taskId: message.taskId,
        status: "failed",
        message: errorMessage(error),
      });
    }
  }

  private ownerConnected(): boolean {
    const ownerId = this.ownerId;
    if (!ownerId) return false;
    for (const participant of this.participants.values()) {
      if (participant.userId === ownerId) return true;
    }
    return false;
  }

  private async persistAgentTaskNotification(title: string, detail: string): Promise<void> {
    const user = this.ownerUser();
    if (!user) return;
    try {
      await user.addAgentTaskNotification(title, detail);
    } catch (error) {
      logger.warn("failed to persist AARYA agent-task notification", {
        event: "aarya.room.agent.notification.persist.failed",
        error,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Google Jules + Jules Flow. Lazy sessions + tool operations. Jules is a normal URL-addressed
  // connected account; Jules Flow is an auto-provisioned singleton with no URL-addressed resources.

  private async ensureJulesSession(): Promise<AaryaJulesSession | null> {
    if (this.julesSession) return this.julesSession;
    const session = await this.startAaryaGatekeeperSession(
      "jules",
      "https://jules.google.com/",
      `aarya-jules-${this.ownerId}`,
    );
    this.julesSession = session as AaryaJulesSession | null;
    return this.julesSession;
  }

  private async ensureJulesFlowSession(): Promise<AaryaJulesFlowSession | null> {
    if (this.julesFlowSession) return this.julesFlowSession;
    const user = this.ownerUser();
    if (!user) return null;
    let cls: DurableObjectClass<Gatekeeper<any>> | null;
    try {
      cls = await user.getAaryaSingletonGatekeeperClass("jules-flow");
    } catch (error) {
      logger.warn("failed to resolve aarya jules-flow class", {
        event: "aarya.room.julesflow.class.failed", error,
      });
      return null;
    }
    if (!cls) return null;
    const gatekeeper = this.ctx.facets.get(`aarya-jules-flow-${this.ownerId}`, () => ({ class: cls }));
    const approvalQueue = new AaryaApprovalQueue(
      gatekeeper,
      (tool, summary) => this.requestConfirmation(tool, summary),
    );
    try {
      const session = (await gatekeeper.startSession(approvalQueue)) as AaryaJulesFlowSession | null;
      this.julesFlowSession = session;
      return session;
    } catch (error) {
      logger.warn("failed to start aarya jules-flow session", {
        event: "aarya.room.julesflow.session.start.failed", error,
      });
      return null;
    }
  }

  private async listJulesSources(): Promise<AaryaJulesSourceSummary[]> {
    const session = await this.ensureJulesSession();
    if (!session) throw new Error("You haven't connected a Google Jules account. Connect Google Jules in Settings first.");
    const sources = await session.listSources({ pageSize: 100 });
    return sources.map((s) => ({
      id: s.id,
      name: s.name,
      ...(s.githubRepo?.owner && s.githubRepo?.repo
        ? { repo: `${s.githubRepo.owner}/${s.githubRepo.repo}` }
        : {}),
    }));
  }

  private async listJulesSessions(): Promise<AaryaJulesSessionSummary[]> {
    const session = await this.ensureJulesSession();
    if (!session) throw new Error("You haven't connected a Google Jules account. Connect Google Jules in Settings first.");
    const sessions = await session.listSessions({ filter: "archived = false" });
    return sessions.map((s) => ({
      id: s.id,
      title: s.title ?? s.id,
      state: s.state,
      ...(s.url ? { url: s.url } : {}),
      ...(s.createTime ? { createTime: s.createTime } : {}),
    }));
  }

  private async listJulesActivities(sessionId: string): Promise<AaryaJulesActivitySummary[]> {
    const session = await this.ensureJulesSession();
    if (!session) throw new Error("You haven't connected a Google Jules account. Connect Google Jules in Settings first.");
    const activities = await session.listActivities(sessionId, { pageSize: 100 });
    return activities.map(summarizeJulesActivity);
  }

  private async startJulesSession(input: StartJulesSessionInput): Promise<{ queued: true; source: string; title?: string }> {
    const session = await this.ensureJulesSession();
    if (!session) throw new Error("You haven't connected a Google Jules account. Connect Google Jules in Settings first.");
    await session.createSession({
      prompt: input.prompt,
      ...(input.title ? { title: input.title } : {}),
      sourceContext: {
        source: input.source,
        ...(input.startingBranch
          ? { githubRepoContext: { startingBranch: input.startingBranch } }
          : {}),
      },
      ...(input.automationMode ? { automationMode: input.automationMode } : {}),
      ...(input.requirePlanApproval ? { requirePlanApproval: true } : {}),
    });
    return { queued: true, source: input.source, ...(input.title ? { title: input.title } : {}) };
  }

  private async approveJulesPlan(sessionId: string): Promise<{ queued: true; session: string }> {
    const session = await this.ensureJulesSession();
    if (!session) throw new Error("You haven't connected a Google Jules account. Connect Google Jules in Settings first.");
    await session.approvePlan(sessionId);
    return { queued: true, session: sessionId };
  }

  private async startJulesFlow(input: AaryaJulesFlowStartInput): Promise<AaryaJulesFlowWorkflow> {
    const session = await this.ensureJulesFlowSession();
    if (!session) throw new Error("Jules Flow is not available. Add the Jules Flow connector in Settings first.");
    return await session.startFlow(input);
  }

  private async listJulesFlowWorkflows(): Promise<AaryaJulesFlowWorkflow[]> {
    const session = await this.ensureJulesFlowSession();
    if (!session) throw new Error("Jules Flow is not available. Add the Jules Flow connector in Settings first.");
    return await session.listWorkflows();
  }

  private async getJulesFlowWorkflow(id: string): Promise<AaryaJulesFlowWorkflow> {
    const session = await this.ensureJulesFlowSession();
    if (!session) throw new Error("Jules Flow is not available. Add the Jules Flow connector in Settings first.");
    return await session.getWorkflow(id);
  }

  private async cancelJulesFlow(id: string): Promise<AaryaJulesFlowWorkflow> {
    const session = await this.ensureJulesFlowSession();
    if (!session) throw new Error("Jules Flow is not available. Add the Jules Flow connector in Settings first.");
    return await session.cancelFlow(id);
  }

  private peerInfo(participant: Participant): AaryaParticipantInfo {
    return { id: participant.id, userId: participant.userId, name: participant.name };
  }

  private peerList(exceptId?: string): AaryaParticipantInfo[] {
    return [...this.participants.values()]
      .filter((p) => p.id !== exceptId)
      .map((p) => this.peerInfo(p));
  }

  private send(participant: Participant, message: AaryaServerMessage): void {
    try {
      participant.ws.send(JSON.stringify(message));
    } catch {
      void this.removeParticipant(participant.id);
    }
  }

  private sendTo(participantId: string, message: AaryaServerMessage): void {
    const participant = this.participants.get(participantId);
    if (participant) this.send(participant, message);
  }

  private broadcast(message: AaryaServerMessage, exceptId?: string): void {
    for (const participant of this.participants.values()) {
      if (participant.id === exceptId) continue;
      this.send(participant, message);
    }
  }

  private broadcastBinary(data: ArrayBuffer, exceptId?: string): void {
    for (const participant of this.participants.values()) {
      if (participant.id === exceptId) continue;
      try {
        participant.ws.send(data);
      } catch {
        void this.removeParticipant(participant.id);
      }
    }
  }
}

const CONFIRMATION_TIMEOUT_MS = 30000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildAgentTaskPrompt(prompt: string): string {
  return (
    prompt +
    "\n\n---\n\nWhen you finish this task, resolve the pending callback (`run()`) with a concise " +
    "Markdown summary of what you did and the resulting plan or deliverable. If a later callback named " +
    "`approve`, `disapprove`, or `iterate` arrives: for `iterate`, revise your work according to the " +
    "feedback in the callback arguments and resolve with an updated summary; for `approve` or " +
    "`disapprove`, acknowledge in a sentence or two and resolve."
  );
}

function normalizeAgentTaskSummary(value: unknown): string {
  if (typeof value === "string") return value.trim() || "Task completed.";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.summary === "string" && record.summary.trim()) return record.summary.trim();
    try {
      return JSON.stringify(value);
    } catch {
      return "Task completed.";
    }
  }
  return "Task completed.";
}

function describeToolCall(call: AaryaToolCall): string {
  return call.name + " " + JSON.stringify(call.args);
}
