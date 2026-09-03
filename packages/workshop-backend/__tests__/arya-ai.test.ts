import { describe, expect, it } from "vitest";

import {
  base64ToPcm16,
  buildGeminiAudioInput,
  buildGeminiSetup,
  buildGeminiToolResponse,
  DEFAULT_ARYA_GEMINI_MODEL,
  parseGeminiServerMessage,
  pcm16ToBase64,
} from "../src/arya/arya-ai";
import { detectUtteranceEnd, pcm16ToWavBytes, utteranceEnded } from "../src/arya/arya-fallback";
import {
  AryaToolRegistry,
  executeAryaTool,
  geminiFunctionDeclarations,
} from "../src/arya/arya-tools";

function loudSamples(count: number): Int16Array {
  return Int16Array.from(
    Array.from({ length: count }, (_, i) => (i % 32 < 16 ? 16000 : -16000)),
  );
}

describe("gemini wire helpers", () => {
  it("builds a setup message with generationConfig.responseModalities and transcription configs", () => {
    const setup = buildGeminiSetup(
      { model: "models/test-live", systemPrompt: "You are a test assistant." },
      [
        {
          functionDeclarations: [
            { name: "get_current_time", description: "Time", parameters: { type: "object" } },
          ],
        },
      ],
    );
    const body = setup["setup"] as Record<string, unknown>;
    expect(body["model"]).toBe("models/test-live");

    const generationConfig = body["generationConfig"] as Record<string, unknown>;
    expect(generationConfig["responseModalities"]).toEqual(["AUDIO"]);

    expect(body["systemInstruction"]).toEqual({
      parts: [{ text: "You are a test assistant." }],
    });
    expect(body["inputAudioTranscription"]).toEqual({});
    expect(body["outputAudioTranscription"]).toEqual({});

    expect(Array.isArray(body["tools"])).toBe(true);
    const tools = body["tools"] as Array<Record<string, unknown>>;
    expect(tools[0]["functionDeclarations"]).toEqual([
      { name: "get_current_time", description: "Time", parameters: { type: "object" } },
    ]);
  });

  it("defaults the model and persona when not provided", () => {
    const setup = buildGeminiSetup({});
    const body = setup["setup"] as Record<string, unknown>;
    expect(body["model"]).toBe(DEFAULT_ARYA_GEMINI_MODEL);
    const instruction = body["systemInstruction"] as { parts: Array<{ text: string }> };
    expect(instruction.parts[0].text.length).toBeGreaterThan(0);
    expect(body["tools"]).toBeUndefined();
  });

  it("builds an audio input frame with pcm16 base64", () => {
    const input = buildGeminiAudioInput(Uint8Array.from([0, 0, 1, 0]).buffer);
    const realtime = input["realtimeInput"] as Record<string, unknown>;
    const audio = realtime["audio"] as Record<string, unknown>;
    expect(audio["mimeType"]).toBe("audio/pcm;rate=16000");
    expect(audio["data"]).toBe("AAABAA==");
  });

  it("round-trips pcm16 bytes through base64", () => {
    const bytes = Uint8Array.from([0, 1, 2, 250, 255, 128]);
    const roundTripped = new Uint8Array(base64ToPcm16(pcm16ToBase64(bytes)));
    expect(Array.from(roundTripped)).toEqual(Array.from(bytes));
  });

  it("parses setupComplete, audio, transcriptions, and tool calls", () => {
    const setupOnly = parseGeminiServerMessage({ setupComplete: {} });
    expect(setupOnly.setupComplete).toBe(true);
    expect(setupOnly.audio).toEqual([]);

    const withContent = parseGeminiServerMessage({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: pcm16ToBase64(Uint8Array.from([7, 8])) } }],
        },
        inputTranscription: { text: "hello arya" },
        outputTranscription: { text: "hi there" },
      },
      toolCall: {
        functionCalls: [{ id: "call-1", name: "get_current_time", args: {} }],
      },
    });
    expect(withContent.setupComplete).toBe(false);
    expect(withContent.audio.length).toBe(1);
    expect(Array.from(new Uint8Array(withContent.audio[0]))).toEqual([7, 8]);
    expect(withContent.userTranscripts).toEqual(["hello arya"]);
    expect(withContent.assistantTranscripts).toEqual(["hi there"]);
    expect(withContent.toolCalls).toEqual([
      { id: "call-1", name: "get_current_time", args: {} },
    ]);
  });

  it("returns empty results for goAway and unrecognized messages", () => {
    expect(parseGeminiServerMessage({ goAway: {} })).toEqual({
      setupComplete: false,
      audio: [],
      userTranscripts: [],
      assistantTranscripts: [],
      toolCalls: [],
    });
    expect(parseGeminiServerMessage("not json")).toEqual({
      setupComplete: false,
      audio: [],
      userTranscripts: [],
      assistantTranscripts: [],
      toolCalls: [],
    });
  });

  it("wraps tool results into a toolResponse message", () => {
    const response = buildGeminiToolResponse([
      { id: "call-1", name: "get_current_time", response: { ok: true, result: { time: "t" } } },
    ]);
    const toolResponse = response["toolResponse"] as Record<string, unknown>;
    expect(toolResponse["functionResponses"]).toEqual([
      { id: "call-1", name: "get_current_time", response: { ok: true, result: { time: "t" } } },
    ]);
  });
});

describe("workers-ai fallback VAD", () => {
  it("does not end while speech is ongoing", () => {
    const samples = loudSamples(1600);
    const result = detectUtteranceEnd(samples);
    expect(result.hasSpeech).toBe(true);
    expect(result.ended).toBe(false);
  });

  it("ends after enough trailing silence", () => {
    const loud = loudSamples(16000);
    const silence = new Int16Array(11200);
    const samples = new Int16Array(loud.length + silence.length);
    samples.set(loud, 0);
    samples.set(silence, loud.length);
    expect(utteranceEnded(samples)).toBe(true);
  });

  it("does not end with only short trailing silence", () => {
    const loud = loudSamples(16000);
    const silence = new Int16Array(1600);
    const samples = new Int16Array(loud.length + silence.length);
    samples.set(loud, 0);
    samples.set(silence, loud.length);
    expect(utteranceEnded(samples)).toBe(false);
  });
});

describe("pcm16 to WAV", () => {
  it("wraps pcm16 in a little-endian RIFF/WAVE container", () => {
    const wav = pcm16ToWavBytes(Int16Array.from([0, 1, -1, 32000]));
    const view = new DataView(wav.buffer);
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...Array.from(wav.subarray(off, off + len)));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(1);
    expect(view.getInt16(48, true)).toBe(-1);
    expect(view.getInt16(50, true)).toBe(32000);
    expect(wav.byteLength).toBe(52);
  });
});

describe("arya tool registry", () => {
  const makeRuntime = () => ({
    now: () => new Date("2026-01-01T00:00:00Z"),
    voiceStatus: () => ({ state: "listening" as const }),
    mutations: {
      setOwnerDisplayName: async (_name: string) => {},
      setReminder: async (_message: string, _dueAt: number) => ({
        id: "r1",
        message: "test",
        dueAt: 0,
        createdAt: 0,
      }),
      cancelReminder: async (_id: string) => true,
    },
    readReminders: async () => [],
    readNotifications: async () => [],
  });

  it("exposes the read-only and mutating tools as gemini declarations", () => {
    const registry = new AryaToolRegistry(makeRuntime());
    const names = registry.definitions().map((t) => t.name).toSorted();
    expect(names).toEqual([
      "cancel_reminder",
      "get_current_time",
      "get_notifications",
      "get_voice_status",
      "list_reminders",
      "set_reminder",
      "update_display_name",
    ]);

    const tools = geminiFunctionDeclarations(registry.definitions());
    const declarations = tools[0]["functionDeclarations"];
    expect(declarations?.map((d) => d.name).toSorted()).toEqual([
      "cancel_reminder",
      "get_current_time",
      "get_notifications",
      "get_voice_status",
      "list_reminders",
      "set_reminder",
      "update_display_name",
    ]);
  });

  it("executes a known tool and returns an ok envelope", async () => {
    const registry = new AryaToolRegistry(makeRuntime());
    const result = await registry.execute({ id: "c1", name: "get_current_time", args: {} });
    expect(result.id).toBe("c1");
    expect(result.name).toBe("get_current_time");
    expect(result.response).toEqual({ ok: true, result: { time: "2026-01-01T00:00:00.000Z" } });
  });

  it("returns an error envelope for unknown tools", async () => {
    const result = await executeAryaTool(
      { id: "c2", name: "delete_everything", args: {} },
      makeRuntime(),
    );
    expect(result.response).toMatchObject({ ok: false });
  });
});
