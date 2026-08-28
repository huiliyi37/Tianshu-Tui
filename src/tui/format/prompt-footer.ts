/**
 * T9 格式化函数 — 输入框下方键位提示行（prompt footer）。
 *
 * 对齐公开仓 prompt-footer 语义：左 mode 段恒保留，右 hints 段从后往前丢
 * 直到放得下。只列真的能按的键（同 command-palette.ts hotkey 字段裁决）：
 * 公开仓的 `pgup 翻页` 在本仓输入框无对应行为，不放。
 */

import { color } from '../engine/ansi.js'
import { displayWidth } from '../width.js'
import type { RivetTheme } from '../theme.js'

export interface PromptFooterInput {
  /** 终端宽度 */
  width: number
  /** 粘滞换行模式：Enter=换行、Shift+Enter 退出（对齐公开仓 newlineMode） */
  newlineMode?: boolean
  /** agent 运行中：提示打断键 */
  agentBusy?: boolean
  /** 审批挂起：提示审批动作 */
  approvalPending?: boolean
}

const CHROME_INACTIVE_SHIMMER = '#8a8a8a'

/**
 * 单行 footer：`normal · / 命令 · ctrl+j 换行 · ctrl+p 面板`。
 * hints 从后往前丢段直到放得下；mode 恒保留。
 */
export function formatPromptFooter(input: PromptFooterInput, theme: RivetTheme): string[] {
  const { width } = input
  /* R23 mode 段写实:vi 语义——粘滞换行开启即「insert」(输入即入文),
     Shift+Enter 退出回「normal」。此前恒显 normal 是无信息量的死占位。 */
  const mode = input.newlineMode === true ? 'insert' : 'normal'
  const modeColor = theme.dim
  const hints: string[] = input.approvalPending === true
    ? ['y 允许', 'n 拒绝', 'a 放行', 'esc 取消']
    : input.agentBusy === true
      ? ['esc 打断', 'ctrl+c 打断']
      : input.newlineMode === true
        ? ['换行中', 'enter 换行', 'shift+enter 退出']
        : ['/ 命令', 'ctrl+j 换行', 'ctrl+p 面板']

  let segs = hints
  for (;;) {
    const text = [mode, ...segs].join(' · ')
    if (displayWidth(text) <= width) break
    if (segs.length === 0) break
    segs = segs.slice(0, -1)
  }

  const parts = [color(mode, modeColor)]
  for (const seg of segs) {
    parts.push(color(seg, CHROME_INACTIVE_SHIMMER))
  }
  return [parts.join(' · ')]
}
