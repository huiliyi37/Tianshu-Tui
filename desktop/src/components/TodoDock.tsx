import { memo, useState } from 'react'
import { ChevronDown, ChevronUp, Maximize2 } from 'lucide-react'
import type { TodoStateItem } from '../runtime/types'

// Cursor 3.0 风格的常驻 To-dos 抽屉。挂在右侧审查面板底部,跨 tab 常驻、可折叠。
// 数据源为同一份 `todo_state`(plan 模式与普通模式统一),agent 自己维护清单——
// 因此不提供手动「+ New」。
//
// memo 包裹:ReviewPanel 在流式帧里频繁重渲染,而 todos 引用多数帧不变。
const COLLAPSE_KEY = 'rivet.todoDock.collapsed'

export const TodoDock = memo(function TodoDock({
  items,
  onOpenFull,
  collapsedList = false,
}: {
  items: TodoStateItem[]
  /** 跳转到右栏完整 Tasks tab(看清单 + 涉及文件 + 工件)。 */
  onOpenFull: () => void
  /** 已在 Tasks tab 时只留标题,避免清单重复渲染两份。 */
  collapsedList?: boolean
}) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(COLLAPSE_KEY) === '1'
    } catch {
      return false
    }
  })

  if (items.length === 0) return null

  const done = items.filter((t) => t.status === 'completed').length
  const total = items.length
  const current = items.find((t) => t.status === 'in_progress')?.content
  const showList = !collapsed && !collapsedList

  const toggle = () => {
    setCollapsed((v) => {
      const next = !v
      try {
        localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0')
      } catch {
        // localStorage may be unavailable
      }
      return next
    })
  }

  return (
    <div className={`todo-dock ${showList ? 'open' : ''}`}>
      <div className="todo-dock-head">
        <button
          className="todo-dock-toggle"
          onClick={toggle}
          title={showList ? '收起清单' : '展开清单'}
          disabled={collapsedList}
        >
          {showList ? <ChevronDown size={13} /> : <ChevronUp size={13} />}
          <span className="tdh-title">To-dos</span>
          <span className="tdh-count">{done}/{total}</span>
        </button>
        {current && !showList && (
          <span className="tdh-current" title={current}>◐ {current}</span>
        )}
        <button
          className="todo-dock-open"
          onClick={onOpenFull}
          title="打开完整任务视图"
          aria-label="打开完整任务视图"
        >
          <Maximize2 size={12} />
        </button>
      </div>

      {showList && (
        <ul className="todo-dock-list">
          {items.map((t) => (
            <li key={t.id} className={`task-item st-${t.status}`}>
              <span className="task-check" aria-hidden>{glyph(t.status)}</span>
              <span className="task-text">{t.content}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
})

function glyph(status: TodoStateItem['status']): string {
  if (status === 'completed') return '✓'
  if (status === 'in_progress') return '◐'
  return '○'
}
