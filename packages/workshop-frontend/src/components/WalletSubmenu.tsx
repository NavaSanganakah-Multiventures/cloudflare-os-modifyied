import { useState, useEffect } from 'react'
import { DropdownMenu } from '@cloudflare/kumo'
import { useAuthenticatedApi } from '../AuthContext'
import { MENU_CONTENT, MENU_ITEM, MENU_POSITIONER_STYLE } from './menuStyles'
import { Brain, Wallet } from '@phosphor-icons/react'

export default function WalletSubmenu() {
  const { authenticatedApi } = useAuthenticatedApi()
  const [balance, setBalance] = useState<number | null>(null)
  const [aiPref, setAiPref] = useState<'system' | 'custom'>('system')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadData() {
      try {
        const [bal, pref] = await Promise.all([
          authenticatedApi.getWalletBalance(),
          authenticatedApi.getAiPreference()
        ])
        setBalance(bal)
        setAiPref(pref)
      } catch (e) {
        console.error("Failed to load wallet data", e)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [authenticatedApi])

  const handleSelect = async (pref: 'system' | 'custom') => {
    setAiPref(pref)
    try {
      await authenticatedApi.setAiPreference(pref)
    } catch (e) {
      console.error("Failed to set AI preference", e)
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
            Balance: <span className="text-kumo-default">${balance?.toFixed(2) ?? '0.00'}</span>
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
      </DropdownMenu.Content>
    </DropdownMenu>
  )
}
