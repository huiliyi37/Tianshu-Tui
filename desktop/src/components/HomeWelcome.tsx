import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Terminal, Compass, Hammer, SearchCheck, Wrench, ArrowUp, Plus, FolderOpen } from 'lucide-react'
import { useUiDispatch, useUiState } from '../state/store'
import { useSessions } from '../state/queries'
import { deriveProjects, loadKnownProjects } from '../lib/projects'

// Codex 对标首页/空态（Wave 2）：居中终端图标 + 大标题「我们应该在 {项目} 中
// 做些什么？」+ 4 张横向操作卡 + 居中 Composer 卡片。HomeSurface 与
// WorkspaceSurface 的 onboard 空态共用这一个组件。提交统一走 openNew
// （prompt 预填进新会话对话框），不触碰会话内 Composer 的提交序列化。
export function HomeWelcome() {
  const { t } = useTranslation('home')
  const ui = useUiState()
  const dispatch = useUiDispatch()
  const sessions = useSessions()
  const [draft, setDraft] = useState('')

  const projectName = useMemo(() => {
    if (!ui.activeProject) return null
    const p = deriveProjects(sessions.data ?? [], loadKnownProjects()).find((x) => x.id === ui.activeProject)
    return p?.name ?? null
  }, [sessions.data, ui.activeProject])

  const openWith = (prompt?: string) => {
    dispatch({ type: 'openNew', open: true, prompt })
  }

  const submit = () => {
    const text = draft.trim()
    if (!text) return
    setDraft('')
    openWith(text)
  }

  const CARDS = [
    { icon: Compass, key: 'explore' },
    { icon: Hammer, key: 'build' },
    { icon: SearchCheck, key: 'review' },
    { icon: Wrench, key: 'fix' },
  ] as const

  return (
    <div className="home-welcome">
      <div className="home-welcome-inner">
        <span className="home-welcome-glyph" aria-hidden>
          <Terminal size={30} strokeWidth={1.6} />
        </span>
        <h1 className="home-welcome-title">
          {projectName
            ? t('welcome.title', { project: projectName })
            : t('welcome.titleNoProject')}
        </h1>

        <div className="home-welcome-cards">
          {CARDS.map(({ icon: Ic, key }) => (
            <button
              key={key}
              className="home-welcome-card"
              onClick={() => openWith(t(`welcome.cards.${key}.prompt`))}
            >
              <Ic size={16} strokeWidth={1.7} aria-hidden />
              <span className="hwc-title">{t(`welcome.cards.${key}.title`)}</span>
              <span className="hwc-desc">{t(`welcome.cards.${key}.desc`)}</span>
            </button>
          ))}
        </div>

        <div className="home-welcome-composer">
          <div className="hw-composer-pill-row">
            <span className="hw-project-pill">
              <FolderOpen size={12} strokeWidth={1.8} aria-hidden />
              {projectName ?? t('welcome.noProject')}
            </span>
          </div>
          <textarea
            className="hw-composer-input"
            rows={2}
            value={draft}
            placeholder={t('welcome.placeholder')}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="hw-composer-actions">
            <button
              className="hw-action-btn"
              title={`${t('welcome.newTask')} (⌘N)`}
              onClick={() => openWith()}
            >
              <Plus size={15} strokeWidth={1.8} aria-hidden />
            </button>
            <span className="hw-spacer" />
            <button
              className="hw-send-btn"
              disabled={!draft.trim()}
              onClick={submit}
              title={t('welcome.send')}
              aria-label={t('welcome.send')}
            >
              <ArrowUp size={15} strokeWidth={2.2} aria-hidden />
            </button>
          </div>
        </div>

        <div className="home-welcome-hints">
          <span><kbd>⌘K</kbd> {t('welcome.hintPalette')}</span>
          <span><kbd>⌘N</kbd> {t('welcome.hintNew')}</span>
        </div>
      </div>
    </div>
  )
}
