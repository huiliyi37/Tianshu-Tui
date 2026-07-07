import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation, Trans } from 'react-i18next'
import type { TFunction } from 'i18next'
import { toast } from 'sonner'
import { useConfigProviders, qk } from '../state/queries'
import {
  setupConfigProvider,
  setProviderKey,
  setProviderAsDefault,
  type ProviderListItem,
} from '../runtime/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

// 引导式「连接模型服务商」向导，对齐命令行端 /connect：
//   1) 选内置服务商（或已配置但缺 Key 的）→ 填 API Key → 完成
//   2) 自定义 OpenAI 兼容服务商 → 名称/地址/模型/Key → 完成
// 复用后端 /config/providers 接口，不改主历史、不碰会话，安全。

type View = 'pick' | 'key' | 'custom'

/** 「填 Key」这一步的目标：要么给已存在的服务商补 Key，要么用内置预设新建。 */
interface KeyTarget {
  kind: 'existing' | 'preset'
  name: string
  label: string
  modelHint?: string
}

function isValidKey(v: string, t: TFunction<'onboarding'>): string | null {
  const trimmed = v.trim()
  if (!trimmed) return t('connect.keyEmpty')
  if (trimmed.length < 4) return t('connect.keyTooShort')
  return null
}

export function ConnectWizard({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation('onboarding')
  const { data, isLoading, isError } = useConfigProviders()
  const qc = useQueryClient()
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: qk.configProviders })
    void qc.invalidateQueries({ queryKey: qk.health })
  }

  const [view, setView] = useState<View>('pick')
  const [target, setTarget] = useState<KeyTarget | null>(null)
  const [apiKey, setApiKey] = useState('')
  const [makeDefault, setMakeDefault] = useState(true)
  const [keyErr, setKeyErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // 已配置但缺 Key 的服务商排在最前（首次启动最常见的就是默认 deepseek 缺 Key）。
  const needKey = useMemo(
    () => (data?.providers ?? []).filter((p) => p.keyStatus.source === 'none'),
    [data],
  )
  const ready = useMemo(
    () => (data?.providers ?? []).filter((p) => p.keyStatus.source !== 'none'),
    [data],
  )

  const gotoKey = (t: KeyTarget) => {
    setTarget(t)
    setApiKey('')
    setKeyErr(null)
    setMakeDefault(true)
    setView('key')
  }

  const submitKey = async () => {
    if (!target || busy) return
    const err = isValidKey(apiKey, t)
    if (err) { setKeyErr(err); return }
    setBusy(true)
    try {
      if (target.kind === 'preset') {
        await setupConfigProvider({ providerName: target.name, apiKey: apiKey.trim(), makeDefault })
      } else {
        await setProviderKey(target.name, { apiKey: apiKey.trim() })
        if (makeDefault) await setProviderAsDefault(target.name)
      }
      refresh()
      toast.success(t('connect.connected', { label: target.label, suffix: makeDefault ? t('connect.connectedDefaultSuffix') : '' }))
      onClose()
    } catch (e) {
      setKeyErr((e as Error)?.message ?? t('connect.connectFailed'))
      setBusy(false)
    }
  }

  const quickDefault = async (p: ProviderListItem) => {
    if (busy) return
    setBusy(true)
    try {
      await setProviderAsDefault(p.name)
      refresh()
      toast.success(t('connect.switchedDefault', { label: p.label }))
      onClose()
    } catch (e) {
      toast.error(t('connect.setDefaultFailed', { error: (e as Error).message }))
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {view === 'pick' && t('connect.titlePick')}
            {view === 'key' && t('connect.titleKey', { label: target?.label ?? '' })}
            {view === 'custom' && t('connect.titleCustom')}
          </DialogTitle>
          <DialogDescription>
            {view === 'pick' && t('connect.descPick')}
            {view === 'key' && t('connect.descKey')}
            {view === 'custom' && t('connect.descCustom')}
          </DialogDescription>
        </DialogHeader>

        {view === 'pick' && (
          <div className="grid gap-4 py-1">
            {isLoading && <p className="text-xs text-muted-foreground">{t('connect.loading')}</p>}
            {isError && <p className="text-xs text-destructive">{t('connect.loadFailed')}</p>}

            {needKey.length > 0 && (
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground">{t('connect.needKeyLabel')}</label>
                <div className="grid gap-1.5">
                  {needKey.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => gotoKey({ kind: 'existing', name: p.name, label: p.label, modelHint: p.models[0]?.alias ?? p.models[0]?.id })}
                      className="flex items-center gap-2 rounded border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                    >
                      <span className="font-medium text-text">{p.label}</span>
                      {p.isDefault && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{t('connect.default')}</span>}
                      <span className="ml-auto text-xs text-warning">{t('connect.noKey')}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(data?.unconfigured.length ?? 0) > 0 && (
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground">{t('connect.builtinLabel')}</label>
                <div className="grid grid-cols-2 gap-1.5">
                  {data!.unconfigured.map((u) => (
                    <button
                      key={u.key}
                      type="button"
                      onClick={() => gotoKey({ kind: 'preset', name: u.key, label: u.label, modelHint: u.defaultModelId })}
                      className="flex flex-col gap-0.5 rounded border border-border px-3 py-2 text-left transition-colors hover:bg-muted"
                    >
                      <span className="text-sm font-medium text-text">{u.label}</span>
                      <span className="truncate text-[11px] text-muted-foreground">{u.defaultModelId}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {ready.length > 0 && (
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground">{t('connect.readyLabel')}</label>
                <div className="grid gap-1.5">
                  {ready.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      disabled={p.isDefault || busy}
                      onClick={() => void quickDefault(p)}
                      className="flex items-center gap-2 rounded border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted disabled:cursor-default disabled:opacity-70"
                    >
                      <span className="font-medium text-text">{p.label}</span>
                      {p.isDefault
                        ? <span className="ml-auto rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{t('connect.currentDefault')}</span>
                        : <span className="ml-auto text-xs text-muted-foreground">{t('connect.setDefault')}</span>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setView('custom')}
              className="flex items-center gap-2 rounded border border-dashed border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
            >
              <span className="text-muted-foreground">＋</span>
              <span>{t('connect.customEntry')}</span>
              <span className="ml-auto text-xs text-muted-foreground">{t('connect.customEntryHint')}</span>
            </button>

            <div className="flex justify-end">
              <Button variant="ghost" onClick={onClose} disabled={busy}>{t('connect.close')}</Button>
            </div>
          </div>
        )}

        {view === 'key' && target && (
          <div className="grid gap-4 py-1">
            <div className="grid gap-1.5">
              <label className="text-xs text-muted-foreground">API Key</label>
              <Input
                type="password"
                autoFocus
                value={apiKey}
                onChange={(e) => { setApiKey(e.target.value); setKeyErr(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submitKey() } }}
                placeholder={`${target.label} API Key…`}
              />
              {target.modelHint && <p className="text-[11px] text-muted-foreground">{t('connect.defaultModel', { model: target.modelHint })}</p>}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} disabled={busy} />
              <span>{t('connect.makeDefault')}</span>
            </label>
            {keyErr && <p className="text-xs text-destructive">{keyErr}</p>}
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setView('pick')} disabled={busy}>{t('connect.back')}</Button>
              <Button onClick={() => void submitKey()} disabled={busy || !apiKey.trim()}>
                {busy ? t('connect.connecting') : t('connect.connect')}
              </Button>
            </div>
          </div>
        )}

        {view === 'custom' && (
          <CustomForm
            busy={busy}
            setBusy={setBusy}
            onBack={() => setView('pick')}
            onDone={(label, isDefault) => {
              refresh()
              toast.success(t('connect.connected', { label, suffix: isDefault ? t('connect.connectedDefaultSuffix') : '' }))
              onClose()
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function CustomForm(props: {
  busy: boolean
  setBusy: (v: boolean) => void
  onBack: () => void
  onDone: (label: string, isDefault: boolean) => void
}) {
  const { busy, setBusy, onBack, onDone } = props
  const { t } = useTranslation('onboarding')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [alias, setAlias] = useState('')
  const [contextWindow, setContextWindow] = useState('1000000')
  const [maxTokens, setMaxTokens] = useState('384000')
  const [makeDefault, setMakeDefault] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const nm = name.trim()
    if (!nm) { setErr(t('connect.nameRequired')); return }
    const url = baseUrl.trim()
    if (!url) { setErr(t('connect.urlRequired')); return }
    try { new URL(url) } catch { setErr(t('connect.urlInvalid')); return }
    const id = modelId.trim()
    if (!id) { setErr(t('connect.modelIdRequired')); return }
    const cw = Number(contextWindow)
    if (!Number.isInteger(cw) || cw <= 0) { setErr(t('connect.ctxPositive')); return }
    const mt = Number(maxTokens)
    if (!Number.isInteger(mt) || mt <= 0) { setErr(t('connect.maxPositive')); return }
    if (mt > cw) { setErr(t('connect.maxExceedsCtx')); return }
    setBusy(true)
    try {
      await setupConfigProvider({
        providerName: nm,
        baseUrl: url,
        apiKey: apiKey.trim() || undefined,
        makeDefault,
        model: { id, alias: alias.trim() || undefined, contextWindow: cw, maxTokens: mt },
      })
      onDone(nm, makeDefault)
    } catch (e) {
      setErr((e as Error)?.message ?? t('connect.connectFailed'))
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3 py-1">
      <div className="grid gap-1.5">
        <label className="text-xs text-muted-foreground">{t('connect.name')}</label>
        <Input value={name} onChange={(e) => { setName(e.target.value); setErr(null) }} placeholder={t('connect.namePlaceholder')} disabled={busy} autoFocus />
      </div>
      <div className="grid gap-1.5">
        <label className="text-xs text-muted-foreground">{t('connect.baseUrl')}</label>
        <Input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setErr(null) }} placeholder="https://api.example.com/v1" disabled={busy} />
      </div>
      <div className="grid gap-1.5">
        <label className="text-xs text-muted-foreground">{t('connect.apiKeyOptional')}</label>
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." disabled={busy} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">{t('connect.modelId')}</label>
          <Input value={modelId} onChange={(e) => { setModelId(e.target.value); setErr(null) }} placeholder="gpt-4o" disabled={busy} />
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">{t('connect.alias')}</label>
          <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={t('connect.aliasPlaceholder')} disabled={busy} />
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">{t('connect.contextWindow')}</label>
          <Input type="number" value={contextWindow} onChange={(e) => { setContextWindow(e.target.value); setErr(null) }} placeholder="128000" disabled={busy} />
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">{t('connect.maxTokens')}</label>
          <Input type="number" value={maxTokens} onChange={(e) => { setMaxTokens(e.target.value); setErr(null) }} placeholder="384000" disabled={busy} />
        </div>
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        <Trans t={t} i18nKey="connect.formHint" components={{ strong: <strong className="text-text" /> }} />
      </p>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} disabled={busy} />
        <span>{t('connect.makeDefault')}</span>
      </label>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={onBack} disabled={busy}>{t('connect.back')}</Button>
        <Button onClick={() => void submit()} disabled={busy}>{busy ? t('connect.connecting') : t('connect.connect')}</Button>
      </div>
    </div>
  )
}
