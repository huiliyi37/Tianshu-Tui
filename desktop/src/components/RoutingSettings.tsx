import { useState, useEffect, useCallback, useMemo } from 'react'
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
const SUBAGENT_PROFILES: { key: string; label: string; hint: string }[] = [
  { key: 'reviewer', label: 'reviewer', hint: '提交后自动审查 / L3 编队审查' },
  { key: 'adversarial_verifier', label: 'adversarial_verifier', hint: 'L2 对抗验证 / team 验证' },
  { key: 'verifier', label: 'verifier', hint: '验证循环' },
  { key: 'patcher', label: 'patcher', hint: '补丁建议 / team 编码' },
  { key: 'council_expert', label: 'council_expert', hint: '议事会席位（覆盖优先于任务路由）' },
  { key: 'code_scout', label: 'code_scout', hint: 'team 代码侦察' },
  { key: 'doc_scout', label: 'doc_scout', hint: 'team 文档侦察' },
]

/** The 5 capability tasks that workers.routing maps to a named profile. */
const CAPABILITY_TASKS: { key: string; label: string }[] = [
  { key: 'repo_summarization', label: 'repo_summarization（仓库摘要）' },
  { key: 'code_edit', label: 'code_edit（代码编辑）' },
  { key: 'test_failure_diagnosis', label: 'test_failure_diagnosis（测试诊断）' },
  { key: 'compaction', label: 'compaction（上下文压缩）' },
  { key: 'risky_refactor', label: 'risky_refactor（高风险重构）' },
]

const INHERIT = '__inherit__'

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

export function RoutingSettings() {
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
      .map((k) => ({ key: k, label: k, hint: '自定义 profile' }))
    return [...SUBAGENT_PROFILES, ...extra]
  }, [config])

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
      toast.success('子代理路由已保存')
      setDirty(false)
    } catch (err) {
      const msg = (err as Error).message
      setError(msg)
      toast.error(`保存失败：${msg}`)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <div className="meta">加载子代理路由配置…</div>
  if (!config) return <div className="meta warn">{error ?? '无法读取路由配置'}</div>

  return (
    <div className="routing-settings flex flex-col gap-5">
      <div className="meta">
        主会话与子代理可用不同 provider + 模型。典型用法：主会话用重型模型，审查 / 杂活子代理用便宜快的 Flash，
        避免 GLM/Kimi/Codex 这类无前缀缓存的 provider 因子代理并发请求淘汰主会话缓存。
        目标 provider 须已在「Provider」里配置且有 API Key，否则该项会静默回退到主会话模型。
      </div>

      {/* agent.review.profiles — 按 profile 覆盖子代理模型（review / council / team 通用） */}
      <section className="flex flex-col gap-3">
        <h5 className="text-xs font-semibold text-text">按 profile 覆盖子代理模型（agent.review.profiles）</h5>
        <div className="meta">
          按 worker profile 名覆盖,命中所有携带该 profile 的子代理——涵盖提交后审查、议事会席位（council_expert）、
          team 编队（patcher / reviewer / scouts）。profile 覆盖<strong>优先于</strong>下方的任务路由,
          适合「议事会用强模型、其余子代理走 Flash」这类精细控制。
        </div>
        {allProfiles.map((p) => {
          const current = config.review.profiles[p.key]
          return (
            <label key={p.key} className="flex items-center justify-between gap-3">
              <span className="flex flex-col">
                <span className="text-xs font-mono text-text">{p.label}</span>
                <span className="meta">{p.hint}</span>
              </span>
              <Select
                value={current ? encodeTarget(current) : INHERIT}
                onValueChange={(v) => { if (v) setReviewProfile(p.key, v) }}
              >
                <SelectTrigger className="w-56 shrink-0">
                  <SelectValue placeholder="继承主会话" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>继承主会话（默认）</SelectItem>
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
          <span>关闭提交后自动审查（skipAuto）</span>
        </label>
        <label className="flex items-center gap-2 text-xs text-text cursor-pointer select-none">
          <input
            type="checkbox"
            checked={config.review.mechanicalFastPath}
            onChange={(e) => setReviewFlag('mechanicalFastPath', e.target.checked)}
            className="rounded border-border text-accent focus:ring-accent h-3.5 w-3.5"
          />
          <span>纯文档 / 重命名变更跳过审查（mechanicalFastPath）</span>
        </label>
      </section>

      {/* workers — 通用能力任务路由 */}
      <section className="flex flex-col gap-3">
        <h5 className="text-xs font-semibold text-text">通用子代理任务路由（workers.routing）</h5>
        <div className="meta">
          每个能力任务指向一个命名档位（在 workers.profiles 中定义，如 cheap-flash → DeepSeek Flash）。
        </div>
        {CAPABILITY_TASKS.map((task) => {
          const current = config.workers.routing[task.key] ?? INHERIT
          return (
            <label key={task.key} className="flex items-center justify-between gap-3">
              <span className="text-xs font-mono text-text">{task.label}</span>
              <Select value={current} onValueChange={(v) => { if (v) setTaskRoute(task.key, v) }}>
                <SelectTrigger className="w-56 shrink-0">
                  <SelectValue placeholder="继承主会话" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>继承主会话（默认）</SelectItem>
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
      <section className="flex flex-col gap-3">
        <h5 className="text-xs font-semibold text-text">异构议事会席位（agent.council.seats）</h5>
        <div className="meta">
          给每个议事会席位单独指定模型,实现「天权用 DeepSeek Pro、天府用 GLM」这类<strong>跨模型会诊</strong>——不同模型不同视角,
          且各跑各的服务端缓存互不挤兑。留空则用内置默认（tianquan / tianfu / tianxuan,全席同模型）。
          席位级覆盖<strong>优先于</strong>上方 council_expert 的 profile 覆盖。
        </div>

        {config.council.seats.length === 0 && (
          <div className="meta">未配置自定义席位 —— 使用内置默认 3 席。</div>
        )}

        {config.council.seats.map((seat, idx) => {
          const seatModelValue = seat.provider && seat.model ? `${seat.provider}::${seat.model}` : INHERIT
          return (
            <div key={idx} className="flex flex-col gap-2 rounded border border-border p-2.5">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={seat.authority}
                  onChange={(e) => updateSeat(idx, { authority: e.target.value })}
                  placeholder="席位 authority（如 tianquan）"
                  className="flex-1 rounded border border-border bg-transparent px-2 py-1 text-xs font-mono text-text focus:border-accent focus:outline-none"
                />
                <Select value={seatModelValue} onValueChange={(v) => { if (v) setSeatModel(idx, v) }}>
                  <SelectTrigger className="w-56 shrink-0">
                    <SelectValue placeholder="继承主会话" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>继承主会话（默认）</SelectItem>
                    {options.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <button
                  className="shrink-0 rounded border border-border px-2 py-1 text-xs text-text hover:border-accent hover:text-accent"
                  onClick={() => removeSeat(idx)}
                  title="移除该席位"
                  aria-label="移除该席位"
                >
                  ✕
                </button>
              </div>
              <input
                type="text"
                value={seat.charter ?? ''}
                onChange={(e) => updateSeat(idx, { charter: e.target.value || undefined })}
                placeholder="席位职守 charter（可选，如：架构与正确性）"
                className="rounded border border-border bg-transparent px-2 py-1 text-xs text-text focus:border-accent focus:outline-none"
              />
            </div>
          )
        })}

        <button className="btn self-start" onClick={addSeat}>+ 添加席位</button>
        {config.council.seats.some((s) => !s.authority.trim()) && (
          <span className="meta warn">每个席位都需填 authority,否则无法保存。</span>
        )}
      </section>

      {error && <div className="meta warn">{error}</div>}

      <div className="flex items-center gap-3">
        <button
          className="btn"
          onClick={save}
          disabled={saving || !dirty || config.council.seats.some((s) => !s.authority.trim())}
        >
          {saving ? '保存中…' : '保存路由'}
        </button>
        {dirty && <span className="meta">有未保存的更改</span>}
      </div>
    </div>
  )
}
