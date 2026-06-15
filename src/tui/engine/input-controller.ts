import type { SlashHintEntry } from '../format/slash-hint.js'

export interface FileCompletionState {
  baseText: string
  baseCursor: number
  candidates: string[]
  idx: number
}

/**
 * Input state manager — holds the 6 input-related state fields extracted from
 * TuiApp (W-B5). Input event handling (onAnyKey, onSubmit), key routing, slash
 * command processing, and tab completion logic stay in TuiApp; this class only
 * manages the state values.
 */
export class InputController {
  /** slash 命令列表（外部注入，提示 + Tab 补全用） */
  slashCommands: SlashHintEntry[] = []
  /** slash hint 当前选中项索引（输入以 / 开头时，Tab 补全目标） */
  slashSelectedIdx = 0
  /** @ 文件补全状态（Tab 循环） */
  fileCompletion: FileCompletionState | null = null
  /** 输入历史（最新在前，submit 时更新 + 持久化） */
  inputHistory: string[] = []
  /** Ctrl+C double-press window start timestamp (ms), 0 = inactive */
  ctrlCPendingSince = 0
  /** ESC double-press: last ESC timestamp (ms), 0 = inactive */
  lastEscAt = 0
}
