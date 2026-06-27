import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { listFiles, listModels, switchModel } from '../runtime/client'
import { detectMention, applyMention, type MentionToken } from '../lib/mention-input'
import { detectSlash, filterCommands, type ComposerCommand } from '../lib/composer-commands'
import type { PlanModeState } from '../runtime/types'
import type { ModelEntry } from '../runtime/types'
import { PlusMenu } from './PlusMenu'
import { compressImage } from '../lib/image-compress'

// Composer (D2/D3) — message input with two autocompletes sharing one dropdown:
//  - '@' anywhere → file mention picker; inserts a canonical `@file:<path>`
//    token (the AgentLoop resolves the mention server-side).
//  - '/' at line start → desktop slash command menu (actions, no agent slashes).
// Controlled value: the parent owns input state so rewind/clear can set it.
// Vision: paste/drop/select images → base64 data URLs → sent as image_url parts.

// Web Speech API types are not in all lib DOM sets; declare minimally.
interface SpeechRecognitionEvent extends Event {
  resultIndex: number
  results: SpeechRecognitionResultList
}
interface SpeechRecognitionResultList {
  length: number
  item(index: number): SpeechRecognitionResult
}
interface SpeechRecognitionResult {
  isFinal: boolean
  [index: number]: SpeechRecognitionAlternative
}
interface SpeechRecognitionAlternative {
  transcript: string
}
interface SpeechRecognition extends EventTarget {
  lang: string
  continuous: boolean
  interimResults: boolean
  onstart: (() => void) | null
  onend: (() => void) | null
  onresult: ((event: SpeechRecognitionEvent) => void) | null
  onerror: ((event: Event) => void) | null
  start(): void
  stop(): void
}

interface SpeechRecognitionConstructor {
  new (): SpeechRecognition
}

declare global {
  interface Window {
    SpeechRecognition?: SpeechRecognitionConstructor
    webkitSpeechRecognition?: SpeechRecognitionConstructor
  }
}

const MAX_IMAGE_SIZE = 5 * 1024 * 1024
const MAX_IMAGES = 4
const COMPOSER_TEXTAREA_MAX_HEIGHT = 220

export function computeComposerTextareaStyle(scrollHeight: number, maxHeight = COMPOSER_TEXTAREA_MAX_HEIGHT): { height: string; overflowY: 'hidden' | 'auto' } {
  const height = Math.min(Math.max(0, scrollHeight), maxHeight)
  return {
    height: `${height}px`,
    overflowY: scrollHeight > maxHeight ? 'auto' : 'hidden',
  }
}

// Accept any raster image/* (canvas transcodes BMP/etc into a provider-safe
// PNG/JPEG on send). SVG is excluded: it is vector, useless for vision, and
// rasterizing it through canvas is fraught (taint, sizing, scripts).
function isImageMime(type: string): boolean {
  return type.startsWith('image/') && type !== 'image/svg+xml'
}

/** File-name heuristic for when MIME is unavailable (Windows clipboard edge case). */
function isImageFileName(name: string): boolean {
  return /\.(png|jpe?g|webp|gif|bmp)$/i.test(name)
}

type Suggest =
  | { mode: 'file'; token: MentionToken; items: string[]; index: number }
  | { mode: 'command'; items: ComposerCommand[]; index: number }

export function Composer(props: {
  sessionId: string
  value: string
  onChange: (v: string) => void
  busy: boolean
  onSubmit: (text: string, images?: string[]) => void
  onAbort: () => void
  onDoubleEscape: () => void
  commands?: ComposerCommand[]
  planMode?: PlanModeState
  onSetPlanMode?: (state: PlanModeState) => void
  /** PlusMenu — bumped on model/domain/skills SSE so an open panel refetches. */
  menuRev?: number
}) {
  const { sessionId, value, onChange, busy, onSubmit, onAbort, onDoubleEscape, commands, planMode, onSetPlanMode, menuRev } = props
  const planning = planMode === 'planning'

  useEffect(() => {
    const win = window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor }
    setSpeechSupported(!!(win.SpeechRecognition || win.webkitSpeechRecognition))
  }, [])
  const togglePlan = useCallback(() => {
    onSetPlanMode?.(planning ? 'off' : 'planning')
  }, [planning, onSetPlanMode])
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const plusRef = useRef<HTMLDivElement>(null)
  const [plusOpen, setPlusOpen] = useState(false)
  const lastEscAt = useRef(0)
  const reqSeq = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout>>()
  const pendingCaret = useRef<number | null>(null)
  const [suggest, setSuggest] = useState<Suggest | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [imageError, setImageError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(false)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  // Restore caret after a programmatic value change (mention insertion).
  useLayoutEffect(() => {
    if (pendingCaret.current != null && taRef.current) {
      const c = pendingCaret.current
      taRef.current.setSelectionRange(c, c)
      pendingCaret.current = null
    }
  }, [value])

  useLayoutEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const next = computeComposerTextareaStyle(el.scrollHeight)
    el.style.height = next.height
    el.style.overflowY = next.overflowY
  }, [value])

  useEffect(() => () => clearTimeout(debounce.current), [])

  // Close the "+" menu when clicking outside its wrapper (which includes the
  // trigger button, so toggling on the button doesn't immediately re-close).
  useEffect(() => {
    if (!plusOpen) return
    const onDown = (e: MouseEvent) => {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) setPlusOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [plusOpen])

  const closeSuggest = () => setSuggest(null)

  const addFiles = useCallback(async (files: FileList | File[]) => {
    setImageError(null)
    // Accept any raster image/* (transcoded on compress), or a known extension
    // when MIME is empty (Windows clipboard). SVG is rejected by isImageMime.
    const arr = Array.from(files).filter(f => isImageMime(f.type) || (f.type === '' && isImageFileName(f.name)))
    if (arr.length === 0) { setImageError('不支持的格式（仅 PNG/JPEG/WebP/GIF/BMP）'); return }
    for (const f of arr) {
      if (f.size > MAX_IMAGE_SIZE) { setImageError(`${f.name} 超过 5MB 限制`); return }
    }
    if (images.length + arr.length > MAX_IMAGES) { setImageError(`最多 ${MAX_IMAGES} 张图片`); return }
    try {
      // Compress once: the resulting data URL is sent to the model AND rendered
      // as the thumbnail AND persisted server-side — one artifact, three uses.
      const results = await Promise.all(arr.map(f => compressImage(f)))
      setImages(prev => [...prev, ...results.map(r => r.dataUrl)])
    } catch {
      setImageError('图片处理失败，请重试')
    }
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

  const toggleRecording = () => {
    if (recording) {
      recognitionRef.current?.stop()
      return
    }
    const win = window as unknown as { SpeechRecognition?: SpeechRecognitionConstructor; webkitSpeechRecognition?: SpeechRecognitionConstructor }
    const SpeechRecognitionCtor = win.SpeechRecognition || win.webkitSpeechRecognition
    if (!SpeechRecognitionCtor) return
    const recognition = new SpeechRecognitionCtor()
    recognition.lang = 'zh-CN'
    recognition.continuous = true
    recognition.interimResults = true
    recognition.onstart = () => setRecording(true)
    recognition.onend = () => {
      setRecording(false)
      recognitionRef.current = null
    }
    recognition.onresult = (event: SpeechRecognitionEvent) => {
      let final = ''
      let interim = ''
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results.item(i)
        if (result.isFinal) final += result[0]?.transcript ?? ''
        else interim += result[0]?.transcript ?? ''
      }
      if (final) {
        onChange(value ? `${value} ${final}`.trim() : final)
      } else if (interim) {
        onChange(value ? `${value} ${interim}`.trim() : interim)
      }
    }
    recognition.onerror = () => setRecording(false)
    recognitionRef.current = recognition
    recognition.start()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggest) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); accept(); return }
      if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return }
    }

    if (e.key === 'Tab' && e.shiftKey && onSetPlanMode) {
      e.preventDefault()
      togglePlan()
      return
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
    // Extract image files from clipboard. Strategy:
    //  1. Scan DataTransferItemList (has MIME metadata; most reliable).
    //     - macOS screenshots: item.type="image/png" but File.type=""
    //     - Windows clipboard: item.type may be "image/bmp" or empty
    //  2. Fallback to DataTransfer.files (some platforms only populate this).
    // Deduplicate by name:size since items and files overlap.
    const seen = new Set<string>()
    const files: File[] = []
    const items = e.clipboardData.items
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (item.kind !== 'file') continue
      const f = item.getAsFile()
      if (!f || f.size === 0) continue
      // item.type is the clipboard's declared MIME (most trustworthy).
      // f.type may be empty on macOS/Windows clipboard images.
      if (isImageMime(item.type) || isImageMime(f.type) || isImageFileName(f.name)) {
        const key = `${f.name}:${f.size}:${f.lastModified}`
        if (!seen.has(key)) {
          seen.add(key)
          files.push(f)
        }
      }
    }
    // Fallback: platforms where .files is the sole source (e.g. drag-into-window).
    for (const f of Array.from(e.clipboardData.files)) {
      const key = `${f.name}:${f.size}:${f.lastModified}`
      if (!seen.has(key) && (isImageMime(f.type) || isImageFileName(f.name))) {
        seen.add(key)
        files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length === 0) return
    const files = Array.from(e.dataTransfer.files)
    const imageFiles = files.filter(f => isImageMime(f.type) || isImageFileName(f.name))
    const textFiles = files.filter(f => !isImageMime(f.type) && !isImageFileName(f.name))

    if (imageFiles.length > 0) void addFiles(imageFiles)

    if (textFiles.length > 0) {
      const contents: string[] = []
      for (const f of textFiles) {
        if (f.size > 512 * 1024) {
          contents.push(`@file:${f.name} (文件过大，已跳过)`)
          continue
        }
        try {
          const text = await f.text()
          contents.push(`@file:${f.name}\n\`\`\`\n${text}\n\`\`\``)
        } catch {
          contents.push(`@file:${f.name} (读取失败)`)
        }
      }
      if (contents.length > 0) {
        const insert = contents.join('\n\n')
        onChange(value ? `${value}\n${insert}` : insert)
      }
    }
  }

  const canSend = value.trim() || images.length > 0

  return (
    <div
      className={`composer${dragOver ? ' drag-over' : ''}${planning ? ' planning' : ''}`}
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
          placeholder={planning
            ? '描述你的目标…'
            : busy
            ? '运行中 · Enter 插入引导'
            : 'Ask anything…'}
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
        {speechSupported && (
          <button
            className={`btn ghost icon-btn ${recording ? 'recording' : ''}`}
            onClick={toggleRecording}
            disabled={busy}
            title={recording ? '停止录音' : '语音输入'}
            aria-label={recording ? '停止录音' : '语音输入'}
          >🎤</button>
        )}
      </div>
      <div className="composer-actions">
        <div className="plus-wrap" ref={plusRef}>
          <button
            className={`plus-btn ${plusOpen ? 'open' : ''}`}
            onClick={() => setPlusOpen((o) => !o)}
            title="添加模式 / 图片 / 命令"
            aria-label="添加"
            aria-haspopup="menu"
            aria-expanded={plusOpen}
          >+</button>
          {plusOpen && (
            <PlusMenu
              sessionId={sessionId}
              menuRev={menuRev}
              sessionRunning={busy}
              planMode={planMode}
              onSetPlanMode={onSetPlanMode}
              onPickImage={() => fileInputRef.current?.click()}
              imageDisabled={images.length >= MAX_IMAGES}
              commands={commands}
              onRunCommand={runCommand}
              onClose={() => setPlusOpen(false)}
            />
          )}
        </div>
        <ModelPicker sessionId={sessionId} disabled={busy} />
        {onSetPlanMode && (
          <button
            className={`mode-toggle ${planning ? 'plan' : 'agent'}`}
            onClick={togglePlan}
            title="Shift+Tab 切换 Plan / Agent 模式"
          >
            <span className="mode-dot" aria-hidden />
            {planning ? 'Plan' : 'Agent'}
          </button>
        )}
        <span className="composer-spacer" />
        {busy ? (
          <>
            <button className="btn ghost" onClick={submit} disabled={!canSend}>引导</button>
            <button className="btn ghost danger" onClick={onAbort}>停止</button>
          </>
        ) : (
          <button className="btn" onClick={submit} disabled={!canSend}>
            {planning ? '生成方案' : '发送'}
          </button>
        )}
      </div>
    </div>
  )
}

/** Inline model selector in the composer bar (Codex-style). */
function ModelPicker({ sessionId, disabled }: { sessionId: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelEntry[]>([])
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    let alive = true
    listModels(sessionId).then((ms) => { if (alive) setModels(ms) })
    return () => { alive = false }
  }, [open, sessionId])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = models.find((m) => m.current)
  const label = current?.alias || current?.id || 'Model'

  const select = async (m: ModelEntry) => {
    setOpen(false)
    if (disabled || m.current) return
    await switchModel(sessionId, m.id)
  }

  return (
    <div className="model-picker" ref={ref}>
      <button
        className="model-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled}
        title={disabled ? '运行中不可切换模型' : '切换模型'}
        aria-label="切换模型"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span aria-hidden>◇</span>
        <span className="model-picker-label">{label}</span>
      </button>
      {open && (
        <div className="model-picker-menu" role="listbox">
          {models.map((m) => (
            <button
              key={m.id}
              role="option"
              aria-selected={m.current}
              className={`model-picker-item ${m.current ? 'active' : ''}`}
              onClick={() => void select(m)}
            >
              <span className="model-picker-name">{m.alias || m.id}</span>
              {m.contextWindow ? (
                <span className="model-picker-desc">{Math.round(m.contextWindow / 1000)}K</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
