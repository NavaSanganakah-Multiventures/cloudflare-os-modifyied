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
    },
  });

  const audioContext = new AudioContext({ sampleRate: 16000 });
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

  source.connect(processor);

  // Route the processor through a muted gain node so captured mic audio does not loop back
  // to the speakers (which triggers acoustic echo suppression and dampens mic sensitivity).
  const muteNode = audioContext.createGain();
  muteNode.gain.value = 0;
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

/** A queue-based PCM16 player that schedules chunks back-to-back with no overlap. */
export interface Pcm16Player {
  /** Enqueue a PCM16 16kHz mono audio buffer for real-time playback. */
  play(audio: ArrayBuffer): void;
  /** Stop all pending/playing audio immediately (barge-in when the user starts talking). */
  flush(): void;
  /** Flush pending audio. The caller still owns and closes the AudioContext. */
  close(): void;
}

const PLAYBACK_PRIME_SECONDS = 0.04;

/** Create a queued player for PCM16 16kHz mono audio. */
export function createPcm16Player(audioContext: AudioContext): Pcm16Player {
  const active = new Set<AudioBufferSourceNode>();
  let nextStartTime = 0;

  function play(audio: ArrayBuffer): void {
    const int16 = new Int16Array(audio);
    if (int16.length === 0) return;

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / 0x8000;
    }

    const buffer = audioContext.createBuffer(1, float32.length, 16000);
    buffer.copyToChannel(float32, 0);

    const source = audioContext.createBufferSource();
    source.buffer = buffer;
    source.connect(audioContext.destination);

    const now = audioContext.currentTime;
    if (nextStartTime < now) {
      nextStartTime = now + PLAYBACK_PRIME_SECONDS;
    }
    const when = nextStartTime;
    source.start(when);
    nextStartTime = when + buffer.duration;

    active.add(source);
    source.addEventListener('ended', () => {
      active.delete(source);
    });
  }

  function flush(): void {
    for (const source of active) {
      try {
        source.stop();
      } catch {
        // Already stopped.
      }
    }
    active.clear();
    nextStartTime = 0;
  }

  function close(): void {
    flush();
  }

  return { play, flush, close };
}
