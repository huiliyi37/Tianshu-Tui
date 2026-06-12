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
import { ANSI, cursorUp, cursorDown } from './ansi.js'

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
  /** lineCache 渲染时的终端宽度。resize 检测：宽度变了说明屏上内容已被 reflow。 */
  private lastColumns = 0
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
   * resize 协调：终端宽度变化时，已绘制的 live region 内容会被终端按新宽 reflow，
   * 其占用的 display rows 随之改变。但 `lastDisplayRows` 是上一帧在**旧宽度**下数的，
   * 若直接用于 `moveToTop`，cursorUp 量与屏上实际行数不符 → 回顶欠/过 → 旧帧顶部
   * 残留进 scrollback（多份不同宽度的 chrome/面板叠屏，见 resize 回归测试）。
   *
   * 修复：检测到宽度变化时，按**当前宽度**从 `lineCache` 重算 `lastDisplayRows`，
   * 使其与终端 reflow 后的屏上行数一致，再做相对回顶。
   */
  private reconcileWidth(): void {
    const currentColumns = this.stdout.columns || 80
    if (this.hasRendered && this.lastDisplayRows > 0 && currentColumns !== this.lastColumns) {
      this.lastDisplayRows = this.countDisplayRows(this.lineCache.map(text => ({ text })))
    }
    this.lastColumns = currentColumns
  }

  /**
   * 渲染 live region（cursor-resident 协议，对标 aider mdstream / ink createIncremental）。
   *
   * 核心不变量：
   * - 渲染后光标**常驻 live region 最后一行末尾**（尾行不写 `\n`）。
   *   这避免了在终端底部因尾行换行触发滚屏 → 杜绝"贴底每帧滚动"的卡顿。
   * - 增量重绘用**相对光标移动**（cursorUp/cursorDown）回到区域顶，不使用
   *   SAVE/RESTORE 绝对光标——内容滚动后绝对坐标会失效错位。
   * - **行级 diff**：结构未变（行数 + 单显示行）时只重写变化的行，跳过未变行（少闪）。
   * - 整帧用 CSI 2026 同步输出包裹，原子刷新防撕裂。
   *
   * @param lines 要显示的行（含 ANSI 格式化）
   */
  render(lines: readonly LiveRegionLine[], opts?: { reservedTail?: number }): void {
    this.reconcileWidth()
    const bounded = this.applyRowBudget(lines, opts?.reservedTail)
    const newDisplayRows = this.countDisplayRows(bounded)

    // 首次渲染 或 clear/clearForCommit 之后（lastDisplayRows === 0）：
    // 直接在当前位置 append 输出。尾行不带 `\n`，光标停在最后一行末尾。
    if (!this.hasRendered || this.lastDisplayRows === 0) {
      this.stdout.write(this.buildAppend(bounded))
      this.lastDisplayRows = newDisplayRows
      this.lineCache = bounded.map(l => l.text)
      this.hasRendered = true
      return
    }

    const prevDisplayRows = this.lastDisplayRows

    // 行级 diff 资格：行数相同且新旧每行均为单显示行（多行 wrap 走全量重写更稳）。
    const canDiff =
      bounded.length === this.lineCache.length &&
      bounded.every(l => this.rowsForLine(l.text) === 1) &&
      this.lineCache.every(t => this.rowsForLine(t) === 1)

    const body = canDiff
      ? this.buildDiff(bounded, prevDisplayRows)
      : this.buildFullRewrite(bounded, prevDisplayRows)

    // CSI 2026 同步输出包裹整帧，原子刷新防撕裂。
    this.stdout.write(ANSI.BEGIN_SYNC + body + ANSI.END_SYNC)
    this.lastDisplayRows = newDisplayRows
    this.lineCache = bounded.map(l => l.text)
  }

  /**
   * 行预算：内容超过 maxRows 时，**优先保留尾部 chrome**（GlanceBar + 输入框 + 提示），
   * 截断的是中段 dynamic（streaming tail / 工具输出）的较早部分。
   *
   * - `lines.length <= maxRows`：全部保留。
   * - 未指定 reservedTail：沿用旧行为（保留前 maxRows 行）。
   * - 指定 reservedTail：尾部 N 行恒保留；剩余预算从 dynamic 段取**最近**的若干行。
   *   若 chrome 本身已超 maxRows，仍全部显示——宁可超行，也不能让输入框消失。
   */
  private applyRowBudget(lines: readonly LiveRegionLine[], reservedTail?: number): LiveRegionLine[] {
    if (lines.length <= this.maxRows) return lines.slice()
    if (reservedTail === undefined || reservedTail <= 0) {
      return lines.slice(0, this.maxRows)
    }
    const tail = Math.min(reservedTail, lines.length)
    const tailLines = lines.slice(lines.length - tail)
    const budget = this.maxRows - tailLines.length
    if (budget <= 0) return tailLines.slice()
    const dynamic = lines.slice(0, lines.length - tail)
    return [...dynamic.slice(-budget), ...tailLines]
  }

  /** Append 路径：行间 `\n`，尾行不带 `\n`（光标常驻最后一行末尾）。 */
  private buildAppend(bounded: readonly LiveRegionLine[]): string {
    let out = ''
    for (let i = 0; i < bounded.length; i++) {
      out += bounded[i]!.text
      if (i < bounded.length - 1) out += '\n'
    }
    return out
  }

  /** 相对光标回到 live region 顶部显示行（光标当前在最后一个显示行）。 */
  private moveToTop(prevDisplayRows: number): string {
    return prevDisplayRows > 1 ? cursorUp(prevDisplayRows - 1) : ''
  }

  /**
   * 全量重写：回顶 → 擦到屏幕末（覆盖旧的所有显示行，含 wrap）→ 重写全部行。
   * 尾行不带 `\n`，光标停在最后一行末尾。
   */
  private buildFullRewrite(bounded: readonly LiveRegionLine[], prevDisplayRows: number): string {
    let out = this.moveToTop(prevDisplayRows)
    out += '\r' + ANSI.ERASE_SCREEN_END
    for (let i = 0; i < bounded.length; i++) {
      out += bounded[i]!.text
      if (i < bounded.length - 1) out += '\n'
    }
    return out
  }

  /**
   * 行级 diff（仅在结构未变 + 全单显示行时调用）：
   * 回顶后逐行——变化行 `\r` + 整行擦除 + 重写；未变行只 cursorDown 跳过不重写。
   * 不写任何 `\n`（cursorDown 在底行会被 clamp，不触发滚屏）。
   */
  private buildDiff(bounded: readonly LiveRegionLine[], prevDisplayRows: number): string {
    let out = this.moveToTop(prevDisplayRows)
    for (let i = 0; i < bounded.length; i++) {
      const text = bounded[i]!.text
      out += '\r'
      if (this.lineCache[i] !== text) {
        out += ANSI.ERASE_LINE + text
      }
      if (i < bounded.length - 1) out += cursorDown(1)
    }
    return out
  }

  /**
   * 清空 live region（擦除但不回滚 scrollback）。
   * 用于流式输出完成、切换到新 turn 时。
   *
   * 光标常驻协议下，光标在最后一个显示行——回顶后擦到屏幕末，光标停在
   * 区域起始处。后续 append/commit 从这里开始写，干净无空白带。
   */
  clear(): void {
    this.reconcileWidth()
    if (this.lastDisplayRows === 0) return
    this.stdout.write(this.moveToTop(this.lastDisplayRows) + '\r' + ANSI.ERASE_SCREEN_END)
    this.lastDisplayRows = 0
    this.lineCache = []
  }

  /**
   * 擦除 live region 并把光标停在其起始行——为向 scrollback commit 内容腾位。
   *
   * 正确的 mid-stream commit 协议：
   *   live.clearForCommit() → commit.write(...) → live.render(...)
   *
   * cursor-resident 协议下与 clear() 行为一致（光标都回到区域起始处）。
   */
  clearForCommit(): void {
    this.clear()
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
