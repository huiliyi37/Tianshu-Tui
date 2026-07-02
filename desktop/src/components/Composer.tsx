import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { listFiles, listModels, switchModel, listDomains, setDomain } from '../runtime/client'
import { detectMention, applyMention, formatFileMention, type MentionToken } from '../lib/mention-input'
import { detectSlash, filterCommands, type ComposerCommand } from '../lib/composer-commands'
import { toast } from 'sonner'
import type { ModelEntry, DomainEntry, PlanModeState } from '../runtime/types'
import { PlusMenu } from './PlusMenu'
import { compressImage } from '../lib/image-compress'
import { isImageFile, isTextFile, isUnsupportedFile, formatUnsupportedFiles, detectImageMimeByMagic } from '../lib/file-types'

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

/** Highlight placeholder arguments like `<描述>` in slash command examples. */
function HighlightedExample({ text }: { text: string }) {
  const parts = text.split(/(<[^>]+>)/g)
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('<') && part.endsWith('>') ? (
          <span key={i} className="suggest-arg">{part}</span>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  )
}

export function computeComposerTextareaStyle(scrollHeight: number, maxHeight = COMPOSER_TEXTAREA_MAX_HEIGHT): { height: string; overflowY: 'hidden' | 'auto' } {
  const height = Math.min(Math.max(0, scrollHeight), maxHeight)
  return {
    height: `${height}px`,
    overflowY: scrollHeight > maxHeight ? 'auto' : 'hidden',
  }
}

type Suggest =
  | { mode: 'file'; token: MentionToken; items: string[]; index: number }
  | { mode: 'command'; items: ComposerCommand[]; index: number; matched: boolean }

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
  /** PlusMenu — open the "派子代理" dispatch dialog. */
  onDelegate?: () => void
  /** PlusMenu — bumped on model/domain/skills SSE so an open panel refetches. */
  menuRev?: number
  /** True when the thread already has messages — used to warn before a
   *  cache-invalidating mid-session star-domain switch. */
  threadNonEmpty?: boolean
}) {
  const { sessionId, value, onChange, busy, onSubmit, onAbort, onDoubleEscape, commands, planMode, onSetPlanMode, onDelegate, menuRev, threadNonEmpty } = props
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
  const lastEscAt = useRef(0)
  const reqSeq = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout>>()
  const pendingCaret = useRef<number | null>(null)
  // IME 组合输入状态追踪：中文/日文输入法选词时按 Enter 确认候选词，绝不能被
  // 当成"提交消息"。用 ref 追踪 compositionstart/end，比 e.nativeEvent.isComposing
  // 更可靠（部分 WebView 下 isComposing 在 keydown 时尚未更新）。
  const composingRef = useRef(false)
  const [suggest, setSuggest] = useState<Suggest | null>(null)
  const [images, setImages] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [recording, setRecording] = useState(false)
  const [speechSupported, setSpeechSupported] = useState(false)
  const [speechError, setSpeechError] = useState<string | null>(null)
  const recognitionRef = useRef<SpeechRecognition | null>(null)

  // Parse mentions from the value prop
  const { text, mentions } = useMemo(() => {
    // Accept quoted (`@file:"a b.ts"`) and bare (`@file:src/a.ts`) forms so
    // paths with spaces (Windows) survive the round-trip.
    const regex = /@file:(?:"([^"]+)"|([^\s]+))\s?/g
    const paths: string[] = []
    const cleanText = value.replace(regex, (_m, quoted, bare) => {
      paths.push(quoted ?? bare)
      return ''
    })
    return { text: cleanText, mentions: paths }
  }, [value])

  const removeMention = (pathToRemove: string) => {
    const remaining = mentions.filter((m) => m !== pathToRemove)
    const suffix = remaining.map(formatFileMention).join(' ')
    let newValue = text
    if (suffix) {
      const needsSpace = text.length > 0 && !text.endsWith(' ')
      newValue = `${text}${needsSpace ? ' ' : ''}${suffix}`
    }
    onChange(newValue)
  }

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
  }, [text])

  useEffect(() => () => clearTimeout(debounce.current), [])

  const closeSuggest = () => setSuggest(null)

  const addImages = useCallback(async (files: FileList | File[]) => {
    setAttachmentError(null)
    const arr = Array.from(files).filter(f => isImageFile(f))
    if (arr.length === 0) { setAttachmentError('不支持的格式（仅支持 PNG/JPEG/WebP/GIF/BMP 图片）'); return }
    for (const f of arr) {
      if (f.size > MAX_IMAGE_SIZE) { setAttachmentError(`${f.name} 超过 5MB 限制`); return }
    }
    if (images.length + arr.length > MAX_IMAGES) { setAttachmentError(`最多 ${MAX_IMAGES} 张图片`); return }
    try {
      // Compress once: the resulting data URL is sent to the model AND rendered
      // as the thumbnail AND persisted server-side — one artifact, three uses.
      const results = await Promise.all(arr.map(f => compressImage(f)))
      setImages(prev => [...prev, ...results.map(r => r.dataUrl)])
    } catch {
      setAttachmentError('图片处理失败，请重试')
    }
  }, [images.length])

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
    setAttachmentError(null)
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

  const onAfterCaret = (textVal: string, caret: number) => {
    // Slash command menu takes priority at line start.
    if (commands && commands.length > 0) {
      const slash = detectSlash(textVal, caret)
      if (slash) {
        clearTimeout(debounce.current)
        const filtered = filterCommands(commands, slash.query)
        const matched = filtered.length > 0
        // If the user typed something with no match, still show the full list
        // grayed-out so they see available commands instead of a blank menu.
        const items = matched ? filtered : commands
        setSuggest({ mode: 'command', items, index: matched ? 0 : -1, matched })
        return
      }
    }
    const token = detectMention(textVal, caret)
    if (token) queryFiles(token)
    else closeSuggest()
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextText = e.target.value
    const suffix = mentions.map(formatFileMention).join(' ')
    let newValue = nextText
    if (suffix) {
      const needsSpace = nextText.length > 0 && !nextText.endsWith(' ')
      newValue = `${nextText}${needsSpace ? ' ' : ''}${suffix}`
    }
    onChange(newValue)
    onAfterCaret(newValue, e.target.selectionStart ?? newValue.length)
  }

  const selectFile = (token: MentionToken, path: string) => {
    const { text: nextRawValue } = applyMention(value, token, path)
    // Place caret at the end of the text segment (where the '@' query was)
    pendingCaret.current = token.start
    onChange(nextRawValue)
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
    else if (suggest.index >= 0 && suggest.matched) runCommand(suggest.items[suggest.index]!)
    else {
      // Not in the local menu — send through to the server slash resolver
      // instead of rejecting client-side (the server knows more commands).
      closeSuggest()
      submit()
    }
  }

  const move = (delta: number) => {
    if (!suggest) return
    if (suggest.mode === 'command' && !suggest.matched) return
    const n = suggest.items.length
    const index = (suggest.index + delta + n) % n
    setSuggest({ ...suggest, index } as Suggest)
  }

  const submit = () => {
    const text = value.trim()
    if (!text && images.length === 0) return
    // Slash commands pass through to the server: POST /prompt runs the full
    // resolveAppPromptInput translation (same as TUI), so commands missing from
    // the local menu (e.g. /write-plan) still work. Truly unknown slashes get a
    // 400 whose toast + input restore is handled by useSendPrompt.onError.
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
    recognition.onstart = () => {
      setSpeechError(null)
      setRecording(true)
    }
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
        const nextText = text ? `${text} ${final}`.trim() : final
        const suffix = mentions.map(formatFileMention).join(' ')
        let newValue = nextText
        if (suffix) {
          const needsSpace = nextText.length > 0 && !nextText.endsWith(' ')
          newValue = `${nextText}${needsSpace ? ' ' : ''}${suffix}`
        }
        onChange(newValue)
      } else if (interim) {
        const nextText = text ? `${text} ${interim}`.trim() : interim
        const suffix = mentions.map(formatFileMention).join(' ')
        let newValue = nextText
        if (suffix) {
          const needsSpace = nextText.length > 0 && !nextText.endsWith(' ')
          newValue = `${nextText}${needsSpace ? ' ' : ''}${suffix}`
        }
        onChange(newValue)
      }
    }
    recognition.onerror = (event: Event) => {
      const code = (event as Event & { error?: string }).error
      setSpeechError(code === 'not-allowed' ? '麦克风权限被拒绝' : '语音识别失败')
      setRecording(false)
    }
    recognitionRef.current = recognition
    recognition.start()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // IME 组合输入中（中文/日文选词）：Enter 是确认候选词，不触发任何命令/提交。
    // 这是中文用户最高频的误触来源——不加此守卫，拼音选词按 Enter 会直接提交半截内容。
    const isComposing = composingRef.current || e.nativeEvent.isComposing || e.keyCode === 229

    if (suggest) {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1); return }
      if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); return }
      if ((e.key === 'Enter' || e.key === 'Tab') && !isComposing) { e.preventDefault(); accept(); return }
      if (e.key === 'Escape') { e.preventDefault(); closeSuggest(); return }
    }

    if (e.key === 'Tab' && e.shiftKey && onSetPlanMode) {
      e.preventDefault()
      togglePlan()
      return
    }

    if (e.key === 'Enter' && !e.shiftKey && !isComposing) {
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

  const onPaste = async (e: React.ClipboardEvent) => {
    // Extract files from clipboard. Strategy:
    //  1. Scan DataTransferItemList (has MIME metadata; most reliable).
    //     - macOS screenshots: item.type="image/png" but File.type=""
    //     - Windows clipboard: item.type may be "image/bmp" or empty
    //  2. Fallback to DataTransfer.files (some platforms only populate this).
    // Deduplicate by name:size since items and files overlap.
    const seen = new Set<string>()
    const pasted: { file: File; mimeHint?: string }[] = []
    const items = e.clipboardData.items
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (item.kind !== 'file') continue
      const f = item.getAsFile()
      if (!f || f.size === 0) continue
      const key = `${f.name}:${f.size}:${f.lastModified}`
      if (!seen.has(key)) {
        seen.add(key)
        // item.type is the clipboard's declared MIME (most trustworthy).
        // f.type may be empty on macOS/Windows clipboard images.
        pasted.push({ file: f, mimeHint: item.type || undefined })
      }
    }
    // Fallback: platforms where .files is the sole source (e.g. drag-into-window).
    for (const f of Array.from(e.clipboardData.files)) {
      const key = `${f.name}:${f.size}:${f.lastModified}`
      if (!seen.has(key)) {
        seen.add(key)
        pasted.push({ file: f })
      }
    }

    const classify = async (p: typeof pasted[0]) => {
      let type = p.mimeHint || p.file.type
      // Last-resort byte-level detection for Windows clipboard images that
      // report no MIME type and have no extension (e.g. "image").
      if (!type && !p.file.name.includes('.')) {
        const detected = await detectImageMimeByMagic(p.file)
        if (detected) type = detected
      }
      const fileLike = { type, name: p.file.name }
      return { file: p.file, fileLike }
    }

    const classified = await Promise.all(pasted.map(classify))
    const imageFiles = classified.filter(c => isImageFile(c.fileLike)).map(c => c.file)
    const textFiles = classified.filter(c => isTextFile(c.fileLike) && !isImageFile(c.fileLike)).map(c => c.file)
    const unsupportedFiles = classified.filter(c => isUnsupportedFile(c.fileLike)).map(c => c.file)

    if (imageFiles.length === 0 && textFiles.length === 0 && unsupportedFiles.length === 0) return

    e.preventDefault()
    if (unsupportedFiles.length > 0) {
      toast.error(formatUnsupportedFiles(unsupportedFiles))
    }
    if (imageFiles.length > 0) void addImages(imageFiles)
    if (textFiles.length > 0) {
      void inlineTextFiles(textFiles)
    }
  }

  const inlineTextFiles = useCallback(async (files: File[]) => {
    const contents: string[] = []
    for (const f of files) {
      // Text files are INLINED as content, not added as @file path
      // references (the browser only exposes the basename, not a real path).
      // Use a plain header so this is never parsed as an @file: mention.
      if (f.size > 512 * 1024) {
        contents.push(`📎 ${f.name}（文件过大，已跳过）`)
        continue
      }
      try {
        const text = await f.text()
        contents.push(`📎 ${f.name}（内联内容）\n\`\`\`\n${text}\n\`\`\``)
      } catch {
        contents.push(`📎 ${f.name}（读取失败）`)
      }
    }
    if (contents.length > 0) {
      const insert = contents.join('\n\n')
      onChange(value ? `${value}\n${insert}` : insert)
    }
  }, [value, onChange])

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    setAttachmentError(null)
    if (e.dataTransfer.files.length === 0) return
    const files = Array.from(e.dataTransfer.files)
    const imageFiles = files.filter(f => isImageFile(f))
    const textFiles = files.filter(f => isTextFile(f) && !isImageFile(f))
    const unsupportedFiles = files.filter(f => isUnsupportedFile(f))

    if (imageFiles.length === 0 && textFiles.length === 0 && unsupportedFiles.length === 0) return

    if (unsupportedFiles.length > 0) {
      setAttachmentError(formatUnsupportedFiles(unsupportedFiles))
    }
    if (imageFiles.length > 0) void addImages(imageFiles)
    if (textFiles.length > 0) void inlineTextFiles(textFiles)
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
            : suggest.items.map((cmd, i) => {
                const disabled = !suggest.matched
                return (
                  <li
                    key={cmd.name}
                    role="option"
                    aria-selected={i === suggest.index}
                    aria-disabled={disabled}
                    className={`suggest-item ${i === suggest.index && !disabled ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
                    onMouseDown={(e) => {
                      e.preventDefault()
                      if (!disabled) runCommand(cmd)
                    }}
                  >
                    <span className="suggest-glyph" aria-hidden>/</span>
                    <span className="suggest-path">{cmd.name}</span>
                    <span className="suggest-desc">{cmd.desc}</span>
                    {cmd.example && <span className="suggest-example"><HighlightedExample text={cmd.example} /></span>}
                  </li>
                )
              })}
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
      {mentions.length > 0 && (
        <div className="composer-chips flex flex-wrap gap-1.5 px-3 pt-2 pb-1">
          {mentions.map((path) => (
            <div key={path} className="composer-chip flex items-center gap-1 bg-panel-3 border border-border rounded-full pl-2 pr-1.5 py-0.5 text-xs text-text-secondary" title={path}>
              <span className="text-muted shrink-0" aria-hidden>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
              </span>
              <span className="truncate max-w-[180px] font-mono text-[11px]">{path.split(/[/\\]/).pop()}</span>
              <button
                type="button"
                className="chip-remove hover:text-error hover:bg-error-soft rounded-full p-0.5 transition-colors"
                onClick={() => removeMention(path)}
                aria-label={`移除 ${path}`}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      {attachmentError && <div className="composer-error">{attachmentError}</div>}
      {speechError && <div className="composer-error">{speechError}</div>}
      <div className="composer-row">
        <textarea
          ref={taRef}
          value={text}
          placeholder={planning
            ? '描述你的目标…'
            : busy
            ? '运行中 · Enter 插入引导'
            : 'Ask anything…'}
          onChange={handleChange}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composingRef.current = true }}
          onCompositionEnd={() => { composingRef.current = false }}
          onClick={(e) => onAfterCaret(value, e.currentTarget.selectionStart ?? value.length)}
        />
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*,.txt,.md,.json,.js,.jsx,.ts,.tsx,.css,.scss,.html,.yaml,.yml,.toml,.py,.go,.rs,.java,.c,.cpp,.h,.rb,.php,.sh,.bash,.zsh,.ps1,.sql,.log"
          multiple
          style={{ display: 'none' }}
          onChange={(e) => {
            if (!e.target.files) return
            const files = Array.from(e.target.files)
            const imageFiles = files.filter(f => isImageFile(f))
            const textFiles = files.filter(f => isTextFile(f) && !isImageFile(f))
            const unsupportedFiles = files.filter(f => isUnsupportedFile(f))
            if (unsupportedFiles.length > 0) {
              setAttachmentError(formatUnsupportedFiles(unsupportedFiles))
            }
            if (imageFiles.length > 0) void addImages(imageFiles)
            if (textFiles.length > 0) void inlineTextFiles(textFiles)
            e.target.value = ''
          }}
        />
        <button
          className="btn ghost icon-btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={images.length >= MAX_IMAGES}
          title="选择文件"
          aria-label="选择文件"
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
        <div className="plus-wrap">
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
            onDelegate={onDelegate}
            onClose={() => {}}
          />
        </div>
        <ModelPicker sessionId={sessionId} disabled={busy} menuRev={menuRev} />
        <DomainPicker sessionId={sessionId} disabled={busy} menuRev={menuRev} threadNonEmpty={threadNonEmpty} />
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
function ModelPicker({ sessionId, disabled, menuRev }: { sessionId: string; disabled?: boolean; menuRev?: number }) {
  const [open, setOpen] = useState(false)
  const [models, setModels] = useState<ModelEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [switchingId, setSwitchingId] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (withSpinner: boolean) => {
    if (!sessionId) return
    if (withSpinner) setLoading(true)
    try {
      const ms = await listModels(sessionId)
      setModels(ms)
    } catch (err) {
      if (withSpinner) toast.error(`加载模型失败: ${(err as Error).message}`)
    } finally {
      if (withSpinner) setLoading(false)
    }
  }, [sessionId])

  // Keep the (closed) trigger label live: refetch on mount, on session change,
  // and whenever a model_switched / domain / skills SSE bumps menuRev. Without
  // this the label lags a switch behind — e.g. switch to Pro still shows Flash —
  // because the list was only ever fetched when the menu was open.
  useEffect(() => { void refresh(false) }, [refresh, menuRev])

  // Fresh list (with spinner) each time the menu opens.
  useEffect(() => { if (open) void refresh(true) }, [open, refresh])

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
    if (disabled || m.current) return
    setSwitchingId(m.id)
    try {
      await switchModel(sessionId, m.id)
      // Optimistically re-flag current so the trigger label updates immediately;
      // the model_switched SSE (menuRev bump) reconciles against the server next.
      setModels((prev) => prev.map((x) => ({ ...x, current: x.id === m.id })))
      setOpen(false)
    } catch (err) {
      toast.error(`切换模型失败: ${(err as Error).message}`)
    } finally {
      setSwitchingId(null)
    }
  }

  return (
    <div className="model-picker" ref={ref}>
      <button
        className="model-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !!switchingId}
        title={disabled ? '运行中不可切换模型' : '切换模型'}
        aria-label="切换模型"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span aria-hidden>◇</span>
        <span className="model-picker-label">{switchingId ? '切换中…' : label}</span>
      </button>
      {open && (
        <div className="model-picker-menu" role="listbox">
          {loading && (
            <div className="model-picker-item" role="status" aria-busy>
              <span className="model-picker-name">加载中…</span>
            </div>
          )}
          {!loading && models.map((m) => (
            <button
              key={m.id}
              role="option"
              aria-selected={m.current}
              disabled={switchingId === m.id}
              className={`model-picker-item ${m.current ? 'active' : ''}`}
              onClick={() => void select(m)}
            >
              <span className="model-picker-name">{m.alias || m.id}</span>
              {switchingId === m.id ? (
                <span className="model-picker-desc">切换中…</span>
              ) : m.contextWindow ? (
                <span className="model-picker-desc">{Math.round(m.contextWindow / 1000)}K</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/** Inline star-domain (星域) selector in the composer bar, beside the model picker. */
const DOMAIN_SWITCH_CACHE_WARNING =
  '会话中途切换星域会使前缀缓存整体失效，下一次请求需全量重建上下文（成本约 10 倍+）。建议新开会话或在会话开始时选择。'

function DomainPicker({ sessionId, disabled, menuRev, threadNonEmpty }: { sessionId: string; disabled?: boolean; menuRev?: number; threadNonEmpty?: boolean }) {
  const [open, setOpen] = useState(false)
  const [entries, setEntries] = useState<DomainEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [applyingKey, setApplyingKey] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async (withSpinner: boolean) => {
    if (!sessionId) return
    if (withSpinner) setLoading(true)
    try {
      const es = await listDomains(sessionId)
      setEntries(es)
    } catch (err) {
      if (withSpinner) toast.error(`加载星域失败: ${(err as Error).message}`)
    } finally {
      if (withSpinner) setLoading(false)
    }
  }, [sessionId])

  // Mirror ModelPicker: keep the closed trigger live via menuRev (domain_changed
  // SSE bumps it), fetch on mount, and a spinnered fetch when the menu opens.
  useEffect(() => { void refresh(false) }, [refresh, menuRev])
  useEffect(() => { if (open) void refresh(true) }, [open, refresh])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const current = entries.find((e) => e.current)
  const glyph = current?.uiPersona?.glyph || '✦'
  const label = current?.name || '星域'

  const select = async (e: DomainEntry) => {
    if (disabled || e.current) return
    // Mid-session switch invalidates the prefix cache (~10x rebuild). Confirm first.
    if (threadNonEmpty && !window.confirm(`⚠ ${DOMAIN_SWITCH_CACHE_WARNING}\n\n确定切换到「${e.name}」？`)) {
      return
    }
    setApplyingKey(e.key)
    try {
      await setDomain(sessionId, e.key)
      setEntries((prev) => prev.map((x) => ({ ...x, current: x.key === e.key })))
      setOpen(false)
    } catch (err) {
      toast.error(`切换星域失败: ${(err as Error).message}`)
    } finally {
      setApplyingKey(null)
    }
  }

  return (
    <div className="model-picker domain-picker" ref={ref}>
      <button
        className="model-picker-trigger"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !!applyingKey}
        title={disabled ? '运行中不可切换星域' : '切换星域'}
        aria-label="切换星域"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span aria-hidden>{glyph}</span>
        <span className="model-picker-label">{applyingKey ? '切换中…' : label}</span>
      </button>
      {open && (
        <div className="model-picker-menu" role="listbox">
          {threadNonEmpty && (
            <div className="model-picker-hint" role="note">
              ⚠ {DOMAIN_SWITCH_CACHE_WARNING}
            </div>
          )}
          {loading && (
            <div className="model-picker-item" role="status" aria-busy>
              <span className="model-picker-name">加载中…</span>
            </div>
          )}
          {!loading && entries.map((e) => (
            <button
              key={e.key}
              role="option"
              aria-selected={e.current}
              disabled={applyingKey === e.key}
              className={`model-picker-item ${e.current ? 'active' : ''}`}
              onClick={() => void select(e)}
            >
              <span className="model-picker-name">
                {e.uiPersona?.glyph ? `${e.uiPersona.glyph} ` : ''}{e.name}
              </span>
              {applyingKey === e.key ? (
                <span className="model-picker-desc">切换中…</span>
              ) : (e.meta || e.motto) ? (
                <span className="model-picker-desc">{e.meta || e.motto}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
