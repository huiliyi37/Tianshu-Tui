import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { useConfigProviders, qk } from '../state/queries'
import {
  setupConfigProvider,
  removeConfigProvider,
  setProviderKey,
  setProviderAsDefault,
  type ProviderListItem,
  type UnconfiguredPreset,
} from '../runtime/client'

/** 对 key 引用做防御性脱敏：前端不应假定后端已脱敏，避免长 ref 泄漏 key 片段。
 *  保留前 4 末 4，中间用 … 占位；短 ref（≤8）原样显示（通常是已脱敏指纹）。 */
function maskRef(ref: string): string {
  const r = ref.trim()
  if (r.length <= 8) return r
  return `${r.slice(0, 4)}…${r.slice(-4)}`
}

function KeyBadge({ status }: { status: ProviderListItem['keyStatus'] }) {
  if (status.source === 'inline') return <span className="badge ok" title="Inline key（已配置）">Key {maskRef(status.ref)}</span>
  if (status.source === 'env') return <span className="badge ok" title={`From env: ${maskRef(status.ref)}`}>{maskRef(status.ref)}</span>
  return <span className="badge warn">未配置</span>
}

function ProviderRow({
  p,
  onRefresh,
}: {
  p: ProviderListItem
  onRefresh: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const validateKey = (v: string): string | null => {
    const trimmed = v.trim()
    if (!trimmed) return 'API Key 不能为空'
    if (trimmed.length < 4) return 'API Key 长度不足'
    return null
  }

  const saveKey = async () => {
    const err = validateKey(keyInput)
    if (err) {
      setKeyError(err)
      return
    }
    setBusy(true)
    try {
      await setProviderKey(p.name, { apiKey: keyInput.trim() })
      setKeyInput('')
      setKeyError(null)
      setEditing(false)
      onRefresh()
    } catch (e) {
      toast.error(`保存 Key 失败: ${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  const makeDefault = async () => {
    setBusy(true)
    try {
      await setProviderAsDefault(p.name)
      onRefresh()
    } catch (e) {
      toast.error(`设为默认失败: ${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (p.isDefault) {
      toast.error('不能移除默认 Provider，请先切换默认')
      return
    }
    setBusy(true)
    try {
      await removeConfigProvider(p.name)
      onRefresh()
    } catch (e) {
      toast.error(`移除 Provider 失败: ${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  return (
    <div className="provider-row">
      <div className="provider-header">
        <span className="provider-name">
          {p.label}
          {p.isDefault && <span className="badge accent">默认</span>}
        </span>
        <KeyBadge status={p.keyStatus} />
      </div>
      <div className="provider-meta">
        {p.baseUrl}
        <span className="provider-models">
          {p.models.map(m => m.alias ?? m.id).join(', ')}
        </span>
      </div>
      <div className="provider-actions">
        {!p.isDefault && (
          <button className="btn-sm" disabled={busy} onClick={makeDefault}>设为默认</button>
        )}
        <button className="btn-sm" disabled={busy} onClick={() => setEditing(!editing)}>
          {editing ? '取消' : '设置 Key'}
        </button>
        {!p.isDefault && (
          <button className="btn-sm danger" disabled={busy} onClick={remove}>移除</button>
        )}
      </div>
      {editing && (
        <div className="provider-key-form">
          <input
            type="password"
            placeholder="sk-..."
            value={keyInput}
            onChange={e => { setKeyInput(e.target.value); setKeyError(null) }}
            onKeyDown={e => { if (e.key === 'Enter') saveKey() }}
            autoFocus
          />
          <button className="btn-sm" disabled={busy} onClick={saveKey}>保存</button>
          {keyError && <span className="provider-key-error">{keyError}</span>}
        </div>
      )}
    </div>
  )
}

function PresetCard({
  preset,
  onRefresh,
}: {
  preset: UnconfiguredPreset
  onRefresh: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const validateKey = (v: string): string | null => {
    const trimmed = v.trim()
    if (!trimmed) return '添加 Provider 需要填写 API Key'
    if (trimmed.length < 4) return 'API Key 长度不足'
    return null
  }

  const add = async () => {
    const err = validateKey(keyInput)
    if (err) {
      setKeyError(err)
      return
    }
    setBusy(true)
    try {
      await setupConfigProvider({ providerName: preset.key, apiKey: keyInput.trim() })
      setKeyInput('')
      setKeyError(null)
      setExpanded(false)
      onRefresh()
    } catch (e) {
      toast.error(`添加 Provider 失败: ${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  if (!expanded) {
    return (
      <button className="preset-card" disabled={busy} onClick={() => setExpanded(true)}>
        <span className="preset-label">{preset.label}</span>
        <span className="preset-model">{preset.defaultModelId}</span>
      </button>
    )
  }

  return (
    <div className="preset-card preset-card-input">
      <span className="preset-label">{preset.label}</span>
      <div className="provider-key-form">
        <input
          type="password"
          placeholder={`${preset.label} API Key…`}
          value={keyInput}
          onChange={e => { setKeyInput(e.target.value); setKeyError(null) }}
          onKeyDown={e => { if (e.key === 'Enter') add() }}
          autoFocus
        />
        <button className="btn-sm" disabled={busy} onClick={add}>添加</button>
        <button className="btn-sm ghost" disabled={busy} onClick={() => setExpanded(false)}>取消</button>
      </div>
      {keyError && <span className="provider-key-error">{keyError}</span>}
    </div>
  )
}

export function ProviderSettings() {
  const { data, isLoading, isError } = useConfigProviders()
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: qk.configProviders })

  if (isLoading) return <div className="meta">加载中…</div>
  if (isError) return <div className="meta warn">无法加载 Provider 配置（sidecar 离线？）</div>

  const { providers, unconfigured } = data!

  return (
    <div className="provider-settings">
      {providers.map(p => (
        <ProviderRow key={p.name} p={p} onRefresh={refresh} />
      ))}

      {unconfigured.length > 0 && (
        <div className="preset-section">
          <div className="preset-header">可添加的预设</div>
          <div className="preset-grid">
            {unconfigured.map(u => (
              <PresetCard key={u.key} preset={u} onRefresh={refresh} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
