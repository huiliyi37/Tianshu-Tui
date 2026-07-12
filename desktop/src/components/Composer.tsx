import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { listFiles, listModels, switchModel, listDomains, setDomain } from '../runtime/client'
import { detectMention, applyMention, formatFileMention, type MentionToken } from '../lib/mention-input'
import { detectSlash, filterCommands, type ComposerCommand } from '../lib/composer-commands'
import { toast } from 'sonner'
import { loadSendMode, saveSendMode, type SendMode } from '../lib/persist'
import type { ModelEntry, DomainEntry, PlanModeState } from '../runtime/types'
import { AutonomyMenu } from './AutonomyMenu'
import type { AutonomyLevel } from '../lib/autonomy'
import { PlusMenu } from './PlusMenu'
import { compressImage } from '../lib/image-compress'
import i18n from '../i18n'
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

/** Sentinel item in the @-mention picker for the Computer Use entry (never a
 *  real path — files can't contain NUL). Selecting it inserts `@Computer ` and
 *  the server mounts the computer_use tool before the run. macOS only. */
const COMPUTER_MENTION_ITEM = '\u0000computer'
const IS_MAC = typeof navigator !== 'undefined' && /Mac/i.test(navigator.userAgent)

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

/** Live context stats for the composer usage ring (P1-1). */
export interface ContextUsage {
  /** Estimated tokens currently in context (last turn total). */
  usedTokens: number
  /** Model context window; 0/undefined hides the ring. */
  contextWindow?: number
  /** Cumulative prefix-cache reads/creations for the hit-rate detail. */
  cacheReadTokens: number
  cacheCreationTokens: number
  /** Context growth of the latest turn. */
  deltaTokens: number
}

export const Composer = memo(function Composer(props: {
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
  /** PlusMenu — current reasoning effort level (off/low/medium/high/max/auto). */
  effort?: string
  /** PlusMenu — switch the session's reasoning effort level. */
  onSetEffort?: (effort: string) => void
  /** PlusMenu — open the "派子代理" dispatch dialog. */
  onDelegate?: () => void
  /** PlusMenu — send a workflow slash command (/council, /team). */
  onWorkflow?: (cmd: string) => void
  /** PlusMenu — bumped on model/domain/skills SSE so an open panel refetches. */
  menuRev?: number
  /** True when the thread already has messages — used to warn before a
   *  cache-invalidating mid-session star-domain switch. */
  threadNonEmpty?: boolean
  /** P1-1 chip row — permission level chip (监督/默认/自治) inline by the send button. */
  approvalLevel?: AutonomyLevel
  onSetApprovalLevel?: (level: AutonomyLevel) => void
  /** P1-1 chip row — context usage ring (used/window + cache detail popover). */
  contextUsage?: ContextUsage
  /** Recall previous (older) prompt from history — terminal-style Up-arrow. */
  onHistoryPrev?: () => void
  /** Recall next (newer) prompt from history — terminal-style Down-arrow. */
  onHistoryNext?: () => void
  activeDomainAccent?: string
}) {
  const { sessionId, value, onChange, busy, onSubmit, onAbort, onDoubleEscape, commands, planMode, onSetPlanMode, effort, onSetEffort, onDelegate, onWorkflow, menuRev, threadNonEmpty, approvalLevel, onSetApprovalLevel, contextUsage, onHistoryPrev, onHistoryNext, activeDomainAccent = 'primary' } = props
  const { t } = useTranslation('composer')
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
  const [sendMode, setSendMode] = useState<SendMode>(loadSendMode())
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

  // Defer textarea auto-resize to useEffect (not useLayoutEffect) so the
  // browser paints the typed character first, then adjusts height next frame.
  // useLayoutEffect blocks paint on the forced synchronous layout
  // (height='auto' → read scrollHeight → write height), making typing feel
  // sluggish especially in WKWebView.
  useEffect(() => {
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
    if (arr.length === 0) { setAttachmentError(t('imageErrorFormat')); return }
    for (const f of arr) {
      if (f.size > MAX_IMAGE_SIZE) { setAttachmentError(t('imageErrorSize', { name: f.name })); return }
    }
    if (images.length + arr.length > MAX_IMAGES) { setAttachmentError(t('imageErrorMax', { max: MAX_IMAGES })); return }
    try {
      // Compress once: the resulting data URL is sent to the model AND rendered
      // as the thumbnail AND persisted server-side — one artifact, three uses.
      const results = await Promise.all(arr.map(f => compressImage(f)))
      setImages(prev => [...prev, ...results.map(r => r.dataUrl)])
    } catch {
      setAttachmentError(t('imageErrorProcess'))
    }
  }, [images.length, t])

  const removeImage = (index: number) => {
    setImages(prev => prev.filter((_, i) => i !== index))
    setAttachmentError(null)
  }

  const queryFiles = (token: MentionToken) => {
    clearTimeout(debounce.current)
    debounce.current = setTimeout(async () => {
      const seq = ++reqSeq.current
      // @Computer entry (Codex parity): offered when the typed query prefixes
      // "computer" — selecting it mounts the computer_use tool for this run.
      const computerEntry =
        IS_MAC && token.query.length > 0 && 'computer'.startsWith(token.query.toLowerCase())
          ? [COMPUTER_MENTION_ITEM]
          : []
      try {
        const files = await listFiles(sessionId, token.query, 30)
        if (seq !== reqSeq.current) return // stale
        const items = [...computerEntry, ...files]
        setSuggest(items.length > 0 ? { mode: 'file', token, items, index: 0 } : null)
      } catch {
        if (seq !== reqSeq.current) return
        setSuggest(computerEntry.length > 0 ? { mode: 'file', token, items: computerEntry, index: 0 } : null)
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
    if (path === COMPUTER_MENTION_ITEM) {
      // Plain-text token (not an @file: reference) — the server's prompt route
      // detects it and mounts computer_use before the run.
      const insert = '@Computer '
      const nextRawValue = value.slice(0, token.start) + insert + value.slice(token.end)
      pendingCaret.current = token.start + insert.length
      onChange(nextRawValue)
      closeSuggest()
      return
    }
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
    // 裸 / 未构成命令 — 对标 TUI rejectSubmit（服务端 resolveAppPromptInput 恒返回 null）。
    // 桌面端有意将未知 slash 透传到服务端（服务端知道的命令多于本地菜单），
    // 但 '/' 本身显然不是有效命令，透传只会稳定触发 400 然后 toast 回填，体验差。
    if (text === '/') return
    // Slash commands pass through to the server: POST /prompt runs the full
    // resolveAppPromptInput translation (same as TUI), so commands missing from
    // the local menu (e.g. /write-plan) still work. Truly unknown slashes get a
    // 400 whose toast + input restore is handled by useSendPrompt.onError.
    onSubmit(text || t('imageOnly'), images.length > 0 ? images : undefined)
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
    // Follow the UI locale instead of hardcoding Chinese (P1-7).
    recognition.lang = i18n.language === 'en' ? 'en-US' : 'zh-CN'
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
      setSpeechError(code === 'not-allowed' ? t('micDenied') : t('speechFailed'))
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

    // History recall (terminal-style Up/Down). Only fires when no autocomplete
    // menu is open AND the caret sits on the first/last line — so multi-line
    // drafts still let the caret move freely within. Up = older, Down = newer.
    if (e.key === 'ArrowUp' && onHistoryPrev) {
      const ta = e.currentTarget
      if (ta.value.slice(0, ta.selectionStart).indexOf('\n') === -1) {
        e.preventDefault()
        onHistoryPrev()
        return
      }
    }
    if (e.key === 'ArrowDown' && onHistoryNext) {
      const ta = e.currentTarget
      if (ta.value.slice(ta.selectionEnd).indexOf('\n') === -1) {
        e.preventDefault()
        onHistoryNext()
        return
      }
    }

    if (e.key === 'Tab' && e.shiftKey && onSetPlanMode) {
      e.preventDefault()
      togglePlan()
      return
    }

    // Send key: 'enter' mode → Enter sends, Shift+Enter = newline.
    //           'shift-enter' mode → Shift+Enter sends, Enter = newline.
    const isSendKey = sendMode === 'enter'
      ? (e.key === 'Enter' && !e.shiftKey)
      : (e.key === 'Enter' && e.shiftKey)
    if (isSendKey && !isComposing) {
      e.preventDefault()
      submit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      const now = Date.now()
      if (images.length > 0) {
        setImages([])
      } else if (value.trim()) {
        onChange('')
      } else if (busy) {
        // P1-6: Esc with an empty composer stops the running turn (Claude Desktop parity).
        onAbort()
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
    let hasFile = false
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!
      if (item.kind !== 'file') continue
      const f = item.getAsFile()
      if (!f || f.size === 0) continue
      hasFile = true
      const key = `${f.name}:${f.size}:${f.lastModified}`
      if (!seen.has(key)) {
        seen.add(key)
        pasted.push({ file: f, mimeHint: item.type || undefined })
      }
    }
    // Fallback: platforms where .files is the sole source (e.g. drag-into-window).
    for (const f of Array.from(e.clipboardData.files)) {
      const key = `${f.name}:${f.size}:${f.lastModified}`
      if (!seen.has(key)) {
        seen.add(key)
        hasFile = true
        pasted.push({ file: f })
      }
    }

    // preventDefault MUST run synchronously — if we await first, the browser's
    // default paste has already inserted content, causing duplicate images.
    if (hasFile) e.preventDefault()

    // Clipboard images often arrive as multiple format representations of the
    // same picture (e.g. PNG + TIFF on macOS, or PNG + BMP on Windows). They
    // share a generic name like "image.png" and the same lastModified, but have
    // different sizes. Drop duplicates, keeping the preferred provider format.
    const MIME_PREF_ORDER = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp', 'image/tiff']
    const isGenericClipboardName = (name: string) =>
      name === '' || /^image(\.[a-z0-9]+)?$/i.test(name) || /^pasted[-_]image(\.[a-z0-9]+)?$/i.test(name) || /^clipboard(\.[a-z0-9]+)?$/i.test(name)
    const genericImages = pasted
      .map((p, idx) => ({ ...p, idx, mime: p.mimeHint || p.file.type || '' }))
      .filter(p => isGenericClipboardName(p.file.name) && (p.mime.startsWith('image/') || !p.file.name.includes('.')))
    const keepIdx = new Set<number>(pasted.map((_, i) => i))
    const byTimestamp = new Map<number, typeof genericImages>()
    for (const p of genericImages) {
      const list = byTimestamp.get(p.file.lastModified) ?? []
      list.push(p)
      byTimestamp.set(p.file.lastModified, list)
    }
    for (const group of byTimestamp.values()) {
      if (group.length <= 1) continue
      group.sort((a, b) => {
        const rankA = MIME_PREF_ORDER.indexOf(a.mime)
        const rankB = MIME_PREF_ORDER.indexOf(b.mime)
        if (rankA !== rankB) return (rankA === -1 ? 999 : rankA) - (rankB === -1 ? 999 : rankB)
        return a.idx - b.idx
      })
      for (let i = 1; i < group.length; i++) keepIdx.delete(group[i]!.idx)
    }
    const deduped = pasted.filter((_, i) => keepIdx.has(i))

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

    const classified = await Promise.all(deduped.map(classify))
    const imageFiles = classified.filter(c => isImageFile(c.fileLike)).map(c => c.file)
    const textFiles = classified.filter(c => isTextFile(c.fileLike) && !isImageFile(c.fileLike)).map(c => c.file)
    const unsupportedFiles = classified.filter(c => isUnsupportedFile(c.fileLike)).map(c => c.file)

    if (imageFiles.length === 0 && textFiles.length === 0 && unsupportedFiles.length === 0) return
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
        contents.push(t('fileTooLarge', { name: f.name }))
        continue
      }
      try {
        const text = await f.text()
        contents.push(`${t('fileInlined', { name: f.name })}\n\`\`\`\n${text}\n\`\`\``)
      } catch {
        contents.push(t('fileReadFailed', { name: f.name }))
      }
    }
    if (contents.length > 0) {
      const insert = contents.join('\n\n')
      onChange(value ? `${value}\n${insert}` : insert)
    }
  }, [value, onChange, t])

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
      className={`composer${dragOver ? ' drag-over' : ''}${planning ? ' planning' : ''} accent-${activeDomainAccent}`}
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
                  {path === COMPUTER_MENTION_ITEM ? (
                    <>
                      <span className="suggest-glyph" aria-hidden>🖥️</span>
                      <span className="suggest-path">Computer</span>
                      <span className="suggest-desc">{t('computerMentionDesc')}</span>
                    </>
                  ) : (
                    <>
                      <span className="suggest-glyph" aria-hidden>@</span>
                      <span className="suggest-path">{path}</span>
                    </>
                  )}
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
              <img src={src} alt={t('imageAlt', { index: i + 1 })} />
              <button className="thumb-remove" onClick={() => removeImage(i)} aria-label={t('removeImage')}>×</button>
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
                aria-label={t('removeMention', { path })}
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
          className="composer-input"
          value={text}
          placeholder={planning
            ? t('placeholderPlan')
            : busy
            ? t('placeholderBusy')
            : t('placeholderIdle')}
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
          title={t('selectFile')}
          aria-label={t('selectFile')}
        >📎</button>
        {speechSupported && (
          <button
            className={`btn ghost icon-btn ${recording ? 'recording' : ''}`}
            onClick={toggleRecording}
            disabled={busy}
            title={recording ? t('voiceStop') : t('voiceStart')}
            aria-label={recording ? t('voiceStop') : t('voiceStart')}
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
            effort={effort}
            onSetEffort={onSetEffort}
            onPickImage={() => fileInputRef.current?.click()}
            imageDisabled={images.length >= MAX_IMAGES}
            commands={commands}
            onRunCommand={runCommand}
            onDelegate={onDelegate}
            onWorkflow={onWorkflow}
            onClose={() => {}}
            threadNonEmpty={threadNonEmpty}
          />
        </div>
        <ModelPicker sessionId={sessionId} disabled={busy} menuRev={menuRev} />
        <DomainPicker sessionId={sessionId} disabled={busy} menuRev={menuRev} threadNonEmpty={threadNonEmpty} />
        {approvalLevel && onSetApprovalLevel && (
          <AutonomyMenu value={approvalLevel} onChange={onSetApprovalLevel} />
        )}
        {contextUsage && <ContextRing usage={contextUsage} />}
        {onSetPlanMode && (
          <button
            className={`mode-toggle ${planning ? 'plan' : 'agent'}`}
            onClick={togglePlan}
            title={t('planToggleTitle')}
          >
            <span className="mode-dot" aria-hidden />
            {planning ? 'Plan' : 'Agent'}
          </button>
        )}
        <span className="composer-spacer" />
        <button
          className="send-mode-toggle"
          title={sendMode === 'enter' ? t('sendModeEnter') : t('sendModeShiftEnter')}
          onClick={() => {
            const next = sendMode === 'enter' ? 'shift-enter' : 'enter'
            setSendMode(next)
            saveSendMode(next)
          }}
        >
          {sendMode === 'enter' ? '↵' : '⇧↵'}
        </button>
        {busy ? (
          <>
            <button className="btn ghost" onClick={submit} disabled={!canSend}>{t('steer')}</button>
            <button className="btn ghost danger" onClick={onAbort}>{t('stop')}</button>
          </>
        ) : (
          <button className="btn" onClick={submit} disabled={!canSend}>
            {planning ? t('generate') : t('send')}
          </button>
        )}
      </div>
    </div>
  )
})

function formatTok(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

/** Context usage ring (P1-1) — SVG ring beside the send button; >80% turns
 *  warning-colored with a /compact hint. Click opens a detail popover with
 *  cache hit rate (our DeepSeek prefix-cache visibility, Claude doesn't have
 *  this). Hidden when the model window is unknown and nothing was used yet. */
function ContextRing({ usage }: { usage: ContextUsage }) {
  const { t } = useTranslation('composer')
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const { usedTokens, contextWindow, cacheReadTokens, cacheCreationTokens, deltaTokens } = usage
  if (!usedTokens && !cacheReadTokens && !cacheCreationTokens) return null

  const pct = contextWindow && contextWindow > 0
    ? Math.min(Math.round((usedTokens / contextWindow) * 100), 100)
    : null
  const warn = pct !== null && pct >= 80
  const cacheTotal = cacheReadTokens + cacheCreationTokens
  const hitRate = cacheTotal > 0 ? Math.round((cacheReadTokens / cacheTotal) * 100) : null

  // r=7 ring in a 18×18 viewBox; stroke-dasharray drives the fill arc.
  const r = 7
  const circ = 2 * Math.PI * r
  const filled = pct !== null ? (pct / 100) * circ : 0

  return (
    <div className={`ctx-ring-wrap ${warn ? 'warn' : ''}`} ref={ref}>
      <button
        className="ctx-ring-trigger"
        onClick={() => setOpen((o) => !o)}
        title={pct !== null
          ? `${t('ctx.title', { used: formatTok(usedTokens), window: formatTok(contextWindow!), pct })}${warn ? t('ctx.compactSuffix') : ''}`
          : t('ctx.titleTokens', { used: formatTok(usedTokens) })}
        aria-label={t('ctx.aria')}
        aria-expanded={open}
      >
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden>
          <circle cx="9" cy="9" r={r} fill="none" stroke="var(--border)" strokeWidth="2.5" />
          {pct !== null && (
            <circle
              cx="9" cy="9" r={r} fill="none"
              stroke={warn ? 'var(--warning, #f59e0b)' : 'var(--accent)'}
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeDasharray={`${filled} ${circ - filled}`}
              transform="rotate(-90 9 9)"
            />
          )}
        </svg>
        <span className="ctx-ring-label">{pct !== null ? `${pct}%` : formatTok(usedTokens)}</span>
      </button>
      {open && (
        <div className="ctx-ring-popover" role="dialog" aria-label={t('ctx.detailAria')}>
          <div className="ctx-ring-row">
            <span>{t('ctx.rowContext')}</span>
            <span>{formatTok(usedTokens)}{contextWindow ? ` / ${formatTok(contextWindow)}` : ''} tok</span>
          </div>
          {deltaTokens > 0 && (
            <div className="ctx-ring-row">
              <span>{t('ctx.rowDelta')}</span>
              <span>+{formatTok(deltaTokens)}</span>
            </div>
          )}
          {hitRate !== null && (
            <>
              <div className="ctx-ring-row">
                <span>{t('ctx.rowHitRate')}</span>
                <span>⚡{hitRate}%</span>
              </div>
              <div className="ctx-ring-row sub">
                <span>{t('ctx.rowReadCreate')}</span>
                <span>{formatTok(cacheReadTokens)} / {formatTok(cacheCreationTokens)}</span>
              </div>
            </>
          )}
          {warn && <div className="ctx-ring-hint">{t('ctx.hint')}</div>}
        </div>
      )}
    </div>
  )
}

/** Inline model selector in the composer bar (Codex-style). */
function ModelPicker({ sessionId, disabled, menuRev }: { sessionId: string; disabled?: boolean; menuRev?: number }) {
  const { t } = useTranslation('composer')
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
      if (withSpinner) toast.error(t('modelLoadError', { message: (err as Error).message }))
    } finally {
      if (withSpinner) setLoading(false)
    }
  }, [sessionId, t])

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
      toast.error(t('modelSwitchError', { message: (err as Error).message }))
    } finally {
      setSwitchingId(null)
    }
  }

  return (
    <div className="model-picker" ref={ref}>
      <button
        className="model-picker-trigger model-active"
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !!switchingId}
        title={disabled ? t('modelDisabled') : t('switchModel')}
        aria-label={t('switchModel')}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span aria-hidden>◇</span>
        <span className="model-picker-label">{switchingId ? t('switching') : label}</span>
      </button>
      {open && (
        <div className="model-picker-menu" role="listbox">
          {loading && (
            <div className="model-picker-item" role="status" aria-busy>
              <span className="model-picker-name">{t('loading')}</span>
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
                <span className="model-picker-desc">{t('switching')}</span>
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
function DomainPicker({ sessionId, disabled, menuRev, threadNonEmpty }: { sessionId: string; disabled?: boolean; menuRev?: number; threadNonEmpty?: boolean }) {
  const { t } = useTranslation('composer')
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
      if (withSpinner) toast.error(t('domainLoadError', { message: (err as Error).message }))
    } finally {
      if (withSpinner) setLoading(false)
    }
  }, [sessionId, t])

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
  const label = current?.name || t('domain')

  const select = async (e: DomainEntry) => {
    if (disabled || e.current) return
    // Mid-session switch invalidates the prefix cache (~10x rebuild). Confirm first.
    if (threadNonEmpty && !window.confirm(`⚠ ${t('domainCacheWarning')}\n\n${t('domainSwitchConfirm', { name: e.name })}`)) {
      return
    }
    setApplyingKey(e.key)
    try {
      await setDomain(sessionId, e.key)
      setEntries((prev) => prev.map((x) => ({ ...x, current: x.key === e.key })))
      setOpen(false)
    } catch (err) {
      toast.error(t('domainSwitchError', { message: (err as Error).message }))
    } finally {
      setApplyingKey(null)
    }
  }

  return (
    <div className="model-picker domain-picker" ref={ref}>
      <button
        className={`model-picker-trigger accent-${current?.uiPersona?.accent || 'primary'}`}
        onClick={() => setOpen((o) => !o)}
        disabled={disabled || !!applyingKey}
        title={disabled ? t('domainDisabled') : t('switchDomain')}
        aria-label={t('switchDomain')}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span aria-hidden>{glyph}</span>
        <span className="model-picker-label">{applyingKey ? t('switching') : label}</span>
      </button>
      {open && (
        <div className="model-picker-menu" role="listbox">
          {threadNonEmpty && (
            <div className="model-picker-hint" role="note">
              ⚠ {t('domainCacheWarning')}
            </div>
          )}
          {loading && (
            <div className="model-picker-item" role="status" aria-busy>
              <span className="model-picker-name">{t('loading')}</span>
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
                <span className="model-picker-desc">{t('switching')}</span>
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
