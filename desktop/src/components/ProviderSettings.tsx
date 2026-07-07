import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
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
  const { t } = useTranslation('settings')
  if (status.source === 'inline') return <span className="badge ok" title={t('providers.keyInline')}>Key {maskRef(status.ref)}</span>
  if (status.source === 'env') return <span className="badge ok" title={`From env: ${maskRef(status.ref)}`}>{maskRef(status.ref)}</span>
  return <span className="badge warn">{t('providers.keyNone')}</span>
}

interface ModelFormState {
  id: string
  alias: string
  contextWindow: string
  maxTokens: string
}

function emptyModel(): ModelFormState {
  return { id: '', alias: '', contextWindow: '1000000', maxTokens: '384000' }
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

function validateModel(state: ModelFormState, t: TFunction<'settings'>): { ok: true; model: { id: string; alias?: string; contextWindow: number; maxTokens: number } } | { ok: false; error: string } {
  const model = modelFromState(state)
  if (!model) {
    if (!state.id.trim()) return { ok: false, error: t('providers.modelIdRequired') }
    const cw = Number(state.contextWindow)
    if (!Number.isInteger(cw) || cw <= 0) return { ok: false, error: t('providers.ctxPositive') }
    const mt = Number(state.maxTokens)
    if (!Number.isInteger(mt) || mt <= 0) return { ok: false, error: t('providers.maxPositive') }
    if (mt > cw) return { ok: false, error: t('providers.maxExceedsCtx') }
    return { ok: false, error: t('providers.modelInvalid') }
  }
  if (model.maxTokens > model.contextWindow) {
    return { ok: false, error: t('providers.maxExceedsCtx') }
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
  const { t } = useTranslation('settings')
  return (
    <div className="provider-model-form">
      <div className="provider-form-grid">
        <label className="provider-field">
          <span className="provider-field-label">{t('providers.modelId')}</span>
          <input
            type="text"
            placeholder={t('providers.modelIdPlaceholder')}
            value={state.id}
            onChange={(e) => onChange({ id: e.target.value })}
            disabled={busy}
          />
        </label>
        <label className="provider-field">
          <span className="provider-field-label">{t('providers.alias')}</span>
          <input
            type="text"
            placeholder={t('providers.aliasPlaceholder')}
            value={state.alias}
            onChange={(e) => onChange({ alias: e.target.value })}
            disabled={busy}
          />
        </label>
        <label className="provider-field">
          <span className="provider-field-label">{t('providers.contextWindow')}</span>
          <input
            type="number"
            placeholder="128000"
            value={state.contextWindow}
            onChange={(e) => onChange({ contextWindow: e.target.value })}
            disabled={busy}
          />
        </label>
        <label className="provider-field">
          <span className="provider-field-label">{t('providers.maxTokens')}</span>
          <input
            type="number"
            placeholder="384000"
            value={state.maxTokens}
            onChange={(e) => onChange({ maxTokens: e.target.value })}
            disabled={busy}
          />
        </label>
      </div>
      <div className="provider-form-hint">
        {t('providers.formHint')}
      </div>
      <div className="provider-form-actions">
        <button className="btn-sm" disabled={busy} onClick={onSubmit}>{submitLabel}</button>
        <button className="btn-sm ghost" disabled={busy} onClick={onCancel}>{t('providers.cancel')}</button>
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
  const { t } = useTranslation('settings')
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
      setError(t('providers.ctxPositive'))
      return
    }
    if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
      setError(t('providers.maxPositive'))
      return
    }
    if (maxTokens > contextWindow) {
      setError(t('providers.maxExceedsCtx'))
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
      toast.error(t('providers.updateModelFailed', { error: (e as Error).message }))
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
                <span>{t('providers.ctxShort')}</span>
                <input
                  type="number"
                  value={ctx}
                  onChange={(e) => setCtx(e.target.value)}
                  disabled={busy}
                  placeholder="tokens"
                />
              </label>
              <label className="provider-mini-field">
                <span>{t('providers.maxShort')}</span>
                <input
                  type="number"
                  value={max}
                  onChange={(e) => setMax(e.target.value)}
                  disabled={busy}
                  placeholder="tokens"
                />
              </label>
              <button className="btn-sm" disabled={busy} onClick={() => save(m)}>{t('providers.save')}</button>
              <button className="btn-sm ghost" disabled={busy} onClick={() => setEditingId(null)}>{t('providers.cancel')}</button>
            </>
          ) : (
            <>
              <span className="provider-model-params">
                ctx {m.contextWindow.toLocaleString()} / max {m.maxTokens.toLocaleString()}
              </span>
              <button className="btn-sm ghost" onClick={() => startEdit(m)} title={t('providers.edit')}>
                <Pencil size={12} />
              </button>
              <button
                  className="btn-sm ghost danger"
                  disabled={busy}
                  title={t('providers.deleteModel')}
                  onClick={async () => {
                    if (!window.confirm(`${t('providers.deleteModelConfirm', { name: m.alias ?? m.id })}${models.length === 1 ? `\n${t('providers.deleteModelLast')}` : ''}`)) return
                    setBusy(true)
                    try {
                      await removeProviderModel(providerName, m.id)
                      onRefresh()
                    } catch (e) {
                      toast.error(t('providers.deleteModelFailed', { error: (e as Error).message }))
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
  const { t } = useTranslation('settings')
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
    if (!trimmed) return t('providers.keyEmpty')
    if (trimmed.length < 4) return t('providers.keyTooShort')
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
      toast.error(t('providers.saveKeyFailed', { error: (e as Error).message }))
    } finally { setBusy(false) }
  }

  const makeDefault = async () => {
    setBusy(true)
    try {
      await setProviderAsDefault(p.name)
      onRefresh()
    } catch (e) {
      toast.error(t('providers.setDefaultFailed', { error: (e as Error).message }))
    } finally { setBusy(false) }
  }

  const remove = async () => {
    if (p.isDefault) {
      toast.error(t('providers.cannotRemoveDefault'))
      return
    }
    setBusy(true)
    try {
      await removeConfigProvider(p.name)
      onRefresh()
    } catch (e) {
      toast.error(t('providers.removeFailed', { error: (e as Error).message }))
    } finally { setBusy(false) }
  }

  const addModel = async () => {
    const result = validateModel(modelState, t)
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
      toast.error(t('providers.addModelFailed', { error: (e as Error).message }))
    } finally { setBusy(false) }
  }

  return (
    <div className="provider-row">
      <div className="provider-header">
        <span className="provider-name">
          {p.label}
          {p.isDefault && <span className="badge accent">{t('providers.default')}</span>}
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
          <button className="btn-sm" disabled={busy} onClick={makeDefault}>{t('providers.setDefault')}</button>
        )}
        <button className="btn-sm" disabled={busy} onClick={() => setEditing(!editing)}>
          {editing ? t('providers.cancel') : t('providers.setKey')}
        </button>
        <button className="btn-sm" disabled={busy} onClick={() => { setManagingModels(!managingModels); setAddingModel(false) }}>
          {managingModels ? t('providers.collapseModels') : t('providers.manageModels')}
        </button>
        <button className="btn-sm" disabled={busy} onClick={() => { setAddingModel(!addingModel); setManagingModels(false) }}>
          {addingModel ? t('providers.cancel') : t('providers.addModel')}
        </button>
        {!p.isDefault && (
          <button className="btn-sm danger" disabled={busy} onClick={remove}>{t('providers.remove')}</button>
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
          <button className="btn-sm" disabled={busy} onClick={saveKey}>{t('providers.save')}</button>
          {keyError && <span className="provider-key-error">{keyError}</span>}
        </div>
      )}
      {addingModel && (
        <ModelForm
          state={modelState}
          onChange={(patch) => setModelState((prev) => ({ ...prev, ...patch }))}
          onSubmit={addModel}
          onCancel={() => { setAddingModel(false); setModelError(null); setModelState(emptyModel()) }}
          submitLabel={t('providers.saveModel')}
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
  const { t } = useTranslation('settings')
  const [expanded, setExpanded] = useState(false)
  const [keyInput, setKeyInput] = useState('')
  const [keyError, setKeyError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const validateKey = (v: string): string | null => {
    const trimmed = v.trim()
    if (!trimmed) return t('providers.keyRequired')
    if (trimmed.length < 4) return t('providers.keyTooShort')
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
      toast.error(t('providers.addProviderFailed', { error: (e as Error).message }))
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
        <button className="btn-sm" disabled={busy} onClick={add}>{t('providers.add')}</button>
        <button className="btn-sm ghost" disabled={busy} onClick={() => setExpanded(false)}>{t('providers.cancel')}</button>
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
  const { t } = useTranslation('settings')
  const [expanded, setExpanded] = useState(false)
  const [state, setState] = useState<CustomProviderFormState>(emptyCustomProvider())
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const add = async () => {
    const name = state.name.trim()
    if (!name) {
      setError(t('providers.nameRequired'))
      return
    }
    const baseUrl = state.baseUrl.trim()
    if (!baseUrl) {
      setError(t('providers.urlRequired'))
      return
    }
    try {
      new URL(baseUrl)
    } catch {
      setError(t('providers.urlInvalid'))
      return
    }
    const modelResult = validateModel(state.model, t)
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
      toast.error(t('providers.addProviderFailed', { error: (e as Error).message }))
    } finally { setBusy(false) }
  }

  if (!expanded) {
    return (
      <button className="preset-card" onClick={() => setExpanded(true)}>
        <span className="preset-label">{t('providers.customCardTitle')}</span>
        <span className="preset-model">{t('providers.customCardSubtitle')}</span>
      </button>
    )
  }

  return (
    <div className="preset-card preset-card-input custom-provider-card">
      <span className="preset-label">{t('providers.customTitle')}</span>
      <div className="provider-form-stack">
        <label className="provider-field">
          <span className="provider-field-label">{t('providers.name')}</span>
          <input
            type="text"
            placeholder={t('providers.namePlaceholder')}
            value={state.name}
            onChange={(e) => setState((prev) => ({ ...prev, name: e.target.value }))}
            disabled={busy}
          />
        </label>
        <label className="provider-field">
          <span className="provider-field-label">Base URL</span>
          <input
            type="text"
            placeholder={t('providers.baseUrlPlaceholder')}
            value={state.baseUrl}
            onChange={(e) => setState((prev) => ({ ...prev, baseUrl: e.target.value }))}
            disabled={busy}
          />
        </label>
        <label className="provider-field">
          <span className="provider-field-label">{t('providers.apiKeyOptional')}</span>
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
            <span className="provider-field-label">{t('providers.modelId')}</span>
            <input
              type="text"
              placeholder={t('providers.modelIdPlaceholder')}
              value={state.model.id}
              onChange={(e) => setState((prev) => ({ ...prev, model: { ...prev.model, id: e.target.value } }))}
              disabled={busy}
            />
          </label>
          <label className="provider-field">
            <span className="provider-field-label">{t('providers.alias')}</span>
            <input
              type="text"
              placeholder={t('providers.aliasPlaceholder')}
              value={state.model.alias}
              onChange={(e) => setState((prev) => ({ ...prev, model: { ...prev.model, alias: e.target.value } }))}
              disabled={busy}
            />
          </label>
          <label className="provider-field">
            <span className="provider-field-label">{t('providers.contextWindow')}</span>
            <input
              type="number"
              placeholder="128000"
              value={state.model.contextWindow}
              onChange={(e) => setState((prev) => ({ ...prev, model: { ...prev.model, contextWindow: e.target.value } }))}
              disabled={busy}
            />
          </label>
          <label className="provider-field">
            <span className="provider-field-label">{t('providers.maxTokens')}</span>
            <input
              type="number"
              placeholder="384000"
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
          <span>{t('providers.makeDefault')}</span>
        </label>
        <div className="provider-form-actions">
          <button className="btn-sm" disabled={busy} onClick={add}>{t('providers.add')}</button>
          <button className="btn-sm ghost" disabled={busy} onClick={() => { setExpanded(false); setError(null); setState(emptyCustomProvider()) }}>{t('providers.cancel')}</button>
        </div>
        {error && <span className="provider-key-error">{error}</span>}
      </div>
    </div>
  )
}

const PAGE_SIZE = 5

export function ProviderSettings() {
  const { t } = useTranslation('settings')
  const { data, isLoading, isError } = useConfigProviders()
  const qc = useQueryClient()
  const refresh = () => qc.invalidateQueries({ queryKey: qk.configProviders })
  const [page, setPage] = useState(0)

  if (isLoading) return <div className="meta">{t('providers.loading')}</div>
  if (isError) return <div className="meta warn">{t('providers.loadFailed')}</div>

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
            {t('providers.prevPage')}
          </button>
          <span>{t('providers.pageInfo', { page: safePage + 1, total: totalPages })}</span>
          <button
            className="btn-mini"
            disabled={safePage >= totalPages - 1}
            onClick={() => setPage(safePage + 1)}
          >
            {t('providers.nextPage')}
          </button>
        </div>
      )}

      <div className="preset-section">
        <div className="preset-header">{t('providers.addProvider')}</div>
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
