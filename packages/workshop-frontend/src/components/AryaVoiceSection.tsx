import { useKumoToastManager } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import { useState, useEffect } from 'react'
import type { ReactNode } from 'react'
import { Check, Trash, Eye, EyeSlash } from '@phosphor-icons/react'

const PRIMARY_BTN =
  'press inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover disabled:cursor-not-allowed disabled:opacity-60'
const INPUT =
  'h-9 w-full rounded-lg border border-kumo-line bg-kumo-base px-3 text-[14px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15'

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
      {children}
    </h2>
  )
}

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[12px] font-medium tracking-[-0.1px] text-kumo-subtle">{children}</p>
  )
}

export default function AryaVoiceSection() {
  const { authenticatedApi } = useAuthenticatedApi()
  const toasts = useKumoToastManager()
  const [keyStatus, setKeyStatus] = useState<{ set: boolean; masked: string | null } | null>(null)
  const [keyInput, setKeyInput] = useState('')
  const [show, setShow] = useState(false)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.getAryaGeminiKeyStatus()
      .then((status) => { if (!cancelled) setKeyStatus(status) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [authenticatedApi])

  const handleSave = async () => {
    if (!keyInput.trim()) return
    setSaving(true)
    try {
      await authenticatedApi.setAryaGeminiKey(keyInput.trim())
      setKeyInput('')
      const status = await authenticatedApi.getAryaGeminiKeyStatus()
      setKeyStatus(status)
      toasts.add({ title: 'Gemini API key saved', variant: 'success' })
    } catch {
      toasts.add({ title: 'Failed to save Gemini API key', variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const handleClear = async () => {
    setSaving(true)
    try {
      await authenticatedApi.clearAryaGeminiKey()
      setKeyInput('')
      setKeyStatus({ set: false, masked: null })
      toasts.add({ title: 'Gemini API key removed', variant: 'success' })
    } catch {
      toasts.add({ title: 'Failed to remove Gemini API key', variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>Arya Voice</SectionLabel>
      <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
        <div className="flex max-w-sm flex-col gap-4">
          <div>
            <FieldLabel>Gemini API Key</FieldLabel>
            {keyStatus?.set ? (
              <p className="mt-1 text-[14px] tracking-[-0.25px] text-kumo-subtle">
                Key set: <span className="font-mono text-[13px]">{keyStatus.masked}</span>
              </p>
            ) : (
              <p className="mt-1 text-[13px] text-kumo-subtle">
                No key configured — Arya will use the Workers AI fallback.
              </p>
            )}
          </div>

          <div className="relative">
            <input
              type={show ? 'text' : 'password'}
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              placeholder="Enter Gemini API key"
              className={INPUT + ' pr-10'}
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              aria-label={show ? 'Hide key' : 'Show key'}
              className="absolute right-1.5 top-1/2 grid h-7 w-7 -translate-y-1/2 cursor-pointer place-items-center rounded-md text-kumo-inactive transition-colors hover:text-kumo-default"
            >
              {show ? <EyeSlash size={15} /> : <Eye size={15} />}
            </button>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || !keyInput.trim()}
              className={PRIMARY_BTN}
            >
              <Check size={14} weight="bold" />
              {saving ? 'Saving…' : 'Save key'}
            </button>
            {keyStatus?.set && (
              <button
                type="button"
                onClick={handleClear}
                disabled={saving}
                className="press inline-flex h-9 cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-kumo-line px-3 text-[13px] font-medium text-kumo-subtle transition-colors hover:bg-kumo-tint disabled:opacity-60"
              >
                <Trash size={14} />
                Remove
              </button>
            )}
          </div>

          <p className="text-[12px] leading-4 tracking-[-0.1px] text-kumo-subtle">
            Your Gemini API key powers the real-time voice AI. It is stored securely and never sent back to the browser.
          </p>
        </div>
      </div>
    </section>
  )
}
