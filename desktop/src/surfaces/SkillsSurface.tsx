import { useState, useEffect, useCallback, useMemo } from 'react'
import { useUiState } from '../state/store'
import { listSkills, setSkillEnabled } from '../runtime/client'
import type { SkillStatus } from '../runtime/types'

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
  const sessionId = ui.activeSessionId
  const [skills, setSkills] = useState<SkillStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  const fetchSkills = useCallback(() => {
    if (!sessionId) return
    setLoading(true)
    listSkills(sessionId)
      .then((list) => { setSkills(list); setError(null) })
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
      </div>

      {loading && (
        <div className="skills-empty-hero"><div className="skills-empty-glyph spin" aria-hidden>◌</div><p>加载中…</p></div>
      )}
      {error && <div className="meta warn">{error}</div>}

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
