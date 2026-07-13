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

/** 宽度口径：与 LiveEngine 一致，ambiguous 符号按宽处理。 */
const WIDE = { ambiguousAsWide: true }

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
}

/**
 * 渲染 approval 行内提示。
 *
 * 精简风格：去掉 AI 感的模态框边框，采用类似 git 编辑器的行内展示。
 * 工具名 + 预览内容用 dim 色，操作提示紧凑排列。
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

  // 紧凑操作提示行（类似 git commit 编辑器的底部提示）
  const hints = [
    `${color('Enter/y', theme.success)}  ${color('approve', theme.muted)}`,
    `${color('Esc/n', theme.error)}   ${color('deny', theme.muted)}`,
    `${color('e', theme.secondary)}     ${color('edit JSON', theme.muted)}`,
  ]
  lines.push(color('  ' + hints.join('    '), theme.dim))

  return lines
}

