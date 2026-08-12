import { useEffect, useState } from 'react'
import { Dialog, Textarea, useKumoToastManager } from '@cloudflare/kumo'
import { X } from '@phosphor-icons/react'
import type { RpcStub, Overseer, GadgetMetadata } from '@gadgets/workshop-shared/api'
import { MAX_WORKSPACE_INSTRUCTIONS_LENGTH } from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from './WorkshopControls'

interface WorkspaceSettingsModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  overseer: RpcStub<Overseer> | null
  metadata: GadgetMetadata | null
}

export default function WorkspaceSettingsModal({
  open,
  onOpenChange,
  overseer,
  metadata,
}: WorkspaceSettingsModalProps) {
  const toasts = useKumoToastManager()
  const [instructionsDraft, setInstructionsDraft] = useState('')
  const [savedInstructions, setSavedInstructions] = useState('')
  const [saving, setSaving] = useState(false)

  // Sync the draft with the workspace metadata whenever the modal opens.
  useEffect(() => {
    if (open) {
      const value = metadata?.workspaceInstructions ?? ''
      setInstructionsDraft(value)
      setSavedInstructions(value)
    }
  }, [open, metadata?.workspaceInstructions])

  const handleSave = async () => {
    if (!overseer) return
    setSaving(true)
    try {
      await overseer.setWorkspaceInstructions(instructionsDraft)
      setSavedInstructions(instructionsDraft)
      toasts.add({ title: 'Workspace agent instructions saved', variant: 'success' })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to save instructions'
      toasts.add({ title: message, variant: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const tooLong = instructionsDraft.length > MAX_WORKSPACE_INSTRUCTIONS_LENGTH

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving) onOpenChange(nextOpen)
      }}
    >
      <Dialog
        className="!z-[1000] !w-[min(560px,calc(100vw-32px))] overflow-hidden bg-kumo-base p-0 !top-[15%] !-translate-y-0"
        size="sm"
      >
        <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="text-[15px] leading-5 font-medium tracking-[-0.3px] text-kumo-default">
              Workspace settings
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[12px] leading-4 font-normal tracking-[-0.2px] text-kumo-subtle">
              Customize how the agent behaves in this workspace. These instructions are added to the
              agent&rsquo;s system prompt in addition to the deployment-wide instructions.
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton
                {...props}
                className="!h-7 !w-7"
                disabled={saving}
                aria-label="Close"
              >
                <X size={16} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div className="flex flex-col gap-3 px-5 py-4">
          <div>
            <p className="text-[12px] font-medium tracking-[-0.1px] text-kumo-subtle">
              Agent instructions
            </p>
            <p className="mt-0.5 text-[12px] tracking-[-0.1px] text-kumo-inactive">
              Use this for workspace-specific context, conventions, or guardrails. Leave empty to use
              only the deployment-wide instructions.
            </p>
            <div className="mt-2">
              <Textarea
                className="w-full"
                value={instructionsDraft}
                onValueChange={setInstructionsDraft}
                rows={6}
                placeholder={'e.g. This workspace is for the marketing team. Always use brand voice\nin copy and prefer the company style guide for formatting.'}
                maxLength={MAX_WORKSPACE_INSTRUCTIONS_LENGTH}
                error={
                  tooLong
                    ? `Too long by ${instructionsDraft.length - MAX_WORKSPACE_INSTRUCTIONS_LENGTH} characters`
                    : undefined
                }
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-t border-kumo-line bg-kumo-base px-5 py-3">
          <span className="text-[11px] text-kumo-subtle">
            {instructionsDraft.length.toLocaleString()} / {MAX_WORKSPACE_INSTRUCTIONS_LENGTH.toLocaleString()} characters
          </span>
          <div className="flex items-center gap-2">
            {instructionsDraft !== savedInstructions && (
              <WorkshopButton
                onClick={() => setInstructionsDraft(savedInstructions)}
                disabled={saving}
                className="!h-9"
              >
                Reset
              </WorkshopButton>
            )}
            <WorkshopButton
              tone="primary"
              onClick={handleSave}
              loading={saving}
              disabled={
                instructionsDraft === savedInstructions || tooLong
              }
              className="!h-9 min-w-[64px]"
            >
              Save
            </WorkshopButton>
          </div>
        </div>
      </Dialog>
    </Dialog.Root>
  )
}
