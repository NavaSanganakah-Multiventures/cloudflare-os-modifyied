// Audio capture, playback, and WebSocket helpers for the Aarya voice panel.
//
// All audio processing happens client-side. The microphone is only accessed after the user
// activates push-to-talk; before that, no audio leaves the browser.

/** Build the WebSocket URL for an Aarya voice call. */
export function aaryaVoiceWsUrl(baseUrl: string, call: string, token: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol.replace("http", "ws");
  url.pathname = "/api/aarya/ws";
  url.searchParams.set("call", call);
  url.searchParams.set("token", token);
  return url.toString();
}

/** Handlers for messages received over the Aarya voice WebSocket. */
export interface AaryaVoiceHandlers {
  onStatus: (state: string, backend?: string, detail?: string) => void;
  onTranscript: (role: "user" | "assistant", text: string, final: boolean) => void;
  onAudio: (audio: ArrayBuffer) => void;
  onPeerEvent: (msg: Record<string, unknown>) => void;
}

/** Create a WebSocket connection to the Aarya voice room. */
export function connectAaryaVoice(wsUrl: string, handlers: AaryaVoiceHandlers): WebSocket {
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  ws.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) {
      handlers.onAudio(event.data);
      return;
    }
    try {
      const msg = JSON.parse(event.data as string) as Record<string, unknown>;
      switch (msg.type) {
        case "ai-status":
          handlers.onStatus(
            typeof msg.state === "string" ? msg.state : "off",
            typeof msg.backend === "string" ? msg.backend : undefined,
            typeof msg.detail === "string" ? msg.detail : undefined,
          );
          break;
        case "transcript":
          handlers.onTranscript(
            msg.role === "assistant" ? "assistant" : "user",
            typeof msg.text === "string" ? msg.text : "",
            msg.final !== false,
          );
          break;
        default:
          handlers.onPeerEvent(msg);
          break;
      }
    } catch {
      // Ignore unparseable messages.
    }
  });

  return ws;
}

/** Set up microphone capture. Audio is captured as PCM16 16kHz mono. Returns a stop function. */
export async function createMicCapture(
  onChunk: (pcm16: ArrayBuffer) => void,
): Promise<{ stop: () => void }> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  const audioContext = new AudioContext({ sampleRate: 16000 });
  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch {
      // Ignore resume failure on initial capture setup.
    }
  }

  const source = audioContext.createMediaStreamSource(stream);
  // ScriptProcessorNode is deprecated but widely supported and sufficient for this use case.
  const processor = audioContext.createScriptProcessor(4096, 1, 1);

  processor.onaudioprocess = (event: AudioProcessingEvent) => {
    const float32 = event.inputBuffer.getChannelData(0);
    const int16 = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
      const clamped = Math.max(-1, Math.min(1, float32[i]));
      int16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
    }
    onChunk(int16.buffer as ArrayBuffer);
  };

  // Route processor through a muted gain node so captured mic audio does not loop back to
  // the speakers (which triggers acoustic echo suppression and dampens mic sensitivity).
  const muteNode = audioContext.createGain();
  muteNode.gain.value = 0;
  source.connect(processor);
  processor.connect(muteNode);
  muteNode.connect(audioContext.destination);

  return {
    stop: () => {
      processor.disconnect();
      muteNode.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
    },
  };
}

/** Detect whether the given audio bytes contain a recognized container format (WAV, MP3, OGG, FLAC). */
export function isAudioContainer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4) return false;
  // RIFF (WAV)
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    return true;
  }
  // ID3 (MP3 with ID3 header)
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    return true;
  }
  // MP3 sync frame (11 consecutive 1 bits: 0xFF followed by high 3 bits set)
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return true;
  }
  // OggS (Ogg / Opus)
  if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
    return true;
  }
  // fLaC
  if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
    return true;
  }
  return false;
}

/** Create an AudioBuffer from raw little-endian PCM16 samples. */
export function createPcm16Buffer(
  audio: ArrayBuffer,
  audioContext: AudioContext,
  sampleRate = 24000,
): AudioBuffer {
  const int16 = new Int16Array(audio);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x8000;
  }
  const buffer = audioContext.createBuffer(1, float32.length, sampleRate);
  buffer.copyToChannel(float32, 0);
  return buffer;
}

/**
 * Manages audio playback for AARYA. Decodes container audio (WAV/MP3 from Workers AI) natively
 * using decodeAudioData, and renders raw PCM chunks (from Gemini Live) at 24kHz. Schedules chunks
 * continuously for seamless, jitter-free streaming speech.
 */
export class AaryaAudioPlayer {
  private nextPlayTime = 0;
  private gainNode: GainNode | null = null;

  constructor(private readonly audioContext: AudioContext, private readonly gainValue = 1.6) {
    try {
      this.gainNode = audioContext.createGain();
      this.gainNode.gain.value = this.gainValue;
      this.gainNode.connect(audioContext.destination);
    } catch {
      // AudioContext might already be closed.
    }
  }

  async play(audio: ArrayBuffer): Promise<void> {
    if (this.audioContext.state === "suspended") {
      try {
        await this.audioContext.resume();
      } catch {
        // Ignore resume failure.
      }
    }

    let buffer: AudioBuffer;
    const bytes = new Uint8Array(audio);

    if (isAudioContainer(bytes)) {
      try {
        // decodeAudioData consumes the slice copy without detaching the original buffer
        buffer = await this.audioContext.decodeAudioData(audio.slice(0));
      } catch {
        buffer = createPcm16Buffer(audio, this.audioContext, 24000);
      }
    } else {
      buffer = createPcm16Buffer(audio, this.audioContext, 24000);
    }

    const src = this.audioContext.createBufferSource();
    src.buffer = buffer;
    if (this.gainNode) {
      src.connect(this.gainNode);
    } else {
      src.connect(this.audioContext.destination);
    }

    const now = this.audioContext.currentTime;
    const startTime = this.nextPlayTime > now && this.nextPlayTime - now < 5 ? this.nextPlayTime : now;
    src.start(startTime);
    this.nextPlayTime = startTime + buffer.duration;
  }

  reset(): void {
    this.nextPlayTime = 0;
  }

  stop(): void {
    this.reset();
    if (this.gainNode) {
      try {
        this.gainNode.disconnect();
      } catch {
        // Ignore disconnect errors.
      }
      this.gainNode = null;
    }
  }
}

/** Play audio through the speakers (supports both container audio and raw PCM). */
export function playPcm16Audio(audio: ArrayBuffer, audioContext: AudioContext): void {
  const player = new AaryaAudioPlayer(audioContext);
  void player.play(audio);
}
