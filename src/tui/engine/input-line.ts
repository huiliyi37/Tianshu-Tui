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

export type VimMode = 'normal' | 'insert'

export class InputLine {
  private _value: string
  private _cursor: number
  private _placeholder: string
  private _history: string[]
  private _historyIdx: number
  private _vimEnabled: boolean
  private _vimMode: VimMode
  private _maxLength: number

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
      const submitted = this._value
      this.onSubmitCallback?.(submitted)
      return { type: 'submit', value: submitted }
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

      case 'backspace': return this.backspace()
      case 'delete': return this.deleteForward()
      case 'left': return this.moveLeft()
      case 'right': return this.moveRight()
      case 'home': return this.moveHome()
      case 'end': return this.moveEnd()
      case 'up': return this.historyPrev()
      case 'down': return this.historyNext()

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
    const before = this._value.slice(0, this._cursor - 1)
    const after = this._value.slice(this._cursor)
    this._value = before + after
    this._cursor--
    this.onChangeCallback?.(this._value, this._cursor)
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private deleteForward(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    const before = this._value.slice(0, this._cursor)
    const after = this._value.slice(this._cursor + 1)
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
    this._cursor--
    return { type: 'change', value: this._value, cursor: this._cursor }
  }

  private moveRight(): InputLineEvent | null {
    if (this._cursor >= this._value.length) return null
    this._cursor++
    return { type: 'change', value: this._value, cursor: this._cursor }
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
      case 'return':
        this.onSubmitCallback?.(this._value)
        return { type: 'submit', value: this._value }
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
