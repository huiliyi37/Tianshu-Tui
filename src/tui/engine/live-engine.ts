/**
 * T9 LiveEngine — 管理终端底部动态区域（live region）的增量重绘。
 *
 * 核心机制：
 * - 在渲染 live region 之前，用 `cursor save` 保存滚动位置。
 * - 渲染时：上移到 live region 起始行 → 逐行擦除 + 重写 → 恢复光标。
 * - live region 永远只占底部 N 行（通常 5-20 行），远小于终端高度。
 * - streaming 内容由 BlockStreamWriter 控制，超出的部分已经 commit 到 scrollback。
 *
 * **Display-row awareness**: 所有行数追踪使用 visual display rows（wrapping-aware），
 * 而非 logical line count。一个 200 字符的行在 80 列终端占 3 display rows。
 * cursorUp / erase / lastDisplayRows 全部基于 display rows，防止 wrap 行导致
 * cursor 定位偏差 → ghost 行 / 重复渲染。
 *
 * 与 Ink 的区别：
 * - Ink 在 live region >= terminal rows 时执行 `\x1B[2J` 全屏清屏，
 *   LiveEngine 永远不会触发全屏清屏——live region 被严格限制在底部。
 */

import type { WriteStream } from 'node:tty'
import stringWidth from 'string-width'
import { ANSI, cursorUp, cursorTo } from './ansi.js'

export interface LiveRegionLine {
  /** 该行的 ANSI 格式化文本（包含颜色码） */
  text: string
  /** 可选：截断指示符 */
  truncated?: boolean
}

export interface LiveEngineOptions {
  stdout: WriteStream
  /** 预留行数（输入行等需要始终可见的行） */
  reservedRows?: number
  /** 最大 live region 行数（安全上限，防止意外超屏） */
  maxRows?: number
}

export class LiveEngine {
  private stdout: WriteStream
  private reservedRows: number
  private maxRows: number

  /** 上一帧渲染的 display rows（wrapping-aware）。用于计算上移量。 */
  private lastDisplayRows = 0
  /** 是否已执行过首次渲染（用于判断是否需要 save cursor） */
  private hasRendered = false
  /** live region 行缓存：每行的原始文本（不含 ANSI）用于 diff */
  private lineCache: string[] = []

  constructor(options: LiveEngineOptions) {
    this.stdout = options.stdout
    this.reservedRows = options.reservedRows ?? 2
    this.maxRows = options.maxRows ?? 20
  }

  // ── Display-row helpers ───────────────────────────────────────

  /** 单个 logical line 占用的 display rows（wrapping-aware）。 */
  private rowsForLine(text: string): number {
    const width = this.stdout.columns || 80
    if (width <= 0) return 1
    const dw = stringWidth(text)
    if (dw === 0) return 1
    return Math.ceil(dw / width)
  }

  /** 一组 LiveRegionLine 占用的总 display rows。 */
  private countDisplayRows(lines: readonly LiveRegionLine[]): number {
    let total = 0
    for (const line of lines) {
      total += this.rowsForLine(line.text)
    }
    return total
  }

  // ── Render ────────────────────────────────────────────────────

  /**
   * 渲染 live region。
   *
   * @param lines 要显示的行（含 ANSI 格式化）
   * @param startRow 可选：live region 起始行号（1-based），用于 `cursorTo` 模式
   */
  render(lines: readonly LiveRegionLine[], startRow?: number): void {
    const bounded = lines.slice(0, this.maxRows)
    const newDisplayRows = this.countDisplayRows(bounded)

    // 首次渲染 或 clearForCommit 之后（lastDisplayRows === 0）：
    // 直接在当前位置追加输出。cursorUp(0) 会被 clamp 到 1，
    // 走重绘路径会向上覆盖已 commit 的 scrollback 行。
    if (!this.hasRendered || this.lastDisplayRows === 0) {
      for (const line of bounded) {
        this.stdout.write(line.text)
        if (!line.text.endsWith('\n')) this.stdout.write('\n')
      }
      this.lastDisplayRows = newDisplayRows
      this.lineCache = bounded.map(l => l.text)
      this.hasRendered = true
      return
    }

    // 增量重绘（display-row-aware）：
    // 1. SAVE_CURSOR 保存当前位置（底部 / 输入行附近）
    // 2. cursorUp(lastDisplayRows) 到 live region 顶部
    // 3. Erase from cursor to end of screen（覆盖所有 display rows，含 wrap 行）
    // 4. 写入全部新内容
    // 5. RESTORE_CURSOR 恢复光标

    const prevDisplayRows = this.lastDisplayRows
    let out = ''

    out += ANSI.SAVE_CURSOR

    if (startRow !== undefined) {
      out += cursorTo(startRow, 1)
    } else {
      out += cursorUp(prevDisplayRows)
    }

    // Erase from cursor to end of screen — covers all display rows including wrapped lines
    out += '\r' + ANSI.ERASE_SCREEN_END

    // Write all new lines
    for (const line of bounded) {
      out += line.text
      if (!line.text.endsWith('\n')) out += '\n'
    }

    out += ANSI.RESTORE_CURSOR

    this.stdout.write(out)
    this.lastDisplayRows = newDisplayRows
    this.lineCache = bounded.map(l => l.text)
  }

  /**
   * 清空 live region（擦除但不回滚 scrollback）。
   * 用于流式输出完成、切换到新 turn 时。
   */
  clear(): void {
    if (this.lastDisplayRows === 0) return

    let out = ''
    out += ANSI.SAVE_CURSOR
    out += cursorUp(this.lastDisplayRows)
    for (let i = 0; i < this.lastDisplayRows; i++) {
      out += ANSI.ERASE_LINE
      if (i < this.lastDisplayRows - 1) out += '\n'
    }
    out += ANSI.RESTORE_CURSOR
    this.stdout.write(out)

    this.lastDisplayRows = 0
    this.lineCache = []
  }

  /**
   * 擦除 live region 并把光标停在其起始行——为向 scrollback commit 内容腾位。
   *
   * 与 clear() 的区别：clear() 用 RESTORE_CURSOR 把光标放回 live region
   * 之下（留下 N 行空白），而 commit 内容必须写在 live region 原来的
   * 位置上，否则会出现空白带 + 下一帧重绘覆盖已 commit 的文本。
   *
   * 正确的 mid-stream commit 协议：
   *   live.clearForCommit() → commit.write(...) → live.render(...)
   */
  clearForCommit(): void {
    if (this.lastDisplayRows === 0) return
    let out = ''
    out += cursorUp(this.lastDisplayRows)
    out += '\r' + ANSI.ERASE_SCREEN_END
    this.stdout.write(out)
    this.lastDisplayRows = 0
    this.lineCache = []
  }

  /**
   * 渲染单行动态文本（如 streaming 行、thinking 指示器）。
   * 简化版：擦除上一帧内容 → 写入新内容。
   */
  renderLine(text: string): void {
    this.render([{ text }])
  }

  /** 重置渲染状态（用于 rewind 等需要全量重绘的场景） */
  reset(): void {
    this.lastDisplayRows = 0
    this.lineCache = []
    this.hasRendered = false
  }
}
