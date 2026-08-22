import { useState, useEffect, useCallback } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import { useServerConfig } from '../ServerConfigContext'
import { DEFAULT_USD_TO_INR_RATE } from '@gadgets/workshop-shared/limits'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from './menuStyles'
import { Brain, Wallet, Plus } from '@phosphor-icons/react'

function loadRazorpayScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    if ((window as any).Razorpay) return resolve()
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.async = true
    script.addEventListener('load', () => resolve())
    script.addEventListener('error', () => reject(new Error('Failed to load Razorpay checkout')))
    document.body.appendChild(script)
  })
}

export default function WalletSubmenu() {
  const { authenticatedApi } = useAuthenticatedApi()
  const serverConfig = useServerConfig()
  const rate = serverConfig?.usdToInrRate ?? DEFAULT_USD_TO_INR_RATE
  const [balance, setBalance] = useState<number | null>(null)
  const [aiPref, setAiPref] = useState<'system' | 'custom'>('system')
  const [loading, setLoading] = useState(true)
  const [rechargeAmount, setRechargeAmount] = useState('')
  const [rechargeLoading, setRechargeLoading] = useState(false)
  const [rechargeError, setRechargeError] = useState<string | null>(null)
  const [rechargeSuccess, setRechargeSuccess] = useState(false)

  const loadData = useCallback(async () => {
    try {
      const [bal, pref] = await Promise.all([
        authenticatedApi.getWalletBalance(),
        authenticatedApi.getAiPreference()
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
    loadData()
  }, [loadData])

  const handleSelect = async (pref: 'system' | 'custom') => {
    const previous = aiPref
    setAiPref(pref)
    try {
      await authenticatedApi.setAiPreference(pref)
    } catch (e) {
      console.error('Failed to set AI preference', e)
      setAiPref(previous)
    }
  }

  const handleRecharge = async () => {
    const amount = Number(rechargeAmount)
    if (!Number.isFinite(amount) || amount < 1) {
      setRechargeError('Minimum recharge amount is 1 INR')
      return
    }
    setRechargeLoading(true)
    setRechargeError(null)
    setRechargeSuccess(false)
    try {
      const order = await authenticatedApi.createRazorpayOrder(amount)
      await loadRazorpayScript()
      const rzp = new (window as any).Razorpay({
        key: order.keyId,
        amount: order.amount,
        currency: order.currency,
        order_id: order.orderId,
        name: 'Cloudflare OS',
        description: 'Wallet recharge',
        handler: async (response: any) => {
          try {
            await authenticatedApi.verifyRazorpayPayment(
              response.razorpay_order_id,
              response.razorpay_payment_id,
              response.razorpay_signature
            )
            await loadData()
            setRechargeAmount('')
            setRechargeError(null)
            setRechargeSuccess(true)
            setTimeout(() => setRechargeSuccess(false), 3000)
          } catch (e) {
            console.error('Payment verification failed', e)
            setRechargeError('Payment verification failed. Please contact support.')
          }
        },
        theme: { color: '#F6461D' }
      })
      rzp.open()
    } catch (e) {
      console.error('Recharge failed', e)
      setRechargeError((e as Error).message || 'Recharge failed')
    } finally {
      setRechargeLoading(false)
    }
  }

  if (loading) return null

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <button
            className="flex items-center gap-1.5 h-8 px-2 cursor-pointer rounded-md text-sm font-medium transition-colors bg-kumo-elevated border border-kumo-line hover:border-kumo-strong hover:bg-kumo-tint text-kumo-default"
            title="AI Configuration"
          >
            <Brain size={16} className="text-kumo-brand" />
            <span className="hidden sm:inline">
              {aiPref === 'system' ? 'System AI' : 'Custom AI'}
            </span>
          </button>
        }
      />
      <DropdownMenu.Content className={MENU_CONTENT} style={MENU_POSITIONER_STYLE}>
        <div className="px-3 py-2 border-b border-kumo-line mb-1 flex items-center gap-2">
          <Wallet size={16} className="text-kumo-subtle" />
          <span className="text-sm text-kumo-subtle font-medium">
            Balance:{' '}
            <span className="text-kumo-default">
              ${balance != null ? balance.toFixed(2) : '0.00'}
              <span className="text-kumo-subtle"> (₹{((balance ?? 0) * rate).toFixed(2)})</span>
            </span>
          </span>
        </div>
        <DropdownMenu.Item
          onClick={() => handleSelect('system')}
          className={`${MENU_ITEM} flex items-center justify-between`}
        >
          <span>Use System AI (Wallet)</span>
          {aiPref === 'system' && <span className="text-kumo-brand">â</span>}
        </DropdownMenu.Item>
        <DropdownMenu.Item
          onClick={() => handleSelect('custom')}
          className={`${MENU_ITEM} flex items-center justify-between`}
        >
          <span>Use My Custom AI (BYOK)</span>
          {aiPref === 'custom' && <span className="text-kumo-brand">â</span>}
        </DropdownMenu.Item>

        <div className="border-t border-kumo-line mt-1 pt-2 px-3 py-2">
          <div className="flex items-center gap-2 mb-2">
            <Plus size={14} className="text-kumo-brand" />
            <span className="text-xs font-medium text-kumo-default">Recharge wallet</span>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              step={1}
              placeholder="INR"
              value={rechargeAmount}
              onChange={(e) => setRechargeAmount(e.target.value)}
              className="w-20 h-7 px-2 text-sm bg-kumo-elevated border border-kumo-line rounded focus:border-kumo-brand outline-none"
            />
            <button
              onClick={handleRecharge}
              disabled={rechargeLoading}
              className="h-7 px-2 text-xs font-medium rounded bg-kumo-brand text-white disabled:opacity-50"
            >
              {rechargeLoading ? '...' : 'Pay'}
            </button>
          </div>
          {rechargeAmount && Number(rechargeAmount) > 0 && (
            <p className="text-[11px] text-kumo-subtle mt-1">
              Adds ~${(Number(rechargeAmount) / rate).toFixed(2)} to your wallet
            </p>
          )}
          {rechargeError && (
            <p className="text-xs text-red-500 mt-1 max-w-[200px]">{rechargeError}</p>
          )}
          {rechargeSuccess && (
            <p className="text-xs text-green-600 mt-1">Wallet recharged! Balance updated.</p>
          )}
        </div>
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
