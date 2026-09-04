// Gemini Live bridge and Workers AI fallback for the Aarya voice assistant.
//
// The Gemini Live bridge is the primary AI: it opens a bidirectional WebSocket to Google's
// BidiGenerateContent endpoint, streams PCM16 audio in both directions, and handles live
// function-calling via the tool executor. When AARYA_GEMINI_API_KEY is absent the factory falls
// back to AaryaWorkersAiFallback (whisper STT + LLM + melotts TTS) so the assistant still works
// without a Gemini key.

import { createWorkshopLogger } from "../observability";
import type { AaryaAiBackend, AaryaAiState } from "./aarya-types";
import type { AaryaToolCall, AaryaToolResult, GeminiTool } from "./aarya-tools";
import { AaryaWorkersAiFallback } from "./aarya-fallback";

const logger = createWorkshopLogger("workshop.aarya.ai");

export const DEFAULT_AARYA_GEMINI_MODEL = "models/gemini-3.1-flash-live-preview";

const GEMINI_LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export const DEFAULT_AARYA_PERSONA =
  "You are AARYA, a friendly and helpful voice assistant for the user's workspace platform. " +
  "Keep spoken replies short, natural, and conversational. " +
  "When you need the current time or the live voice status, use the provided tools.";

/** Subset of Cloudflare.Env that buildGeminiSetup reads. */
export interface GeminiSetupOptions {
  model?: string;
  systemPrompt?: string;
}

/** Status event emitted by an AI session to the room. */
export interface AaryaStatusEvent {
  state: AaryaAiState;
  backend: AaryaAiBackend;
  detail?: string;
}

/** Callbacks the room provides to receive AI output. */
export interface AaryaAiCallbacks {
  onAudio(audio: ArrayBuffer): void;
  onTranscript(transcript: { role: "user" | "assistant"; text: string; final: boolean }): void;
  onStatus(status: AaryaStatusEvent): void;
  onToolCalls(calls: AaryaToolCall[]): Promise<AaryaToolResult[]>;
}

/** A live AI session (Gemini or Workers AI fallback) that the room drives. */
export interface AaryaAiSession {
  readonly backend: AaryaAiBackend;
  start(): Promise<void>;
  stop(): Promise<void>;
  handleAudioChunk(chunk: ArrayBuffer): Promise<void>;
}

/** Encode raw PCM16 bytes as base64 (chunked to avoid call-stack limits). */
export function pcm16ToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

/** Decode a base64 string into a PCM16 ArrayBuffer. */
export function base64ToPcm16(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return bytes.buffer;
}

/** Build the Gemini Live setup message (sent as the first WebSocket frame). */
export function buildGeminiSetup(options: GeminiSetupOptions, tools: GeminiTool[] = []): Record<string, unknown> {
  const setup: Record<string, unknown> = {
    model: options.model ?? DEFAULT_AARYA_GEMINI_MODEL,
    generationConfig: {
      responseModalities: ["AUDIO"],
    },
    systemInstruction: {
      parts: [{ text: options.systemPrompt ?? DEFAULT_AARYA_PERSONA }],
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
  };
  if (tools.length > 0) {
    setup["tools"] = tools;
  }
  return { setup };
}

/** Build a Gemini Live realtime audio input message from a PCM16 chunk. */
export function buildGeminiAudioInput(chunk: ArrayBuffer): Record<string, unknown> {
  return {
    realtimeInput: {
      audio: {
        data: pcm16ToBase64(new Uint8Array(chunk)),
        mimeType: "audio/pcm;rate=16000",
      },
    },
  };
}

/** Structured result of parsing one Gemini Live server message. */
export interface ParsedGeminiMessage {
  setupComplete: boolean;
  audio: ArrayBuffer[];
  userTranscripts: string[];
  assistantTranscripts: string[];
  toolCalls: AaryaToolCall[];
}

/** Parse a Gemini Live server message (string or pre-parsed object). Defensive: never throws. */
export function parseGeminiServerMessage(message: unknown): ParsedGeminiMessage {
  const parsed: ParsedGeminiMessage = {
    setupComplete: false,
    audio: [],
    userTranscripts: [],
    assistantTranscripts: [],
    toolCalls: [],
  };

  let msg: unknown = message;
  if (typeof message === "string") {
    try {
      msg = JSON.parse(message);
    } catch {
      return parsed;
    }
  }
  if (!msg || typeof msg !== "object") return parsed;

  const record = msg as Record<string, unknown>;
  parsed.setupComplete = "setupComplete" in record;

  const serverContent = record["serverContent"];
  if (serverContent && typeof serverContent === "object") {
    const content = serverContent as Record<string, unknown>;

    const modelTurn = content["modelTurn"];
    if (modelTurn && typeof modelTurn === "object") {
      const parts = (modelTurn as Record<string, unknown>)["parts"];
      if (Array.isArray(parts)) {
        for (const part of parts) {
          if (!part || typeof part !== "object") continue;
          const inlineData = (part as Record<string, unknown>)["inlineData"];
          if (inlineData && typeof inlineData === "object") {
            const data = (inlineData as Record<string, unknown>)["data"];
            if (typeof data === "string") {
              parsed.audio.push(base64ToPcm16(data));
            }
          }
        }
      }
    }

    const inputTranscription = content["inputTranscription"];
    if (inputTranscription && typeof inputTranscription === "object") {
      const text = (inputTranscription as Record<string, unknown>)["text"];
      if (typeof text === "string") parsed.userTranscripts.push(text);
    }

    const outputTranscription = content["outputTranscription"];
    if (outputTranscription && typeof outputTranscription === "object") {
      const text = (outputTranscription as Record<string, unknown>)["text"];
      if (typeof text === "string") parsed.assistantTranscripts.push(text);
    }
  }

  const toolCall = record["toolCall"];
  if (toolCall && typeof toolCall === "object") {
    const functionCalls = (toolCall as Record<string, unknown>)["functionCalls"];
    if (Array.isArray(functionCalls)) {
      for (const fc of functionCalls) {
        if (!fc || typeof fc !== "object") continue;
        const call = fc as Record<string, unknown>;
        const args = call["args"];
        parsed.toolCalls.push({
          id: typeof call["id"] === "string" ? call["id"] : "",
          name: typeof call["name"] === "string" ? call["name"] : "",
          args: (args && typeof args === "object" ? args : {}) as Record<string, unknown>,
        });
      }
    }
  }

  return parsed;
}

/** Build a Gemini Live tool-response message from executed tool results. */
export function buildGeminiToolResponse(results: AaryaToolResult[]): Record<string, unknown> {
  return {
    toolResponse: {
      functionResponses: results.map((result) => ({
        id: result.id,
        name: result.name,
        response: result.response,
      })),
    },
  };
}

/** Factory: pick Gemini Live when a key is configured, else Workers AI fallback. */
export function createAaryaAiSession(
  env: Cloudflare.Env,
  callbacks: AaryaAiCallbacks,
  tools: GeminiTool[] = [],
  geminiKey?: string,
  systemPrompt?: string,
): AaryaAiSession {
  const key = geminiKey ?? env.AARYA_GEMINI_API_KEY;
  if (key) {
    return new AaryaLiveBridge(env, callbacks, tools, key, systemPrompt);
  }
  return new AaryaWorkersAiFallback(env, callbacks, systemPrompt);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function waitForOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.removeEventListener("open", onOpen);
      ws.removeEventListener("error", onError);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("Gemini Live WebSocket failed to connect"));
    };
    ws.addEventListener("open", onOpen);
    ws.addEventListener("error", onError);
  });
}

/** Gemini Live bridge: bidirectional WebSocket to Google's BidiGenerateContent endpoint. */
class AaryaLiveBridge implements AaryaAiSession {
  readonly backend: AaryaAiBackend = "gemini";
  private ws: WebSocket | null = null;
  private intentionallyStopped = false;

  constructor(
    private readonly env: Cloudflare.Env,
    private readonly callbacks: AaryaAiCallbacks,
    private readonly tools: GeminiTool[] = [],
    private readonly geminiKey: string,
    private readonly systemPrompt?: string,
  ) {}

  async start(): Promise<void> {
    if (this.ws) return;
    const key = this.geminiKey;
    if (!key) {
      throw new Error("AARYA_GEMINI_API_KEY is not configured");
    }
    this.intentionallyStopped = false;
    this.emitStatus("connecting");

    let ws: WebSocket;
    try {
      ws = new WebSocket(GEMINI_LIVE_ENDPOINT + "?key=" + encodeURIComponent(key));
    } catch (error) {
      this.emitStatus("error", errorMessage(error));
      throw error;
    }
    this.ws = ws;

    ws.addEventListener("message", (event) => {
      void this.handleServerMessage(event.data).catch((error) => {
        logger.warn("failed to handle gemini live message", {
          event: "aarya.ai.gemini.message.failed",
          error,
        });
      });
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (!this.intentionallyStopped) {
        this.emitStatus("error", "Gemini Live connection closed");
      }
    });
    ws.addEventListener("error", () => {
      if (!this.intentionallyStopped) {
        this.emitStatus("error", "Gemini Live connection error");
      }
    });

    try {
      await waitForOpen(ws);
    } catch (error) {
      this.ws = null;
      this.emitStatus("error", errorMessage(error));
      throw error;
    }

    ws.send(
      JSON.stringify(
        buildGeminiSetup(
          {
            model: this.env.AARYA_GEMINI_MODEL,
            systemPrompt: this.systemPrompt ?? this.env.AARYA_GEMINI_SYSTEM_PROMPT,
          },
          this.tools,
        ),
      ),
    );
  }

  async stop(): Promise<void> {
    this.intentionallyStopped = true;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try {
        ws.close(1000, "client stop");
      } catch {
        // Already closed.
      }
    }
    this.emitStatus("off");
  }

  async handleAudioChunk(chunk: ArrayBuffer): Promise<void> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(buildGeminiAudioInput(chunk)));
    } catch (error) {
      logger.warn("failed to send audio to gemini live", {
        event: "aarya.ai.gemini.audio.send.failed",
        error,
      });
    }
  }

  private async handleServerMessage(data: unknown): Promise<void> {
    const parsed = parseGeminiServerMessage(data);
    if (parsed.setupComplete) {
      this.emitStatus("listening");
    }
    for (const audio of parsed.audio) {
      this.callbacks.onAudio(audio);
    }
    for (const text of parsed.userTranscripts) {
      this.callbacks.onTranscript({ role: "user", text, final: true });
    }
    for (const text of parsed.assistantTranscripts) {
      this.callbacks.onTranscript({ role: "assistant", text, final: true });
    }
    if (parsed.toolCalls.length > 0) {
      const results = await this.callbacks.onToolCalls(parsed.toolCalls);
      const ws = this.ws;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(buildGeminiToolResponse(results)));
      }
    }
  }

  private emitStatus(state: AaryaAiState, detail?: string): void {
    this.callbacks.onStatus({ state, backend: this.backend, detail });
  }
}
