/**
 * T9 LiveEngine — 管理终端底部动态区域（live region）的增量重绘。
 *
 * 核心机制：
 * - 在渲染 live region 之前，用 `cursor save` 保存滚动位置。
 * - 渲染时：上移到 live region 起始行 → 逐行擦除 + 重写 → 恢复光标。
 * - live region 永远只占底部 N 行（通常 5-20 行），远小于终端高度。
 * - streaming 内容由 BlockStreamWriter 控制，超出的部分已经 commit 到 scrollback。
 *
 * 与 Ink 的区别：
 * - Ink 在 live region >= terminal rows 时执行 `\x1B[2J` 全屏清屏，
 *   LiveEngine 永远不会触发全屏清屏——live region 被严格限制在底部。
 */

import type { WriteStream } from 'node:tty'
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

  /** 上一帧渲染的行数。用于计算上移量。 */
  private lastRenderedRows = 0
  /** 是否已执行过首次渲染（用于判断是否需要 save cursor） */
  private hasRendered = false
  /** live region 行缓存：每行的原始文本（不含 ANSI）用于 diff */
  private lineCache: string[] = []

  constructor(options: LiveEngineOptions) {
    this.stdout = options.stdout
    this.reservedRows = options.reservedRows ?? 2
    this.maxRows = options.maxRows ?? 20
  }

  /**
   * 渲染 live region。
   *
   * @param lines 要显示的行（含 ANSI 格式化）
   * @param startRow 可选：live region 起始行号（1-based），用于 `cursorTo` 模式
   */
  render(lines: readonly LiveRegionLine[], startRow?: number): void {
    const bounded = lines.slice(0, this.maxRows)

    if (!this.hasRendered) {
      // 首次渲染：直接在当前位置输出，后续帧用重绘
      for (const line of bounded) {
        this.stdout.write(line.text)
        if (!line.text.endsWith('\n')) this.stdout.write('\n')
      }
      this.lastRenderedRows = bounded.length
      this.lineCache = bounded.map(l => l.text)
      this.hasRendered = true
      return
    }

    // 增量重绘策略：
    // 1. 用 cursor save 保存当前位置
    // 2. 上移 lastRenderedRows 行到 live region 起始行
    // 3. 逐行：擦除 → 写入新内容 → 换行
    // 4. 如果新行数少于旧行数，擦除多余行
    // 5. cursor restore

    const prevRows = this.lastRenderedRows
    const newRows = bounded.length

    let out = ''

    if (startRow !== undefined) {
      // 精确模式：跳到起始行
      out += cursorTo(startRow, 1)
    } else {
      // 相对模式：上移
      out += cursorUp(prevRows)
    }

    // 逐行重绘
    for (let i = 0; i < Math.max(prevRows, newRows); i++) {
      if (i < newRows) {
        const line = bounded[i]!
        // 检查是否与缓存相同（相同则跳过擦除+重写，减少闪烁）
        if (i < this.lineCache.length && this.lineCache[i] === line.text) {
          out += cursorUp(0) || '\n' // 只换行
          // 实际上需要下移一行。用 cursorDown 模拟。
          out += '\x1B[1B'
        } else {
          out += ANSI.ERASE_LINE + line.text
          if (i < newRows - 1) out += '\n'
        }
      } else {
        // 新行数少于旧行数：擦除多余行
        out += ANSI.ERASE_LINE
        if (i < prevRows - 1) out += '\n'
      }
    }

    // 恢复光标
    out += ANSI.RESTORE_CURSOR

    this.stdout.write(out)
    this.lastRenderedRows = newRows
    this.lineCache = bounded.map(l => l.text)
  }

  /**
   * 清空 live region（擦除但不回滚 scrollback）。
   * 用于流式输出完成、切换到新 turn 时。
   */
  clear(): void {
    if (this.lastRenderedRows === 0) return

    let out = ''
    out += ANSI.SAVE_CURSOR
    out += cursorUp(this.lastRenderedRows)
    for (let i = 0; i < this.lastRenderedRows; i++) {
      out += ANSI.ERASE_LINE
      if (i < this.lastRenderedRows - 1) out += '\n'
    }
    out += ANSI.RESTORE_CURSOR
    this.stdout.write(out)

    this.lastRenderedRows = 0
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
    this.lastRenderedRows = 0
    this.lineCache = []
    this.hasRendered = false
  }
}
