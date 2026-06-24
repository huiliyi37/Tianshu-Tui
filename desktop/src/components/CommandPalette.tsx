import { useEffect, useMemo, useRef, useState } from 'react'
import { filterCommands, type Command } from '../lib/commands'

const SHORTCUTS: { keys: string; desc: string }[] = [
  { keys: '⌘/Ctrl + K', desc: '打开/关闭命令面板' },
  { keys: '⌘/Ctrl + 1-4', desc: '切换面板（工作台·自动化·需处理·设置）' },
  { keys: 'Enter', desc: '发送消息（运行中则为引导）' },
  { keys: 'Shift + Enter', desc: '换行' },
  { keys: 'Esc × 2', desc: '清空输入 → 打开 Rewind' },
]

// Cmd+K command palette (Q4). Keyboard-first: type to filter, ↑/↓ to move,
// Enter to run, Esc to close.
export function CommandPalette(props: { commands: Command[]; onClose: () => void }) {
  const { commands, onClose } = props
  const [q, setQ] = useState('')
  const [idx, setIdx] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const results = useMemo(() => filterCommands(commands, q), [commands, q])

  useEffect(() => { inputRef.current?.focus() }, [])
  useEffect(() => { setIdx(0) }, [q])

  const run = (c: Command | undefined) => {
    if (!c) return
    c.run()
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIdx((i) => Math.min(i + 1, results.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIdx((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      run(results[idx])
    } else if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    }
  }

  return (
    <div className="modal-backdrop palette-backdrop" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="palette-input"
          value={q}
          placeholder="输入命令或线程…"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="palette-list">
          {results.length === 0 && <div className="empty sm">无匹配</div>}
          {results.map((c, i) => (
            <div
              key={c.id}
              className={`palette-item ${i === idx ? 'active' : ''}`}
              onMouseEnter={() => setIdx(i)}
              onClick={() => run(c)}
            >
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="palette-hint">{c.hint}</span>}
            </div>
          ))}
        </div>
        <div className="palette-shortcuts">
          <div className="palette-shortcuts-title">快捷键</div>
          {SHORTCUTS.map((s) => (
            <div key={s.keys} className="palette-shortcut-row">
              <kbd className="palette-kbd">{s.keys}</kbd>
              <span className="palette-shortcut-desc">{s.desc}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
