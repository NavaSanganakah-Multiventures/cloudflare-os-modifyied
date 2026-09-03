import { useState, useRef, useCallback, useEffect } from 'react'
import { useAuthenticatedApi } from './AuthContext'
import {
  aryaVoiceWsUrl,
  connectAryaVoice,
  createMicCapture,
  playPcm16Audio,
} from './arya-voice'
import { Microphone, X, Phone, PhoneSlash, SpeakerHigh } from '@phosphor-icons/react'

interface TranscriptEntry {
  role: 'user' | 'assistant'
  text: string
}

/** Floating voice panel: connects to the Arya WebSocket, captures mic audio (push-to-talk),
 *  plays AI audio, and shows live transcripts and status. */
export function AryaVoicePanel() {
  const { authenticatedApi } = useAuthenticatedApi()
  const [open, setOpen] = useState(false)
  const [connected, setConnected] = useState(false)
  const [aiState, setAiState] = useState('off')
  const [aiBackend, setAiBackend] = useState<string | undefined>(undefined)
  const [transcripts, setTranscripts] = useState<TranscriptEntry[]>([])
  const [talking, setTalking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const micRef = useRef<{ stop: () => void } | null>(null)
  const playbackRef = useRef<AudioContext | null>(null)

  const handleConnect = useCallback(async () => {
    setError(null)
    setTranscripts([])
    try {
      const callId = crypto.randomUUID()
      const token = await authenticatedApi.mintAryaVoiceToken(callId)
      const wsUrl = aryaVoiceWsUrl(window.location.origin, callId, token)

      if (!playbackRef.current) {
        playbackRef.current = new AudioContext({ sampleRate: 16000 })
      }

      const ws = connectAryaVoice(wsUrl, {
        onStatus: (state, backend, detail) => {
          setAiState(state)
          if (backend) setAiBackend(backend)
          if (state === 'error' && detail) setError(detail)
        },
        onTranscript: (role, text, _final) => {
          setTranscripts((prev) => [...prev, { role, text }])
        },
        onAudio: (audio) => {
          if (playbackRef.current) {
            playPcm16Audio(audio, playbackRef.current)
          }
        },
        onPeerEvent: (_msg) => {
          // Ring/accept/reject/hangup handling reserved for future PRs.
        },
      })

      ws.addEventListener('open', () => setConnected(true))
      ws.addEventListener('close', () => {
        setConnected(false)
        setAiState('off')
      })
      ws.addEventListener('error', () => {
        setError('Connection error')
        setConnected(false)
      })

      wsRef.current = ws
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect')
    }
  }, [authenticatedApi])

  const handleDisconnect = useCallback(() => {
    if (micRef.current) {
      micRef.current.stop()
      micRef.current = null
    }
    setTalking(false)
    if (wsRef.current) {
      try {
        wsRef.current.send(JSON.stringify({ type: 'hangup' }))
      } catch {
        // Already closed.
      }
      wsRef.current.close()
      wsRef.current = null
    }
    setConnected(false)
    setAiState('off')
    setTranscripts([])
  }, [])

  const handleStartTalk = useCallback(async () => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return
    try {
      const mic = await createMicCapture((chunk) => {
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(chunk)
        }
      })
      micRef.current = mic
      setTalking(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to access microphone')
    }
  }, [])

  const handleStopTalk = useCallback(() => {
    if (micRef.current) {
      micRef.current.stop()
      micRef.current = null
    }
    setTalking(false)
  }, [])

  const handleStartAi = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'ai-command', action: 'start' }))
    }
  }, [])

  const handleStopAi = useCallback(() => {
    if (wsRef.current && wsRef.current.readyState !== WebSocket.OPEN) return
    wsRef.current.send(JSON.stringify({ type: 'ai-command', action: 'stop' }))
  }, [])

  useEffect(() => {
    return () => {
      handleDisconnect()
      if (playbackRef.current) {
        playbackRef.current.close()
        playbackRef.current = null
      }
    }
  }, [handleDisconnect])

  return (
    <>
      <button
        onClick={() => setOpen((o) => !o)}
        className="press fixed bottom-6 right-6 z-50 grid h-12 w-12 cursor-pointer place-items-center rounded-full bg-kumo-brand text-white shadow-lg transition-colors hover:bg-kumo-brand-hover"
        aria-label="Toggle Arya voice panel"
      >
        <Microphone size={22} />
      </button>

      {open && (
        <div className="fixed bottom-20 right-6 z-50 flex h-[420px] w-80 flex-col rounded-xl border border-kumo-line bg-kumo-base shadow-xl">
          <div className="flex items-center justify-between border-b border-kumo-line px-4 py-3">
            <div className="flex items-center gap-2">
              <Microphone size={16} className="text-kumo-brand" />
              <span className="text-[14px] font-medium text-kumo-default">Arya Voice</span>
              {aiBackend && (
                <span className="rounded-md bg-kumo-tint px-1.5 py-0.5 text-[10px] font-medium text-kumo-subtle">
                  {aiBackend === 'gemini' ? 'Gemini' : 'Workers AI'}
                </span>
              )}
            </div>
            <button onClick={() => setOpen(false)} className="text-kumo-inactive hover:text-kumo-default" aria-label="Close">
              <X size={16} />
            </button>
          </div>

          <div className="flex items-center gap-2 px-4 py-2">
            <div className={'h-2 w-2 rounded-full ' + (aiState === 'listening' ? 'bg-green-500' : aiState === 'error' ? 'bg-red-500' : 'bg-kumo-inactive')} />
            <span className={'text-[12px] ' + (aiState === 'listening' ? 'text-green-500' : aiState === 'error' ? 'text-red-500' : 'text-kumo-inactive')}>{aiState}</span>
            {error && <span className="text-[12px] text-red-500">{error}</span>}
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-2">
            {transcripts.length === 0 ? (
              <p className="text-[13px] text-kumo-inactive">No conversation yet. Connect and press Talk to start.</p>
            ) : (
              <div className="flex flex-col gap-2">
                {transcripts.map((t, i) => (
                  <div key={i} className={'text-[13px] ' + (t.role === 'assistant' ? 'text-kumo-default' : 'text-kumo-subtle')}>
                    <span className="font-medium">{t.role === 'assistant' ? 'Arya' : 'You'}: </span>
                    {t.text}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="flex flex-col gap-2 border-t border-kumo-line px-4 py-3">
            {!connected ? (
              <button
                onClick={handleConnect}
                className="press inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium text-white transition-colors hover:bg-kumo-brand-hover"
              >
                <Phone size={14} weight="bold" />
                Connect
              </button>
            ) : (
              <>
                <div className="flex gap-2">
                  <button
                    onMouseDown={() => void handleStartTalk()}
                    onMouseUp={handleStopTalk}
                    onTouchStart={() => void handleStartTalk()}
                    onTouchEnd={handleStopTalk}
                    disabled={aiState !== 'listening'}
                    className={'press inline-flex h-9 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium text-white transition-colors disabled:opacity-50 ' + (talking ? 'bg-red-500' : 'bg-kumo-brand')}
                  >
                    <Microphone size={14} weight="bold" />
                    {talking ? 'Release' : 'Talk'}
                  </button>
                  <button
                    onClick={handleDisconnect}
                    className="press inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-kumo-line px-3 text-[13px] font-medium text-kumo-subtle transition-colors hover:bg-kumo-tint"
                  >
                    <PhoneSlash size={14} />
                  </button>
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={handleStartAi}
                    disabled={aiState === 'listening'}
                    className="press inline-flex h-8 flex-1 cursor-pointer items-center justify-center gap-1 rounded-lg border border-kumo-line text-[12px] text-kumo-subtle transition-colors hover:bg-kumo-tint disabled:opacity-50"
                  >
                    <SpeakerHigh size={12} />
                    Start AI
                  </button>
                  <button
                    onClick={handleStopAi}
                    disabled={aiState === 'off'}
                    className="press inline-flex h-8 flex-1 cursor-pointer items-center justify-center gap-1 rounded-lg border border-kumo-line text-[12px] text-kumo-subtle transition-colors hover:bg-kumo-tint disabled:opacity-50"
                  >
                    Stop AI
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
