import type { SlashHintEntry } from '../format/slash-hint.js'
import { filterSlashCommands } from '../format/slash-hint.js'

export interface FileCompletionState {
  baseText: string
  baseCursor: number
  candidates: string[]
  idx: number
}

/** slash 命令菜单状态：输入以 / 开头且有匹配时 open，matches 已过滤 + MRU 排序。 */
export interface SlashMenuState {
  /** 菜单是否打开（输入以 / 开头且有匹配命令）。 */
  open: boolean
  /** 当前查询（输入去掉 / 前缀的部分）。 */
  query: string
  /** 匹配命令列表（过滤 + MRU 排序后的最终顺序）。 */
  matches: SlashHintEntry[]
  /** 选中项下标。 */
  selected: number
}

/** MRU 列表长度上限（超出丢弃最旧）。 */
export const SLASH_MRU_MAX = 10

/**
 * Input state manager — holds the 6 input-related state fields extracted from
 * TuiApp (W-B5). Input event handling (onAnyKey, onSubmit), key routing, slash
 * command processing, and tab completion logic stay in TuiApp; this class only
 * manages the state values.
 */
export class InputController {
  /** slash 命令列表（外部注入，提示 + Tab 补全用） */
  slashCommands: SlashHintEntry[] = []
  /** slash 命令菜单状态（输入变化经 refreshSlash 更新；app.ts 渲染与键路由消费）。 */
  slashMenu: SlashMenuState = { open: false, query: '', matches: [], selected: 0 }
  /** 最近使用命令名（最新在前，上限 SLASH_MRU_MAX；匹配排序 MRU 优先） */
  slashMru: string[] = []
  /** @ 文件补全状态（Tab 循环） */
  fileCompletion: FileCompletionState | null = null
  /** 输入历史（最新在前，submit 时更新 + 持久化） */
  inputHistory: string[] = []
  /** Ctrl+C double-press window start timestamp (ms), 0 = inactive */
  ctrlCPendingSince = 0
  /** Ctrl+C 清空输入后的恢复提示截止时间 (ms)——渲染层显示 "Ctrl+Z to restore"。 */
  clearedHintUntil = 0
  /** ESC double-press: last ESC timestamp (ms), 0 = inactive */
  lastEscAt = 0

  /**
   * 记录一次命令执行（MRU 排序数据源）：去重前移、超上限截断尾部。
   * @param name - 命令名（含或不含 / 前缀均可，内部统一剥离）。
   */
  recordSlashUse(name: string): void {
    const stripped = name.replace(/^\//, '')
    this.slashMru = [stripped, ...this.slashMru.filter(n => n !== stripped)].slice(0, SLASH_MRU_MAX)
  }

  /**
   * 输入变化时刷新 slash 菜单：
   * - 完整命令名 + 尾空格（参数模式，如 `/effort `）且命令带 argsHint → 菜单
   *   保持打开显示该命令（ghost 参数提示由渲染层消费）。
   * - 以 / 开头且有匹配命令 → 打开并保持选择（carry：query 不变时按命令名
   *   找回选中项）；无匹配或非 / 输入 → 关闭。
   * @param value - 输入行当前文本。
   */
  refreshSlash(value: string): void {
    if (!value.startsWith('/')) {
      this.closeSlash()
      return
    }
    const query = value.slice(1)
    // 参数模式：`/cmd ` 精确匹配带 argsHint 的命令 → 菜单保持（1 项）。
    const argMatch = /^(\S+) $/.exec(query)
    if (argMatch !== null) {
      const cmdName = argMatch[1]
      /* v8 ignore next -- exec 捕获组恒有值；noUncheckedIndexedAccess 防御 */
      if (cmdName === undefined) return
      const cmd = this.slashCommands.find(c => c.name === `/${cmdName}`)
      if (cmd !== undefined && cmd.argsHint !== undefined) {
        this.slashMenu = { open: true, query, matches: [cmd], selected: 0 }
        return
      }
    }
    const prev = this.slashMenu
    const matches = this.suggestMatches(query)
    if (matches.length === 0) {
      this.closeSlash()
      return
    }
    this.slashMenu = {
      open: true,
      query,
      matches,
      selected: prev.open && prev.query === query ? this.carrySelection(prev, matches) : 0,
    }
  }

  /** 关闭 slash 菜单（保持 matches 供渲染兜底，open 置 false）。 */
  closeSlash(): void {
    this.slashMenu.open = false
  }

  /**
   * 移动菜单选择（↑↓；环绕）。
   * @param delta - 步长（-1 / +1）。
   */
  moveSlashSelection(delta: number): void {
    const m = this.slashMenu
    if (!m.open || m.matches.length === 0) return
    m.selected = (m.selected + delta + m.matches.length) % m.matches.length
  }

  /**
   * 滚动菜单选择（PageUp/Down；两端 clamp 不环绕）。
   * @param delta - 步长（±maxRows 由调用方给定）。
   */
  scrollSlashSelection(delta: number): void {
    const m = this.slashMenu
    if (!m.open || m.matches.length === 0) return
    m.selected = Math.max(0, Math.min(m.matches.length - 1, m.selected + delta))
  }

  /** 过滤 + MRU 排序（filterSlashCommands 内部同分按 MRU 降序）。 */
  private suggestMatches(query: string): SlashHintEntry[] {
    return filterSlashCommands(this.slashCommands, query, this.mruRank())
  }

  /** MRU 排名表：最近使用得分最高（未使用 0 分）。 */
  private mruRank(): Map<string, number> {
    const rank = new Map<string, number>()
    for (let i = 0; i < this.slashMru.length; i++) {
      const name = this.slashMru[i]
      /* v8 ignore next -- 循环内下标恒在界内；noUncheckedIndexedAccess 防御 */
      if (name === undefined) continue
      rank.set(name, this.slashMru.length - i)
    }
    return rank
  }

  /**
   * query 未变时按命令名找回上一选中项（输入变化不重置选择）。
   * @param prev - 上一菜单状态（open 且 query 相同）。
   * @param matches - 新匹配列表。
   * @returns 选中项下标（找不到回 0）。
   */
  private carrySelection(prev: SlashMenuState, matches: SlashHintEntry[]): number {
    const prevName = prev.matches[prev.selected]?.name
    /* v8 ignore next -- open=true 时 matches 恒非空且 selected 由 move/scroll 钳制；防御分支 */
    if (prevName === undefined) return 0
    const idx = matches.findIndex(m => m.name === prevName)
    return idx >= 0 ? idx : 0
  }
}
