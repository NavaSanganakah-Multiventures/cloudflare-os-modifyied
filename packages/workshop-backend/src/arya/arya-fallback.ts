// Workers AI fallback for the Arya voice assistant.
//
// When ARYA_GEMINI_API_KEY is absent the voice assistant uses this pipeline instead of the
// Gemini Live bridge: PCM16 audio is buffered, a simple energy-based VAD detects end-of-utterance,
// then whisper transcribes, an LLM completes the reply, and melotts synthesizes audio. This is a
// request-response loop rather than true streaming, but it keeps the assistant usable without a
// Gemini key.

import { createWorkshopLogger } from "../observability";
import type { AryaAiCallbacks, AryaAiSession } from "./arya-ai";
import type { AryaAiBackend, AryaAiState } from "./arya-types";

const logger = createWorkshopLogger("workshop.arya.fallback");

const FALLBACK_SAMPLE_RATE = 16000;
const DEFAULT_ARYA_FALLBACK_LLM = "@cf/meta/llama-3.1-8b-instruct-fast";
const FALLBACK_PERSONA =
  "You are Arya, a friendly voice assistant for the user's workspace. " +
  "Answer concisely and conversationally, in the same language the user speaks.";

/** Options for the simple energy-based voice-activity detector. */
export interface AryaVadOptions {
  threshold?: number;
  silenceMs?: number;
  sampleRate?: number;
  frameMs?: number;
}

/** Result of running VAD over a buffer of PCM16 samples. */
export interface AryaVadResult {
  hasSpeech: boolean;
  ended: boolean;
  speechEndSample: number;
  peakRms: number;
}

/**
 * Detect whether an utterance has ended within the given samples.
 *
 * Frames the audio into fixed-size windows, computes per-frame RMS, and treats any frame at or
 * above `threshold` as speech. An utterance has ended when there is at least `silenceMs` of
 * trailing silence after the last speech frame.
 */
export function detectUtteranceEnd(samples: Int16Array, options: AryaVadOptions = {}): AryaVadResult {
  const threshold = options.threshold ?? 0.01;
  const silenceMs = options.silenceMs ?? 700;
  const sampleRate = options.sampleRate ?? FALLBACK_SAMPLE_RATE;
  const frameMs = options.frameMs ?? 20;

  const frameSamples = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  const silenceSamples = Math.floor((sampleRate * silenceMs) / 1000);

  let peakRms = 0;
  let lastSpeechEndSample = -1;

  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(samples.length, start + frameSamples);
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      const normalized = samples[i] / 32768;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / (end - start));
    if (rms > peakRms) peakRms = rms;
    if (rms >= threshold) lastSpeechEndSample = end;
  }

  if (lastSpeechEndSample < 0) {
    return { hasSpeech: false, ended: false, speechEndSample: 0, peakRms };
  }

  return {
    hasSpeech: true,
    ended: samples.length - lastSpeechEndSample >= silenceSamples,
    speechEndSample: lastSpeechEndSample,
    peakRms,
  };
}

/** Convenience wrapper: true when VAD detects speech followed by enough trailing silence. */
export function utteranceEnded(samples: Int16Array, options: AryaVadOptions = {}): boolean {
  return detectUtteranceEnd(samples, options).ended;
}

/** Interpret raw little-endian PCM16 bytes as an Int16Array. */
export function int16FromBytes(bytes: Uint8Array): Int16Array {
  const length = bytes.byteLength - (bytes.byteLength % 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, length);
  const samples = new Int16Array(length / 2);
  for (let i = 0; i < samples.length; i++) {
    samples[i] = view.getInt16(i * 2, true);
  }
  return samples;
}

/** Wrap PCM16 samples in a 44-byte RIFF/WAVE container so whisper can decode them. */
export function pcm16ToWavBytes(samples: Int16Array, sampleRate = FALLBACK_SAMPLE_RATE): Uint8Array {
  const dataSize = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) {
      view.setUint8(offset + i, value.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  for (let i = 0; i < samples.length; i++) {
    view.setInt16(44 + i * 2, samples[i], true);
  }

  return new Uint8Array(buffer);
}

/** Workers AI fallback session: STT -> LLM -> TTS pipeline driven by a simple VAD. */
export class AryaWorkersAiFallback implements AryaAiSession {
  readonly backend: AryaAiBackend = "workers-ai";

  private buffer = new Int16Array(0);
  private processing = false;
  private stopped = false;

  constructor(
    private readonly env: Cloudflare.Env,
    private readonly callbacks: AryaAiCallbacks,
  ) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.buffer = new Int16Array(0);
    this.emitStatus("listening");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.buffer = new Int16Array(0);
    this.emitStatus("off");
  }

  async handleAudioChunk(chunk: ArrayBuffer): Promise<void> {
    if (this.stopped) return;
    const samples = int16FromBytes(new Uint8Array(chunk));
    if (samples.length === 0) return;
    this.buffer = concatInt16(this.buffer, samples);

    const vad = detectUtteranceEnd(this.buffer);
    if (!vad.hasSpeech || !vad.ended || this.processing) return;

    const utterance = this.buffer.slice(0, vad.speechEndSample);
    this.buffer = this.buffer.slice(vad.speechEndSample);
    if (utterance.length === 0) return;

    this.processing = true;
    try {
      await this.processUtterance(utterance);
    } catch (error) {
      logger.warn("arya workers-ai fallback utterance failed", {
        event: "arya.ai.fallback.utterance.failed",
        error,
      });
      this.emitStatus("error", errorMessage(error));
    } finally {
      this.processing = false;
    }
  }

  private async processUtterance(samples: Int16Array): Promise<void> {
    this.emitStatus("listening");

    const userText = await this.transcribe(samples);
    if (!userText) return;
    this.callbacks.onTranscript({ role: "user", text: userText, final: true });

    const reply = await this.complete(userText);
    if (!reply) return;
    this.callbacks.onTranscript({ role: "assistant", text: reply, final: true });

    const audio = await this.synthesize(reply);
    if (audio) this.callbacks.onAudio(audio);
  }

  private async transcribe(samples: Int16Array): Promise<string> {
    const wav = pcm16ToWavBytes(samples);
    const result = await this.env.WORKERS_AI.run("@cf/openai/whisper", {
      audio: Array.from(wav),
    });
    return result.text.trim();
  }

  private async complete(userText: string): Promise<string> {
    const model = this.env.ARYA_WORKERS_AI_LLM ?? DEFAULT_ARYA_FALLBACK_LLM;
    const persona = this.env.ARYA_GEMINI_SYSTEM_PROMPT ?? FALLBACK_PERSONA;
    const result = await this.env.WORKERS_AI.run(model, {
      messages: [
        { role: "system", content: persona },
        { role: "user", content: userText },
      ],
      stream: false,
    });
    const text = result["response"];
    return typeof text === "string" ? text.trim() : "";
  }

  private async synthesize(text: string): Promise<ArrayBuffer | null> {
    const result = await this.env.WORKERS_AI.run("@cf/myshell-ai/melotts", {
      prompt: text,
      lang: "en",
    });
    if (result instanceof Uint8Array) {
      return toArrayBuffer(result);
    }
    return base64ToBytes(result.audio);
  }

  private emitStatus(state: AryaAiState, detail?: string): void {
    this.callbacks.onStatus({ state, backend: this.backend, detail });
  }
}

function concatInt16(a: Int16Array, b: Int16Array): Int16Array {
  const out = new Int16Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function base64ToBytes(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return bytes.buffer;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
