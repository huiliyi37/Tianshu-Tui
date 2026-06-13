/**
 * T9 InputHandler — 统一键盘输入处理（替代 Ink 的 useInput hooks）。
 *
 * 核心功能：
 * - 设置 stdin raw mode，逐字节读取
 * - 解析 UTF-8 字符 + ANSI escape sequences（方向键、功能键等）
 * - 支持多种输入模式：normal / input / overlay / vim
 * - 分发按键事件到注册的处理器
 *
 * 按键类型分类（参考 Node.js readline + Ink 的 keypress 解析）：
 * - 可打印字符（UTF-8）：直接分发
 * - 控制字符（Ctrl+A..Z, Tab, Enter, Escape, Backspace）
 * - ANSI escape sequences（方向键、Home/End、PgUp/PgDn、F1-F12）
 * - 鼠标事件（SGR mouse protocol）— 暂不处理
 */

import type { ReadStream } from 'node:tty'

export interface KeyPress {
  /** 按键原始字符串 */
  raw: string
  /** 可打印字符（如 'a', '你'），控制键为 '' */
  char: string
  /** 按键名称 */
  name: KeyName
  /** Ctrl 是否按下 */
  ctrl: boolean
  /** Alt/Meta 是否按下 */
  meta: boolean
  /** Shift 是否按下 */
  shift: boolean
}

export type KeyName =
  | 'return'
  | 'escape'
  | 'tab'
  | 'backspace'
  | 'delete'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'home'
  | 'end'
  | 'pageup'
  | 'pagedown'
  | 'insert'
  | 'f1' | 'f2' | 'f3' | 'f4' | 'f5' | 'f6' | 'f7' | 'f8' | 'f9' | 'f10' | 'f11' | 'f12'
  | 'space'
  | 'ctrl_c'
  | 'ctrl_d'
  | 'ctrl_h'
  | 'ctrl_j'
  | 'ctrl_z'
  | 'ctrl_l'
  | 'ctrl_u'
  | 'ctrl_a'
  | 'ctrl_e'
  | 'ctrl_k'
  | 'ctrl_w'
  | 'ctrl_n'
  | 'ctrl_o'
  | 'ctrl_p'
  | 'ctrl_r'
  | 'ctrl_t'
  | 'ctrl_b'
  | 'ctrl_f'
  | 'unknown'

export type KeyHandler = (key: KeyPress) => void

export interface InputHandlerOptions {
  stdin: ReadStream
  /** 初始输入模式 */
  mode?: InputMode
  /** 单独 ESC 字节的刷新超时（ms）。期间无后续字节则派发 escape。 */
  escapeTimeoutMs?: number
}

/** Bracketed paste 标记（DEC 2004） */
const PASTE_START = '\x1B[200~'
const PASTE_END = '\x1B[201~'

export type InputMode = 'normal' | 'input' | 'overlay' | 'approval' | 'intent'

/**
 * Ctrl+key 的 ASCII 范围：Ctrl+A = 0x01 .. Ctrl+Z = 0x1A
 * 以及一些特殊控制字符。
 */
const CTRL_CODES: Record<number, KeyName> = {
  0x01: 'ctrl_a',
  0x02: 'ctrl_b',
  0x03: 'ctrl_c',
  0x04: 'ctrl_d',
  0x05: 'ctrl_e',
  0x06: 'ctrl_f',
  0x08: 'ctrl_h', // 同时也映射为 backspace
  0x09: 'tab',
  0x0a: 'ctrl_j', // Ctrl+J = LF
  0x0b: 'ctrl_k',
  0x0c: 'ctrl_l',
  0x0d: 'return',
  0x0e: 'ctrl_n',
  0x0f: 'ctrl_o',
  0x10: 'ctrl_p',
  0x12: 'ctrl_r',
  0x14: 'ctrl_t',
  0x15: 'ctrl_u',
  0x17: 'ctrl_w',
  0x1a: 'ctrl_z',
  0x1b: 'escape',
  0x7f: 'backspace',
}

const ANSI_ESCAPE_MAP: Record<string, KeyName> = {
  '[A': 'up',
  '[B': 'down',
  '[C': 'right',
  '[D': 'left',
  '[H': 'home',
  '[F': 'end',
  '[2~': 'insert',
  '[3~': 'delete',
  '[5~': 'pageup',
  '[6~': 'pagedown',
  'OP': 'f1',
  'OQ': 'f2',
  'OR': 'f3',
  'OS': 'f4',
  '[15~': 'f5',
  '[17~': 'f6',
  '[18~': 'f7',
  '[19~': 'f8',
  '[20~': 'f9',
  '[21~': 'f10',
  '[23~': 'f11',
  '[24~': 'f12',
}

export class InputHandler {
  private stdin: ReadStream
  private mode: InputMode
  private handlers = new Map<string, Set<KeyHandler>>()
  private pasteHandlers = new Set<(text: string) => void>()
  private escaped = false
  private escapeSeq = ''
  private escapeTimeoutMs: number
  private escapeTimer: ReturnType<typeof setTimeout> | null = null
  private pasteActive = false
  private pasteBuffer = ''
  /**
   * 跨 chunk 不完整代理对缓冲：上游（stdin）可能把同一 UTF-16 代理对的两个
   * code unit 拆到两个 `data` 事件里（高强度输入 + 终端流量控制时偶发）。
   * 若不缓冲，第一段被当成"可打印字符"派发，char 字段就是孤立的
   * high-surrogate `\uD83D`——输入框会显示成豆腐方块，emoji 簇不可用。
   * 这里在 handleData 入口预拼，在派发前剥离尾部 high-surrogate。
   */
  private pendingData = ''

  constructor(options: InputHandlerOptions) {
    this.stdin = options.stdin
    this.mode = options.mode ?? 'input'
    this.escapeTimeoutMs = options.escapeTimeoutMs ?? 40
    this.stdin.setRawMode(true)
    this.stdin.resume()
    this.stdin.setEncoding('utf8')
    this.stdin.on('data', (data: string) => this.handleData(data))
  }

  /** 注册按键处理器。返回取消注册的函数。 */
  onKey(event: string, handler: KeyHandler): () => void {
    let set = this.handlers.get(event)
    if (!set) {
      set = new Set()
      this.handlers.set(event, set)
    }
    set.add(handler)
    return () => { set?.delete(handler) }
  }

  /** 注册所有按键的处理器（通配符） */
  onAnyKey(handler: KeyHandler): () => void {
    return this.onKey('*', handler)
  }

  /** 注册 bracketed paste 处理器（一次性收到整段粘贴文本，已规范化换行）。 */
  onPaste(handler: (text: string) => void): () => void {
    this.pasteHandlers.add(handler)
    return () => { this.pasteHandlers.delete(handler) }
  }

  /** 切换输入模式 */
  setMode(mode: InputMode): void {
    this.mode = mode
  }

  /** 获取当前输入模式 */
  getMode(): InputMode {
    return this.mode
  }

  /** 关闭 raw mode，恢复终端默认行为。 */
  dispose(): void {
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer)
      this.escapeTimer = null
    }
    this.pendingData = ''
    this.stdin.removeAllListeners('data')
    this.stdin.setRawMode(false)
    this.stdin.pause()
    this.handlers.clear()
    this.pasteHandlers.clear()
  }

  // ── internal ─────────────────────────────────────────────────

  private handleData(data: string): void {
    // 0. 拼接上次未处理完的代理对片段
    if (this.pendingData) {
      data = this.pendingData + data
      this.pendingData = ''
    }

    // 0b. 若末尾是孤立的 high-surrogate，剥出留到下个 chunk 拼接。
    // 注意：不做内容裁剪对 paste 路径也是安全的——consumePaste 会自己
    // 累积 pasteBuffer，跨 chunk 的代理对在收到 low-surrogate 后由
    // pasteActive 路径整体派发，Display 上仍是完整 emoji。
    if (data.length > 0) {
      const lastCode = data.charCodeAt(data.length - 1)
      if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
        this.pendingData = data.slice(-1)
        data = data.slice(0, -1)
        if (!data) return
      }
    }

    // 1. 进行中的 paste：累积直到结束标记
    if (this.pasteActive) {
      this.consumePaste(data)
      return
    }

    // 2. 检测 paste 起始标记（可能与前置/后续字节同 chunk 到达）
    const startIdx = data.indexOf(PASTE_START)
    if (startIdx !== -1) {
      const before = data.slice(0, startIdx)
      if (before) this.handleData(before)
      this.pasteActive = true
      this.pasteBuffer = ''
      this.consumePaste(data.slice(startIdx + PASTE_START.length))
      return
    }

    // 3. 新字节到达 → 取消待定的 lone-ESC 超时（后续序列接管解析）
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer)
      this.escapeTimer = null
    }

    const parsed = this.parseInput(data)
    if (parsed.key) {
      this.dispatch(parsed.key)
      // 关键：parseInput 只取首字符/首序列；剩余部分递归派发。
      // 这条路径只在「单 chunk 含多字符」时触发——典型场景：
      //   (a) surrogate 合并后跟 ASCII：'\uD83D\uDE00a' → 😀 + a
      //   (b) 高频 typing 把多个按键并到一次 stdin data 事件
      //   旧实现会派发 {char: 整串} 一个 char 字段，把多字符粘成单键
      //   ——输入框会显示成一团乱码、insertText 把整串塞在光标后。
      const rest = data.slice(parsed.consumed)
      if (rest) this.handleData(rest)
      return
    }

    // 4. lone ESC 进入 escaped 态 → 起短定时器，无后续则刷新为 escape
    if (this.escaped && this.escapeSeq === '\x1B') {
      this.escapeTimer = setTimeout(() => {
        this.escapeTimer = null
        if (this.escaped && this.escapeSeq === '\x1B') {
          this.escaped = false
          this.escapeSeq = ''
          this.dispatch({ raw: '\x1B', char: '', name: 'escape', ctrl: false, meta: false, shift: false })
        }
      }, this.escapeTimeoutMs)
    }
  }

  /** 累积 paste 内容；遇结束标记则规范化换行并一次性派发，再处理尾部字节。 */
  private consumePaste(chunk: string): void {
    const endIdx = chunk.indexOf(PASTE_END)
    if (endIdx === -1) {
      this.pasteBuffer += chunk
      return
    }
    this.pasteBuffer += chunk.slice(0, endIdx)
    const text = this.pasteBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    this.pasteActive = false
    this.pasteBuffer = ''
    for (const handler of this.pasteHandlers) handler(text)
    const rest = chunk.slice(endIdx + PASTE_END.length)
    if (rest) this.handleData(rest)
  }

  /** 把按键分发到 name / 通配 / mode 前缀三类处理器。 */
  private dispatch(key: KeyPress): void {
    const nameSet = this.handlers.get(key.name)
    if (nameSet) {
      for (const handler of nameSet) handler(key)
    }

    const wildSet = this.handlers.get('*')
    if (wildSet) {
      for (const handler of wildSet) handler(key)
    }

    const modeSet = this.handlers.get(`${this.mode}:${key.name}`)
    if (modeSet) {
      for (const handler of modeSet) handler(key)
    }
  }

  /**
   * 解析 data 首部的一个按键事件 + 实际消费的 code unit 数。
   *
   * 返回 { key: null, consumed: 0 } 表示"等后续字节"（孤 ESC 字节、跨 chunk
   * 代理对前半），handleData 据此决定是否挂起；否则 key 非 null，consumed
   * 告诉调用方"data 已被消费的字节数"，剩余 data.slice(consumed) 由 handleData
   * 递归再派发——这条路径是「单 stdin chunk 含多字符」时的唯一安全通道。
   */
  private parseInput(data: string): { key: KeyPress | null; consumed: number } {
    if (data.length === 0) return { key: null, consumed: 0 }

    // 完整 ESC 序列一次到达（如 \x1B[A）——直接解析，不走两阶段状态机
    if (data.startsWith('\x1B') && data.length > 1) {
      const name = this.resolveEscapeSequence(data)
      if (name) {
        const meta = data.includes(';3') || data.includes(';4')
        const shift = data.includes(';2')
        return { key: { raw: data, char: '', name, ctrl: false, meta, shift }, consumed: data.length }
      }
      return { key: { raw: data, char: '', name: 'unknown', ctrl: false, meta: false, shift: false }, consumed: data.length }
    }

    // 单独的 ESC 字节 — 进入 escaped 状态，等待后续字节
    if (data === '\x1B') {
      this.escaped = true
      this.escapeSeq = '\x1B'
      return { key: null, consumed: 0 }
    }

    if (this.escaped) {
      this.escapeSeq += data
      const fullSeq = this.escapeSeq
      const name = this.resolveEscapeSequence(fullSeq)
      if (name) {
        this.escaped = false
        this.escapeSeq = ''
        const meta = fullSeq.includes(';3') || fullSeq.includes(';4')
        const shift = fullSeq.includes(';2')
        return { key: { raw: fullSeq, char: '', name, ctrl: false, meta, shift }, consumed: 0 /* 全路径已消费 */ }
      }
      // 如果序列还没结束（如 `\x1B[1` 等待 `;5D`），保持 escaped 状态
      if (this.escapeSeq.length > 10) {
        // 超长序列，放弃解析
        this.escaped = false
        this.escapeSeq = ''
        return { key: { raw: data, char: '', name: 'unknown', ctrl: false, meta: false, shift: false }, consumed: data.length }
      }
      return { key: null, consumed: 0 }
    }

    // 单字节字符
    const code = data.codePointAt(0)
    if (code === undefined) return { key: null, consumed: 0 }

    // Ctrl+key 范围 (0x01-0x1F 和 0x7F) — 1 个 UTF-16 code unit
    if (code <= 0x1f || code === 0x7f) {
      const name = CTRL_CODES[code] ?? 'unknown'
      return {
        key: { raw: data, char: '', name, ctrl: code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d, meta: false, shift: false },
        consumed: 1,
      }
    }

    // 可打印字符：UTF-16 代理对占 2 code unit；BMP 占 1。
    // ⚠️ 这里关键：data 可能含「emoji 簇（多 codepoint ZWJ 序列）」
    // 之类的多字符，但 parseInput 只取首「用户字符」——一个 codepoint。
    // 多 codepoint 簇的拆分留给 InputLine 的 graphemeSegmenter 处理。
    const charLen = code > 0xFFFF ? 2 : 1
    const char = data.slice(0, charLen)
    return {
      key: {
        raw: char,
        char,
        name: char === ' ' ? 'space' : 'unknown',
        ctrl: false,
        meta: false,
        shift: char !== char.toLowerCase() && char !== char.toUpperCase() ? false : char === char.toUpperCase() && char.toLowerCase() !== char.toUpperCase(),
      },
      consumed: charLen,
    }
  }

  private resolveEscapeSequence(seq: string): KeyName | null {
    // 移除前导 \x1B
    const body = seq.slice(1)

    // 直接映射
    if (ANSI_ESCAPE_MAP[body]) return ANSI_ESCAPE_MAP[body]!

    // 处理带修饰键的序列（如 \x1B[1;5A = Ctrl+Up）
    const modMatch = body.match(/^\[(\d+);(\d+)([A-HF~])$/)
    if (modMatch) {
      const suffix = `[${modMatch[3]}`
      const baseName = ANSI_ESCAPE_MAP[suffix]
      if (baseName) return baseName
    }

    // 处理 \x1B[1~ 等带数字前缀的序列
    const prefixMatch = body.match(/^\[(\d+)([~])$/)
    if (prefixMatch) {
      const suffix = `[${prefixMatch[2]}`
      const baseName = ANSI_ESCAPE_MAP[suffix]
      if (baseName) return baseName
    }

    return null
  }
}
