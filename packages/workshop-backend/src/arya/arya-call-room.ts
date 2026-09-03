import { DurableObject } from "cloudflare:workers";
import { createWorkshopLogger } from "../observability";
import { isAuthorizedMember, verifyAryaToken } from "./arya-auth";
import { createAryaAiSession, DEFAULT_ARYA_PERSONA } from "./arya-ai";
import { AryaToolRegistry, geminiFunctionDeclarations } from "./arya-tools";
import type { AryaAiSession } from "./arya-ai";
import type { AryaToolCall, AryaToolDefinition, AryaToolResult } from "./arya-tools";
import type { AryaAiState, AryaClientMessage, AryaParticipantInfo, AryaServerMessage } from "./arya-types";
import { buildNotificationsHint } from "./arya-reminders";
import type { AryaNotification } from "./arya-reminders";
import type { UserDurableObject } from "../user";

const logger = createWorkshopLogger("workshop.arya.room");

interface Participant {
  id: string;
  ws: WebSocket;
  userId: string;
  name: string;
}

/**
 * One Arya voice call. Participants connect over /api/arya/ws; the room verifies each token, keeps
 * the live participant set, relays JSON signaling, and relays binary audio frames to every other
 * participant. The Gemini Live / Workers AI bridge joins as a server-side participant behind this
 * same relay: human audio is forwarded to the AI, and AI audio is broadcast back to every human.
 */
export class AryaCallRoom extends DurableObject<Cloudflare.Env> {
  private readonly participants = new Map<string, Participant>();

  private ai: AryaAiSession | null = null;
  private aiState: AryaAiState = "off";
  private ownerId: string | null = null;
  // In-memory is safe here: a confirmation only exists during a live call, and the call's open
  // WebSockets keep this Durable Object from hibernating. If the owner is not connected (or never
  // responds), requestConfirmation resolves to "timeout" after CONFIRMATION_TIMEOUT_MS.
  private readonly pendingConfirmations = new Map<string, (decision: "approved" | "rejected" | "timeout") => void>();
  private readonly tools = new AryaToolRegistry({
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
    },
    readReminders: async () => {
      const user = this.ownerUser();
      return user ? await user.listReminders() : [];
    },
    readNotifications: async () => {
      const user = this.ownerUser();
      return user ? await user.listNotifications() : [];
    },
  });

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 426 });
    }

    const url = new URL(request.url);
    const call = url.searchParams.get("call");
    const token = url.searchParams.get("token");
    const claims = await verifyAryaToken(token, this.env);

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
        logger.warn("failed to handle arya voice message", {
          event: "arya.room.message.failed",
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

    logger.info("arya voice participant joined", { event: "arya.room.join" });
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
    logger.info("arya voice participant left", { event: "arya.room.leave" });

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
          logger.warn("failed to route audio to arya ai", {
            event: "arya.room.ai.audio.failed",
            error,
          });
        });
      }
      return;
    }

    let message: AryaClientMessage;
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
    }
  }

  private async ensureAi(): Promise<void> {
    if (this.ai) return;

    // Fetch the user's Gemini key from the user DO (if available); fall back to env-level key.
    let geminiKey: string | undefined;
    try {
      const user = this.ownerUser();
      if (user) {
        geminiKey = (await user.getAryaGeminiKey()) ?? undefined;
      }
    } catch (error) {
      logger.warn("failed to fetch user gemini key from user DO", {
        event: "arya.room.ai.key.fetch.failed",
        error,
      });
    }

    // Surface any due reminders in the AI's first reply. We only clear them from the inbox after
    // the session actually starts, so a failed start doesn't silently drop the user's reminders.
    const { hint, pending } = await this.collectNotificationHint();
    const basePersona = this.env.ARYA_GEMINI_SYSTEM_PROMPT ?? DEFAULT_ARYA_PERSONA;
    const systemPrompt = hint ? `${basePersona}\n\n${hint}` : undefined;

    const session = createAryaAiSession(
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
      logger.warn("failed to start arya ai session", {
        event: "arya.room.ai.start.failed",
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
      logger.warn("failed to stop arya ai session", {
        event: "arya.room.ai.stop.failed",
        error,
      });
      this.aiState = "off";
      this.broadcast({ type: "ai-status", state: "off" });
    }
  }

  private async executeToolCalls(calls: AryaToolCall[]): Promise<AryaToolResult[]> {
    const results: AryaToolResult[] = [];
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

  private summarizeToolCall(call: AryaToolCall, tool: AryaToolDefinition): string {
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

  private sendToOwner(message: AryaServerMessage): void {
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

  private ownerUser(): Fetcher<UserDurableObject> | null {
    const ownerId = this.ownerId;
    if (!ownerId) return null;
    const userNs: DurableObjectNamespace<UserDurableObject> | undefined =
      this.ctx.exports.UserDurableObject;
    if (!userNs) return null;
    return userNs.get(userNs.idFromName(ownerId));
  }

  private async collectNotificationHint(): Promise<{ hint: string; pending: AryaNotification[] }> {
    const user = this.ownerUser();
    if (!user) return { hint: "", pending: [] };
    try {
      await user.sweepDueReminders(Date.now());
      const pending = await user.listNotifications();
      return { hint: buildNotificationsHint(pending), pending };
    } catch (error) {
      logger.warn("failed to collect arya notifications", {
        event: "arya.room.notifications.collect.failed",
        error,
      });
      return { hint: "", pending: [] };
    }
  }

  private async clearNotifications(notifications: AryaNotification[]): Promise<void> {
    const user = this.ownerUser();
    if (!user || notifications.length === 0) return;
    try {
      await user.clearNotifications(notifications.map((n) => n.id));
    } catch (error) {
      logger.warn("failed to clear arya notifications", {
        event: "arya.room.notifications.clear.failed",
        error,
      });
    }
  }

  private peerInfo(participant: Participant): AryaParticipantInfo {
    return { id: participant.id, userId: participant.userId, name: participant.name };
  }

  private peerList(exceptId?: string): AryaParticipantInfo[] {
    return [...this.participants.values()]
      .filter((p) => p.id !== exceptId)
      .map((p) => this.peerInfo(p));
  }

  private send(participant: Participant, message: AryaServerMessage): void {
    try {
      participant.ws.send(JSON.stringify(message));
    } catch {
      void this.removeParticipant(participant.id);
    }
  }

  private sendTo(participantId: string, message: AryaServerMessage): void {
    const participant = this.participants.get(participantId);
    if (participant) this.send(participant, message);
  }

  private broadcast(message: AryaServerMessage, exceptId?: string): void {
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

function describeToolCall(call: AryaToolCall): string {
  return call.name + " " + JSON.stringify(call.args);
}
