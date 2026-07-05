import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { useConfigProviders, qk } from '../state/queries'
import {
  setupConfigProvider,
  setupCustomProvider,
  removeConfigProvider,
  removeProviderModel,
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

interface ModelFormState {
  id: string
  alias: string
  contextWindow: string
  maxTokens: string
}

function emptyModel(): ModelFormState {
  return { id: '', alias: '', contextWindow: '128000', maxTokens: '64000' }
}

function modelFromState(state: ModelFormState): { id: string; alias?: string; contextWindow: number; maxTokens: number } | null {
  const id = state.id.trim()
  if (!id) return null
  const contextWindow = Number(state.contextWindow)
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) return null
  const maxTokens = Number(state.maxTokens)
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) return null
  const alias = state.alias.trim() || undefined
  return { id, alias, contextWindow, maxTokens }
}

function validateModel(state: ModelFormState): { ok: true; model: { id: string; alias?: string; contextWindow: number; maxTokens: number } } | { ok: false; error: string } {
  const model = modelFromState(state)
  if (!model) {
    if (!state.id.trim()) return { ok: false, error: '模型 ID 不能为空' }
    const cw = Number(state.contextWindow)
    if (!Number.isInteger(cw) || cw <= 0) return { ok: false, error: '上下文长度必须是正整数' }
    const mt = Number(state.maxTokens)
    if (!Number.isInteger(mt) || mt <= 0) return { ok: false, error: '最大 Tokens 必须是正整数' }
    if (mt > cw) return { ok: false, error: '最大输出不能超过上下文长度（请照官方 API 的真实上限填写）' }
    return { ok: false, error: '模型信息无效' }
  }
  if (model.maxTokens > model.contextWindow) {
    return { ok: false, error: '最大输出不能超过上下文长度（请照官方 API 的真实上限填写）' }
  }
  return { ok: true, model }
}

function ModelForm({
  state,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  busy,
  error,
}: {
  state: ModelFormState
  onChange: (patch: Partial<ModelFormState>) => void
  onSubmit: () => void
  onCancel: () => void
  submitLabel: string
  busy: boolean
  error: string | null
}) {
  return (
    <div className="provider-model-form">
      <div className="provider-form-grid">
        <label className="provider-field">
          <span className="provider-field-label">模型 ID</span>
          <input
            type="text"
            placeholder="例如 gpt-4o"
            value={state.id}
            onChange={(e) => onChange({ id: e.target.value })}
            disabled={busy}
          />
        </label>
        <label className="provider-field">
          <span className="provider-field-label">别名（可选）</span>
          <input
            type="text"
            placeholder="显示用名称"
            value={state.alias}
            onChange={(e) => onChange({ alias: e.target.value })}
            disabled={busy}
          />
        </label>
        <label className="provider-field">
          <span className="provider-field-label">上下文长度（tokens）</span>
          <input
            type="number"
            placeholder="128000"
            value={state.contextWindow}
            onChange={(e) => onChange({ contextWindow: e.target.value })}
            disabled={busy}
          />
        </label>
        <label className="provider-field">
          <span className="provider-field-label">最大输出 Tokens</span>
          <input
            type="number"
            placeholder="64000"
            value={state.maxTokens}
            onChange={(e) => onChange({ maxTokens: e.target.value })}
            disabled={busy}
          />
        </label>
      </div>
      <div className="provider-form-hint">
        请照该服务商官方 API 文档的真实值填写。上下文长度决定天枢的自动压缩点（填小了会过早压缩、丢上下文；填大了会撞 API 上限），也决定模型能记住多少对话；最大输出 Tokens 是单次回复上限，不能超过上下文长度。
      </div>
      <div className="provider-form-actions">
        <button className="btn-sm" disabled={busy} onClick={onSubmit}>{submitLabel}</button>
        <button className="btn-sm ghost" disabled={busy} onClick={onCancel}>取消</button>
      </div>
      {error && <span className="provider-key-error">{error}</span>}
    </div>
  )
}

function ModelManageList({
  providerName,
  models,
  onRefresh,
}: {
  providerName: string
  models: ProviderListItem['models']
  onRefresh: () => void
}) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [ctx, setCtx] = useState('')
  const [max, setMax] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const startEdit = (m: ProviderListItem['models'][number]) => {
    setEditingId(m.id)
    setCtx(String(m.contextWindow))
    setMax(String(m.maxTokens))
    setError(null)
  }

  const save = async (model: ProviderListItem['models'][number]) => {
    const contextWindow = Number(ctx)
    const maxTokens = Number(max)
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      setError('上下文长度必须是正整数')
      return
    }
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      setError('最大 Tokens 必须是正整数')
      return
    }
    if (maxTokens > contextWindow) {
      setError('最大输出不能超过上下文长度（请照官方 API 的真实上限填写）')
      return
    }
    setBusy(true)
    try {
      await setupConfigProvider({
        providerName,
        model: {
          id: model.id,
          alias: model.alias,
          contextWindow,
          maxTokens,
        },
      })
      setEditingId(null)
      setError(null)
      onRefresh()
    } catch (e) {
      toast.error(`更新模型失败: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="provider-models-list">
      {models.map((m) => (
        <div key={m.id} className="provider-model-row">
          <span className="provider-model-name">{m.alias ?? m.id}</span>
          {editingId === m.id ? (
            <>
              <label className="provider-mini-field">
                <span>上下文</span>
                <input
                  type="number"
                  value={ctx}
                  onChange={(e) => setCtx(e.target.value)}
                  disabled={busy}
                  placeholder="tokens"
                />
              </label>
              <label className="provider-mini-field">
                <span>最大输出</span>
                <input
                  type="number"
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                  disabled={busy}
                  placeholder="tokens"
                />
              </label>
              <button className="btn-sm" disabled={busy} onClick={() => save(m)}>保存</button>
              <button className="btn-sm ghost" disabled={busy} onClick={() => setEditingId(null)}>取消</button>
            </>
          ) : (
            <>
              <span className="provider-model-params">
                ctx {m.contextWindow.toLocaleString()} / max {m.maxTokens.toLocaleString()}
              </span>
              <button className="btn-sm ghost" onClick={() => startEdit(m)} title="编辑">
                <Pencil size={12} />
              </button>
              <button
                  className="btn-sm ghost danger"
                  disabled={busy}
                  title="删除模型"
                  onClick={async () => {
                    if (!window.confirm(`确定删除模型「${m.alias ?? m.id}」？${models.length === 1 ? '\n这是最后一个模型，删除后整个 Provider 也会被移除。' : ''}`)) return
                    setBusy(true)
                    try {
                      await removeProviderModel(providerName, m.id)
                      onRefresh()
                    } catch (e) {
                      toast.error(`删除模型失败: ${(e as Error).message}`)
                    } finally { setBusy(false) }
                  }}
                >
                  ✕
                </button>
            </>
          )}
        </div>
      ))}
      {error && <span className="provider-key-error">{error}</span>}
    </div>
  )
}

function ProviderRow({
  p,
  onRefresh,
}: {
  p: ProviderListItem
  onRefresh: () => void
}) {
  const [editing, setEditing] = useState(false)
  const [addingModel, setAddingModel] = useState(false)
  const [managingModels, setManagingModels] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [modelState, setModelState] = useState<ModelFormState>(emptyModel())
  const [modelError, setModelError] = useState<string | null>(null)
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

  const addModel = async () => {
    const result = validateModel(modelState)
    if (!result.ok) {
      setModelError(result.error)
      return
    }
    setBusy(true)
    try {
      await setupConfigProvider({ providerName: p.name, model: result.model })
      setModelState(emptyModel())
      setModelError(null)
      setAddingModel(false)
      onRefresh()
    } catch (e) {
      toast.error(`添加模型失败: ${(e as Error).message}`)
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
        <button className="btn-sm" disabled={busy} onClick={() => { setManagingModels(!managingModels); setAddingModel(false) }}>
          {managingModels ? '收起模型' : '管理模型'}
        </button>
        <button className="btn-sm" disabled={busy} onClick={() => { setAddingModel(!addingModel); setManagingModels(false) }}>
          {addingModel ? '取消' : '添加模型'}
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
      {addingModel && (
        <ModelForm
          state={modelState}
          onChange={(patch) => setModelState((prev) => ({ ...prev, ...patch }))}
          onSubmit={addModel}
          onCancel={() => { setAddingModel(false); setModelError(null); setModelState(emptyModel()) }}
          submitLabel="保存模型"
          busy={busy}
          error={modelError}
        />
      )}
      {managingModels && (
        <ModelManageList providerName={p.name} models={p.models} onRefresh={onRefresh} />
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

interface CustomProviderFormState {
  name: string
  baseUrl: string
  apiKey: string
  model: ModelFormState
  makeDefault: boolean
}

function emptyCustomProvider(): CustomProviderFormState {
  return {
    name: '',
    baseUrl: '',
    apiKey: '',
    model: emptyModel(),
    makeDefault: false,
  }
}

function CustomProviderCard({ onRefresh }: { onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false)
  const [state, setState] = useState<CustomProviderFormState>(emptyCustomProvider())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const add = async () => {
    const name = state.name.trim()
    if (!name) {
      setError('Provider 名称不能为空')
      return
    }
    const baseUrl = state.baseUrl.trim()
    if (!baseUrl) {
      setError('Base URL 不能为空')
      return
    }
    try {
      new URL(baseUrl)
    } catch {
      setError('Base URL 格式不正确')
      return
    }
    const modelResult = validateModel(state.model)
    if (!modelResult.ok) {
      setError(modelResult.error)
      return
    }
    setBusy(true)
    try {
      await setupCustomProvider({
        providerName: name,
        baseUrl,
        apiKey: state.apiKey.trim() || undefined,
        model: modelResult.model,
        makeDefault: state.makeDefault,
      })
      setState(emptyCustomProvider())
      setError(null)
      setExpanded(false)
      onRefresh()
    } catch (e) {
      toast.error(`添加 Provider 失败: ${(e as Error).message}`)
    } finally { setBusy(false) }
  }

  if (!expanded) {
    return (
      <button className="preset-card" onClick={() => setExpanded(true)}>
        <span className="preset-label">+ 自定义 Provider</span>
        <span className="preset-model">手动输入名称、URL、模型</span>
      </button>
    )
  }

  return (
    <div className="preset-card preset-card-input custom-provider-card">
      <span className="preset-label">自定义 Provider</span>
      <div className="provider-form-stack">
        <label className="provider-field">
          <span className="provider-field-label">Provider 名称</span>
          <input
            type="text"
            placeholder="例如 my-openai"
            value={state.name}
            onChange={(e) => setState((prev) => ({ ...prev, name: e.target.value }))}
            disabled={busy}
          />
        </label>
        <label className="provider-field">
          <span className="provider-field-label">Base URL</span>
          <input
            type="text"
            placeholder="例如 https://api.example.com/v1"
            value={state.baseUrl}
            onChange={(e) => setState((prev) => ({ ...prev, baseUrl: e.target.value }))}
            disabled={busy}
          />
        </label>
        <label className="provider-field">
          <span className="provider-field-label">API Key（可选）</span>
          <input
            type="password"
            placeholder="sk-..."
            value={state.apiKey}
            onChange={(e) => setState((prev) => ({ ...prev, apiKey: e.target.value }))}
            disabled={busy}
          />
        </label>
        <div className="provider-form-grid">
          <label className="provider-field">
            <span className="provider-field-label">模型 ID</span>
            <input
              type="text"
              placeholder="例如 gpt-4o"
              value={state.model.id}
              onChange={(e) => setState((prev) => ({ ...prev, model: { ...prev.model, id: e.target.value } }))}
              disabled={busy}
            />
          </label>
          <label className="provider-field">
            <span className="provider-field-label">别名（可选）</span>
            <input
              type="text"
              placeholder="显示用名称"
              value={state.model.alias}
              onChange={(e) => setState((prev) => ({ ...prev, model: { ...prev.model, alias: e.target.value } }))}
              disabled={busy}
            />
          </label>
          <label className="provider-field">
            <span className="provider-field-label">上下文长度（tokens）</span>
            <input
              type="number"
              placeholder="128000"
              value={state.model.contextWindow}
              onChange={(e) => setState((prev) => ({ ...prev, model: { ...prev.model, contextWindow: e.target.value } }))}
              disabled={busy}
            />
          </label>
          <label className="provider-field">
            <span className="provider-field-label">最大输出 Tokens</span>
            <input
              type="number"
              placeholder="64000"
              value={state.model.maxTokens}
              onChange={(e) => setState((prev) => ({ ...prev, model: { ...prev.model, maxTokens: e.target.value } }))}
              disabled={busy}
            />
          </label>
        </div>
        <label className="provider-check">
          <input
            type="checkbox"
            checked={state.makeDefault}
            onChange={(e) => setState((prev) => ({ ...prev, makeDefault: e.target.checked }))}
            disabled={busy}
          />
          <span>设为默认 Provider</span>
        </label>
        <div className="provider-form-actions">
          <button className="btn-sm" disabled={busy} onClick={add}>添加</button>
          <button className="btn-sm ghost" disabled={busy} onClick={() => { setExpanded(false); setError(null); setState(emptyCustomProvider()) }}>取消</button>
        </div>
        {error && <span className="provider-key-error">{error}</span>}
      </div>
    </div>
  )
}

const PAGE_SIZE = 5

export function ProviderSettings() {
  const { data, isLoading, isError } = useConfigProviders()
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: qk.configProviders })
  const [page, setPage] = useState(0)

  if (isLoading) return <div className="meta">加载中…</div>
  if (isError) return <div className="meta warn">无法加载 Provider 配置（sidecar 离线？）</div>

  const { providers, unconfigured } = data!
  const totalPages = Math.max(1, Math.ceil(providers.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages - 1)
  const pagedProviders = providers.slice(safePage * PAGE_SIZE, (safePage + 1) * PAGE_SIZE)

  return (
    <div className="provider-settings">
      {pagedProviders.map(p => (
        <ProviderRow key={p.name} p={p} onRefresh={refresh} />
      ))}

      {providers.length > PAGE_SIZE && (
        <div className="provider-pagination">
          <button
            className="btn-mini"
            disabled={safePage === 0}
            onClick={() => setPage(safePage - 1)}
          >
            上一页
          </button>
          <span>第 {safePage + 1} / {totalPages} 页</span>
          <button
            className="btn-mini"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage(safePage + 1)}
          >
            下一页
          </button>
        </div>
      )}

      <div className="preset-section">
        <div className="preset-header">添加 Provider</div>
        <div className="preset-grid">
          {unconfigured.map(u => (
            <PresetCard key={u.key} preset={u} onRefresh={refresh} />
          ))}
          <CustomProviderCard onRefresh={refresh} />
        </div>
      </div>
    </div>
  )
}
