import { useState, useEffect, useCallback, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../i18n'
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
import { PluginsMarket } from '../components/PluginsMarket'
import { McpSettingsManager } from '../components/McpSettings'

/** source → 本地化标签 + 样式类 */
function sourceBadge(source: string): { label: string; cls: string } {
  switch (source) {
    case 'builtin': return { label: i18n.t('skills:source.builtin'), cls: 'src-builtin' }
    case 'project-claude': return { label: 'Claude', cls: 'src-claude' }
    case 'global-claude': return { label: i18n.t('skills:source.globalClaude'), cls: 'src-claude' }
    default: return { label: i18n.t('skills:source.project'), cls: 'src-rivet' }
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
    case 'builtin': return i18n.t('skills:path.builtin')
    case 'project-claude': return `.claude/skills/${name}/SKILL.md`
    case 'global-claude': return `~/.claude/skills/${name}/SKILL.md`
    default: return `.rivet/skills/${name}/SKILL.md`
  }
}

/** Detail-dialog target — a reference only; the skill object is looked up
 *  from the live lists at render time so toggle/install state never goes
 *  stale inside the dialog (e.g. optimistic-update rollback on API failure). */
type SkillDetail =
  | { kind: 'loaded'; name: string }
  | { kind: 'installable'; name: string }

/** Extensions hub tab id. Skills are per-session; plugins and MCP
 *  connectors are global config and render without an active session. */
type ExtTab = 'skills' | 'plugins' | 'connectors'

/**
 * Extensions hub（三轮 — 统一扩展中心）：技能 / 插件 / 连接器三个 tab。
 * 技能 tab = 原 Skills store（Wave 5 对标 Codex「精致 App Store」）：
 * 网格卡片（图标/名称/描述/来源 badge/启停开关）+ 内置与项目分组保留 +
 * 可安装技能提为「发现」区一键安装 + 点击卡片开详情 Dialog。
 * 插件 tab = PluginsMarket（/plugins/* REST）；连接器 tab = MCP 管理
 * （与 Settings 集成卡片共用 McpSettingsManager）。
 */
export function SkillsSurface() {
  const { t } = useTranslation('skills')
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessionId = ui.activeSessionId
  const [tab, setTab] = useState<ExtTab>('skills')
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
          setInstallNotice(i18n.t('skills:install.notice'))
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

  const renderCard = (s: SkillStatus) => {
    const badge = sourceBadge(s.source)
    return (
      <div
        key={s.name}
        className={`skill-store-card${s.enabled ? ' enabled' : ''}`}
        role="button"
        tabIndex={0}
        onClick={() => setDetail({ kind: 'loaded', name: s.name })}
        onKeyDown={(e) => { if (e.key === 'Enter') setDetail({ kind: 'loaded', name: s.name }) }}
      >
        <div className="skill-store-head">
          <div className={`skill-tile ${tileClass(s.name)}`} aria-hidden>
            {s.name.slice(0, 1).toUpperCase()}
          </div>
          <button
            className={`skill-toggle ${s.enabled ? 'on' : ''}`}
            role="switch"
            aria-checked={s.enabled}
            aria-label={s.enabled ? t('card.disableAria', { name: s.name }) : t('card.enableAria', { name: s.name })}
            onClick={(e) => { e.stopPropagation(); toggle(s.name, !s.enabled) }}
          >
            <span className="skill-toggle-knob" />
          </button>
        </div>
        <div className="skill-store-name">{s.name}</div>
        <div className="skill-store-desc">{s.description || t('card.noDescription')}</div>
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
        onClick={() => setDetail({ kind: 'installable', name: s.name })}
        onKeyDown={(e) => { if (e.key === 'Enter') setDetail({ kind: 'installable', name: s.name }) }}
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
            {s.installed ? t('install.installed') : busy ? t('install.installing') : confirming ? t('install.confirm') : t('install.install')}
          </button>
        </div>
        <div className="skill-store-name">{s.name}</div>
        <div className="skill-store-desc">{s.description || t('card.noDescription')}</div>
        <div className="skill-store-foot">
          <span className={`skill-src-chip ${badge.cls}`}>{badge.label}</span>
        </div>
      </div>
    )
  }

  const hasResults = builtinSkills.length > 0 || projectSkills.length > 0 || discoverSkills.length > 0

  // Live lookup for the detail dialog — always reflects the current list
  // state (optimistic toggles and their rollbacks included).
  const detailSkill: SkillStatus | InstallableSkill | null = detail
    ? (detail.kind === 'loaded'
        ? skills.find((s) => s.name === detail.name) ?? null
        : installable.find((s) => s.name === detail.name) ?? null)
    : null

  return (
    <div className="single-pane skills skills-store">
      <div className="panel-header">
        <span>{t('title')}</span>
        {tab === 'skills' && sessionId && (
          <span className="meta">{t('enabledCount', { enabled: enabledCount, total: skills.length })}</span>
        )}
      </div>

      <div className="ext-tabs" role="tablist" aria-label={t('title')}>
        {(['skills', 'plugins', 'connectors'] as ExtTab[]).map((id) => (
          <button
            key={id}
            className={`ext-tab${tab === id ? ' active' : ''}`}
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {t(`tabs.${id}`)}
          </button>
        ))}
      </div>

      {tab === 'plugins' && <PluginsMarket />}

      {tab === 'connectors' && (
        <div className="ext-connectors">
          <McpSettingsManager />
        </div>
      )}

      {tab === 'skills' && !sessionId && (
        <div className="skills-empty-hero">
          <div className="skills-empty-glyph" aria-hidden>◈</div>
          <p>{t('selectSessionHint')}</p>
        </div>
      )}

      {tab === 'skills' && sessionId && (
      <>
      <div className="skills-toolbar">
        <input
          className="skills-search"
          type="text"
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {loading && (
        <div className="skills-empty-hero"><div className="skills-empty-glyph spin" aria-hidden>◌</div><p>{t('loading')}</p></div>
      )}
      {error && <div className="meta warn">{error}</div>}

      {loadErrors.length > 0 && (
        <div className="skills-load-errors">
          <div className="skills-group-label">{t('loadErrors.title', { n: loadErrors.length })}</div>
          <div className="meta warn">{t('loadErrors.hint')}</div>
          <ul className="skills-error-list">
            {loadErrors.map((e, i) => <li key={`le-${i}`}>{e}</li>)}
          </ul>
        </div>
      )}

      {installNotice && (
        <div className="meta warn skills-install-notice">
          <span>{installNotice}</span>
          <button className="skills-newthread-btn" onClick={openNewThread}>{t('install.newThreadToEnable')}</button>
        </div>
      )}

      {!q && trulyPending.length > 0 && (
        <>
          <div className="skills-group-label">{t('pending.title')}</div>
          <div className="skills-grid">
            {trulyPending.map((name) => (
              <div key={`pending-${name}`} className="skill-store-card pending">
                <div className="skill-store-head">
                  <div className={`skill-tile ${tileClass(name)}`} aria-hidden>{name.slice(0, 1).toUpperCase()}</div>
                  <button className="skills-newthread-btn" onClick={openNewThread}>{t('install.newThread')}</button>
                </div>
                <div className="skill-store-name">{name}</div>
                <div className="skill-store-desc">{t('pending.desc')}</div>
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
          <p>{query ? t('empty.noMatch') : t('empty.noSkills')}</p>
          {!query && <p className="skills-empty-hint">{t('empty.hint')}</p>}
        </div>
      )}

      {projectSkills.length > 0 && (
        <>
          <div className="skills-group-label">{t('groups.project')}</div>
          <div className="skills-grid">{projectSkills.map(renderCard)}</div>
        </>
      )}
      {builtinSkills.length > 0 && (
        <>
          <div className="skills-group-label">{t('groups.builtin')}</div>
          <div className="skills-grid">{builtinSkills.map(renderCard)}</div>
        </>
      )}

      {(discoverSkills.length > 0 || installLoading) && (
        <>
          <div className="skills-group-label">
            {t('groups.discover')}
            <span className={`skills-cap-inline${overCap ? ' over' : ''}`}>
              {t('cap.status', { n: installedCount, max: recommendedMax })}
              {overCap && t('cap.overLimit')}
            </span>
          </div>
          <div className="skills-restraint">
            {t('restraint')}
          </div>
          {installLoading && <div className="meta">{t('scanning')}</div>}
          <div className="skills-grid">{discoverSkills.map(renderDiscoverCard)}</div>
        </>
      )}

      <Dialog open={detail !== null} onOpenChange={(open) => { if (!open) setDetail(null) }}>
        <DialogContent className="skill-detail-dialog">
          {detail && detailSkill && (
            <>
              <DialogHeader>
                <div className="skill-detail-head">
                  <div className={`skill-tile lg ${tileClass(detailSkill.name)}`} aria-hidden>
                    {detailSkill.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <DialogTitle>{detailSkill.name}</DialogTitle>
                    <span className={`skill-src-chip ${sourceBadge(detailSkill.source).cls}`}>
                      {sourceBadge(detailSkill.source).label}
                    </span>
                  </div>
                </div>
              </DialogHeader>
              <DialogDescription className="skill-detail-desc">
                {detailSkill.description || t('card.noDescription')}
              </DialogDescription>
              <div className="skill-detail-meta">
                <div className="skill-detail-row">
                  <span className="k">{t('detail.location')}</span>
                  <span className="v font-mono">{skillPathHint(detailSkill.source, detailSkill.name)}</span>
                </div>
                <div className="skill-detail-row">
                  <span className="k">{t('detail.effect')}</span>
                  <span className="v">
                    {detail.kind === 'loaded'
                      ? t('detail.loadedEffect')
                      : t('detail.installableEffect')}
                  </span>
                </div>
              </div>
              <div className="skill-detail-actions">
                {detail.kind === 'loaded' ? (
                  <button
                    className="btn sm"
                    onClick={() => toggle(detailSkill.name, !(detailSkill as SkillStatus).enabled)}
                  >
                    {(detailSkill as SkillStatus).enabled ? t('detail.disable') : t('detail.enable')}
                  </button>
                ) : (
                  <button
                    className="btn sm"
                    disabled={(detailSkill as InstallableSkill).installed || installing.has(detailSkill.name)}
                    onClick={() => install(detailSkill.name)}
                  >
                    {(detailSkill as InstallableSkill).installed
                      ? t('install.installed')
                      : installing.has(detailSkill.name) ? t('install.installing') : overCap && confirmName === detailSkill.name ? t('install.confirm') : t('install.install')}
                  </button>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      </>
      )}
    </div>
  )
}
