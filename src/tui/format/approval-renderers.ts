/**
 * T9 工具专用审批渲染器。
 *
 * 为不同工具提供差异化的审批前预览：
 * - bash：展示完整命令 + 危险命令检测
 * - write_file：展示路径、行数、内容预览
 * - edit_file / hash_edit：展示 diff 预览
 * - delegate_task / delegate_batch：展示目标/任务数
 * - 其他：回退到通用 JSON 摘要
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import type { RiskExplanation, RiskLevel } from '../../agent/risk-explain.js'

export interface ApprovalRenderer {
  /** 渲染审批预览行（每行已做列宽控制，调用方直接显示） */
  render(toolName: string, input: Record<string, unknown>, columns: number, theme: RivetTheme): string[]
}

const DANGEROUS_PATTERNS = [
  /rm\s+-rf\s+\//,
  />\s*\/dev\/(sda|disk|hd)/,
  /:\(\)\s*\{\s*:\s*\|:\s*\}\s*;\s*:/,
  /curl\s+[^|]+\|\s*(sh|bash|zsh)/,
  /wget\s+[^|]+\|\s*(sh|bash|zsh)/,
  /mkfs\./,
  /dd\s+if=/,
]

function isDangerousCommand(cmd: string): boolean {
  return DANGEROUS_PATTERNS.some(p => p.test(cmd))
}

function renderLabeledLine(label: string, value: string, columns: number, theme: RivetTheme): string {
  const prefix = `${label}: `
  const prefixColored = color(prefix, theme.muted)
  const prefixWidth = displayWidth(prefix)
  const maxValueWidth = Math.max(1, columns - 2 - prefixWidth)
  const clamped = truncateToDisplayWidth(value, maxValueWidth)
  return `${prefixColored}${clamped}`
}

function renderDimPrefixLine(prefix: string, value: string, columns: number, theme: RivetTheme): string {
  const prefixColored = color(prefix, theme.dim)
  const prefixWidth = displayWidth(prefix)
  const maxValueWidth = Math.max(1, columns - 2 - prefixWidth)
  const clamped = truncateToDisplayWidth(value, maxValueWidth)
  return `${prefixColored}${clamped}`
}

const bashRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme) {
    const cmd = typeof input.command === 'string' ? input.command : JSON.stringify(input)
    const cwd = typeof input.cwd === 'string' ? input.cwd : undefined
    const lines: string[] = []
    lines.push(renderLabeledLine('Command', cmd, columns, theme))
    if (cwd) {
      lines.push(renderLabeledLine('CWD', cwd, columns, theme))
    }
    if (isDangerousCommand(cmd)) {
      lines.push(color('⚠ High-risk command detected', theme.error))
    }
    return lines
  },
}

const fileWriteRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme) {
    const filePath = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : null
    const content = typeof input.content === 'string' ? input.content : null
    const lines: string[] = []
    if (filePath) {
      lines.push(renderLabeledLine('Path', filePath, columns, theme))
    }
    if (content !== null) {
      const contentLines = content.split('\n')
      lines.push(color(`${contentLines.length} lines`, theme.muted))
      const previewLimit = Math.min(4, contentLines.length)
      for (let i = 0; i < previewLimit; i++) {
        lines.push(renderDimPrefixLine('│ ', contentLines[i]!, columns, theme))
      }
      if (contentLines.length > 4) {
        const prefix = color('│ ', theme.dim)
        const more = color(`… +${contentLines.length - 4} more lines`, theme.muted)
        lines.push(`${prefix}${more}`)
      }
    }
    return lines
  },
}

const fileEditRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme) {
    const filePath = typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : null
    const oldStr = typeof input.old_string === 'string' ? input.old_string : null
    const newStr = typeof input.new_string === 'string' ? input.new_string : null
    const lines: string[] = []
    if (filePath) lines.push(renderLabeledLine('Path', filePath, columns, theme))
    if (oldStr !== null && newStr !== null) {
      const oldLines = oldStr.split('\n').length
      const newLines = newStr.split('\n').length
      lines.push(`${color(`- ${oldLines} lines removed`, theme.error)}  ${color(`+ ${newLines} lines added`, theme.success)}`)
      // Compact preview: first changed line if old_str is short
      if (oldLines <= 3 && newLines <= 3) {
        for (const ol of oldStr.split('\n')) {
          lines.push(renderDimPrefixLine('- ', ol, columns, theme))
        }
        for (const nl of newStr.split('\n')) {
          lines.push(renderDimPrefixLine('+ ', nl, columns, theme))
        }
      }
    } else {
      if (oldStr !== null) lines.push(color(`- ${oldStr.split('\n').length} lines removed`, theme.error))
      if (newStr !== null) lines.push(color(`+ ${newStr.split('\n').length} lines added`, theme.success))
    }
    return lines
  },
}

const delegateRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme) {
    const lines: string[] = []
    if (toolName === 'delegate_batch') {
      const tasks = Array.isArray(input.tasks) ? input.tasks : []
      const profile = typeof input.profile === 'string' ? input.profile : 'default'
      lines.push(`${color(`Delegate ${tasks.length} tasks`, theme.warning)} ${color(`(profile: ${profile})`, theme.muted)}`)
      for (let i = 0; i < Math.min(3, tasks.length); i++) {
        const t = tasks[i] as Record<string, unknown> | undefined
        const obj = t && typeof t.objective === 'string' ? t.objective : JSON.stringify(t)
        lines.push(renderLabeledLine(`  ${i + 1}`, obj, columns, theme))
      }
      if (tasks.length > 3) {
        lines.push(color(`… +${tasks.length - 3} more tasks`, theme.muted))
      }
      return lines
    }
    const objective = typeof input.objective === 'string' ? input.objective : JSON.stringify(input)
    const profile = typeof input.profile === 'string' ? input.profile : undefined
    lines.push(renderLabeledLine('Objective', objective, columns, theme))
    if (profile) {
      lines.push(renderLabeledLine('Profile', profile, columns, theme))
    }
    return lines
  },
}

const webRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme) {
    const value = typeof input.url === 'string'
      ? input.url
      : typeof input.query === 'string'
        ? input.query
        : JSON.stringify(input)
    const label = toolName === 'web_fetch' || typeof input.url === 'string' ? 'URL' : 'Query'
    return [renderLabeledLine(label, value, columns, theme)]
  },
}

const fallbackRenderer: ApprovalRenderer = {
  render(toolName, input, columns, theme) {
    const raw = JSON.stringify(input)
    const arrow = color('→', theme.dim)
    const maxValueWidth = Math.max(1, columns - 4 - displayWidth('→ '))
    const truncated = truncateToDisplayWidth(raw, maxValueWidth)
    return [`${arrow} ${truncated}`]
  },
}

const RENDERERS: Record<string, ApprovalRenderer> = {
  bash: bashRenderer,
  shell: bashRenderer,
  sandbox_exec: bashRenderer,
  write_file: fileWriteRenderer,
  write: fileWriteRenderer,
  edit_file: fileEditRenderer,
  edit: fileEditRenderer,
  hash_edit: fileEditRenderer,
  delegate_task: delegateRenderer,
  delegate_batch: delegateRenderer,
  web_fetch: webRenderer,
  web_search: webRenderer,
}

/**
 * 获取指定工具的审批渲染器。
 */
export function getApprovalRenderer(toolName: string): ApprovalRenderer {
  return RENDERERS[toolName] ?? fallbackRenderer
}

/**
 * 渲染审批预览行。
 */
export function renderApprovalPreview(
  toolName: string,
  input: Record<string, unknown>,
  columns: number,
  theme: RivetTheme,
): string[] {
  const renderer = getApprovalRenderer(toolName)
  return renderer.render(toolName, input, columns, theme)
}

export interface FormatApprovalPromptInput {
  toolName: string
  input: Record<string, unknown>
  columns: number
  /** 光标选项列表的选中行（0 批准 / 1 拒绝 / 2 编辑 JSON / 3 解释风险）。 */
  selectedIndex: number
  /** Ctrl+E 拉取的风险解释状态（未请求时三者皆空）。 */
  risk?: RiskExplanation | null
  riskPending?: boolean
  riskError?: string
  /** 工作区外路径审批：选项表插入「批准并记住此目录」（记住 = 授权持久化到本工作区）。 */
  rememberOption?: boolean
}

const RISK_LABEL: Record<RiskLevel, string> = { low: '低风险', medium: '中风险', high: '高风险' }

function riskColor(level: RiskLevel, theme: RivetTheme): string {
  return level === 'high' ? theme.error : level === 'medium' ? theme.warning : theme.success
}

/**
 * 渲染 approval 行内提示。
 *
 * 精简风格：去掉 AI 感的模态框边框，采用类似 git 编辑器的行内展示。
 * 工具名 + 预览内容用 dim 色；底部是光标选项列表（↑↓ 移动、Enter 确认），
 * 行内保留快捷键字母——y/n/e/^E 直达键与光标确认等价，兼容肌肉记忆。
 */
export function formatApprovalPrompt(input: FormatApprovalPromptInput, theme: RivetTheme): string[] {
  const lines: string[] = []

  // 工具名行
  lines.push(color(`  ${input.toolName}`, theme.secondary, { bold: true }))

  // 预览内容（缩进）
  const previewLines = renderApprovalPreview(input.toolName, input.input, input.columns - 4, theme)
  for (const pv of previewLines) {
    lines.push(`    ${pv}`)
  }

  // 风险解释（Ctrl+E 按需拉取）。只在用户真的问了之后才占屏。
  if (input.riskPending) {
    lines.push(`  ${color('· 正在分析这条操作的风险…', theme.dim)}`)
  } else if (input.riskError) {
    lines.push(`  ${color(`· 风险分析不可用：${input.riskError}`, theme.dim)}`)
  } else if (input.risk) {
    const c = riskColor(input.risk.level, theme)
    lines.push(`  ${color(`[${RISK_LABEL[input.risk.level]}]`, c, { bold: true })}`)
    for (const line of input.risk.lines) {
      lines.push(`    ${color(line, theme.secondary)}`)
    }
  }

  // 光标选项列表。已经给过解释就不再出现「解释风险」行——重复入口只是噪音。
  // 工作区外路径审批插入「批准并记住此目录」：记住把目录授权持久化到本工作区
  // （restart 后不再询问同一目录），不勾则授权仅本会话有效。
  const options = ['批准 (Enter/y)', '拒绝 (Esc/n)', '编辑 JSON (e)']
  if (input.rememberOption) options.push('批准并记住此目录 (r)')
  if (!input.risk && !input.riskPending) options.push('解释风险 (^E)')
  lines.push('')
  options.forEach((label, i) => {
    const cursor = i === input.selectedIndex
    const glyph = cursor ? color('>', theme.primary, { bold: true }) : ' '
    const text = cursor
      ? color(`${i + 1}. ${label}`, theme.primary, { bold: true })
      : color(`${i + 1}. ${label}`, theme.muted)
    lines.push(`  ${glyph} ${text}`)
  })

  return lines
}

