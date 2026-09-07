import { useCallback, useEffect, useState } from 'react'
import { Dialog, Button, Loader } from '@cloudflare/kumo'
import { CloudWarning, Wallet } from '@phosphor-icons/react'
import { useOptionalAuthenticatedApi } from '../../AuthContext'
import { useServerConfig } from '../../ServerConfigContext'
import { DEFAULT_USD_TO_INR_RATE } from '@gadgets/workshop-shared/limits'
import { useWalletRecharge } from './useWalletRecharge'

const RUPEE = '\u20B9'

interface OutOfCreditsModalProps {
  open: boolean
  onClose: () => void
}

// Modal shown from the chat when a System AI turn is blocked because the wallet balance is too
// low. Lets the user recharge via Razorpay, or switch to Custom AI (BYOK) from the top bar.
export default function OutOfCreditsModal({ open, onClose }: OutOfCreditsModalProps) {
  const auth = useOptionalAuthenticatedApi()
  const serverConfig = useServerConfig()
  const rate = serverConfig?.usdToInrRate ?? DEFAULT_USD_TO_INR_RATE
  const [balance, setBalance] = useState<number | null>(null)
  const [aiPref, setAiPref] = useState<'system' | 'custom'>('system')
  const [amount, setAmount] = useState('')

  const refresh = useCallback(() => {
    if (!auth) return
    Promise.all([auth.authenticatedApi.getWalletBalance(), auth.authenticatedApi.getAiPreference()])
      .then(([bal, pref]) => { setBalance(bal); setAiPref(pref) })
      .catch(() => {})
  }, [auth])

  const { recharge, loading, error, success } = useWalletRecharge(refresh)

  useEffect(() => {
    if (open && auth) { setBalance(null); refresh() }
  }, [open, auth, refresh])

  const recharged = success && balance !== null && balance > 0

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog className="p-6 sm:w-[520px]" size="base">
        <Dialog.Title className="text-lg font-semibold mb-2 flex items-center gap-2">
          <CloudWarning size={22} weight="bold" className="text-kumo-warning" />
          Your wallet balance is too low
        </Dialog.Title>

        {balance === null ? (
          <div className="flex justify-center py-8"><Loader size="base" /></div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-kumo-default">
              <Wallet size={16} className="text-kumo-subtle" />
              <strong>{'$' + balance.toFixed(2)}</strong>
              <span className="text-kumo-subtle">({RUPEE}{(balance * rate).toFixed(2)})</span>
            </div>

            <p className="text-sm text-kumo-subtle">
              System AI needs wallet credit to run. Recharge below (INR via Razorpay) to continue,
              or switch to Custom AI (BYOK) in the top bar to use your own API keys.
            </p>

            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                step={1}
                placeholder="INR"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-24 h-8 px-2 text-sm bg-kumo-elevated border border-kumo-line rounded focus:border-kumo-brand outline-none"
              />
              <Button variant="primary" size="sm" onClick={() => recharge(Number(amount))} loading={loading}>
                <Wallet size={14} weight="bold" className="mr-1" />
                Recharge
              </Button>
            </div>
            {amount && Number(amount) > 0 && (
              <p className="text-[11px] text-kumo-subtle">
                {'~$' + (Number(amount) / rate).toFixed(2) + ' added to your wallet'}
              </p>
            )}
            {error && <p className="text-xs text-red-500">{error}</p>}
            {recharged && <p className="text-xs text-green-600">Wallet recharged! You can continue.</p>}

            <div className="flex items-center justify-end gap-2 pt-2">
              <Button variant="secondary" onClick={onClose}>
                {aiPref === 'system' ? 'Maybe later' : 'Close'}
              </Button>
              {recharged && <Button variant="primary" onClick={onClose}>Continue</Button>}
            </div>
          </div>
        )}
      </Dialog>
    </Dialog.Root>
  )
}
