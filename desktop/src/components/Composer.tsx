import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listFiles } from '../runtime/client'
import { detectMention, applyMention, type MentionToken } from '../lib/mention-input'
import { detectSlash, filterCommands, type ComposerCommand } from '../lib/composer-commands'

// Composer (D2/D3) — message input with two autocompletes sharing one dropdown:
//  - '@' anywhere → file mention picker; inserts a canonical `@file:<path>`
//    token (the AgentLoop resolves the mention server-side).
//  - '/' at line start → desktop slash command menu (actions, no agent slashes).
// Controlled value: the parent owns input state so rewind/clear can set it.
// Vision: paste/drop/select images → base64 data URLs → sent as image_url parts.

const ACCEPTED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
const MAX_IMAGE_SIZE = 5 * 1024 * 1024
const MAX_IMAGES = 4

type Suggest =
  | { mode: 'file'; token: MentionToken; items: string[]; index: number }
  | { mode: 'command'; items: ComposerCommand[]; index: number }

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

export function Composer(props: {
  sessionId: string
  value: string
  onChange: (v: string) => void
  busy: boolean
  onSubmit: (text: string, images?: string[]) => void
  onAbort: () => void
  onDoubleEscape: () => void
  commands?: ComposerCommand[]
}) {
  const { sessionId, value, onChange, busy, onSubmit, onAbort, onDoubleEscape, commands } = props
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const lastEscAt = useRef(0)
  const reqSeq = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout>>()
  const pendingCaret = useRef<number | null>(null)
  const [suggest, setSuggest] = useState<Suggest | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)

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

  const addFiles = useCallback(async (files: FileList | File[]) => {
    setImageError(null)
    const arr = Array.from(files).filter(f => ACCEPTED_IMAGE_TYPES.has(f.type))
    if (arr.length === 0) { setImageError('不支持的格式（仅 PNG/JPEG/WebP/GIF）'); return }
    for (const f of arr) {
      if (f.size > MAX_IMAGE_SIZE) { setImageError(`${f.name} 超过 5MB 限制`); return }
    }
    if (images.length + arr.length > MAX_IMAGES) { setImageError(`最多 ${MAX_IMAGES} 张图片`); return }
    const urls = await Promise.all(arr.map(readFileAsDataURL))
    setImages(prev => [...prev, ...urls])
  }, [images.length])

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
    setImageError(null)
  }

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
    if (!text && images.length === 0) return
    onSubmit(text || '(图片)', images.length > 0 ? images : undefined)
    setImages([])
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
      if (images.length > 0) {
        setImages([])
      } else if (value.trim()) {
        onChange('')
      } else if (now - lastEscAt.current < 400) {
        lastEscAt.current = 0
        onDoubleEscape()
      } else {
        lastEscAt.current = now
      }
    }
  }

  const onPaste = (e: React.ClipboardEvent) => {
    // Extract image files from BOTH .files and .items — WebKit/Tauri may
    // populate only items for clipboard image paste (e.g. macOS screenshots).
    const files: File[] = []
    for (const f of Array.from(e.clipboardData.files)) {
      if (ACCEPTED_IMAGE_TYPES.has(f.type)) files.push(f)
    }
    for (const item of Array.from(e.clipboardData.items)) {
      if (item.kind === 'file') {
        const f = item.getAsFile()
        if (f && ACCEPTED_IMAGE_TYPES.has(f.type)) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files)
  }

  const canSend = value.trim() || images.length > 0

  return (
    <div
      className={`composer${dragOver ? ' drag-over' : ''}`}
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={(e) => { e.preventDefault(); setDragOver(false) }}
      onPaste={onPaste}
    >
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
      {images.length > 0 && (
        <div className="composer-images">
          {images.map((src, i) => (
            <div key={i} className="composer-thumb">
              <img src={src} alt={`图片 ${i + 1}`} />
              <button className="thumb-remove" onClick={() => removeImage(i)} aria-label="移除图片">×</button>
            </div>
          ))}
        </div>
      )}
      {imageError && <div className="composer-error">{imageError}</div>}
      <div className="composer-row">
        <textarea
          ref={taRef}
          value={value}
          placeholder={busy
            ? '运行中 · Enter 插入引导（下一步生效）· @ 引用文件'
            : '和天枢对话…  (Enter 发送, Shift+Enter 换行, 粘贴/拖入图片)'}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          onClick={(e) => onAfterCaret(value, e.currentTarget.selectionStart ?? value.length)}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/gif"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files)
            e.target.value = ''
          }}
        />
        <button
          className="btn ghost icon-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={images.length >= MAX_IMAGES}
          title="选择图片"
          aria-label="选择图片"
        >📎</button>
      </div>
      {busy ? (
        <div className="composer-actions">
          <button className="btn ghost" onClick={submit} disabled={!canSend}>引导</button>
          <button className="btn ghost danger" onClick={onAbort}>停止</button>
        </div>
      ) : (
        <button className="btn" onClick={submit} disabled={!canSend}>发送</button>
      )}
    </div>
  )
}
