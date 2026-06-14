import { useCallback, useEffect, useState } from 'react'
import { getArtifact, listArtifacts } from '../runtime/client'
import type { ArtifactSummary, SessionEvent } from '../runtime/types'

export function ArtifactsPanel(props: { sessionId: string | null; events: SessionEvent[] }) {
  const { sessionId, events } = props
  const [artifacts, setArtifacts] = useState<ArtifactSummary[]>([])
  const [open, setOpen] = useState<{ artifact: ArtifactSummary; raw: string } | null>(null)

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setArtifacts([])
      return
    }
    try {
      setArtifacts(await listArtifacts(sessionId))
    } catch {
      // runtime may not expose artifacts yet
    }
  }, [sessionId])

  useEffect(() => { void refresh() }, [refresh])

  // An 'artifact' event means a new trust-layer artifact landed — refresh.
  useEffect(() => {
    if (events.some((e) => e.type === 'artifact')) void refresh()
  }, [events, refresh])

  const view = useCallback(async (a: ArtifactSummary) => {
    if (!sessionId) return
    try {
      setOpen(await getArtifact(sessionId, a.id))
    } catch {
      // ignore
    }
  }, [sessionId])

  return (
    <div className="artifacts">
      <div className="panel-header"><span>Artifacts · 信任层</span></div>
      {artifacts.length === 0 && <div className="empty">还没有工件</div>}
      {artifacts.map((a) => (
        <div key={a.id} className="artifact-card" onClick={() => view(a)}>
          <div className="kind">{a.kind}</div>
          <div className="summary">{a.summary || a.target}</div>
          <div className="meta">{a.lineCount} 行 · {a.charCount} 字符</div>
        </div>
      ))}

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{open.artifact.kind} · {open.artifact.target}</h3>
            <pre>{open.raw}</pre>
            <div className="modal-actions">
              <button className="btn" onClick={() => setOpen(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
