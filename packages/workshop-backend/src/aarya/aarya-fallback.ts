// Workers AI fallback for the Aarya voice assistant.
//
// When AARYA_GEMINI_API_KEY is absent the voice assistant uses this pipeline instead of the
// Gemini Live bridge: PCM16 audio is buffered, a simple energy-based VAD detects end-of-utterance,
// then whisper transcribes, an LLM completes the reply, and melotts synthesizes audio. This is a
// request-response loop rather than true streaming, but it keeps the assistant usable without a
// Gemini key.

import { createWorkshopLogger } from "../observability";
import type { AaryaAiCallbacks, AaryaAiSession } from "./aarya-ai";
import type { AaryaAiBackend, AaryaAiState } from "./aarya-types";
import { transliterateDevanagariToLatin } from "./aarya-transliterate";

const logger = createWorkshopLogger("workshop.aarya.fallback");

const FALLBACK_SAMPLE_RATE = 16000;
const DEFAULT_AARYA_FALLBACK_LLM = "@cf/meta/llama-3.1-8b-instruct-fast";
const FALLBACK_PERSONA =
  "You are AARYA, a friendly voice assistant for the user's workspace. " +
  "The user speaks Hinglish (a Hindi/English mix) and their message may arrive in Roman (Latin) letters. " +
  "Always answer in Hindi written in Devanagari script, unless the user asks otherwise. " +
  "Keep replies short and conversational. If you did not hear or understand the user clearly, ask them to repeat.";

const MAX_HISTORY_MESSAGES = 8;

/**
 * Minimum utterance length (in PCM16 samples at 16kHz) that we will send to whisper STT.
 * Shorter buffers yield degenerate mel/VAD input and make whisper's Triton backend fail with
 * "could not broadcast input array from shape (0,) into shape (0,2)".
 */
const MIN_TRANSCRIBE_SAMPLES = Math.floor(0.5 * FALLBACK_SAMPLE_RATE); // 8000 = 0.5s

export const DEFAULT_AARYA_FALLBACK_STT = "@cf/openai/whisper-large-v3-turbo";
export const LEGACY_AARYA_FALLBACK_STT = "@cf/openai/whisper";
export const DEFAULT_AARYA_FALLBACK_TTS = "@cf/deepgram/aura-1";
export const LEGACY_AARYA_FALLBACK_TTS = "@cf/myshell-ai/melotts";

/** Options for the voice-activity detector. */
export interface AaryaVadOptions {
  threshold?: number;
  silenceMs?: number;
  sampleRate?: number;
  frameMs?: number;
  minSpeechMs?: number;
  maxUtteranceMs?: number;
}

/** Result of running VAD over a buffer of PCM16 samples. */
export interface AaryaVadResult {
  hasSpeech: boolean;
  ended: boolean;
  speechEndSample: number;
  peakRms: number;
}

/**
 * Detect whether an utterance has ended within the given samples.
 *
 * Frames the audio into fixed-size windows, computes per-frame RMS, and treats any frame at or
 * above `threshold` as speech. Filters out transients shorter than `minSpeechMs`. An utterance has
 * ended when there is at least `silenceMs` of trailing silence after the last speech frame or
 * when the utterance exceeds `maxUtteranceMs`.
 */
export function detectUtteranceEnd(samples: Int16Array, options: AaryaVadOptions = {}): AaryaVadResult {
  const threshold = options.threshold ?? 0.01;
  const silenceMs = options.silenceMs ?? 700;
  const sampleRate = options.sampleRate ?? FALLBACK_SAMPLE_RATE;
  const frameMs = options.frameMs ?? 20;
  const minSpeechMs = options.minSpeechMs ?? 100;
  const maxUtteranceMs = options.maxUtteranceMs ?? 15000;

  const frameSamples = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  const silenceSamples = Math.floor((sampleRate * silenceMs) / 1000);
  const minSpeechSamples = Math.floor((sampleRate * minSpeechMs) / 1000);
  const maxUtteranceSamples = Math.floor((sampleRate * maxUtteranceMs) / 1000);

  let peakRms = 0;
  let lastSpeechEndSample = -1;
  let speechSamplesCount = 0;

  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(samples.length, start + frameSamples);
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      const normalized = samples[i] / 32768;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / (end - start));
    if (rms > peakRms) peakRms = rms;
    if (rms >= threshold) {
      lastSpeechEndSample = end;
      speechSamplesCount += end - start;
    }
  }

  if (lastSpeechEndSample < 0 || speechSamplesCount < minSpeechSamples) {
    return { hasSpeech: false, ended: false, speechEndSample: 0, peakRms };
  }

  const trailingSilence = samples.length - lastSpeechEndSample;
  const reachedMaxDuration = samples.length >= maxUtteranceSamples;

  return {
    hasSpeech: true,
    ended: trailingSilence >= silenceSamples || reachedMaxDuration,
    speechEndSample: lastSpeechEndSample,
    peakRms,
  };
}

/** Convenience wrapper: true when VAD detects speech followed by enough trailing silence. */
export function utteranceEnded(samples: Int16Array, options: AaryaVadOptions = {}): boolean {
  return detectUtteranceEnd(samples, options).ended;
}

/** Estimate the ambient noise floor as the mean RMS of the quietest third of frames. */
export function estimateNoiseFloor(samples: Int16Array, options: AaryaVadOptions = {}): number {
  const sampleRate = options.sampleRate ?? FALLBACK_SAMPLE_RATE;
  const frameMs = options.frameMs ?? 20;
  const frameSamples = Math.max(1, Math.floor((sampleRate * frameMs) / 1000));
  const rmsValues: number[] = [];
  for (let start = 0; start < samples.length; start += frameSamples) {
    const end = Math.min(samples.length, start + frameSamples);
    let sumSquares = 0;
    for (let i = start; i < end; i++) {
      const normalized = samples[i] / 32768;
      sumSquares += normalized * normalized;
    }
    rmsValues.push(Math.sqrt(sumSquares / (end - start)));
  }
  if (rmsValues.length === 0) return 0;
  const sorted = rmsValues.toSorted((a, b) => a - b);
  const quietCount = Math.max(1, Math.floor(sorted.length / 3));
  let sum = 0;
  for (let i = 0; i < quietCount; i++) sum += sorted[i];
  return sum / quietCount;
}

/** True when an utterance is long enough to be worth sending to the STT model. */
export function shouldTranscribe(samples: Int16Array): boolean {
  return samples.length >= MIN_TRANSCRIBE_SAMPLES;
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

/** Workers AI fallback session: STT -> LLM -> TTS pipeline driven by an enhanced VAD. */
export class AaryaWorkersAiFallback implements AaryaAiSession {
  readonly backend: AaryaAiBackend = "workers-ai";

  private buffer: Int16Array<ArrayBufferLike> = new Int16Array(0);
  private processing = false;
  private stopped = false;
  private history: Array<{ role: "user" | "assistant"; content: string }> = [];

  constructor(
    private readonly env: Cloudflare.Env,
    private readonly callbacks: AaryaAiCallbacks,
    private readonly systemPrompt?: string,
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

    // Bound buffer size to max 30s of audio to prevent unbounded memory growth during continuous noise.
    const maxBufferSamples = 30 * FALLBACK_SAMPLE_RATE;
    if (this.buffer.length > maxBufferSamples) {
      this.buffer = this.buffer.slice(this.buffer.length - maxBufferSamples);
    }

    const noiseFloor = estimateNoiseFloor(this.buffer);
    const threshold = Math.max(0.008, Math.min(0.05, noiseFloor * 3));
    const vad = detectUtteranceEnd(this.buffer, { threshold });
    if (!vad.hasSpeech || !vad.ended || this.processing) return;

    const utterance = this.buffer.slice(0, vad.speechEndSample);
    this.buffer = this.buffer.slice(vad.speechEndSample);
    if (utterance.length === 0) return;
    if (!shouldTranscribe(utterance)) {
      // Too short to transcribe reliably; sending it to whisper produces an empty VAD segment
      // set and crashes the Triton backend. Drop it and keep listening.
      logger.debug(
        "dropping too-short aarya utterance (" + utterance.length + " samples)",
        { event: "aarya.ai.fallback.utterance.too_short" },
      );
      return;
    }

    this.processing = true;
    try {
      await this.processUtterance(utterance);
    } catch (error) {
      logger.warn("aarya workers-ai fallback utterance failed", {
        event: "aarya.ai.fallback.utterance.failed",
        error,
      });
      this.emitStatus("error", errorMessage(error));
    } finally {
      this.processing = false;
    }
  }

  private async processUtterance(samples: Int16Array): Promise<void> {
    this.emitStatus("listening");

    const userText = transliterateDevanagariToLatin(await this.transcribe(samples));
    if (!userText) return;
    this.callbacks.onTranscript({ role: "user", text: userText, final: true });

    this.history.push({ role: "user", content: userText });
    const reply = await this.complete();
    if (!reply) return;
    this.history.push({ role: "assistant", content: reply });
    if (this.history.length > MAX_HISTORY_MESSAGES) {
      this.history.splice(0, this.history.length - MAX_HISTORY_MESSAGES);
    }
    this.callbacks.onTranscript({ role: "assistant", text: reply, final: true });

    const audio = await this.synthesize(reply);
    if (audio) this.callbacks.onAudio(audio);
  }

  private async transcribe(samples: Int16Array): Promise<string> {
    if (!shouldTranscribe(samples)) return "";

    const wav = pcm16ToWavBytes(samples);
    const sttModel = this.env.AARYA_WORKERS_AI_STT ?? DEFAULT_AARYA_FALLBACK_STT;
    const audioData = Array.from(wav);

    let result: Record<string, unknown> | null = null;
    try {
      // We already trim utterances with our own VAD, so whisper's internal VAD must
      // not drop short or quiet speech segments that our VAD kept.
      result = (await this.env.WORKERS_AI.run(sttModel as any, {
        audio: audioData,
        vad_filter: false,
      })) as unknown as Record<string, unknown>;
    } catch (err) {
      // Whisper's Triton backend throws this when VAD finds no speech segments (e.g. a
      // noise-only or otherwise empty utterance). Treat it as "no speech" rather than failing
      // the whole session, and do not retry: the legacy model would hit the same empty input.
      if (isEmptyVadWhisperError(err)) {
        logger.warn("whisper found no speech segments in utterance", {
          event: "aarya.ai.fallback.stt.empty",
          error: err,
        });
        return "";
      }
      if (sttModel !== LEGACY_AARYA_FALLBACK_STT) {
        logger.warn("primary STT failed, falling back to legacy whisper", {
          event: "aarya.ai.fallback.stt.retry",
          error: err,
        });
        result = (await this.env.WORKERS_AI.run(LEGACY_AARYA_FALLBACK_STT, {
          audio: audioData,
        })) as unknown as Record<string, unknown>;
      } else {
        throw err;
      }
    }

    const text = result?.["text"];
    return typeof text === "string" ? text.trim() : "";
  }

  private async complete(): Promise<string> {
    const model = this.env.AARYA_WORKERS_AI_LLM ?? DEFAULT_AARYA_FALLBACK_LLM;
    const persona = this.systemPrompt ?? this.env.AARYA_GEMINI_SYSTEM_PROMPT ?? FALLBACK_PERSONA;
    const result = await this.env.WORKERS_AI.run(model, {
      messages: [
        { role: "system", content: persona },
        ...this.history,
      ],
      stream: false,
    });
    const text = result["response"];
    return typeof text === "string" ? text.trim() : "";
  }

  private async synthesize(text: string): Promise<ArrayBuffer | null> {
    const ttsModel = this.env.AARYA_WORKERS_AI_TTS ?? DEFAULT_AARYA_FALLBACK_TTS;
    try {
      if (ttsModel.includes("aura")) {
        const result = (await this.env.WORKERS_AI.run(ttsModel as any, {
          text,
          sample_rate: 16000,
        })) as unknown;

        if (result instanceof Uint8Array) {
          return toArrayBuffer(result);
        }
        if (result instanceof ArrayBuffer) {
          return result;
        }
        if (result && typeof result === "object" && "audio" in result) {
          const audio = (result as Record<string, unknown>).audio;
          return typeof audio === "string"
            ? base64ToBytes(audio)
            : toArrayBuffer(audio as Uint8Array);
        }
      } else {
        const result = (await this.env.WORKERS_AI.run(ttsModel as any, {
          prompt: text,
          lang: "en",
        })) as unknown;

        if (result instanceof Uint8Array) {
          return toArrayBuffer(result);
        }
        if (result && typeof result === "object" && "audio" in result) {
          const audio = (result as Record<string, unknown>).audio;
          return typeof audio === "string" ? base64ToBytes(audio) : null;
        }
      }
    } catch (error) {
      logger.warn("primary TTS failed, attempting fallback to melotts", {
        event: "aarya.ai.fallback.tts.retry",
        error,
      });
      try {
        const fallbackResult = (await this.env.WORKERS_AI.run(LEGACY_AARYA_FALLBACK_TTS, {
          prompt: text,
          lang: "en",
        })) as unknown;
        if (fallbackResult instanceof Uint8Array) {
          return toArrayBuffer(fallbackResult);
        }
        if (fallbackResult && typeof fallbackResult === "object" && "audio" in fallbackResult) {
          const audio = (fallbackResult as Record<string, unknown>).audio;
          return typeof audio === "string" ? base64ToBytes(audio) : null;
        }
      } catch (fallbackError) {
        logger.warn("all fallback TTS attempts failed", {
          event: "aarya.ai.fallback.tts.failed",
          error: fallbackError,
        });
        return null;
      }
    }
    return null;
  }

  private emitStatus(state: AaryaAiState, detail?: string): void {
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

/** True when the error is whisper/Triton's empty-VAD crash (no speech segments were found). */
function isEmptyVadWhisperError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("could not broadcast input array") || message.includes("shape (0,)");
}
