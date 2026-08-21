import { useState, useCallback } from 'react'
import { useAuthenticatedApi } from '../../AuthContext'

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

// Shared Razorpay wallet-recharge hook. Creates an order, opens the Razorpay checkout, verifies
// the payment (crediting the wallet in USD server-side), then calls onSuccess so the caller can
// refresh its displayed balance.
export function useWalletRecharge(onSuccess?: () => void) {
  const { authenticatedApi } = useAuthenticatedApi()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const recharge = useCallback(async (amountRupee: number) => {
    if (!Number.isFinite(amountRupee) || amountRupee < 1) {
      setError('Minimum recharge amount is 1 INR')
      return
    }
    setLoading(true)
    setError(null)
    setSuccess(false)
    try {
      const order = await authenticatedApi.createRazorpayOrder(amountRupee)
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
              response.razorpay_signature,
            )
            setSuccess(true)
            onSuccess?.()
          } catch (e) {
            console.error('Payment verification failed', e)
            setError('Payment verification failed. Please contact support.')
          }
        },
        theme: { color: '#F6461D' },
      })
      rzp.open()
    } catch (e) {
      console.error('Recharge failed', e)
      setError((e as Error).message || 'Recharge failed')
    } finally {
      setLoading(false)
    }
  }, [authenticatedApi, onSuccess])

  return { recharge, loading, error, success }
}
