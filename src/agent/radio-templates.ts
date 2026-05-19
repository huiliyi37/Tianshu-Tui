/**
 * Tianshu Radio — Chinese message template library
 *
 * 15 templates for phase transitions, milestones, and warnings.
 * All messages are in Chinese with the [天枢] prefix.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TemplateVars {
  fileCount: number
  topFiles: string        // e.g. "（auth.ts, types.ts）"
  targetFiles: string     // e.g. "middleware.ts, handler.ts"
  errorBrief: string
  lastFailedTool: string
  failCount: number
  phaseName: string
  turnCount: number
}

export interface RadioContext {
  transition: string
  vars: TemplateVars
}

type ToolEntry = {
  tool: string
  target: string
  status: 'success' | 'failed' | 'running'
  error?: string
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const TEMPLATES: Record<string, string> = {
  'session_start':    '[天枢] 收到任务，开始分析。',
  'explore→plan':     '[天枢] 已读取 {fileCount} 个文件{topFiles}。准备制定方案。',
  'plan→execute':     '[天枢] 开始修改。预计修改 {targetFiles}。',
  'execute→verify':   '[天枢] 代码修改完成，运行测试验证。',
  'verify→deliver':   '[天枢] ✓ 测试全部通过，准备交付结果。',
  'test_pass':        '[天枢] ✓ 测试通过。',
  'test_fail':        '[天枢] ✗ 测试失败 {failCount} 个：{errorBrief}。正在修复。',
  'error':            '[天枢] ⚠ {lastFailedTool} 出错：{errorBrief}。',
  'stuck':            '[天枢] ⚠ 已在{phaseName}停留 {turnCount} turn，可能遇到困难。',
  'doom_loop':        '[天枢] ⚠⚠ 检测到循环，考虑换个方向。',
  'high_pressure':    '[天枢] 上下文即将满，准备压缩。',
  'midpoint':         '[天枢] 进度过半，继续执行中。',
  'near_complete':    '[天枢] 接近完成，最后验证中。',
}

const FALLBACK_TEMPLATE = '[天枢] {phaseName}中。'

// ---------------------------------------------------------------------------
// extractTemplateVars
// ---------------------------------------------------------------------------

export function extractTemplateVars(history: ToolEntry[]): TemplateVars {
  // fileCount = count of read_file entries
  const readFileEntries = history.filter(e => e.tool === 'read_file')
  const fileCount = readFileEntries.length

  // topFiles = last 3 read_file basenames in Chinese parens
  const topBases = readFileEntries
    .slice(-3)
    .map(e => basename(e.target))
  const topFiles = topBases.length > 0
    ? `（${topBases.join(', ')}）`
    : ''

  // targetFiles = unique basenames of edit_file/write_file entries
  const writeTargets = history
    .filter(e => e.tool === 'edit_file' || e.tool === 'write_file')
    .map(e => basename(e.target))
  const targetFiles = [...new Set(writeTargets)].join(', ')

  // errorBrief = last failed entry's error, truncated to 60 chars
  const failedEntries = history.filter(e => e.status === 'failed')
  const lastFailed = failedEntries[failedEntries.length - 1]
  const errorBrief = lastFailed?.error
    ? lastFailed.error.slice(0, 60)
    : ''

  // lastFailedTool = last failed entry's tool name
  const lastFailedTool = lastFailed?.tool ?? ''

  // failCount = count of failed entries
  const failCount = failedEntries.length

  return {
    fileCount,
    topFiles,
    targetFiles,
    errorBrief,
    lastFailedTool,
    failCount,
    phaseName: '',
    turnCount: 0,
  }
}

// ---------------------------------------------------------------------------
// formatRadioMessage
// ---------------------------------------------------------------------------

export function formatRadioMessage(ctx: RadioContext): string {
  const template = TEMPLATES[ctx.transition] ?? FALLBACK_TEMPLATE

  let msg = template
  const entries = Object.entries(ctx.vars) as [string, string | number][]

  for (const [key, val] of entries) {
    // Skip empty strings and zero numbers
    if (val === '' || val === 0) {
      msg = msg.replace(new RegExp(`\\s*\\{${key}\\}`, 'g'), '')
    } else {
      msg = msg.replace(new RegExp(`\\{${key}\\}`, 'g'), String(val))
    }
  }

  // Collapse double spaces
  msg = msg.replace(/ {2,}/g, ' ')

  return msg
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] ?? path
}
