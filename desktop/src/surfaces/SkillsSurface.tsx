import { useState, useEffect, useCallback, useMemo } from 'react'
import { useUiState, useUiDispatch } from '../state/store'
import { listSkillsDetailed, setSkillEnabled, listInstallableSkills, installSkills } from '../runtime/client'
import type { SkillStatus, InstallableSkill } from '../runtime/types'

/** source → 中文标签 + 样式类 */
function sourceBadge(source: string): { label: string; cls: string } {
  switch (source) {
    case 'builtin': return { label: '内置', cls: 'src-builtin' }
    case 'project-claude': return { label: 'Claude', cls: 'src-claude' }
    case 'global-claude': return { label: 'Claude·全局', cls: 'src-claude' }
    default: return { label: '项目', cls: 'src-rivet' }
  }
}

/**
 * Skills browser surface — lists every loaded skill with its per-session
 * enablement status, search/filter, and toggle. Mirrors Codex's sidebar skills
 * panel. Requires an active session to scope the skill list.
 *
 * 布局优化：按来源分组（内置/项目）+ source chip 内联 + enabled 卡片色条 +
 * 信息密度提升（source 不再独占一行），让用户一眼看清有哪些技能可用。
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

  // ── Install (copy from .claude/skills into .rivet/skills) ──
  const [showInstall, setShowInstall] = useState(false)
  const [installable, setInstallable] = useState<InstallableSkill[]>([])
  const [installedCount, setInstalledCount] = useState(0)
  const [recommendedMax, setRecommendedMax] = useState(5)
  const [installLoading, setInstallLoading] = useState(false)
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [installNotice, setInstallNotice] = useState<string | null>(null)
  // Name awaiting a second click when installing past the recommended cap.
  const [confirmName, setConfirmName] = useState<string | null>(null)

  const overCap = installedCount >= recommendedMax

  const fetchInstallable = useCallback(() => {
    if (!sessionId) return
    setInstallLoading(true)
    listInstallableSkills(sessionId)
      .then((res) => {
        setInstallable(res.skills)
        setInstalledCount(res.installedCount)
        setRecommendedMax(res.recommendedMax)
      })
      .catch((err) => setError((err as Error).message))
      .finally(() => setInstallLoading(false))
  }, [sessionId])

  const toggleInstallPanel = useCallback(() => {
    setShowInstall((prev) => {
      const next = !prev
      if (next) fetchInstallable()
      return next
    })
  }, [fetchInstallable])

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

  // 按来源分组：内置技能 vs 项目技能，提升视觉层次。
  // 搜索时合并为一组（按相关度），避免分组干扰查找。
  const { builtinSkills, projectSkills, filtered } = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (s: SkillStatus) =>
      !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)
    if (q) {
      return { builtinSkills: [], projectSkills: [], filtered: skills.filter(match) }
    }
    return {
      builtinSkills: skills.filter(s => s.source === 'builtin'),
      projectSkills: skills.filter(s => s.source !== 'builtin'),
      filtered: [] as SkillStatus[],
    }
  }, [skills, query])

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
      <div key={s.name} className={`skill-card${s.enabled ? ' enabled' : ''}`}>
        <div className="skill-info">
          <div className="skill-title-row">
            <span className="skill-name">{s.name}</span>
            <span className={`skill-src-chip ${badge.cls}`}>{badge.label}</span>
          </div>
          <div className="skill-desc">{s.description || '（无描述）'}</div>
        </div>
        <button
          className={`skill-toggle ${s.enabled ? 'on' : ''}`}
          role="switch"
          aria-checked={s.enabled}
          aria-label={s.enabled ? `禁用 ${s.name}` : `启用 ${s.name}`}
          onClick={() => toggle(s.name, !s.enabled)}
        >
          <span className="skill-toggle-knob" />
        </button>
      </div>
    )
  }

  const hasResults = builtinSkills.length > 0 || projectSkills.length > 0 || filtered.length > 0

  return (
    <div className="single-pane skills">
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
        <button
          className={`skills-install-btn${showInstall ? ' on' : ''}`}
          onClick={toggleInstallPanel}
          aria-pressed={showInstall}
        >
          {showInstall ? '收起' : '安装技能'}
        </button>
      </div>

      {showInstall && (
        <div className="skills-install-panel">
          <div className="skills-group-label">从 .claude/skills 安装</div>

          <div className="skills-restraint">
            默认不建议盲目安装技能。天枢已原生集成开发工作流，覆盖约 90% 真实任务场景——先用原生能力，确有需要再按需安装。整个项目安装的技能不超过 5 个，本体 70% 的代码即由此完成；不装技能不影响真实任务的完成。
          </div>

          <div className={`skills-cap-line${overCap ? ' over' : ''}`}>
            已安装 {installedCount} 个 · 建议 ≤ {recommendedMax}
            {overCap && '，已达上限，非必要不再安装（点两次确认）'}
          </div>

          {installNotice && (
            <div className="meta warn skills-install-notice">
              <span>{installNotice}</span>
              <button className="skills-newthread-btn" onClick={openNewThread}>新建线程以启用</button>
            </div>
          )}
          {installLoading && (
            <div className="skills-empty-hero"><div className="skills-empty-glyph spin" aria-hidden>◌</div><p>扫描中…</p></div>
          )}
          {!installLoading && installable.length === 0 && (
            <div className="meta">.claude/skills 下没有可安装的技能。</div>
          )}
          <div className="skills-list">
            {installable.map((s) => {
              const badge = sourceBadge(s.source)
              const busy = installing.has(s.name)
              const confirming = confirmName === s.name
              return (
                <div key={`inst-${s.name}`} className="skill-card">
                  <div className="skill-info">
                    <div className="skill-title-row">
                      <span className="skill-name">{s.name}</span>
                      <span className={`skill-src-chip ${badge.cls}`}>{badge.label}</span>
                    </div>
                    <div className="skill-desc">{s.description || '（无描述）'}</div>
                  </div>
                  <button
                    className={`skills-install-action${confirming ? ' confirm' : ''}`}
                    disabled={s.installed || busy}
                    onClick={() => install(s.name)}
                  >
                    {s.installed ? '已安装' : busy ? '安装中…' : confirming ? '确认安装?' : '安装'}
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

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

      {!query.trim() && trulyPending.length > 0 && (
        <>
          <div className="skills-group-label">待生效（重开线程）</div>
          <div className="skills-list">
            {trulyPending.map((name) => (
              <div key={`pending-${name}`} className="skill-card pending">
                <div className="skill-info">
                  <div className="skill-title-row">
                    <span className="skill-name">{name}</span>
                    <span className="skill-src-chip src-claude">Claude</span>
                  </div>
                  <div className="skill-desc">已安装，新开线程后可启用</div>
                </div>
                <button className="skills-newthread-btn" onClick={openNewThread}>新建线程</button>
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

      {/* 搜索模式：单列结果 */}
      {filtered.length > 0 && (
        <div className="skills-list">{filtered.map(renderCard)}</div>
      )}

      {/* 浏览模式：分组 */}
      {!query.trim() && projectSkills.length > 0 && (
        <>
          <div className="skills-group-label">项目技能</div>
          <div className="skills-list">{projectSkills.map(renderCard)}</div>
        </>
      )}
      {!query.trim() && builtinSkills.length > 0 && (
        <>
          <div className="skills-group-label">内置技能</div>
          <div className="skills-list">{builtinSkills.map(renderCard)}</div>
        </>
      )}
    </div>
  )
}
