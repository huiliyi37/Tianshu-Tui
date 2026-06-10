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
  | 'ctrl_p'
  | 'ctrl_b'
  | 'ctrl_f'
  | 'unknown'

export type KeyHandler = (key: KeyPress) => void

export interface InputHandlerOptions {
  stdin: ReadStream
  /** 初始输入模式 */
  mode?: InputMode
}

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
  0x10: 'ctrl_p',
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
  private escaped = false
  private escapeSeq = ''

  constructor(options: InputHandlerOptions) {
    this.stdin = options.stdin
    this.mode = options.mode ?? 'input'
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
    this.stdin.removeAllListeners('data')
    this.stdin.setRawMode(false)
    this.stdin.pause()
    this.handlers.clear()
  }

  // ── internal ─────────────────────────────────────────────────

  private handleData(data: string): void {
    const key = this.parseInput(data)
    if (!key) return

    // 分发到特定按键处理器
    const nameSet = this.handlers.get(key.name)
    if (nameSet) {
      for (const handler of nameSet) handler(key)
    }

    // 分发到通配符处理器
    const wildSet = this.handlers.get('*')
    if (wildSet) {
      for (const handler of wildSet) handler(key)
    }

    // 分发带 mode 前缀的事件
    const modeSet = this.handlers.get(`${this.mode}:${key.name}`)
    if (modeSet) {
      for (const handler of modeSet) handler(key)
    }
  }

  private parseInput(data: string): KeyPress | null {
    if (data.length === 0) return null

    // 完整 ESC 序列一次到达（如 \x1B[A）——直接解析，不走两阶段状态机
    if (data.startsWith('\x1B') && data.length > 1) {
      const name = this.resolveEscapeSequence(data)
      if (name) {
        const meta = data.includes(';3') || data.includes(';4')
        const shift = data.includes(';2')
        return { raw: data, char: '', name, ctrl: false, meta, shift }
      }
      return { raw: data, char: '', name: 'unknown', ctrl: false, meta: false, shift: false }
    }

    // 单独的 ESC 字节 — 进入 escaped 状态，等待后续字节
    if (data === '\x1B') {
      this.escaped = true
      this.escapeSeq = '\x1B'
      return null
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
        return { raw: fullSeq, char: '', name, ctrl: false, meta, shift }
      }
      // 如果序列还没结束（如 `\x1B[1` 等待 `;5D`），保持 escaped 状态
      if (this.escapeSeq.length > 10) {
        // 超长序列，放弃解析
        this.escaped = false
        this.escapeSeq = ''
        return { raw: data, char: '', name: 'unknown', ctrl: false, meta: false, shift: false }
      }
      return null
    }

    // 单字节字符
    const code = data.codePointAt(0)
    if (code === undefined) return null

    // Ctrl+key 范围 (0x01-0x1F 和 0x7F)
    if (code <= 0x1f || code === 0x7f) {
      const name = CTRL_CODES[code] ?? 'unknown'
      return { raw: data, char: '', name, ctrl: code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d, meta: false, shift: false }
    }

    // 可打印字符
    return {
      raw: data,
      char: data,
      name: data === ' ' ? 'space' : 'unknown',
      ctrl: false,
      meta: false,
      shift: data !== data.toLowerCase() && data !== data.toUpperCase() ? false : data === data.toUpperCase() && data.toLowerCase() !== data.toUpperCase(),
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
