import type { IntentRequest } from '../runtime/types'

// Intent-preview intervention (B2): the agent surfaces what it's about to do and
// how confident it is; the human can let it continue, veto, or ask for an
// alternative. Maps to answerIntent(continue|veto|alternative).
export function IntentModal(props: {
  request: IntentRequest
  onDecision: (decision: 'continue' | 'veto' | 'alternative') => void
}) {
  const { request, onDecision } = props
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>意图预览 · 置信度 {(request.confidence * 100).toFixed(0)}%</h3>
        <p>{request.summary}</p>
        {request.alternatives.length > 0 && (
          <>
            <label className="meta">备选</label>
            <ul>{request.alternatives.map((a, i) => <li key={i}>{a}</li>)}</ul>
          </>
        )}
        {request.warnings.length > 0 && (
          <>
            <label className="meta">警告</label>
            <ul>{request.warnings.map((w, i) => <li key={i} className="warn">{w}</li>)}</ul>
          </>
        )}
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => onDecision('veto')}>否决</button>
          <button className="btn ghost" onClick={() => onDecision('alternative')}>换方案</button>
          <button className="btn" onClick={() => onDecision('continue')}>继续</button>
        </div>
      </div>
    </div>
  )
}
