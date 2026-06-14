import { useState } from 'react'
import type { ApprovalRequest } from '../runtime/types'
import { DiffView } from './DiffView'

const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'apply_patch'])

/** The input key that carries the new file content for each edit tool. */
function editableKey(req: ApprovalRequest): 'new_string' | 'content' | null {
  const input = req.input as Record<string, unknown>
  if (!EDIT_TOOLS.has(req.toolName)) return null
  if (typeof input.new_string === 'string') return 'new_string'
  if (typeof input.content === 'string') return 'content'
  return null
}

// Render a readable preview of what the agent wants to do. Edit/write tools get
// a diff-style view; everything else shows the raw input JSON.
function previewOf(req: ApprovalRequest): { isDiff: boolean; text: string } {
  const input = req.input as Record<string, unknown>
  if (EDIT_TOOLS.has(req.toolName)) {
    const oldStr = typeof input.old_string === 'string' ? input.old_string : ''
    const newStr =
      typeof input.new_string === 'string' ? input.new_string
        : typeof input.content === 'string' ? input.content : ''
    if (oldStr || newStr) {
      const path = typeof input.path === 'string' ? input.path : ''
      const body = [
        `--- ${path}`,
        `+++ ${path}`,
        ...oldStr.split('\n').map((l) => `-${l}`),
        ...newStr.split('\n').map((l) => `+${l}`),
      ].join('\n')
      return { isDiff: true, text: body }
    }
  }
  return { isDiff: false, text: JSON.stringify(req.input, null, 2) }
}

export function ApprovalModal(props: {
  request: ApprovalRequest
  onDecision: (decision: 'approve' | 'reject', editedInput?: Record<string, unknown>) => void
}) {
  const { request, onDecision } = props
  const preview = previewOf(request)
  const editKey = editableKey(request)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(
    editKey ? String((request.input as Record<string, unknown>)[editKey] ?? '') : '',
  )

  const approve = () => {
    if (editing && editKey) {
      onDecision('approve', { ...request.input, [editKey]: draft })
    } else {
      onDecision('approve')
    }
  }

  return (
    <div className="modal-backdrop">
      <div className={`modal ${preview.isDiff ? 'wide' : ''}`}>
        <h3>需要批准：{request.toolName}</h3>
        <p className="meta">agent 请求执行一个需要确认的操作。</p>
        {editing && editKey ? (
          <textarea
            className="edit-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        ) : preview.isDiff ? (
          <DiffView raw={preview.text} />
        ) : (
          <pre>{preview.text}</pre>
        )}
        <div className="modal-actions">
          {editKey && (
            <button className="btn ghost" onClick={() => setEditing((v) => !v)}>
              {editing ? '取消编辑' : '编辑后批准'}
            </button>
          )}
          <button className="btn ghost" onClick={() => onDecision('reject')}>拒绝</button>
          <button className="btn" onClick={approve}>{editing ? '应用并批准' : '批准'}</button>
        </div>
      </div>
    </div>
  )
}
