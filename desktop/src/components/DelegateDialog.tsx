import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { delegateWorker, listDomains } from '../runtime/client'
import type { DomainEntry } from '../runtime/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// 派后台子代理：用户填任务 → 一键派单。子代理在隔离子会话后台跑,进度走
// delegation 面板;不阻塞主对话、不碰主历史(前缀缓存安全)。

// Labels/hints live in the `delegation` namespace under `profiles.<value>`.
const PROFILES: { value: string }[] = [
  { value: 'code_scout' },
  { value: 'doc_scout' },
  { value: 'planner' },
  { value: 'reviewer' },
  { value: 'verifier' },
  { value: 'patcher' },
]

export function DelegateDialog(props: {
  sessionId: string
  onClose: () => void
  onDispatched: (workerId: string) => void
}) {
  const { sessionId, onClose, onDispatched } = props
  const { t } = useTranslation('delegation')
  const [objective, setObjective] = useState('')
  const [profile, setProfile] = useState('code_scout')
  const [authority, setAuthority] = useState('')
  const [filesText, setFilesText] = useState('')
  const [domains, setDomains] = useState<DomainEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    listDomains(sessionId)
      .then((entries) => setDomains(entries.filter((e) => e.key !== 'auto')))
      .catch(() => setDomains([]))
  }, [sessionId])

  const submit = async () => {
    const obj = objective.trim()
    if (!obj || busy) return
    setBusy(true)
    setError(null)
    try {
      const files = filesText
        .split(/[,，\n]/)
        .map((f) => f.trim())
        .filter(Boolean)
      const { workerId } = await delegateWorker(sessionId, {
        objective: obj,
        profile,
        ...(authority ? { authority } : {}),
        ...(files.length ? { files } : {}),
      })
      onDispatched(workerId)
      onClose()
    } catch (e) {
      setError((e as Error)?.message ?? t('dialog.submitFailed'))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dialog.title')}</DialogTitle>
          <DialogDescription>{t('dialog.description')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">{t('dialog.objective')}</label>
            <Textarea
              autoFocus
              value={objective}
              onChange={(e) => setObjective(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit() } }}
              placeholder={t('dialog.objectivePlaceholder')}
              className="min-h-[88px] resize-none"
            />
          </div>

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">{t('dialog.role')}</label>
            <div className="flex flex-wrap gap-1.5">
              {PROFILES.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  title={t(`profiles.${p.value}.hint`)}
                  onClick={() => setProfile(p.value)}
                  className={`rounded border px-2.5 py-1 text-xs transition-colors ${
                    profile === p.value
                      ? 'border-accent bg-accent/10 text-text'
                      : 'border-border text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {t(`profiles.${p.value}.label`)}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-muted-foreground">{t(`profiles.${profile}.hint`)}</p>
          </div>

          {domains.length > 0 && (
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">{t('dialog.domain')}</label>
              <select
                value={authority}
                onChange={(e) => setAuthority(e.target.value)}
                className="h-8 rounded border border-border bg-transparent px-2 text-sm"
              >
                <option value="">{t('dialog.domainNone')}</option>
                {domains.map((d) => (
                  <option key={d.key} value={d.key}>{d.name}</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid gap-1.5">
            <label className="text-xs text-muted-foreground">{t('dialog.files')}</label>
            <Input
              value={filesText}
              onChange={(e) => setFilesText(e.target.value)}
              placeholder="src/auth/login.ts, src/api/sms.ts"
              className="font-mono text-xs"
            />
          </div>

          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={busy}>{t('dialog.cancel')}</Button>
          <Button onClick={() => void submit()} disabled={busy || !objective.trim()}>
            {busy ? t('dialog.submitting') : t('dialog.submit')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
