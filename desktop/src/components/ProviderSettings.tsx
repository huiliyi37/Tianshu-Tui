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

function KeyBadge({ status }: { status: ProviderListItem['keyStatus'] }) {
  if (status.source === 'inline') return <span className="badge ok" title={`Inline key ${status.ref}`}>Key {status.ref}</span>
  if (status.source === 'env') return <span className="badge ok" title={`From env: ${status.ref}`}>{status.ref}</span>
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
  const [busy, setBusy] = useState(false)

  const saveKey = async () => {
    if (!keyInput.trim()) return
    setBusy(true)
    try {
      await setProviderKey(p.name, { apiKey: keyInput.trim() })
      setKeyInput('')
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
    if (p.isDefault) return
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
            onChange={e => setKeyInput(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') saveKey() }}
            autoFocus
          />
          <button className="btn-sm" disabled={busy || !keyInput.trim()} onClick={saveKey}>保存</button>
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
  const [busy, setBusy] = useState(false)

  const add = async () => {
    setBusy(true)
    try {
      await setupConfigProvider({ providerName: preset.key })
      onRefresh()
    } catch (e) {
      toast.error(`添加 Provider 失败: ${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  return (
    <button className="preset-card" disabled={busy} onClick={add}>
      <span className="preset-label">{preset.label}</span>
      <span className="preset-model">{preset.defaultModelId}</span>
    </button>
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
