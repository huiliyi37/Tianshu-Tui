import { useState, useEffect, useCallback, useMemo } from 'react'
import { useUiState, useUiDispatch } from '../state/store'
import { listSkillsDetailed, setSkillEnabled, listInstallableSkills, installSkills } from '../runtime/client'
import type { SkillStatus, InstallableSkill } from '../runtime/types'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

/** source → 中文标签 + 样式类 */
function sourceBadge(source: string): { label: string; cls: string } {
  switch (source) {
    case 'builtin': return { label: '内置', cls: 'src-builtin' }
    case 'project-claude': return { label: 'Claude', cls: 'src-claude' }
    case 'global-claude': return { label: 'Claude·全局', cls: 'src-claude' }
    default: return { label: '项目', cls: 'src-rivet' }
  }
}

/** Deterministic tile hue class from the skill name (store-card icon). */
function tileClass(name: string): string {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return `tile-${h % 6}`
}

/** Human-readable install location for the detail dialog (API carries no path). */
function skillPathHint(source: string, name: string): string {
  switch (source) {
    case 'builtin': return '内置注册表（随天枢发布）'
    case 'project-claude': return `.claude/skills/${name}/SKILL.md`
    case 'global-claude': return `~/.claude/skills/${name}/SKILL.md`
    default: return `.rivet/skills/${name}/SKILL.md`
  }
}

/** Detail-dialog target: a loaded skill or a discoverable (installable) one. */
type SkillDetail =
  | { kind: 'loaded'; skill: SkillStatus }
  | { kind: 'installable'; skill: InstallableSkill }

/**
 * Skills store surface（Wave 5 — 对标 Codex「精致 App Store」）：
 * 网格卡片（图标/名称/描述/来源 badge/启停开关）+ 内置与项目分组保留 +
 * 可安装技能提为「发现」区一键安装 + 点击卡片开详情 Dialog。
 * 纯呈现层改造：API（listSkillsDetailed/setSkillEnabled/installSkills）不动。
 */
export function SkillsSurface() {
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessionId = ui.activeSessionId
  const [skills, setSkills] = useState<SkillStatus[]>([])
  const [loadErrors, setLoadErrors] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  // Skills installed this session but not yet loaded (registry is intentionally
  // not hot-loaded to protect the prefix cache). Shown as pending "重开线程生效".
  const [pendingInstalled, setPendingInstalled] = useState<string[]>([])

  const fetchSkills = useCallback(() => {
    if (!sessionId) return
    setLoading(true)
    listSkillsDetailed(sessionId)
      .then((res) => { setSkills(res.skills); setLoadErrors(res.loadErrors); setError(null) })
      .catch((err) => setError((err as Error).message))
      .finally(() => setLoading(false))
  }, [sessionId])

  useEffect(() => { fetchSkills() }, [fetchSkills])

  const toggle = useCallback((name: string, enabled: boolean) => {
    if (!sessionId) return
    // Optimistic update
    setSkills((prev) => prev.map((s) => s.name === name ? { ...s, enabled } : s))
    setSkillEnabled(sessionId, name, enabled).catch(() => {
      // Revert on failure
      setSkills((prev) => prev.map((s) => s.name === name ? { ...s, enabled: !enabled } : s))
    })
  }, [sessionId])

  // ── 发现区（Install — copy from .claude/skills into .rivet/skills）──
  const [installable, setInstallable] = useState<InstallableSkill[]>([])
  const [installedCount, setInstalledCount] = useState(0)
  const [recommendedMax, setRecommendedMax] = useState(5)
  const [installLoading, setInstallLoading] = useState(false)
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [installNotice, setInstallNotice] = useState<string | null>(null)
  // Name awaiting a second click when installing past the recommended cap.
  const [confirmName, setConfirmName] = useState<string | null>(null)

  const overCap = installedCount >= recommendedMax

  useEffect(() => {
    if (!sessionId) return
    setInstallLoading(true)
    listInstallableSkills(sessionId)
      .then((res) => {
        setInstallable(res.skills)
        setInstalledCount(res.installedCount)
        setRecommendedMax(res.recommendedMax)
      })
      .catch(() => { /* 发现区为增强项 — 扫描失败不阻塞主列表 */ })
      .finally(() => setInstallLoading(false))
  }, [sessionId])

  const doInstall = useCallback((name: string) => {
    if (!sessionId) return
    setConfirmName(null)
    setInstalling((prev) => new Set(prev).add(name))
    installSkills(sessionId, [name])
      .then((res) => {
        if (res.copied.includes(name)) {
          setInstallable((prev) => prev.map((s) => s.name === name ? { ...s, installed: true } : s))
          setInstalledCount((c) => c + 1)
          setPendingInstalled((prev) => prev.includes(name) ? prev : [...prev, name])
          setInstallNotice('已复制到 .rivet/skills/，需新开线程才生效——会话内热加载新技能会打碎前缀缓存，成本可达几十倍。')
          // Refetch so any state that DID change is reflected; the just-installed
          // skill stays "pending" until a new thread reloads the registry.
          fetchSkills()
        } else if (res.skipped.includes(name)) {
          setInstallable((prev) => prev.map((s) => s.name === name ? { ...s, installed: true } : s))
        } else if (res.errors.length > 0) {
          setError(res.errors.join('；'))
        }
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setInstalling((prev) => { const n = new Set(prev); n.delete(name); return n }))
  }, [sessionId, fetchSkills])

  // Skills already present in the loaded list don't need the "pending" chip.
  const loadedNames = useMemo(() => new Set(skills.map((s) => s.name)), [skills])
  const trulyPending = useMemo(
    () => pendingInstalled.filter((n) => !loadedNames.has(n)),
    [pendingInstalled, loadedNames],
  )

  const openNewThread = useCallback(() => {
    dispatch({ type: 'openNew', open: true })
  }, [dispatch])

  // Past the recommended cap, require a second click before installing.
  const install = useCallback((name: string) => {
    if (overCap && confirmName !== name) {
      setConfirmName(name)
      return
    }
    doInstall(name)
  }, [overCap, confirmName, doInstall])

  const enabledCount = skills.filter((s) => s.enabled).length

  // 按来源分组：内置技能 vs 项目技能。搜索时统一过滤（含发现区）。
  const q = query.trim().toLowerCase()
  const matchLoaded = useCallback((s: SkillStatus) =>
    !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q), [q])
  const matchInstallable = useCallback((s: InstallableSkill) =>
    !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q), [q])

  const builtinSkills = useMemo(() => skills.filter((s) => s.source === 'builtin' && matchLoaded(s)), [skills, matchLoaded])
  const projectSkills = useMemo(() => skills.filter((s) => s.source !== 'builtin' && matchLoaded(s)), [skills, matchLoaded])
  const discoverSkills = useMemo(() => installable.filter(matchInstallable), [installable, matchInstallable])

  if (!sessionId) {
    return (
      <div className="single-pane skills">
        <div className="panel-header"><span>技能</span></div>
        <div className="skills-empty-hero">
          <div className="skills-empty-glyph" aria-hidden>◈</div>
          <p>请先选择一个线程以查看技能配置</p>
        </div>
      </div>
    )
  }

  const renderCard = (s: SkillStatus) => {
    const badge = sourceBadge(s.source)
    return (
      <div
        key={s.name}
        className={`skill-store-card${s.enabled ? ' enabled' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => setDetail({ kind: 'loaded', skill: s })}
        onKeyDown={(e) => { if (e.key === 'Enter') setDetail({ kind: 'loaded', skill: s }) }}
      >
        <div className="skill-store-head">
          <div className={`skill-tile ${tileClass(s.name)}`} aria-hidden>
            {s.name.slice(0, 1).toUpperCase()}
          </div>
          <button
            className={`skill-toggle ${s.enabled ? 'on' : ''}`}
            role="switch"
            aria-checked={s.enabled}
            aria-label={s.enabled ? `禁用 ${s.name}` : `启用 ${s.name}`}
            onClick={(e) => { e.stopPropagation(); toggle(s.name, !s.enabled) }}
          >
            <span className="skill-toggle-knob" />
          </button>
        </div>
        <div className="skill-store-name">{s.name}</div>
        <div className="skill-store-desc">{s.description || '（无描述）'}</div>
        <div className="skill-store-foot">
          <span className={`skill-src-chip ${badge.cls}`}>{badge.label}</span>
        </div>
      </div>
    )
  }

  const renderDiscoverCard = (s: InstallableSkill) => {
    const badge = sourceBadge(s.source)
    const busy = installing.has(s.name)
    const confirming = confirmName === s.name
    return (
      <div
        key={`inst-${s.name}`}
        className="skill-store-card discover"
        role="button"
        tabIndex={0}
        onClick={() => setDetail({ kind: 'installable', skill: s })}
        onKeyDown={(e) => { if (e.key === 'Enter') setDetail({ kind: 'installable', skill: s }) }}
      >
        <div className="skill-store-head">
          <div className={`skill-tile ${tileClass(s.name)}`} aria-hidden>
            {s.name.slice(0, 1).toUpperCase()}
          </div>
          <button
            className={`skills-install-action${confirming ? ' confirm' : ''}`}
            disabled={s.installed || busy}
            onClick={(e) => { e.stopPropagation(); install(s.name) }}
          >
            {s.installed ? '已安装' : busy ? '安装中…' : confirming ? '确认安装?' : '安装'}
          </button>
        </div>
        <div className="skill-store-name">{s.name}</div>
        <div className="skill-store-desc">{s.description || '（无描述）'}</div>
        <div className="skill-store-foot">
          <span className={`skill-src-chip ${badge.cls}`}>{badge.label}</span>
        </div>
      </div>
    )
  }

  const hasResults = builtinSkills.length > 0 || projectSkills.length > 0 || discoverSkills.length > 0

  return (
    <div className="single-pane skills skills-store">
      <div className="panel-header">
        <span>技能</span>
        <span className="meta">{enabledCount}/{skills.length} 已启用</span>
      </div>

      <div className="skills-toolbar">
        <input
          className="skills-search"
          type="text"
          placeholder="搜索技能…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && (
        <div className="skills-empty-hero"><div className="skills-empty-glyph spin" aria-hidden>◌</div><p>加载中…</p></div>
      )}
      {error && <div className="meta warn">{error}</div>}

      {loadErrors.length > 0 && (
        <div className="skills-load-errors">
          <div className="skills-group-label">加载失败（{loadErrors.length}）</div>
          <div className="meta warn">这些技能已在 .rivet/skills/ 但无法解析（多为 frontmatter 缺失/格式错误），修正后重开线程即可生效：</div>
          <ul className="skills-error-list">
            {loadErrors.map((e, i) => <li key={`le-${i}`}>{e}</li>)}
          </ul>
        </div>
      )}

      {installNotice && (
        <div className="meta warn skills-install-notice">
          <span>{installNotice}</span>
          <button className="skills-newthread-btn" onClick={openNewThread}>新建线程以启用</button>
        </div>
      )}

      {!q && trulyPending.length > 0 && (
        <>
          <div className="skills-group-label">待生效（重开线程）</div>
          <div className="skills-grid">
            {trulyPending.map((name) => (
              <div key={`pending-${name}`} className="skill-store-card pending">
                <div className="skill-store-head">
                  <div className={`skill-tile ${tileClass(name)}`} aria-hidden>{name.slice(0, 1).toUpperCase()}</div>
                  <button className="skills-newthread-btn" onClick={openNewThread}>新建线程</button>
                </div>
                <div className="skill-store-name">{name}</div>
                <div className="skill-store-desc">已安装，新开线程后可启用</div>
                <div className="skill-store-foot">
                  <span className="skill-src-chip src-claude">Claude</span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}

      {!loading && !hasResults && (
        <div className="skills-empty-hero">
          <div className="skills-empty-glyph" aria-hidden>◈</div>
          <p>{query ? '没有匹配的技能' : '暂无可用技能'}</p>
          {!query && <p className="skills-empty-hint">将技能放入 .rivet/skills/ 或在配置中 importFromClaude</p>}
        </div>
      )}

      {projectSkills.length > 0 && (
        <>
          <div className="skills-group-label">项目技能</div>
          <div className="skills-grid">{projectSkills.map(renderCard)}</div>
        </>
      )}
      {builtinSkills.length > 0 && (
        <>
          <div className="skills-group-label">内置技能</div>
          <div className="skills-grid">{builtinSkills.map(renderCard)}</div>
        </>
      )}

      {(discoverSkills.length > 0 || installLoading) && (
        <>
          <div className="skills-group-label">
            发现
            <span className={`skills-cap-inline${overCap ? ' over' : ''}`}>
              已安装 {installedCount} 个 · 建议 ≤ {recommendedMax}
              {overCap && '，已达上限，非必要不再安装（点两次确认）'}
            </span>
          </div>
          <div className="skills-restraint">
            默认不建议盲目安装技能。天枢已原生集成开发工作流，覆盖约 90% 真实任务场景——先用原生能力，确有需要再按需安装。整个项目安装的技能不超过 5 个，本体 70% 的代码即由此完成；不装技能不影响真实任务的完成。
          </div>
          {installLoading && <div className="meta">扫描 .claude/skills 中…</div>}
          <div className="skills-grid">{discoverSkills.map(renderDiscoverCard)}</div>
        </>
      )}

      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent className="skill-detail-dialog">
          {detail && (
            <>
              <DialogHeader>
                <div className="skill-detail-head">
                  <div className={`skill-tile lg ${tileClass(detail.skill.name)}`} aria-hidden>
                    {detail.skill.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <DialogTitle>{detail.skill.name}</DialogTitle>
                    <span className={`skill-src-chip ${sourceBadge(detail.skill.source).cls}`}>
                      {sourceBadge(detail.skill.source).label}
                    </span>
                  </div>
                </div>
              </DialogHeader>
              <DialogDescription className="skill-detail-desc">
                {detail.skill.description || '（无描述）'}
              </DialogDescription>
              <div className="skill-detail-meta">
                <div className="skill-detail-row">
                  <span className="k">位置</span>
                  <span className="v font-mono">{skillPathHint(detail.skill.source, detail.skill.name)}</span>
                </div>
                <div className="skill-detail-row">
                  <span className="k">生效</span>
                  <span className="v">
                    {detail.kind === 'loaded'
                      ? '启停即时生效于当前会话'
                      : '安装后需新开线程才生效（保护前缀缓存，不做会话内热加载）'}
                  </span>
                </div>
              </div>
              <div className="skill-detail-actions">
                {detail.kind === 'loaded' ? (
                  <button
                    className="btn sm"
                    onClick={() => {
                      toggle(detail.skill.name, !(detail.skill as SkillStatus).enabled)
                      setDetail({ kind: 'loaded', skill: { ...(detail.skill as SkillStatus), enabled: !(detail.skill as SkillStatus).enabled } })
                    }}
                  >
                    {(detail.skill as SkillStatus).enabled ? '禁用' : '启用'}
                  </button>
                ) : (
                  <button
                    className="btn sm"
                    disabled={(detail.skill as InstallableSkill).installed || installing.has(detail.skill.name)}
                    onClick={() => install(detail.skill.name)}
                  >
                    {(detail.skill as InstallableSkill).installed
                      ? '已安装'
                      : installing.has(detail.skill.name) ? '安装中…' : overCap && confirmName === detail.skill.name ? '确认安装?' : '安装'}
                  </button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
