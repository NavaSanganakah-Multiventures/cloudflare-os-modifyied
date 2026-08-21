import { useCallback, useEffect, useState } from 'react'
import { Button } from '@cloudflare/kumo'
import { Wallet, Brain, Plus } from '@phosphor-icons/react'
import { useAuthenticatedApi } from '../../AuthContext'
import { useServerConfig } from '../../ServerConfigContext'
import { DEFAULT_USD_TO_INR_RATE } from '@gadgets/workshop-shared/limits'
import { useWalletRecharge } from './useWalletRecharge'

const RUPEE = '\u20B9'

// Shows the user's wallet balance (the System AI meter) and a Razorpay recharge control on the
// profile page. Renders nothing unless the wallet/limits flow is enabled server-side.
export default function UsageSettings() {
  const serverConfig = useServerConfig()
  const limitsEnabled = serverConfig?.cloudflareLimitsEnabled ?? false
  const rate = serverConfig?.usdToInrRate ?? DEFAULT_USD_TO_INR_RATE
  const { authenticatedApi } = useAuthenticatedApi()
  const [balance, setBalance] = useState<number | null>(null)
  const [aiPref, setAiPref] = useState<'system' | 'custom'>('system')
  const [loading, setLoading] = useState(true)
  const [amount, setAmount] = useState('')
  const { recharge, loading: recharging, error, success } = useWalletRecharge(refresh)

  const refresh = useCallback(async () => {
    try {
      const [bal, pref] = await Promise.all([
        authenticatedApi.getWalletBalance(),
        authenticatedApi.getAiPreference(),
      ])
      setBalance(bal)
      setAiPref(pref)
    } catch (e) {
      console.error('Failed to load wallet data', e)
    } finally {
      setLoading(false)
    }
  }, [authenticatedApi])

  useEffect(() => {
    if (!limitsEnabled) { setLoading(false); return }
    refresh()
    const onFocus = () => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [limitsEnabled, refresh])

  if (!limitsEnabled) return null

  return (
    <section className="flex flex-col gap-3">
      <h2 className="px-1 text-[12px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
        Usage &amp; billing
      </h2>
      <div className="rounded-xl border border-kumo-line bg-kumo-base p-5">
        {loading || balance === null ? (
          <p className="text-sm text-kumo-subtle">Loading wallet…</p>
        ) : (
          <div className="space-y-6">
            <div>
              <p className="text-xs font-medium text-kumo-subtle mb-1">Wallet balance</p>
              <div className="flex items-center gap-2 text-sm text-kumo-default">
                <Wallet size={16} className="text-kumo-subtle" />
                <strong>{'$' + balance.toFixed(2)}</strong>
                <span className="text-kumo-subtle">({RUPEE}{(balance * rate).toFixed(2)})</span>
              </div>
            </div>

            <div>
              <p className="text-xs font-medium text-kumo-subtle mb-1">AI mode</p>
              <div className="flex items-center gap-2 text-sm text-kumo-default">
                <Brain size={16} className="text-kumo-brand" />
                {aiPref === 'system' ? 'System AI (billed to wallet)' : 'Custom AI (your own API keys)'}
              </div>
            </div>

            <p className="text-xs text-kumo-subtle">
              Each System AI request is billed at the model's real per-call cost (USD), deducted
              after it completes — so cheap models cost less and expensive ones more. Top up with
              Razorpay (INR) below.
            </p>

            <div className="pt-1">
              <div className="flex items-center gap-2 mb-1">
                <Plus size={14} className="text-kumo-brand" />
                <span className="text-xs font-medium text-kumo-default">Recharge wallet</span>
              </div>
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
                <Button variant="primary" size="sm" onClick={() => recharge(Number(amount))} loading={recharging}>
                  <Wallet size={14} weight="bold" className="mr-1" />
                  Pay
                </Button>
              </div>
              {amount && Number(amount) > 0 && (
                <p className="text-[11px] text-kumo-subtle mt-1">
                  {'~$' + (Number(amount) / rate).toFixed(2) + ' added to your wallet'}
                </p>
              )}
              {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
              {success && <p className="text-xs text-green-600 mt-1">Wallet recharged! Balance updated.</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  )
}
