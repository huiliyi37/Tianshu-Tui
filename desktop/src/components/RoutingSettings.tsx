import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import {
  getRoutingConfig,
  setRoutingConfig,
  listConfigProviders,
  type RoutingConfig,
  type RoutingTarget,
  type ProviderListItem,
} from '../runtime/client'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** Review worker profiles worth surfacing. `reviewer` is the one the
 *  deliver_task post-commit auto review actually uses. */
const REVIEW_PROFILES: { key: string; label: string; hint: string }[] = [
  { key: 'reviewer', label: 'reviewer', hint: '提交后自动审查 / L3 编队审查' },
  { key: 'adversarial_verifier', label: 'adversarial_verifier', hint: 'L2 对抗验证' },
  { key: 'verifier', label: 'verifier', hint: '验证循环' },
  { key: 'patcher', label: 'patcher', hint: '补丁建议' },
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

  const save = async () => {
    if (!config) return
    setSaving(true)
    setError(null)
    try {
      await setRoutingConfig({ review: config.review, workers: config.workers })
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

      {/* agent.review — 审查 worker 路由 */}
      <section className="flex flex-col gap-3">
        <h5 className="text-xs font-semibold text-text">审查 worker 模型（agent.review）</h5>
        {REVIEW_PROFILES.map((p) => {
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

      {error && <div className="meta warn">{error}</div>}

      <div className="flex items-center gap-3">
        <button className="btn" onClick={save} disabled={saving || !dirty}>
          {saving ? '保存中…' : '保存路由'}
        </button>
        {dirty && <span className="meta">有未保存的更改</span>}
      </div>
    </div>
  )
}
