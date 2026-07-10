import { useState } from 'react'
import { relaunch } from '@tauri-apps/plugin-process'
import { useTranslation } from 'react-i18next'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { activateWithCode, type ActivationStatus } from '../runtime/client'
import { openEula } from '../lib/open-external'

const KNOWN_ERRORS = new Set([
  'code_not_found',
  'code_revoked',
  'license_expired',
  'activation_limit_reached',
  'activation_revoked',
  'invalid_code_format',
  'device_mismatch',
  'no_token',
])

/**
 * Pro 升级弹窗（双层模式）：可随时关闭，从 设置 → 关于与许可 打开。
 * 输入许可证码 → 前端调授权服务器换 token → Rust Ed25519 验签落盘。
 * 成功后 relaunch，让 spawn_sidecar 按新许可证注入 RIVET_PRO 解锁 Pro 功能。
 * Basic 不需要此弹窗——应用免许可证即用。
 */
export function ProUpgradeDialog({
  status,
  open,
  onOpenChange,
}: {
  status: ActivationStatus | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useTranslation('shell')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const expired = status != null && (status.reason === 'license_expired' || status.reason === 'token_expired')

  const resolveError = (raw: string): string => {
    if (raw === 'Failed to fetch' || raw.toLowerCase().includes('fetch')) {
      return t('activation.errors.network')
    }
    if (KNOWN_ERRORS.has(raw)) return t(`activation.errors.${raw}`)
    return t('activation.errors.generic', { reason: raw })
  }

  const handleActivate = async () => {
    if (!code.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const next = await activateWithCode(code)
      if (next.activated) {
        setDone(true)
        setTimeout(() => {
          void relaunch().catch(() => window.location.reload())
        }, 900)
      } else {
        setError(resolveError(next.reason))
      }
    } catch (e) {
      setError(resolveError((e as Error).message))
    } finally {
      setBusy(false)
    }
  }

  const deviceId = status?.deviceId ?? ''
  const shortDevice = deviceId.length > 20 ? `${deviceId.slice(0, 12)}…${deviceId.slice(-6)}` : deviceId

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy && !done) onOpenChange(next) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('activation.title')}</DialogTitle>
          <DialogDescription>{t('activation.subtitle')}</DialogDescription>
        </DialogHeader>

        {expired && (
          <div className="banner error" style={{ marginBottom: 8 }}>
            {t('activation.revoked', { reason: status?.reason })}
          </div>
        )}

        <div className="flex flex-col gap-3">
          <label className="text-xs text-muted">{t('activation.codeLabel')}</label>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder={t('activation.codePlaceholder')}
            autoFocus
            spellCheck={false}
            disabled={busy || done}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleActivate() }}
          />

          {error && <div className="text-xs text-destructive">{error}</div>}
          {done && <div className="text-xs text-emerald-500">{t('activation.success')}</div>}

          <Button onClick={() => void handleActivate()} disabled={busy || done || !code.trim()}>
            {busy ? t('activation.activating') : t('activation.activate')}
          </Button>

          <div className="flex items-center justify-between text-[11px] text-muted mt-1">
            <span title={deviceId}>
              {t('activation.deviceLabel')}: <span className="font-mono">{shortDevice || '—'}</span>
            </span>
            <button
              type="button"
              className="underline hover:text-text"
              onClick={() => { void openEula() }}
            >
              {t('activation.viewEula')}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
