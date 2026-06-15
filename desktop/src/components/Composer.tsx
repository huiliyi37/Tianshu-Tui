import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listFiles } from '../runtime/client'
import { detectMention, applyMention, type MentionToken } from '../lib/mention-input'
import { detectSlash, filterCommands, type ComposerCommand } from '../lib/composer-commands'

// Composer (D2/D3) — message input with two autocompletes sharing one dropdown:
//  - '@' anywhere → file mention picker; inserts a canonical `@file:<path>`
//    token (the AgentLoop resolves the mention server-side).
//  - '/' at line start → desktop slash command menu (actions, no agent slashes).
// Controlled value: the parent owns input state so rewind/clear can set it.

type Suggest =
  | { mode: 'file'; token: MentionToken; items: string[]; index: number }
  | { mode: 'command'; items: ComposerCommand[]; index: number }

export function Composer(props: {
  sessionId: string
  value: string
  onChange: (v: string) => void
  busy: boolean
  onSubmit: (text: string) => void
  onAbort: () => void
  onDoubleEscape: () => void
  commands?: ComposerCommand[]
}) {
  const { sessionId, value, onChange, busy, onSubmit, onAbort, onDoubleEscape, commands } = props
  const taRef = useRef<HTMLTextAreaElement>(null)
  const lastEscAt = useRef(0)
  const reqSeq = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout>>()
  const pendingCaret = useRef<number | null>(null)
  const [suggest, setSuggest] = useState<Suggest | null>(null)

  // Restore caret after a programmatic value change (mention insertion).
  useLayoutEffect(() => {
    if (pendingCaret.current != null && taRef.current) {
      const c = pendingCaret.current
      taRef.current.setSelectionRange(c, c)
      pendingCaret.current = null
    }
  }, [value])

  useEffect(() => () => clearTimeout(debounce.current), [])

  const closeSuggest = () => setSuggest(null)

  const queryFiles = (token: MentionToken) => {
    clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      const seq = ++reqSeq.current
      try {
        const items = await listFiles(sessionId, token.query, 30)
        if (seq !== reqSeq.current) return // stale
        setSuggest(items.length > 0 ? { mode: 'file', token, items, index: 0 } : null)
      } catch {
        if (seq === reqSeq.current) setSuggest(null)
      }
    }, 120)
  }

  const onAfterCaret = (text: string, caret: number) => {
    // Slash command menu takes priority at line start.
    if (commands && commands.length > 0) {
      const slash = detectSlash(text, caret)
      if (slash) {
        clearTimeout(debounce.current)
        const items = filterCommands(commands, slash.query)
        setSuggest(items.length > 0 ? { mode: 'command', items, index: 0 } : null)
        return
      }
    }
    const token = detectMention(text, caret)
    if (token) queryFiles(token)
    else closeSuggest()
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const next = e.target.value
    onChange(next)
    onAfterCaret(next, e.target.selectionStart ?? next.length)
  }

  const selectFile = (token: MentionToken, path: string) => {
    const { text, caret } = applyMention(value, token, path)
    pendingCaret.current = caret
    onChange(text)
    closeSuggest()
  }

  const runCommand = (cmd: ComposerCommand) => {
    closeSuggest()
    onChange('')
    cmd.run()
  }

  const accept = () => {
    if (!suggest) return
    if (suggest.mode === 'file') selectFile(suggest.token, suggest.items[suggest.index]!)
    else runCommand(suggest.items[suggest.index]!)
  }

  const move = (delta: number) => {
    if (!suggest) return
    const n = suggest.items.length
    const index = (suggest.index + delta + n) % n
    setSuggest({ ...suggest, index } as Suggest)
  }

  const submit = () => {
    const text = value.trim()
    if (!text) return
    onSubmit(text)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(); return }
      if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      const now = Date.now()
      if (value.trim()) {
        onChange('')
      } else if (now - lastEscAt.current < 400) {
        lastEscAt.current = 0
        onDoubleEscape()
      } else {
        lastEscAt.current = now
      }
    }
  }

  return (
    <div className="composer">
      {suggest && (
        <ul className="composer-suggest" role="listbox">
          {suggest.mode === 'file'
            ? suggest.items.map((path, i) => (
                <li
                  key={path}
                  role="option"
                  aria-selected={i === suggest.index}
                  className={`suggest-item ${i === suggest.index ? 'active' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); selectFile(suggest.token, path) }}
                >
                  <span className="suggest-glyph" aria-hidden>@</span>
                  <span className="suggest-path">{path}</span>
                </li>
              ))
            : suggest.items.map((cmd, i) => (
                <li
                  key={cmd.name}
                  role="option"
                  aria-selected={i === suggest.index}
                  className={`suggest-item ${i === suggest.index ? 'active' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); runCommand(cmd) }}
                >
                  <span className="suggest-glyph" aria-hidden>/</span>
                  <span className="suggest-path">{cmd.name}</span>
                  <span className="suggest-desc">{cmd.desc}</span>
                </li>
              ))}
        </ul>
      )}
      <textarea
        ref={taRef}
        value={value}
        placeholder={busy
          ? '运行中 · Enter 插入引导（下一步生效）· @ 引用文件'
          : '和天枢对话…  (Enter 发送, Shift+Enter 换行, @ 文件, / 命令)'}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        onClick={(e) => onAfterCaret(value, e.currentTarget.selectionStart ?? value.length)}
      />
      {busy ? (
        <div className="composer-actions">
          <button className="btn ghost" onClick={submit} disabled={!value.trim()}>引导</button>
          <button className="btn ghost danger" onClick={onAbort}>停止</button>
        </div>
      ) : (
        <button className="btn" onClick={submit} disabled={!value.trim()}>发送</button>
      )}
    </div>
  )
}
