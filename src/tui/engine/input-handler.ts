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
  | 'ctrl_x'
  | 'ctrl_]'
  | 'shift_tab'
  | 'unknown'

export type KeyHandler = (key: KeyPress) => void

export interface InputHandlerOptions {
  stdin: ReadStream
  /** 初始输入模式 */
  mode?: InputMode
  /** 单独 ESC 字节的刷新超时（ms）。期间无后续字节则派发 escape。
   *  80ms 平衡低延迟和高延迟 SSH（原 40ms 在 150ms+ RTT 连接上会导致方向键序列被拆包）。 */
  escapeTimeoutMs?: number
}

/** Bracketed paste 标记（DEC 2004） */
const PASTE_START = '\x1B[200~'
const PASTE_END = '\x1B[201~'

export type InputMode = 'normal' | 'input' | 'overlay' | 'approval'

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
  0x18: 'ctrl_x',
  0x1a: 'ctrl_z',
  0x1d: 'ctrl_]',
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
  '[Z': 'shift_tab',
}

export class InputHandler {
  private stdin: ReadStream
  private mode: InputMode
  private handlers = new Map<string, Set<KeyHandler>>()
  private pasteHandlers = new Set<(text: string) => void>()
  private escapeTimeoutMs: number
  private escapeTimer: ReturnType<typeof setTimeout> | null = null
  /** 当为 true 时，单独的 ESC 字节立即派发为 escape，不等待超时。
   *  用于 overlay 激活场景，避免 ESC 关闭/退出有 40ms 可感知延迟。 */
  private escapeImmediate = false
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
  /**
   * 跨 chunk 输入字节缓冲。ESC 序列、bracketed paste 起止标记都可能被拆到
   * 多个 `data` 事件里；保留未处理完的尾部，等待后续字节完整后再派发。
   */
  private inputBuffer = ''

  constructor(options: InputHandlerOptions) {
    this.stdin = options.stdin
    this.mode = options.mode ?? 'input'
    this.escapeTimeoutMs = options.escapeTimeoutMs ?? 80
    // WSL 边缘情况：stdin 可能不是 TTY（如管道输入），setRawMode 会抛错
    if (this.stdin.isTTY) {
      try { this.stdin.setRawMode(true) } catch { /* best-effort */ }
    }
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

  /**
   * 设置单独 ESC 字节是否立即派发。
   * overlay 激活时设为 true，避免 ESC 关闭/退出等待超时。
   */
  setEscapeImmediate(immediate: boolean): void {
    this.escapeImmediate = immediate
  }

  /** 关闭 raw mode，恢复终端默认行为。 */
  dispose(): void {
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer)
      this.escapeTimer = null
    }
    this.pendingData = ''
    this.inputBuffer = ''
    this.stdin.removeAllListeners('data')
    // WSL: 若 stdin 不是 TTY，setRawMode 会抛错
    if (this.stdin.isTTY) {
      try { this.stdin.setRawMode(false) } catch { /* best-effort */ }
    }
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
    if (data.length > 0) {
      const lastCode = data.charCodeAt(data.length - 1)
      if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
        this.pendingData = data.slice(-1)
        data = data.slice(0, -1)
        if (!data) return
      }
    }

    this.inputBuffer += data

    // 新字节到达 → 取消待定的 lone-ESC 超时（后续序列接管解析）
    if (this.escapeTimer) {
      clearTimeout(this.escapeTimer)
      this.escapeTimer = null
    }

    this.processInputBuffer()
  }

  /**
   * 从缓冲区起始位置连续派发普通按键，直到遇到不完整序列或缓冲区末尾。
   * 返回实际消费的字节数。
   */
  private dispatchKeys(buf: string): number {
    let i = 0
    while (i < buf.length) {
      const parsed = this.parseInput(buf.slice(i))
      if (!parsed.key) break
      this.dispatch(parsed.key)
      i += parsed.consumed
    }
    return i
  }

  /** 处理跨 chunk 缓冲的输入缓冲区，按 paste → ESC 序列 → 普通字符优先级解析。 */
  private processInputBuffer(): void {
    while (this.inputBuffer.length > 0) {
      // 1. 进行中的 paste：累积直到结束标记
      if (this.pasteActive) {
        const endIdx = this.inputBuffer.indexOf(PASTE_END)
        if (endIdx !== -1) {
          this.pasteBuffer += this.inputBuffer.slice(0, endIdx)
          const text = this.pasteBuffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
          this.pasteActive = false
          this.pasteBuffer = ''
          for (const handler of this.pasteHandlers) handler(text)
          this.inputBuffer = this.inputBuffer.slice(endIdx + PASTE_END.length)
          continue
        }

        const partial = getPartialSuffix(this.inputBuffer, PASTE_END)
        if (partial > 0) {
          this.pasteBuffer += this.inputBuffer.slice(0, -partial)
          this.inputBuffer = this.inputBuffer.slice(-partial)
          break
        }

        this.pasteBuffer += this.inputBuffer
        this.inputBuffer = ''
        break
      }

      // 2. 检测 paste 起始标记（前面可能还有普通按键）
      const startIdx = this.inputBuffer.indexOf(PASTE_START)
      if (startIdx !== -1) {
        const prefix = this.inputBuffer.slice(0, startIdx)
        const consumed = this.dispatchKeys(prefix)
        if (consumed < prefix.length) {
          // 前缀里有未完整的按键，先保留，等下一 chunk 再处理
          this.inputBuffer = this.inputBuffer.slice(consumed)
          break
        }
        // 前缀派发完毕，进入 paste 模式
        this.inputBuffer = this.inputBuffer.slice(startIdx + PASTE_START.length)
        this.pasteActive = true
        this.pasteBuffer = ''
        continue
      }

      // 3. paste 起始标记被拆到 chunk 边界，保留可能的部分标记
      const partialStart = getPartialSuffix(this.inputBuffer, PASTE_START)
      if (partialStart > 0) {
        const prefixLen = this.inputBuffer.length - partialStart
        const consumed = this.dispatchKeys(this.inputBuffer.slice(0, prefixLen))
        this.inputBuffer = this.inputBuffer.slice(consumed)
        break
      }

      // 4. 普通按键
      const consumed = this.dispatchKeys(this.inputBuffer)
      this.inputBuffer = this.inputBuffer.slice(consumed)
      break
    }

    // lone ESC 超时处理
    if (this.inputBuffer === '\x1B' && !this.pasteActive) {
      if (this.escapeImmediate) {
        this.inputBuffer = ''
        this.dispatch({ raw: '\x1B', char: '', name: 'escape', ctrl: false, meta: false, shift: false })
      } else {
        this.escapeTimer = setTimeout(() => {
          this.escapeTimer = null
          if (this.inputBuffer === '\x1B' && !this.pasteActive) {
            this.inputBuffer = ''
            this.dispatch({ raw: '\x1B', char: '', name: 'escape', ctrl: false, meta: false, shift: false })
          }
        }, this.escapeTimeoutMs)
      }
    }
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
   * 的 CSI/SS3 序列）；否则 key 非 null，consumed 告诉调用方已消费的字节数。
   */
  private parseInput(data: string): { key: KeyPress | null; consumed: number } {
    if (data.length === 0) return { key: null, consumed: 0 }

    // ESC 序列
    if (data.startsWith('\x1B')) {
      if (data.length === 1) return { key: null, consumed: 0 }

      // CSI 序列（方向键、功能键、带修饰键的序列等）
      const csiMatch = data.match(/^\x1B\[[0-9;]*[A-Za-z~]/)
      if (csiMatch) {
        const seq = csiMatch[0]
        const name = this.resolveEscapeSequence(seq)
        const meta = seq.includes(';3') || seq.includes(';4')
        const shift = seq.includes(';2') || name === 'shift_tab'
        return { key: { raw: seq, char: '', name: name ?? 'unknown', ctrl: false, meta, shift }, consumed: seq.length }
      }

      // SS3 序列（F1-F4 等）
      const ss3Match = data.match(/^\x1BO[A-Za-z]/)
      if (ss3Match) {
        const seq = ss3Match[0]
        const name = this.resolveEscapeSequence(seq)
        return { key: { raw: seq, char: '', name: name ?? 'unknown', ctrl: false, meta: false, shift: false }, consumed: seq.length }
      }

      // Alt/Meta + 可打印字符（\x1B 后跟非 [ 非 O 的字符）
      // 终端将 Alt+key 编码为 ESC + key。如 Alt+f → \x1Bf。
      if (data.length >= 2 && data[1] !== '[' && data[1] !== 'O') {
        const char = data[1]!
        const isUpper = char >= 'A' && char <= 'Z'
        return {
          key: { raw: data.slice(0, 2), char, name: 'unknown', ctrl: false, meta: true, shift: isUpper },
          consumed: 2,
        }
      }

      // 看起来是未完整的 CSI/SS3 序列，等待后续字节
      if (/^\x1B(\[([0-9;]*)|O)$/.test(data)) {
        return { key: null, consumed: 0 }
      }

      // 无法识别的 ESC 序列：消费掉 ESC 字节本身，避免无限循环
      return { key: { raw: '\x1B', char: '', name: 'unknown', ctrl: false, meta: false, shift: false }, consumed: 1 }
    }

    // 单字节控制字符
    const code = data.codePointAt(0)
    if (code === undefined) return { key: null, consumed: 0 }
    if (code <= 0x1f || code === 0x7f) {
      const name = CTRL_CODES[code] ?? 'unknown'
      return {
        key: { raw: data.slice(0, 1), char: '', name, ctrl: code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d, meta: false, shift: false },
        consumed: 1,
      }
    }

    // 可打印字符：UTF-16 代理对占 2 code unit；BMP 占 1。
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

/** 返回 `buf` 后缀中是 `marker` 前缀的最长长度（0 表示没有）。
 *  用于 bracketed paste 起止标记跨 chunk 时保留不完整尾部。 */
function getPartialSuffix(buf: string, marker: string): number {
  const max = Math.min(marker.length - 1, buf.length)
  for (let len = max; len > 0; len--) {
    if (buf.endsWith(marker.slice(0, len))) return len
  }
  return 0
}
