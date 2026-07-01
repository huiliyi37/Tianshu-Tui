/**
 * T9 InputLine — 纯 TypeScript 类，替代 base-text-input.tsx / input.tsx。
 *
 * 管理输入文本缓冲区、光标位置、历史、Vim 模式。
 * 零 React/Ink 依赖。通过回调通知外部变化。
 *
 * 核心能力：
 * - 字符输入 + 多字节 UTF-8 支持
 * - 光标移动（左右/home/end/词级）
 * - 删除（backspace/delete/词级删除）
 * - 历史导航（上下键）
 * - 行内编辑（Ctrl+A/E/U/K/W）
 * - Vim 模式（Normal/Insert）
 * - Tab 补全接口
 * - 粘贴支持
 */

export type InputLineEvent =
  | { type: 'change'; value: string; cursor: number }
  | { type: 'submit'; value: string }
  | { type: 'tab' }
  | { type: 'history'; direction: 'prev' | 'next' }

export interface InputLineOptions {
  /** 初始文本值 */
  value?: string
  /** 占位符文本（当 value 为空时显示） */
  placeholder?: string
  /** 历史记录（最新的在前） */
  history?: string[]
  /** 是否启用 Vim 模式 */
  vimEnabled?: boolean
  /** 回调 */
  onChange?: (value: string, cursor: number) => void
  onSubmit?: (value: string) => void
  onTabComplete?: () => boolean
  /** 最大输入长度 */
  maxLength?: number
}

export interface InputLineDisplayOptions {
  /** Maximum display rows to return. When exceeded, keep the cursor line visible. */
  maxLines?: number
  /** Maximum display columns per line. When the cursor line exceeds this width,
   *  a horizontal viewport centered on the cursor is shown instead of truncating
   *  from the start (which hides the text the user is actively typing at the end). */
  maxWidth?: number
}

export type VimMode = 'normal' | 'insert'

/** Grapheme 分段器（Node 22+）。用于按用户感知字符（CJK/emoji/ZWJ 簇）步进光标。 */
const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

import stringWidth from 'string-width'

/**
 * Grapheme 边界缓存：Intl.Segmenter 对整串分段是 O(n)，而 prevGrapheme/
 * nextGrapheme 在每次光标移动（左右键/backspace/delete）都被调用。长输入下
 * 每次按键重跑全长分段会卡。按 value 缓存边界数组，value 未变（纯光标移动）
 * 直接复用；并用二分定位而非线性扫描边界。
 */
interface GraphemeCache {
  value: string
  bounds: number[] // 升序的 code-unit 偏移（含 0 与末尾）
}

/** 返回字符串中所有 grapheme 边界的 code-unit 偏移（含 0 与末尾）。 */
function graphemeBoundaries(value: string): number[] {
  const bounds = [0]
  for (const seg of graphemeSegmenter.segment(value)) {
    bounds.push(seg.index + seg.segment.length)
  }
  return bounds
}

/**
 * 水平视窗：当光标行的内容部分超过可用宽度时，以光标位置为中心截取可见窗口。
 * 前缀（`〉 ` 或 `  `）始终保留，截断只发生在内容部分。
 *
 * @param prefix 固定前缀（如 `〉 `），始终完整保留
 * @param beforeCursor 光标前的内容文本
 * @param afterCursor 光标后含 `█` 的文本（`█${rest}`）
 * @param maxCols 该行的最大显示列数（含前缀）
 */
function hscrollCursorLine(
  prefix: string,
  beforeCursor: string,
  afterCursor: string,
  maxCols: number,
): string {
  const prefixWidth = stringWidth(prefix)
  const beforeW = stringWidth(beforeCursor)
  const afterW = stringWidth(afterCursor) // includes █
  const contentW = beforeW + afterW
  const available = maxCols - prefixWidth
  if (contentW <= available) return prefix + beforeCursor + afterCursor

  const max = Math.max(3, available)
  const reserveLeft = 1 // `…` marker
  const reserveRight = 1
  const usable = max - reserveLeft - reserveRight
  if (usable < 1) return prefix + beforeCursor.slice(-max) // extreme fallback

  // 以光标为中心分配左右预算
  let leftBudget = Math.floor(usable / 2)
  let rightBudget = usable - leftBudget

  if (beforeW < leftBudget) {
    rightBudget += leftBudget - beforeW
    leftBudget = beforeW
  }
  if (afterW < rightBudget) {
    leftBudget += rightBudget - afterW
    rightBudget = afterW
  }

  // 从光标向左收集字符
  const leftChars: string[] = []
  let leftW = 0
  for (const ch of [...beforeCursor].reverse()) {
    const cw = stringWidth(ch)
    if (leftW + cw > leftBudget) break
    leftChars.unshift(ch)
    leftW += cw
  }

  // 从光标向右收集字符（afterCursor 含 █ + rest）
  const rightChars: string[] = []
  let rightW = 0
  for (const ch of afterCursor) {
    const cw = stringWidth(ch)
    if (rightW + cw > rightBudget + reserveRight) break
    rightChars.push(ch)
    rightW += cw
  }

  const leftEllipsis = leftW < beforeW ? '…' : ''
  const rightEllipsis = rightW < afterW ? '…' : ''

  return prefix + leftEllipsis + leftChars.join('') + rightChars.join('') + rightEllipsis
}

/** 在升序边界数组中找严格小于 cursor 的最大下标（光标左侧最近边界）。二分 O(log n)。 */
function boundaryBefore(bounds: number[], cursor: number): number {
  let lo = 0, hi = bounds.length - 1, ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1
    if (bounds[mid]! < cursor) { ans = bounds[mid]!; lo = mid + 1 }
    else hi = mid - 1
  }
  return ans
}

/** 在升序边界数组中找严格大于 cursor 的最小下标（光标右侧最近边界）。二分 O(log n)。 */
function boundaryAfter(bounds: number[], cursor: number): number {
  let lo = 0, hi = bounds.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (bounds[mid]! > cursor) hi = mid
    else lo = mid + 1
  }
  return bounds[lo]! > cursor ? bounds[lo]! : -1
}

function viewportAroundCursor(lines: string[], cursorLine: number, maxLines?: number): string[] {
  if (maxLines === undefined || lines.length <= maxLines) return lines
  const max = Math.max(1, Math.floor(maxLines))
  const cursor = Math.min(Math.max(cursorLine, 0), lines.length - 1)
  if (max === 1) return [lines[cursor]!]
  if (max === 2) {
    return cursor < lines.length - 1
      ? [lines[cursor]!, `… ${lines.length - cursor - 1} lines below`]
      : [`… ${cursor} lines above`, lines[cursor]!]
  }

  const hasAbove = cursor > 0
  const hasBelow = cursor < lines.length - 1
  const contentSlots = Math.max(1, max - (hasAbove ? 1 : 0) - (hasBelow ? 1 : 0))
  const minStart = hasAbove ? 1 : 0
  const maxStart = hasBelow
    ? Math.max(minStart, lines.length - 1 - contentSlots)
    : Math.max(minStart, lines.length - contentSlots)
  const centeredStart = cursor - Math.floor(contentSlots / 2)
  const start = Math.min(Math.max(centeredStart, minStart), maxStart)
  const visible = lines.slice(start, start + contentSlots)

  return [
    ...(hasAbove ? [`… ${start} lines above`] : []),
    ...visible,
    ...(hasBelow ? [`… ${lines.length - (start + contentSlots)} lines below`] : []),
  ]
}

export class InputLine {
  private _value: string
  private _cursor: number
  private _placeholder: string
  private _history: string[]
  private _historyIdx: number
  private _vimEnabled: boolean
  private _vimMode: VimMode
  private _maxLength: number

  /** Grapheme 边界缓存（按 value 失效）。光标移动不改 value，命中缓存省去 O(n) 分段。 */
  private _graphemeCache: GraphemeCache | null = null

  private onChangeCallback?: (value: string, cursor: number) => void
  private onSubmitCallback?: (value: string) => void
  private onTabCompleteCallback?: () => boolean

  constructor(options: InputLineOptions = {}) {
    this._value = options.value ?? ''
    this._cursor = this._value.length
    this._placeholder = options.placeholder ?? ''
    this._history = options.history ?? []
    this._historyIdx = -1
    this._vimEnabled = options.vimEnabled ?? false
    this._vimMode = 'insert'
    this._maxLength = options.maxLength ?? 100000
    this.onChangeCallback = options.onChange
    this.onSubmitCallback = options.onSubmit
    this.onTabCompleteCallback = options.onTabComplete
  }

  // ── Accessors ────────────────────────────────────────────────

  get value(): string { return this._value }
  get cursor(): number { return this._cursor }
  get vimMode(): VimMode { return this._vimMode }
  get vimEnabled(): boolean { return this._vimEnabled }
  get placeholder(): string { return this._placeholder }

  /** 启用/停用 vim 键位。停用或启用时都复位到 insert 模式，避免残留 normal 态吞字符。 */
  setVimEnabled(enabled: boolean): void {
    this._vimEnabled = enabled
    this._vimMode = 'insert'
  }

  /**
   * 多行渲染：返回输入框的显示行数组。
   * - 空值时显示 placeholder（首行）
   * - 光标行以 `〉 ` 前缀标识（高亮行），其余行缩进对齐
   * - 光标位置以 `█` 标记
   * - 当 maxWidth 给出时，对光标行做水平视窗：内容超宽时以光标为中心截取，
   *   保证光标位置（正在输入的字符）始终可见，而非从行首截断导致行尾不可见。
   */
  displayLines(options: InputLineDisplayOptions = {}): string[] {
    if (!this._value) {
      return [`〉 █${this._placeholder}`]
    }
    const before = this._value.slice(0, this._cursor)
    const cursorLine = before.split('\n').length - 1
    const cursorCol = before.length - (before.lastIndexOf('\n') + 1)

    const lines = this._value.split('\n').map((line, i) => {
      const isCursorLine = i === cursorLine
      const prefix = isCursorLine ? '〉 ' : '  '
      if (!isCursorLine) return `${prefix}${line}`
      const beforeCursor = line.slice(0, cursorCol)
      const afterCursor = `█${line.slice(cursorCol)}`
      if (options.maxWidth === undefined) return `${prefix}${beforeCursor}${afterCursor}`
      return hscrollCursorLine(prefix, beforeCursor, afterCursor, options.maxWidth)
    })
    return viewportAroundCursor(lines, cursorLine, options.maxLines)
  }

  /** 设置值（外部更新用） */
  setValue(value: string, cursor?: number): void {
    this._value = value.slice(0, this._maxLength)
    this._cursor = cursor !== undefined ? Math.min(cursor, this._value.length) : this._value.length
    this.onChangeCallback?.(this._value, this._cursor)
  }

  /** 追加文本到末尾 */
  append(text: string): void {
    this.setValue(this._value + text, this._value.length + text.length)
  }

  /** 在光标处插入文本（用于 bracketed paste），光标移动到插入内容之后。 */
  insertText(text: string): void {
    if (!text) return
    const before = this._value.slice(0, this._cursor)
    const after = this._value.slice(this._cursor)
    const next = (before + text + after).slice(0, this._maxLength)
    const cursor = Math.min(before.length + text.length, next.length)
    this.setValue(next, cursor)
  }

  /** 设置历史 */
  setHistory(history: string[]): void {
    this._history = history
  }

  // ── Key Dispatch ─────────────────────────────────────────────

  /**
   * 处理按键。返回处理后的文本值（如果需要渲染）。
   */
  handleKey(name: string, char: string, ctrl: boolean, meta: boolean): InputLineEvent | null {
    // ── 全局键 ─────────────────────────────────────────────────
    if (name === 'return') {
      // 多行输入：`\` + Enter 续行（去掉尾部反斜杠，插入换行）
      if (this._value.slice(0, this._cursor).endsWith('\\')) {
        const before = this._value.slice(0, this._cursor - 1)
        const after = this._value.slice(this._cursor)
        this._value = before + '\n' + after
        // 光标落在新插入的换行符之后（去掉了尾部 `\`，补了一个 `\n`）
        this._cursor = before.length + 1
        this.onChangeCallback?.(this._value, this._cursor)
        return { type: 'change', value: this._value, cursor: this._cursor }
      }
      const submitted = this._value
      this.clearAfterSubmit()
      this.onSubmitCallback?.(submitted)
      return { type: 'submit', value: submitted }
    }

    // 多行输入：Ctrl+J 插入换行
    if (name === 'ctrl_j') {
      return this.insertChar('\n')
    }

    if (name === 'tab' && !ctrl) {
      this.onTabCompleteCallback?.()
      return { type: 'tab' }
    }

    // ── Vim mode: normal ────────────────────────────────────────
    if (this._vimEnabled && this._vimMode === 'normal') {
      return this.handleVimNormal(name, char, ctrl)
    }

    // ── Insert mode ────────────────────────────────────────────
    // Meta/Option key (word-level) — check before switch
    if (meta) {
      switch (name) {
        case 'left': return this.moveWordLeft()
        case 'right': return this.moveWordRight()
        case 'backspace': return this.deleteWordBack()
        case 'delete': return this.deleteWordForward()
        default: return null
      }
    }

    switch (name) {
      case 'escape':
        if (this._vimEnabled) {
          this._vimMode = 'normal'
          return null
        }
        break // not vim → fall through to ignore

      case 'backspace':
      case 'ctrl_h': return this.backspace()
      case 'delete': return this.deleteForward()
      case 'left': return this.moveLeft()
      case 'right': return this.moveRight()
      case 'home': return this.moveHome()
      case 'end': return this.moveEnd()
      case 'up': return this.moveUpOrHistory()
      case 'down': return this.moveDownOrHistory()

      default: break
    }

    // Ctrl+key combos (in insert mode)
    if (ctrl) {
      switch (name) {
        case 'ctrl_a': return this.moveHome()
        case 'ctrl_e': return this.moveEnd()
        case 'ctrl_u': return this.deleteToStart()
        case 'ctrl_k': return this.deleteToEnd()
        case 'ctrl_w': return this.deleteWordBack()
        case 'ctrl_d': return this.deleteForward()
        case 'ctrl_b': return this.moveLeft()
        case 'ctrl_f': return this.moveRight()
        case 'ctrl_n': return this.historyNext()
        case 'ctrl_p': return this.historyPrev()
        default: break
      }
      return null
    }

    // ── 可打印字符 ─────────────────────────────────────────────
    if (char && char.length > 0 && !ctrl) {
      return this.insertChar(char)
    }

    return null
  }

  // ── Editing Operations ───────────────────────────────────────

  /**
   * 提交后重置缓冲：清空文本、归零光标、复位历史游标。
   * 不触发 onChangeCallback —— submit 路径自己负责后续渲染，
   * 避免在 submit 回调里又触发一次 change 渲染造成竞态。
   */
  private clearAfterSubmit(): void {
    this._value = ''
    this._cursor = 0
    this._historyIdx = -1
  }

  private insertChar(ch: string): InputLineEvent | null {
    if (this._value.length >= this._maxLength) return null
    const before = this._value.slice(0, this._cursor)
    const after = this._value.slice(this._cursor)
    this._value = before + ch + after
    this._cursor += ch.length
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private backspace(): InputLineEvent | null {
    if (this._cursor <= 0) return null
    // grapheme-aware：删除光标左侧一个完整用户字符（CJK/emoji 簇）
    const start = this.prevGrapheme()
    const before = this._value.slice(0, start)
    const after = this._value.slice(this._cursor)
    this._value = before + after
    this._cursor = start
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteForward(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    // grapheme-aware：删除光标右侧一个完整用户字符
    const end = this.nextGrapheme()
    const before = this._value.slice(0, this._cursor)
    const after = this._value.slice(end)
    this._value = before + after
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteToStart(): InputLineEvent | null {
    if (this._cursor <= 0) return null
    this._value = this._value.slice(this._cursor)
    this._cursor = 0
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteToEnd(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    this._value = this._value.slice(0, this._cursor)
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteWordBack(): InputLineEvent | null {
    if (this._cursor <= 0) return null
    const start = this.prevWordStart()
    const before = this._value.slice(0, start)
    const after = this._value.slice(this._cursor)
    this._value = before + after
    this._cursor = start
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteWordForward(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    const end = this.nextWordEnd()
    const before = this._value.slice(0, this._cursor)
    const after = this._value.slice(end)
    this._value = before + after
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  // ── Cursor Movement ──────────────────────────────────────────

  private moveLeft(): InputLineEvent | null {
    if (this._cursor <= 0) return null
    this._cursor = this.prevGrapheme()
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private moveRight(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    this._cursor = this.nextGrapheme()
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  /** 光标左侧最近的 grapheme 边界。 */
  private prevGrapheme(): number {
    if (this._cursor <= 0) return 0
    return boundaryBefore(this.graphemeBounds(), this._cursor)
  }

  /** 光标右侧最近的 grapheme 边界。 */
  private nextGrapheme(): number {
    if (this._cursor >= this._value.length) return this._value.length
    const b = boundaryAfter(this.graphemeBounds(), this._cursor)
    return b < 0 ? this._value.length : b
  }

  /** 当前 value 的 grapheme 边界（按 value 缓存，纯光标移动命中缓存）。 */
  private graphemeBounds(): number[] {
    if (this._graphemeCache?.value === this._value) return this._graphemeCache.bounds
    const bounds = graphemeBoundaries(this._value)
    this._graphemeCache = { value: this._value, bounds }
    return bounds
  }

  private moveHome(): InputLineEvent | null {
    if (this._cursor === 0) return null
    this._cursor = 0
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private moveEnd(): InputLineEvent | null {
    if (this._cursor === this._value.length) return null
    this._cursor = this._value.length
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private moveWordLeft(): InputLineEvent | null {
    const start = this.prevWordStart()
    if (start === this._cursor) return null
    this._cursor = start
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private moveWordRight(): InputLineEvent | null {
    const end = this.nextWordEnd()
    if (end === this._cursor || end >= this._value.length && this._cursor === this._value.length) return null
    this._cursor = end
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  // ── Multi-line Navigation ────────────────────────────────────

  /** 当前光标的（行,列），列以 code-unit 计。 */
  private getLineCol(pos: number): { line: number; col: number } {
    const parts = this._value.slice(0, pos).split('\n')
    return { line: parts.length - 1, col: parts[parts.length - 1]!.length }
  }

  /** 由（行,列）还原 code-unit 偏移，col 超出行长则贴到行尾。 */
  private posFromLineCol(line: number, col: number): number {
    const lines = this._value.split('\n')
    const clampedLine = Math.max(0, Math.min(line, lines.length - 1))
    let pos = 0
    for (let i = 0; i < clampedLine; i++) pos += lines[i]!.length + 1 // +1 = '\n'
    pos += Math.min(col, lines[clampedLine]!.length)
    return pos
  }

  /** Up：多行且不在首行时上移一行，否则取上一条历史。 */
  private moveUpOrHistory(): InputLineEvent | null {
    if (this._value.includes('\n')) {
      const { line, col } = this.getLineCol(this._cursor)
      if (line > 0) {
        this._cursor = this.posFromLineCol(line - 1, col)
        return { type: 'change', value: this._value, cursor: this._cursor }
      }
    }
    return this.historyPrev()
  }

  /** Down：多行且不在末行时下移一行，否则取下一条历史。 */
  private moveDownOrHistory(): InputLineEvent | null {
    if (this._value.includes('\n')) {
      const { line, col } = this.getLineCol(this._cursor)
      const lastLine = this._value.split('\n').length - 1
      if (line < lastLine) {
        this._cursor = this.posFromLineCol(line + 1, col)
        return { type: 'change', value: this._value, cursor: this._cursor }
      }
    }
    return this.historyNext()
  }

  // ── History ──────────────────────────────────────────────────

  private historyPrev(): InputLineEvent | null {
    if (this._history.length === 0) return null
    if (this._historyIdx === -1) this._historyIdx = 0
    else if (this._historyIdx < this._history.length - 1) this._historyIdx++
    else return null
    this._value = this._history[this._historyIdx] ?? ''
    this._cursor = this._value.length
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private historyNext(): InputLineEvent | null {
    if (this._historyIdx <= 0) return null
    this._historyIdx--
    this._value = this._history[this._historyIdx] ?? ''
    if (this._historyIdx === 0) this._historyIdx = -1
    this._cursor = this._value.length
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  // ── Vim Normal Mode ──────────────────────────────────────────

  private handleVimNormal(name: string, _char: string, _ctrl: boolean): InputLineEvent | null {
    switch (name) {
      case 'escape': return null
      case 'return': {
        const submitted = this._value
        this.clearAfterSubmit()
        this.onSubmitCallback?.(submitted)
        return { type: 'submit', value: submitted }
      }
      case 'left':
      case 'ctrl_b': return this.moveLeft()
      case 'right':
      case 'ctrl_f': return this.moveRight()
      case 'home': return this.moveHome()
      case 'end': return this.moveEnd()
      case 'up': return this.historyPrev()
      case 'down': return this.historyNext()
      default:
        // i → insert, a → append, I → insert at start, A → append at end
        if (_char === 'i') { this._vimMode = 'insert'; return null }
        if (_char === 'a') { this._cursor = Math.min(this._cursor + 1, this._value.length); this._vimMode = 'insert'; return null }
        if (_char === 'I') { this._cursor = 0; this._vimMode = 'insert'; return null }
        if (_char === 'A') { this._cursor = this._value.length; this._vimMode = 'insert'; return null }
        // x → delete char, D → delete to end
        if (_char === 'x') return this.deleteForward()
        if (_char === 'D') return this.deleteToEnd()
        // 0 → home, $ → end, ^ → first non-whitespace
        if (_char === '0') return this.moveHome()
        if (_char === '$') return this.moveEnd()
        if (_char === '^') { this._cursor = this._value.search(/\S|$/); return { type: 'change', value: this._value, cursor: this._cursor } }
        if (_char === 'w') return this.moveWordRightVim()
        if (_char === 'b') return this.moveWordLeft()
        return null
    }
  }

  // ── Word Navigation Helpers ──────────────────────────────────

  private prevWordStart(): number {
    if (this._cursor <= 0) return 0
    let i = this._cursor - 1
    while (i > 0 && !/\w/.test(this._value[i] ?? '')) i--
    while (i > 0 && /\w/.test(this._value[i - 1] ?? '')) i--
    return i
  }

  private nextWordEnd(): number {
    if (this._cursor >= this._value.length) return this._value.length
    let i = this._cursor
    while (i < this._value.length && !/\w/.test(this._value[i] ?? '')) i++
    if (i >= this._value.length) return this._cursor
    while (i < this._value.length && /\w/.test(this._value[i] ?? '')) i++
    return i
  }

  /** Vim 'w' — move to start of next word (not end) */
  private moveWordRightVim(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    let i = this._cursor
    // Skip current word
    while (i < this._value.length && /\w/.test(this._value[i] ?? '')) i++
    // Skip whitespace
    while (i < this._value.length && !/\w/.test(this._value[i] ?? '')) i++
    if (i === this._cursor) return null
    this._cursor = i
    return { type: 'change', value: this._value, cursor: this._cursor }
  }
}
