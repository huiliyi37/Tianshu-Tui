import { useEffect, useMemo, useState } from 'react'
import { getArtifact, openExternal } from '../runtime/client'
import { useSessionEvents } from '../state/use-session-events'
import { deriveBrowserState, EMPTY_BROWSER_STATE } from '../lib/browser-mirror'

// Browser mirror panel — shows what the agent's `browser_debug` tool is doing:
// current URL, the latest screenshot, a navigation timeline and the most recent
// extracted text. Pure read-only mirror; it replays session history on mount so
// it is populated even when opened after the agent already browsed.
export function BrowserPanel({ sessionId }: { sessionId: string | null }) {
  const events = useSessionEvents(sessionId)
  const state = useMemo(
    () => (sessionId ? deriveBrowserState(events.blocks) : EMPTY_BROWSER_STATE),
    // blocksRev bumps on every block mutation — cheap invalidation without deep compare.
    [sessionId, events.blocksRev], // eslint-disable-line react-hooks/exhaustive-deps
  )

  const [shotUrl, setShotUrl] = useState<string | null>(null)
  const [shotFailed, setShotFailed] = useState(false)
  const [lightbox, setLightbox] = useState(false)

  const artifactId = state.latestScreenshotArtifactId
  useEffect(() => {
    if (!artifactId || !sessionId) {
      setShotUrl(null)
      return
    }
    let cancelled = false
    setShotFailed(false)
    getArtifact(sessionId, artifactId)
      .then(({ raw }) => { if (!cancelled && raw) setShotUrl(`data:image/png;base64,${raw}`) })
      .catch(() => { if (!cancelled) setShotFailed(true) })
    return () => { cancelled = true }
  }, [artifactId, sessionId])

  useEffect(() => {
    if (!lightbox) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLightbox(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [lightbox])

  if (!sessionId || !state.active) {
    return (
      <div className="review-body flex items-center justify-center h-full">
        <div className="empty sm text-center max-w-xs">
          尚未有浏览器活动。当天枢用 <code className="bd-line bd-muted">browser_debug</code> 打开网页时，这里会实时镜像它看到的页面。
        </div>
      </div>
    )
  }

  return (
    <div className="review-body flex flex-col h-full gap-2 p-2">
      <div className="browser-urlbar flex items-center gap-2 bg-panel-2 border border-border rounded px-2 py-1">
        <span aria-hidden className="text-xs">🌐</span>
        <input
          className="flex-1 min-w-0 bg-transparent text-xs text-text truncate outline-none"
          value={state.currentUrl ?? '（未导航）'}
          readOnly
          title={state.currentUrl ?? undefined}
        />
        {state.currentUrl && (
          <button
            type="button"
            className="text-[10px] text-muted hover:text-text px-1.5 py-0.5 border border-border rounded shrink-0"
            onClick={() => { if (state.currentUrl) openExternal(state.currentUrl).catch(() => {}) }}
            title="在系统浏览器中打开"
          >
            外部打开
          </button>
        )}
      </div>

      <div className="browser-viewport flex-1 min-h-0 overflow-auto border border-border rounded bg-panel flex items-start justify-center">
        {shotUrl && !shotFailed ? (
          <img
            className="max-w-full h-auto cursor-zoom-in"
            src={shotUrl}
            alt="agent screenshot"
            loading="lazy"
            onClick={() => setLightbox(true)}
            onError={() => setShotFailed(true)}
          />
        ) : (
          <div className="empty sm p-4">
            {shotFailed ? '截图加载失败' : '暂无截图（agent 尚未截屏）'}
          </div>
        )}
      </div>

      {state.latestText && (
        <details className="browser-text bg-panel-2 border border-border rounded text-xs">
          <summary className="cursor-pointer px-2 py-1 text-muted select-none">提取的文本 / 最近结果</summary>
          <pre className="px-2 py-1 whitespace-pre-wrap break-words max-h-40 overflow-auto text-text">{state.latestText}</pre>
        </details>
      )}

      {state.timeline.length > 0 && (
        <div className="browser-timeline bg-panel-2 border border-border rounded text-xs max-h-32 overflow-auto">
          <div className="px-2 py-1 text-muted border-b border-border">导航历史（{state.timeline.length}）</div>
          <ul>
            {state.timeline.slice().reverse().map((nav) => (
              <li key={nav.key} className="px-2 py-1 flex items-center gap-2 border-b border-border/40 last:border-0">
                <span className="text-[10px] text-muted shrink-0">{nav.action}</span>
                <span className="truncate text-text" title={nav.url}>{nav.url}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {lightbox && shotUrl && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setLightbox(false)}
        >
          <img className="max-w-full max-h-full object-contain" src={shotUrl} alt="screenshot fullscreen" />
        </div>
      )}
    </div>
  )
}
