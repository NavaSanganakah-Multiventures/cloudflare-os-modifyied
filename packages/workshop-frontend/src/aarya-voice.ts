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
  processor.connect(audioContext.destination);

  return {
    stop: () => {
      processor.disconnect();
      source.disconnect();
      stream.getTracks().forEach((track) => track.stop());
      void audioContext.close();
    },
  };
}

/** Play a PCM16 16kHz mono audio buffer through the speakers. */
export function playPcm16Audio(audio: ArrayBuffer, audioContext: AudioContext): void {
  const int16 = new Int16Array(audio);
  const float32 = new Float32Array(int16.length);
  for (let i = 0; i < int16.length; i++) {
    float32[i] = int16[i] / 0x8000;
  }
  const buffer = audioContext.createBuffer(1, float32.length, 16000);
  buffer.copyToChannel(float32, 0);
  const src = audioContext.createBufferSource();
  src.buffer = buffer;
  src.connect(audioContext.destination);
  src.start();
}
