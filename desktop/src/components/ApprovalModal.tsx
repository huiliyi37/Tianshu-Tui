import type { ApprovalRequest } from '../runtime/types'

export function ApprovalModal(props: {
  request: ApprovalRequest
  onDecision: (decision: 'approve' | 'reject') => void
}) {
  const { request, onDecision } = props
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h3>需要批准：{request.toolName}</h3>
        <p className="meta">agent 请求执行一个需要确认的操作。</p>
        <pre>{JSON.stringify(request.input, null, 2)}</pre>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => onDecision('reject')}>拒绝</button>
          <button className="btn" onClick={() => onDecision('approve')}>批准</button>
        </div>
      </div>
    </div>
  )
}
