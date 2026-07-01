import { useMemo, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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

function isValidKey(v: string): string | null {
  const t = v.trim()
  if (!t) return 'API Key 不能为空'
  if (t.length < 4) return 'API Key 长度不足'
  return null
}

export function ConnectWizard({ onClose }: { onClose: () => void }) {
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
    const err = isValidKey(apiKey)
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
      toast.success(`已连接 ${target.label}${makeDefault ? '（已设为默认）' : ''}，新建会话即可使用`)
      onClose()
    } catch (e) {
      setKeyErr((e as Error)?.message ?? '连接失败，请重试')
      setBusy(false)
    }
  }

  const quickDefault = async (p: ProviderListItem) => {
    if (busy) return
    setBusy(true)
    try {
      await setProviderAsDefault(p.name)
      refresh()
      toast.success(`已切换默认服务商为 ${p.label}`)
      onClose()
    } catch (e) {
      toast.error(`设为默认失败：${(e as Error).message}`)
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent showCloseButton={false} className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {view === 'pick' && '连接模型服务商'}
            {view === 'key' && `连接 ${target?.label ?? ''}`}
            {view === 'custom' && '自定义服务商'}
          </DialogTitle>
          <DialogDescription>
            {view === 'pick' && '选择一个内置服务商填入 API 密钥，或添加自定义的 OpenAI 兼容服务。配置后新建会话即可使用。'}
            {view === 'key' && '填入该服务商的 API 密钥即可开始使用。'}
            {view === 'custom' && '任何兼容 OpenAI 接口的服务都可以在这里手动接入。'}
          </DialogDescription>
        </DialogHeader>

        {view === 'pick' && (
          <div className="grid gap-4 py-1">
            {isLoading && <p className="text-xs text-muted-foreground">加载中…</p>}
            {isError && <p className="text-xs text-destructive">无法读取服务商配置（后台离线？）</p>}

            {needKey.length > 0 && (
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground">待填密钥</label>
                <div className="grid gap-1.5">
                  {needKey.map((p) => (
                    <button
                      key={p.name}
                      type="button"
                      onClick={() => gotoKey({ kind: 'existing', name: p.name, label: p.label, modelHint: p.models[0]?.alias ?? p.models[0]?.id })}
                      className="flex items-center gap-2 rounded border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-muted"
                    >
                      <span className="font-medium text-text">{p.label}</span>
                      {p.isDefault && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">默认</span>}
                      <span className="ml-auto text-xs text-warning">未配置 Key</span>
                    </button>
                  ))}
                </div>
              </div>
            )}

            {(data?.unconfigured.length ?? 0) > 0 && (
              <div className="grid gap-1.5">
                <label className="text-xs text-muted-foreground">内置服务商</label>
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
                <label className="text-xs text-muted-foreground">已连接（点选设为默认）</label>
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
                        ? <span className="ml-auto rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">当前默认</span>
                        : <span className="ml-auto text-xs text-muted-foreground">设为默认</span>}
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
              <span>自定义服务商</span>
              <span className="ml-auto text-xs text-muted-foreground">手动填地址与模型</span>
            </button>

            <div className="flex justify-end">
              <Button variant="ghost" onClick={onClose} disabled={busy}>关闭</Button>
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
              {target.modelHint && <p className="text-[11px] text-muted-foreground">默认模型：{target.modelHint}</p>}
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} disabled={busy} />
              <span>设为默认服务商</span>
            </label>
            {keyErr && <p className="text-xs text-destructive">{keyErr}</p>}
            <div className="flex justify-between gap-2">
              <Button variant="ghost" onClick={() => setView('pick')} disabled={busy}>返回</Button>
              <Button onClick={() => void submitKey()} disabled={busy || !apiKey.trim()}>
                {busy ? '连接中…' : '连接'}
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
              toast.success(`已连接 ${label}${isDefault ? '（已设为默认）' : ''}，新建会话即可使用`)
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
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [modelId, setModelId] = useState('')
  const [alias, setAlias] = useState('')
  const [contextWindow, setContextWindow] = useState('128000')
  const [maxTokens, setMaxTokens] = useState('64000')
  const [makeDefault, setMakeDefault] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const submit = async () => {
    const nm = name.trim()
    if (!nm) { setErr('服务商名称不能为空'); return }
    const url = baseUrl.trim()
    if (!url) { setErr('接口地址不能为空'); return }
    try { new URL(url) } catch { setErr('接口地址格式不正确'); return }
    const id = modelId.trim()
    if (!id) { setErr('模型 ID 不能为空'); return }
    const cw = Number(contextWindow)
    if (!Number.isInteger(cw) || cw <= 0) { setErr('上下文长度必须是正整数'); return }
    const mt = Number(maxTokens)
    if (!Number.isInteger(mt) || mt <= 0) { setErr('最大输出 Tokens 必须是正整数'); return }
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
      setErr((e as Error)?.message ?? '连接失败，请重试')
      setBusy(false)
    }
  }

  return (
    <div className="grid gap-3 py-1">
      <div className="grid gap-1.5">
        <label className="text-xs text-muted-foreground">服务商名称</label>
        <Input value={name} onChange={(e) => { setName(e.target.value); setErr(null) }} placeholder="例如 my-openai" disabled={busy} autoFocus />
      </div>
      <div className="grid gap-1.5">
        <label className="text-xs text-muted-foreground">接口地址（Base URL）</label>
        <Input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setErr(null) }} placeholder="https://api.example.com/v1" disabled={busy} />
      </div>
      <div className="grid gap-1.5">
        <label className="text-xs text-muted-foreground">API Key（可选）</label>
        <Input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-..." disabled={busy} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">模型 ID</label>
          <Input value={modelId} onChange={(e) => { setModelId(e.target.value); setErr(null) }} placeholder="gpt-4o" disabled={busy} />
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">别名（可选）</label>
          <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="显示用名称" disabled={busy} />
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">上下文长度</label>
          <Input type="number" value={contextWindow} onChange={(e) => { setContextWindow(e.target.value); setErr(null) }} placeholder="128000" disabled={busy} />
        </div>
        <div className="grid gap-1.5">
          <label className="text-xs text-muted-foreground">最大输出 Tokens</label>
          <Input type="number" value={maxTokens} onChange={(e) => { setMaxTokens(e.target.value); setErr(null) }} placeholder="64000" disabled={busy} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} disabled={busy} />
        <span>设为默认服务商</span>
      </label>
      {err && <p className="text-xs text-destructive">{err}</p>}
      <div className="flex justify-between gap-2">
        <Button variant="ghost" onClick={onBack} disabled={busy}>返回</Button>
        <Button onClick={() => void submit()} disabled={busy}>{busy ? '连接中…' : '连接'}</Button>
      </div>
    </div>
  )
}
