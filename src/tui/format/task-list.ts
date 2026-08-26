/**
 * T9 格式化函数 — 常驻任务面板（todo task list）。
 *
 * 符号族与子代理 chrome 分开：标题 ≡、进行中月相旋转、待办 ○、完成 ✓。
 * 着色纪律与活动带相同——只给字形一点色，不整行 primary + bold。
 *
 *   ○ pending         — dim
 *   ◐◓◑◒ in_progress — 月相随 tick 转，仅字形 primary
 *   ✓ completed       — success 勾
 *
 * 纯函数：空列表返回 `[]`（不渲染），限高（默认 ≤6 行 + `└ …(+N)`）。
 *
 * 智能可见窗口：当条目数超过 maxRows 时，优先显示 in_progress 和 pending，
 * 折叠 completed 到摘要行，确保活跃任务永不被折叠行吞掉。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { TodoItem } from '../../tools/todo-store.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { circleSpinnerFrame } from '../braille-spinner.js'
import { isReducedMotion } from './spinner-status.js'

/** 宽度口径：与 LiveEngine.rowsForLine 一致（CJK 终端把 ambiguous 符号按 2 列渲染）。
 *  task content 多为 CJK，按 narrow(.length/stringWidth) 截断会严重低估实际列宽 →
 *  单行任务溢出终端宽度折行 → rowsForLine 低估 → chrome 残留重影。 */
const WIDE = { ambiguousAsWide: true }

const ASCII_SPIN = ['-', '\\', '|', '/'] as const
/** 主区 ticker 120ms；除 3 后约 360ms 一帧，清单旁不抢注意力。 */
const TICK_DIVISOR = 3

export interface TaskListOptions {
  /** 终端宽度（内容超宽截断） */
  width?: number
  /** 面板最大行数（含标题 + 摘要行），默认 6 */
  maxRows?: number
  /** 是否显示标题里的 8-cell 进度条。默认 false（compact 标题）。
   *  三个调用方（主区 live、side panel）都采用 compact 标题，故默认与之对齐；
   *  需要进度条的调用方显式传 true。 */
  showProgressBar?: boolean
  /** 展开态：原序全量渲染（completed 也逐条 ✓），不再折叠为 `✓ N done`
   *  摘要；调用方应同时调高 maxRows（12-15）。 */
  expanded?: boolean
  /** 展开态末尾的 dim 键位提示（如 "ctrl+x t 收起"）；仅 expanded 时渲染。 */
  expandHint?: string
  /** 月相帧计数（in_progress 字形随 tick/3 旋转）。 */
  tick?: number
  /** ascii 降级（进行中 → `-`/`|` 轮转）。 */
  ascii?: boolean
}

/**
 * 任务面板显隐门禁。run 空闲且所有条目已完成时隐藏——审查/执行结束后面板
 * 应立即消失，而不是常驻到进程退出（此前 state.todos 无任何清除路径，面板
 * 永久渲染，并作为 chrome 首元素在超屏/行宽少算时被反复挤入 scrollback，
 * 形成同一块的多份副本）。运行中或仍有未完成项时显示。
 */
export function shouldShowTaskPanel(items: readonly TodoItem[], phase: string, todosStale = false): boolean {
  if (items.length === 0) return false
  // 全完成清单在两种情况下收起：run 已结束（idle），或清单属于更早的 run
  // （todosStale：当前 run 尚未写过 todo——旧 5/5 复活挂在新 run 头上，观感
  // 即「任务计数不更新」）。todoExpanded 强制回看由调用方短路，不进这里。
  if (items.every(t => t.status === 'completed') && (phase === 'idle' || todosStale)) return false
  return true
}

function inProgressGlyph(opts: TaskListOptions): string {
  const ascii = opts.ascii === true
  if (isReducedMotion()) return ascii ? '*' : '◐'
  const frame = Math.floor((opts.tick ?? 0) / TICK_DIVISOR)
  if (ascii) {
    const idx = ((frame % ASCII_SPIN.length) + ASCII_SPIN.length) % ASCII_SPIN.length
    return ASCII_SPIN[idx] ?? '-'
  }
  return circleSpinnerFrame(frame)
}

function glyphFor(status: TodoItem['status'], opts: TaskListOptions): string {
  switch (status) {
    case 'completed': return '✓'
    case 'in_progress': return inProgressGlyph(opts)
    default: return '○'
  }
}

function glyphColor(status: TodoItem['status'], theme: RivetTheme): string {
  switch (status) {
    case 'in_progress': return theme.primary
    case 'completed': return theme.success
    default: return theme.dim
  }
}

/** 8-cell progress bar: █ filled / ░ empty, proportional to done/total. */
function progressBar(done: number, total: number): string {
  const filled = total === 0 ? 0 : Math.round((done / total) * 8)
  return '█'.repeat(filled) + '░'.repeat(8 - filled)
}

function splitLead(text: string): { lead: string; rest: string } | null {
  const idx = text.search(/[:：]/)
  if (idx <= 0) return null
  return { lead: text.slice(0, idx), rest: text.slice(idx) }
}

function paintContent(text: string, status: TodoItem['status'], theme: RivetTheme): string {
  if (status === 'pending' || status === 'completed') {
    return color(text, theme.muted)
  }
  const parts = splitLead(text)
  if (!parts) return color(text, theme.secondary)
  return `${color(parts.lead, theme.secondary)}${color(parts.rest, theme.muted)}`
}

function renderLine(t: TodoItem, theme: RivetTheme, width: number, opts: TaskListOptions): string {
  const ELLIPSIS_W = displayWidth('…', WIDE)
  const glyph = glyphFor(t.status, opts)
  const prefix = ` ${color(glyph, glyphColor(t.status, theme))} `
  const prefixW = displayWidth(prefix, WIDE)
  const contentBudget = Math.max(1, width - 1 - prefixW)
  // 进行中的项念现在时（activeForm），其余念祈使式的 content——面板读起来
  // 是「正在做什么 / 还要做什么」，而不是一列同构的祈使句。缺席时回退 content。
  const text = t.status === 'in_progress' ? (t.activeForm ?? t.content) : t.content
  const flat = text.replace(/\s+/g, ' ').trim()
  const content = displayWidth(flat, WIDE) > contentBudget
    ? `${truncateToDisplayWidth(flat, Math.max(1, contentBudget - ELLIPSIS_W), WIDE)}…`
    : flat
  return `${prefix}${paintContent(content, t.status, theme)}`
}

function overflowLine(n: number, theme: RivetTheme): string {
  return color(` └ …(+${n})`, theme.dim)
}

/**
 * 将 todo 列表格式化为常驻面板行。空列表返回 `[]`。
 *
 * 可见窗口策略（解决"后面的默认沉底"问题）：
 * 1. in_progress 永远可见
 * 2. pending 按 id 顺序填充剩余行
 * 3. completed 折叠为摘要（"✓ 3 done"），不逐条占用行
 * 4. 仅当 in_progress + pending 仍超行时才显示 `└ …(+N)`
 */
export function formatTaskList(items: TodoItem[], theme: RivetTheme, opts: TaskListOptions = {}): string[] {
  if (items.length === 0) return []
  const width = opts.width ?? 80
  const maxRows = Math.max(3, opts.maxRows ?? 6)
  const showProgressBar = opts.showProgressBar === true

  const lines: string[] = []
  const completed = items.filter(t => t.status === 'completed')
  const done = completed.length

  const header = showProgressBar
    ? `≡ 任务 [${progressBar(done, items.length)}] · ${done}/${items.length}`
    : `≡ 任务 · ${done}/${items.length}`
  lines.push(color(header, theme.muted))

  // 展开态（ctrl+x t 切换）：原序全量渲染——completed 逐条 ✓ 可回看，
  // 不再折叠为摘要；超预算才 …(+N)；末尾附 dim 键位提示。
  if (opts.expanded) {
    const hint = opts.expandHint
    const rowBudget = maxRows - 1 - (hint ? 1 : 0)
    let visibleCount = items.length
    let hasOverflow = false
    if (items.length > rowBudget) {
      visibleCount = Math.max(0, rowBudget - 1)
      hasOverflow = true
    }
    for (let i = 0; i < visibleCount; i++) {
      lines.push(renderLine(items[i]!, theme, width, opts))
    }
    if (hasOverflow) {
      lines.push(overflowLine(items.length - visibleCount, theme))
    }
    if (hint) lines.push(color(` ⎿ ${hint}`, theme.dim))
    return lines
  }

  // 预算：标题已占 1 行，完成摘要占 1 行（当有完成项时）
  let budget = maxRows - 1
  if (done > 0) budget -= 1

  const unfinished = items.filter(t => t.status !== 'completed')

  let visibleCount: number
  let hasOverflow = false

  if (unfinished.length <= budget) {
    visibleCount = unfinished.length
  } else {
    visibleCount = budget - 1
    hasOverflow = true
  }

  for (let i = 0; i < Math.min(visibleCount, unfinished.length); i++) {
    lines.push(renderLine(unfinished[i]!, theme, width, opts))
  }

  if (hasOverflow) {
    lines.push(overflowLine(unfinished.length - visibleCount, theme))
  }

  if (done > 0) {
    const sample = completed[0]!.content.replace(/\s+/g, ' ').trim()
    const sampleBudget = Math.max(8, width - 10)
    const sampleText = displayWidth(sample, WIDE) > sampleBudget
      ? `${truncateToDisplayWidth(sample, sampleBudget - displayWidth('…', WIDE), WIDE)}…`
      : sample
    const mark = color('✓', theme.success)
    const rest = done === 1 ? ` ${sampleText}` : ` ${done} done`
    lines.push(` ${mark}${color(rest, theme.muted)}`)
  }

  return lines
}
