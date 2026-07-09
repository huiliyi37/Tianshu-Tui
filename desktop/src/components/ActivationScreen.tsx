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
 * Full-screen, non-dismissable activation gate. Shown when the local license is
 * missing/expired/revoked. The real enforcement is in Rust (the sidecar is not
 * spawned when unactivated) — this is purely the redemption UI. On success the
 * app relaunches so setup()'s gate spawns the runtime.
 */
export function ActivationScreen({ status }: { status: ActivationStatus }) {
  const { t } = useTranslation('shell')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  const revoked = status.reason === 'license_expired' || status.reason === 'token_expired'

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

  const shortDevice =
    status.deviceId.length > 20 ? `${status.deviceId.slice(0, 12)}…${status.deviceId.slice(-6)}` : status.deviceId

  return (
    <Dialog open onOpenChange={() => { /* cannot dismiss the activation gate */ }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('activation.title')}</DialogTitle>
          <DialogDescription>{t('activation.subtitle')}</DialogDescription>
        </DialogHeader>

        {revoked && (
          <div className="banner error" style={{ marginBottom: 8 }}>
            {t('activation.revoked', { reason: status.reason })}
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
            <span title={status.deviceId}>
              {t('activation.deviceLabel')}: <span className="font-mono">{shortDevice}</span>
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
