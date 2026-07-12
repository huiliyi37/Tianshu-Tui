import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { useConfigProviders, useVisionModelConfig, useSetVisionModelConfig } from '../state/queries'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

const INHERIT = '__inherit__'

/** Integrations → Vision model: configure a dedicated multimodal model that
 *  describes pasted/attached images when the primary model is not vision-capable. */
export function VisionModelSettings() {
  const { t } = useTranslation('settings')
  const { data: provData, isLoading: provLoading, isError: provError } = useConfigProviders()
  const { data: cfgData, isLoading: cfgLoading } = useVisionModelConfig()
  const setConfig = useSetVisionModelConfig()

  const [provider, setProvider] = useState<string>(INHERIT)
  const [model, setModel] = useState<string>(INHERIT)
  const [prompt, setPrompt] = useState('')
  const [maxTokens, setMaxTokens] = useState('1024')
  const [dirty, setDirty] = useState(false)

  const visionOptions = useMemo(() => {
    const out: { provider: string; model: string; label: string }[] = []
    if (!provData) return out
    for (const p of provData.providers) {
      for (const m of p.models) {
        if (m.supportsVision) {
          out.push({
            provider: p.name,
            model: m.id,
            label: `${p.label ?? p.name} / ${m.alias ?? m.id}`,
          })
        }
      }
    }
    return out
  }, [provData])

  const saved = cfgData?.config

  useEffect(() => {
    if (cfgLoading) return
    if (saved) {
      setProvider(saved.provider)
      setModel(saved.model)
      setPrompt(saved.prompt ?? '')
      setMaxTokens(String(saved.maxTokens))
    } else {
      setProvider(INHERIT)
      setModel(INHERIT)
      setPrompt('')
      setMaxTokens('1024')
    }
    setDirty(false)
  }, [saved, cfgLoading])

  const selectedProvider = provider === INHERIT ? null : provider
  const modelOptions = useMemo(
    () => visionOptions.filter((o) => o.provider === selectedProvider),
    [visionOptions, selectedProvider],
  )

  const handleProviderChange = (val: string) => {
    setProvider(val)
    setModel(INHERIT)
    setDirty(true)
  }

  const handleSave = async () => {
    if (provider === INHERIT || model === INHERIT) {
      await setConfig.mutateAsync(null)
      toast.success(t('visionModel.clearedToast'))
    } else {
      const mt = Number(maxTokens)
      if (!Number.isInteger(mt) || mt <= 0) {
        toast.error(t('visionModel.invalidMaxTokens'))
        return
      }
      await setConfig.mutateAsync({
        provider,
        model,
        ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
        maxTokens: mt,
      })
      toast.success(t('visionModel.savedToast'))
    }
    setDirty(false)
  }

  if (provLoading || cfgLoading) {
    return <div className="meta">{t('visionModel.loading')}</div>
  }
  if (provError) {
    return <div className="meta warn">{t('visionModel.loadFailed')}</div>
  }

  return (
    <div className="vision-model-settings flex flex-col gap-4">
      <div className="meta">{t('visionModel.intro')}</div>
      {visionOptions.length === 0 && (
        <div className="meta warn">{t('visionModel.noVisionModels')}</div>
      )}

      <label className="flex flex-col gap-1">
        <span className="text-xs text-text">{t('visionModel.provider')}</span>
        <Select
          value={provider}
          onValueChange={handleProviderChange}
          disabled={visionOptions.length === 0}
        >
          <SelectTrigger className="w-72">
            <SelectValue placeholder={t('visionModel.providerPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>{t('visionModel.inherit')}</SelectItem>
            {[...new Set(visionOptions.map((o) => o.provider))].map((p) => (
              <SelectItem key={p} value={p}>
                {p}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-text">{t('visionModel.model')}</span>
        <Select
          value={model}
          onValueChange={(v) => { setModel(v); setDirty(true) }}
          disabled={provider === INHERIT || modelOptions.length === 0}
        >
          <SelectTrigger className="w-72">
            <SelectValue placeholder={t('visionModel.modelPlaceholder')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>{t('visionModel.inherit')}</SelectItem>
            {modelOptions.map((o) => (
              <SelectItem key={`${o.provider}::${o.model}`} value={o.model}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-text">{t('visionModel.prompt')}</span>
        <textarea
          className="settings-input"
          rows={3}
          value={prompt}
          onChange={(e) => { setPrompt(e.target.value); setDirty(true) }}
          placeholder={t('visionModel.promptPlaceholder')}
          disabled={provider === INHERIT}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-text">{t('visionModel.maxTokens')}</span>
        <input
          className="settings-input"
          style={{ width: 120 }}
          type="number"
          value={maxTokens}
          onChange={(e) => { setMaxTokens(e.target.value); setDirty(true) }}
          disabled={provider === INHERIT}
        />
      </label>

      <div className="flex items-center gap-3">
        <button
          className="btn"
          onClick={() => void handleSave()}
          disabled={setConfig.isPending}
        >
          {setConfig.isPending ? t('visionModel.saving') : t('visionModel.save')}
        </button>
        {provider !== INHERIT && (
          <button
            className="btn ghost"
            onClick={() => { setProvider(INHERIT); setModel(INHERIT); setDirty(true) }}
            disabled={setConfig.isPending}
          >
            {t('visionModel.clear')}
          </button>
        )}
        {dirty && <span className="meta">{t('visionModel.dirty')}</span>}
      </div>
    </div>
  )
}
