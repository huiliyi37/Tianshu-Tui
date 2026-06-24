import { useState, useEffect, useCallback } from 'react'
import { useUiState } from '../state/store'
import { listSkills, setSkillEnabled } from '../runtime/client'
import type { SkillStatus } from '../runtime/types'

/**
 * Skills browser surface — lists every loaded skill with its per-session
 * enablement status, search/filter, and toggle. Mirrors Codex's sidebar skills
 * panel. Requires an active session to scope the skill list.
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

  const filtered = query.trim()
    ? skills.filter((s) =>
        s.name.toLowerCase().includes(query.toLowerCase()) ||
        s.description.toLowerCase().includes(query.toLowerCase()))
    : skills

  const enabledCount = skills.filter((s) => s.enabled).length

  if (!sessionId) {
    return (
      <div className="single-pane skills">
        <div className="panel-header"><span>技能</span></div>
        <div className="empty">请先选择一个线程以查看技能配置。</div>
      </div>
    )
  }

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

      {loading && <div className="surface-loading">加载中…</div>}
      {error && <div className="meta warn">{error}</div>}

      {!loading && filtered.length === 0 && (
        <div className="empty">{query ? '没有匹配的技能' : '暂无可用技能'}</div>
      )}

      <div className="skills-list">
        {filtered.map((s) => (
          <div key={s.name} className={`skill-card${s.enabled ? ' enabled' : ''}`}>
            <div className="skill-info">
              <div className="skill-name">{s.name}</div>
              <div className="skill-desc">{s.description}</div>
              <div className="skill-source">{s.source}</div>
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
        ))}
      </div>
    </div>
  )
}
