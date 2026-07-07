import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation, Trans } from 'react-i18next'
import { toast } from 'sonner'
import {
  getRoutingConfig,
  setRoutingConfig,
  listConfigProviders,
  type RoutingConfig,
  type RoutingTarget,
  type CouncilSeatConfig,
  type ProviderListItem,
} from '../runtime/client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** Sub-agent worker profiles worth surfacing. Profile-keyed overrides apply to
 *  ANY worker carrying that profile — covers deliver_task review, council 议事会
 *  seats (council_expert), and team waves (patcher/reviewer/scouts). A profile
 *  override takes precedence over workers.routing task routing in the
 *  coordinator, so it's the right lever for "council strong, others cheap". */
const SUBAGENT_PROFILES: { key: string; label: string }[] = [
  { key: 'reviewer', label: 'reviewer' },
  { key: 'adversarial_verifier', label: 'adversarial_verifier' },
  { key: 'verifier', label: 'verifier' },
  { key: 'patcher', label: 'patcher' },
  { key: 'council_expert', label: 'council_expert' },
  { key: 'code_scout', label: 'code_scout' },
  { key: 'doc_scout', label: 'doc_scout' },
]

/** The 5 capability tasks that workers.routing maps to a named profile. */
const CAPABILITY_TASKS = [
  'repo_summarization',
  'code_edit',
  'test_failure_diagnosis',
  'compaction',
  'risky_refactor',
] as const

const INHERIT = '__inherit__'

/** Built-in star-domain ids valid as council seat authorities. An authority that
 *  is NOT a loaded domain makes the seat worker tool-less (fail-closed) and skips
 *  cognitive injection — so we suggest these. Custom domains (card frontmatter)
 *  are still allowed, hence a datalist (suggest) rather than a hard select. */
const BUILTIN_DOMAINS = [
  'tianshu', 'pojun', 'tianfu', 'tianliang', 'tianquan',
  'tianji', 'tianxuan', 'fu', 'wenqu', 'yaoguang',
]

function encodeTarget(t: RoutingTarget): string {
  return `${t.provider}::${t.model}`
}

function decodeTarget(value: string): RoutingTarget | null {
  if (value === INHERIT) return null
  const idx = value.indexOf('::')
  if (idx < 0) return null
  return { provider: value.slice(0, idx), model: value.slice(idx + 2) }
}

/** Flatten configured providers into selectable provider/model options. */
function modelOptions(providers: ProviderListItem[]): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = []
  for (const p of providers) {
    for (const m of p.models) {
      out.push({ value: `${p.name}::${m.id}`, label: `${p.name} / ${m.alias ?? m.id}` })
    }
  }
  return out
}

/** Profiles that are safe and recommended to route to a cheap/fast model. */
const RECOMMENDED_PROFILES = SUBAGENT_PROFILES
  .filter((p) => p.key !== 'council_expert')
  .map((p) => p.key)

/** Pick a sensible default sub-agent model: Flash > DeepSeek > first available. */
function findRecommendedTarget(options: { value: string; label: string }[]): string | null {
  if (options.length === 0) return null
  const flash = options.find((o) => /flash/i.test(o.label) || /flash/i.test(o.value))
  if (flash) return flash.value
  const deepseek = options.find((o) => /deepseek/i.test(o.label) || /deepseek/i.test(o.value))
  if (deepseek) return deepseek.value
  return options[0]!.value
}

export function RoutingSettings() {
  const { t } = useTranslation('settings')
  const [config, setConfig] = useState<RoutingConfig | null>(null)
  const [providers, setProviders] = useState<ProviderListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)

  const load = useCallback(() => {
    setLoading(true)
    Promise.all([getRoutingConfig(), listConfigProviders()])
      .then(([routing, provs]) => {
        setConfig(routing)
        setProviders(provs.providers)
        setError(null)
        setDirty(false)
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => { load() }, [load])

  const options = useMemo(() => modelOptions(providers), [providers])
  const recommendedValue = useMemo(() => findRecommendedTarget(options), [options])
  const workerProfileNames = useMemo(
    () => (config ? Object.keys(config.workers.profiles) : []),
    [config],
  )
  // Surface any override keys present in config but not in the well-known list
  // (e.g. goal_judge or a hand-edited profile) so they stay visible/editable
  // rather than silently persisting on save.
  const allProfiles = useMemo(() => {
    if (!config) return SUBAGENT_PROFILES
    const known = new Set(SUBAGENT_PROFILES.map((p) => p.key))
    const extra = Object.keys(config.review.profiles)
      .filter((k) => !known.has(k))
      .map((k) => ({ key: k, label: k }))
    return [...SUBAGENT_PROFILES, ...extra]
  }, [config])

  const knownProfileKeys = useMemo(() => new Set(SUBAGENT_PROFILES.map((p) => p.key)), [])
  const profileHint = (key: string) =>
    knownProfileKeys.has(key) ? t(`routing.profileHints.${key}`) : t('routing.customProfile')

  const needsRecommendation = useMemo(() => {
    if (!config || !recommendedValue) return false
    return RECOMMENDED_PROFILES.some((key) => !config.review.profiles[key])
  }, [config, recommendedValue])

  const applyRecommendation = useCallback(() => {
    if (!config || !recommendedValue) return
    const target = decodeTarget(recommendedValue)
    if (!target) return
    setConfig((prev) => {
      if (!prev) return prev
      const profiles = { ...prev.review.profiles }
      for (const key of RECOMMENDED_PROFILES) {
        profiles[key] = target
      }
      return { ...prev, review: { ...prev.review, profiles } }
    })
    setDirty(true)
  }, [config, recommendedValue])

  const setReviewProfile = (profileKey: string, value: string) => {
    setConfig((prev) => {
      if (!prev) return prev
      const profiles = { ...prev.review.profiles }
      const target = decodeTarget(value)
      if (target) profiles[profileKey] = target
      else delete profiles[profileKey]
      return { ...prev, review: { ...prev.review, profiles } }
    })
    setDirty(true)
  }

  const setReviewFlag = (flag: 'skipAuto' | 'mechanicalFastPath', val: boolean) => {
    setConfig((prev) => (prev ? { ...prev, review: { ...prev.review, [flag]: val } } : prev))
    setDirty(true)
  }

  const setTaskRoute = (task: string, profileName: string) => {
    setConfig((prev) => {
      if (!prev) return prev
      const routing = { ...prev.workers.routing }
      if (profileName === INHERIT) delete routing[task]
      else routing[task] = profileName
      return { ...prev, workers: { ...prev.workers, routing } }
    })
    setDirty(true)
  }

  const mutateSeats = (fn: (seats: CouncilSeatConfig[]) => CouncilSeatConfig[]) => {
    setConfig((prev) => (prev ? { ...prev, council: { ...prev.council, seats: fn(prev.council.seats) } } : prev))
    setDirty(true)
  }

  const addSeat = () => mutateSeats((seats) => [...seats, { authority: '' }])
  const removeSeat = (idx: number) => mutateSeats((seats) => seats.filter((_, i) => i !== idx))
  const updateSeat = (idx: number, patch: Partial<CouncilSeatConfig>) =>
    mutateSeats((seats) => seats.map((s, i) => (i === idx ? { ...s, ...patch } : s)))

  /** Model select for a seat: clearing both provider+model means "no override"
   *  (the seat inherits the session model). */
  const setSeatModel = (idx: number, value: string) => {
    const t = decodeTarget(value)
    updateSeat(idx, t ? { provider: t.provider, model: t.model } : { provider: undefined, model: undefined })
  }

  const save = async () => {
    if (!config) return
    setSaving(true)
    setError(null)
    try {
      await setRoutingConfig({ review: config.review, workers: config.workers, council: config.council })
      toast.success(t('routing.savedToast'))
      setDirty(false)
    } catch (err) {
      const msg = (err as Error).message
      setError(msg)
      toast.error(t('routing.saveFailedToast', { error: msg }))
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="meta">{t('routing.loading')}</div>
  if (!config) return <div className="meta warn">{error ?? t('routing.loadFailed')}</div>

  const seatAuthorities = config.council.seats.map((s) => s.authority.trim())
  const hasEmptySeat = seatAuthorities.some((a) => !a)
  const dupAuthority = seatAuthorities.find((a, i) => a && seatAuthorities.indexOf(a) !== i)
  const councilInvalid = hasEmptySeat || Boolean(dupAuthority)

  return (
    <div className="routing-settings flex flex-col gap-5">
      <div className="routing-intro">
        {t('routing.intro')}
      </div>

      {/* agent.review.profiles — 按 profile 覆盖子代理模型（review / council / team 通用） */}
      <section className="routing-card">
        <h5 className="routing-card-title">{t('routing.profileCardTitle')}</h5>
        <div className="routing-card-hint">
          <Trans t={t} i18nKey="routing.profileCardHint" components={{ strong: <strong /> }} />
        </div>

        {needsRecommendation && (
          <div className="routing-recommendation">
            <div>
              <strong>{t('routing.recommendTitle')}</strong>
              <p>{t('routing.recommendDesc')}</p>
            </div>
            <button className="btn-sm" onClick={applyRecommendation}>{t('routing.recommendApply')}</button>
          </div>
        )}
        {!recommendedValue && providers.length > 0 && (
          <div className="routing-recommendation muted">
            {t('routing.noCheapModel')}
          </div>
        )}
        {allProfiles.map((p) => {
          const current = config.review.profiles[p.key]
          return (
            <label key={p.key} className="flex items-center justify-between gap-3">
              <span className="flex flex-col">
                <span className="text-xs font-mono text-text">{p.label}</span>
                <span className="meta">{profileHint(p.key)}</span>
              </span>
              <Select
                value={current ? encodeTarget(current) : INHERIT}
                onValueChange={(v) => { if (v) setReviewProfile(p.key, v) }}
              >
                <SelectTrigger className="w-56 shrink-0">
                  <SelectValue placeholder={t('routing.inheritPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>{t('routing.inheritDefault')}</SelectItem>
                  {options.map((o) => (
                    <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          )
        })}

        <label className="flex items-center gap-2 text-xs text-text cursor-pointer select-none mt-1">
          <input
            type="checkbox"
            checked={config.review.skipAuto}
            onChange={(e) => setReviewFlag('skipAuto', e.target.checked)}
            className="rounded border-border text-accent focus:ring-accent h-3.5 w-3.5"
          />
          <span>{t('routing.skipAuto')}</span>
        </label>
        <label className="flex items-center gap-2 text-xs text-text cursor-pointer select-none">
          <input
            type="checkbox"
            checked={config.review.mechanicalFastPath}
            onChange={(e) => setReviewFlag('mechanicalFastPath', e.target.checked)}
            className="rounded border-border text-accent focus:ring-accent h-3.5 w-3.5"
          />
          <span>{t('routing.mechanicalFastPath')}</span>
        </label>
      </section>

      {/* workers — 通用能力任务路由 */}
      <section className="routing-card">
        <h5 className="routing-card-title">{t('routing.taskCardTitle')}</h5>
        <div className="routing-card-hint">
          {t('routing.taskCardHint')}
        </div>
        {CAPABILITY_TASKS.map((taskKey) => {
          const current = config.workers.routing[taskKey] ?? INHERIT
          return (
            <label key={taskKey} className="flex items-center justify-between gap-3">
              <span className="text-xs font-mono text-text">{t(`routing.tasks.${taskKey}`)}</span>
              <Select value={current} onValueChange={(v) => { if (v) setTaskRoute(taskKey, v) }}>
                <SelectTrigger className="w-56 shrink-0">
                  <SelectValue placeholder={t('routing.inheritPlaceholder')} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>{t('routing.inheritDefault')}</SelectItem>
                  {workerProfileNames.map((name) => {
                    const tgt = config.workers.profiles[name]
                    return (
                      <SelectItem key={name} value={name}>
                        {name}（{tgt.provider} / {tgt.model}）
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
            </label>
          )
        })}
      </section>

      {/* agent.council.seats — 异构议事会：每席独立 provider/model */}
      <section className="routing-card">
        <h5 className="routing-card-title">{t('routing.councilCardTitle')}</h5>
        <div className="routing-card-hint">
          <Trans t={t} i18nKey="routing.councilCardHint1" components={{ strong: <strong /> }} />
          <br />
          <Trans t={t} i18nKey="routing.councilCardHint2" components={{ strong: <strong /> }} />
        </div>

        <datalist id="council-domains">
          {BUILTIN_DOMAINS.map((d) => <option key={d} value={d} />)}
        </datalist>

        {config.council.seats.length === 0 && (
          <div className="meta">{t('routing.noSeats')}</div>
        )}

        {config.council.seats.map((seat, idx) => {
          const seatModelValue = seat.provider && seat.model ? `${seat.provider}::${seat.model}` : INHERIT
          return (
            <div key={idx} className="flex flex-col gap-2 rounded border border-border p-2.5">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  list="council-domains"
                  value={seat.authority}
                  onChange={(e) => updateSeat(idx, { authority: e.target.value.trim() })}
                  placeholder={t('routing.seatAuthorityPlaceholder')}
                  className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs font-mono text-text focus:border-accent focus:outline-none"
                />
                <Select value={seatModelValue} onValueChange={(v) => { if (v) setSeatModel(idx, v) }}>
                  <SelectTrigger className="w-56 shrink-0">
                    <SelectValue placeholder={t('routing.inheritPlaceholder')} />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>{t('routing.inheritDefault')}</SelectItem>
                    {options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  className="shrink-0 rounded border border-border px-2 py-1 text-xs text-text hover:border-accent hover:text-accent"
                  onClick={() => removeSeat(idx)}
                  title={t('routing.removeSeat')}
                  aria-label={t('routing.removeSeat')}
                >
                  ✕
                </button>
              </div>
              <input
                type="text"
                value={seat.charter ?? ''}
                onChange={(e) => updateSeat(idx, { charter: e.target.value || undefined })}
                placeholder={t('routing.charterPlaceholder')}
                className="rounded border border-border bg-transparent px-2 py-1 text-xs text-text focus:border-accent focus:outline-none"
              />
            </div>
          )
        })}

        <button className="btn self-start" onClick={addSeat}>{t('routing.addSeat')}</button>
        {hasEmptySeat && (
          <span className="meta warn">{t('routing.emptySeatWarn')}</span>
        )}
        {dupAuthority && (
          <span className="meta warn">{t('routing.dupAuthorityWarn', { authority: dupAuthority })}</span>
        )}
      </section>

      {error && <div className="meta warn">{error}</div>}

      <div className="flex items-center gap-3">
        <button
          className="btn"
          onClick={save}
          disabled={saving || !dirty || councilInvalid}
        >
          {saving ? t('routing.saving') : t('routing.save')}
        </button>
        {dirty && <span className="meta">{t('routing.dirty')}</span>}
      </div>
    </div>
  )
}
