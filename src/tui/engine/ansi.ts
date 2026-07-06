/**
 * T9 ANSI 转义序列工具库。
 *
 * 提供两个层次的 API：
 * 1. 原始转义序列常量 — 直接拼接到输出字符串中
 * 2. 类型安全的构建器函数 — 防止参数注入
 *
 * 参照：ECMA-48 / ISO 6429 标准，VT100/VT220 兼容。
 */

// ── 原始转义序列常量 ──────────────────────────────────────────

/** ANSI 转义序列原始常量。直接用模板字面量拼接到输出字符串。 */
export const ANSI = {
  /** 保存当前光标位置 */
  SAVE_CURSOR: '\x1B[s',
  /** 恢复之前保存的光标位置 */
  RESTORE_CURSOR: '\x1B[u',
  /** 从光标处擦除到行尾 (Erase to End of Line) */
  ERASE_LINE_END: '\x1B[0K',
  /** 擦除整行 (Erase Entire Line) */
  ERASE_LINE: '\x1B[2K',
  /** 从光标处擦除到屏幕末尾 (Erase to End of Screen) */
  ERASE_SCREEN_END: '\x1B[0J',
  /** 擦除整个屏幕 (Erase Entire Screen) */
  ERASE_SCREEN: '\x1B[2J',
  /** 进入 alternate screen buffer（全屏 overlay 用） */
  ALT_SCREEN_ON: '\x1B[?1049h',
  /** 退出 alternate screen buffer，恢复主屏 */
  ALT_SCREEN_OFF: '\x1B[?1049l',
  /**
   * 开始同步输出（CSI 2026 / DECSET 2026）。
   * 终端会缓冲后续输出，直到 END_SYNC 才一次性原子刷新 → 防止增量重绘撕裂/闪烁。
   * 不支持的终端会静默忽略此私有模式（无副作用）。
   */
  BEGIN_SYNC: '\x1B[?2026h',
  /** 结束同步输出，原子刷新本帧。 */
  END_SYNC: '\x1B[?2026l',
  /** 隐藏光标 */
  HIDE_CURSOR: '\x1B[?25l',
  /** 显示光标 */
  SHOW_CURSOR: '\x1B[?25h',
  /** 重置所有 SGR 属性 */
  RESET: '\x1B[0m',
  /** 粗体 */
  BOLD: '\x1B[1m',
  /** 细体/暗色 */
  DIM: '\x1B[2m',
  /** 斜体 */
  ITALIC: '\x1B[3m',
  /** 下划线 */
  UNDERLINE: '\x1B[4m',
  /** 闪烁（慢） */
  BLINK: '\x1B[5m',
  /** 反色 */
  REVERSE: '\x1B[7m',
  /** 删除线 */
  STRIKETHROUGH: '\x1B[9m',
} as const

// ── 类型安全的构建器 ──────────────────────────────────────────

/** 将光标向上移动 n 行。n 必须是正整数。 */
export function cursorUp(n: number): string {
  return `\x1B[${Math.max(1, Math.floor(n))}A`
}

/** 将光标向下移动 n 行。n 必须是正整数。 */
export function cursorDown(n: number): string {
  return `\x1B[${Math.max(1, Math.floor(n))}B`
}

/** 将光标向右移动 n 列。n 必须是正整数。 */
export function cursorForward(n: number): string {
  return `\x1B[${Math.max(1, Math.floor(n))}C`
}

/** 将光标向左移动 n 列。n 必须是正整数。 */
export function cursorBack(n: number): string {
  return `\x1B[${Math.max(1, Math.floor(n))}D`
}

/** 移动光标到绝对位置 (row, col)。1-based。 */
export function cursorTo(row: number, col: number): string {
  return `\x1B[${Math.max(1, Math.floor(row))};${Math.max(1, Math.floor(col))}H`
}

/** 移动光标到第 col 列（保持当前行）。1-based。 */
export function cursorToCol(col: number): string {
  return `\x1B[${Math.max(1, Math.floor(col))}G`
}

// ── SGR (Select Graphic Rendition) 颜色构建器 ──────────────────

/**
 * hex 颜色字符串 → RGB 元组。
 * 支持 `#rgb`、`#rrggbb` 格式。无法解析时返回 null。
 */
function hexToRgb(hex: string): [number, number, number] | null {
  const match = hex.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/)
  if (!match) return null
  const h = match[1]!
  if (h.length === 3) {
    return [parseInt(h[0]! + h[0]!, 16), parseInt(h[1]! + h[1]!, 16), parseInt(h[2]! + h[2]!, 16)]
  }
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** 设置前景色（truecolor）。hex 格式如 `#a8e6cf`。 */
export function fg(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return ''
  return `\x1B[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}

/** 设置背景色（truecolor）。hex 格式如 `#1e293b`。 */
export function bg(hex: string): string {
  const rgb = hexToRgb(hex)
  if (!rgb) return ''
  return `\x1B[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`
}

/**
 * 用 ANSI 前景色 + 可选 SGR 属性包裹文本。
 * 始终以 ANSI.RESET 结尾，防止颜色泄露。
 */
export function color(text: string, fgHex: string, opts?: { bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean }): string {
  let prefix = fg(fgHex)
  if (opts?.bold) prefix += ANSI.BOLD
  if (opts?.dim) prefix += ANSI.DIM
  if (opts?.italic) prefix += ANSI.ITALIC
  if (opts?.underline) prefix += ANSI.UNDERLINE
  return `${prefix}${text}${ANSI.RESET}`
}

// ── 终端查询 ──────────────────────────────────────────────────

/** 查询光标位置。终端会通过 stdin 返回 `\x1B[row;colR`。 */
export const QUERY_CURSOR_POS = '\x1B[6n'

/** 查询终端尺寸（备用方案）。某些终端不支持 stdout.columns。 */
export const QUERY_TERMINAL_SIZE = '\x1B[18t'
