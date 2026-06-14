import { useEffect, useMemo, useRef, useState } from 'react'
import { filterCommands, type Command } from '../lib/commands'

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
      </div>
    </div>
  )
}
