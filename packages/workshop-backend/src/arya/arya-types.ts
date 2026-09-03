// Wire types for Arya voice calls. These are plain JSON (and binary audio) messages sent over the
// /api/arya/ws WebSocket. They are intentionally separate from the Cap'n Web RPC API: audio frames
// and signaling need a low-latency channel distinct from the workspace RPC socket.
//
// PR 2 adds the Gemini Live / Workers AI bridge as another participant in the room; PR 3 adds the
// browser client. The signal messages are placeholders so a WebRTC transport can be introduced
// behind the same room later without changing the wire protocol.

/** Public identity of one participant in an Arya voice room. */
export interface AryaParticipantInfo {
  /** Opaque, connection-scoped participant id (not the user id). */
  id: string;
  /** Authenticated user id carried by the call token. */
  userId: string;
  /** Display name carried by the call token. */
  name: string;
}

/** Lifecycle state of the server-side AI participant. */
export type AryaAiState = "off" | "connecting" | "listening" | "error";

/** Which AI engine is driving the voice session. */
export type AryaAiBackend = "gemini" | "workers-ai";

/** JSON messages the client sends to the server. */
export type AryaClientMessage =
  | { type: "ping"; ts: number }
  | { type: "signal"; target: string; data: unknown }
  | { type: "ring" }
  | { type: "accept" }
  | { type: "reject" }
  | { type: "hangup" }
  | { type: "ai-command"; action: "start" | "stop" };

/** JSON messages the server sends to the client. */
export type AryaServerMessage =
  | { type: "welcome"; roomId: string; selfId: string; participants: AryaParticipantInfo[] }
  | { type: "peer-joined"; peer: AryaParticipantInfo }
  | { type: "peer-left"; peerId: string }
  | { type: "signal"; from: string; data: unknown }
  | { type: "ring"; from: string }
  | { type: "accepted"; by: string }
  | { type: "rejected"; by: string }
  | { type: "hangup"; by: string }
  | { type: "pong"; ts: number }
  | { type: "ai-status"; state: AryaAiState; backend?: AryaAiBackend; detail?: string }
  | { type: "transcript"; role: "user" | "assistant"; text: string; final: boolean }
  | { type: "error"; code: string; message: string };
