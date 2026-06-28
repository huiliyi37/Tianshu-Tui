import { memo } from 'react'
import type { TodoStateItem } from '../runtime/types'

// T2 — active task list (Codex-style active todo / Antigravity Task Plan).
// Persistent operational checklist: stays visible across turns (including idle),
// auto-marks items as the agent updates the list. Pure presentational view fed
// by the `todo_state` event.
//
// memo 包裹：ThreadView 在每个流式帧（view.blocks 变化）都重渲染，而 todos 引用
// 多数帧不变（仅 todo_state 事件才改）。不加 memo 会每帧 reconcile 整个列表。
export const TaskList = memo(function TaskList({ items }: { items: TodoStateItem[] }) {
  if (items.length === 0) return null

  const done = items.filter((t) => t.status === 'completed').length
  const total = items.length

  return (
    <div className="task-list">
      <div className="task-list-head">
        <span className="tl-title">任务清单</span>
        <span className="tl-count">{done}/{total}</span>
      </div>
      <ul className="tl-items">
        {items.map((t) => (
          <li key={t.id} className={`tl-item ${t.status}`}>
            <span className="tl-glyph" aria-hidden>{glyph(t.status)}</span>
            <span className="tl-text">{t.content}</span>
          </li>
        ))}
      </ul>
    </div>
  )
})

function glyph(status: TodoStateItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '►'
  return '○'
}
