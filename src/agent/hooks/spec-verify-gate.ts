import { isVerifyCall } from './self-verify-hook.js'

/**
 * Spec-to-Execute Verification Gate — detects when an agent reads a
 * diagnostic/spec document then proceeds to source code implementation
 * without any independent verification step.
 *
 * Pattern: read_file('docs/handoff-*.md') → read_file/grep('src/**') →
 * edit_file/write_file — 中间没有 run_tests、读测试文件、或读运行时日志。
 *
 * 纯函数，不依赖 hook 上下文或 advisory bus。
 */

export interface SpecVerifyGateInput {
  /** 最近 N 条工具历史。target 为 string（必选，空串表示无 target）。 */
  recentToolHistory: Array<{ tool: string; target: string }>
  /** spec 文档的 glob 模式，默认 ['docs/*handoff*', 'docs/*-issue*'] */
  specGlobs?: string[]
  /** spec 文档的窗口大小（最近多少条工具中查找），默认 20 */
  windowSize?: number
}

export interface SpecVerifyGateResult {
  /** 是否检测到"spec→实现"跳跃模式 */
  triggered: boolean
  /** 检测到的 spec 文档路径（用于 advisory 消息） */
  specDocPath?: string
  /** 缺失的验证类型列表 */
  missingVerifications: string[]
}

/**
 * 检查 target 是否匹配 spec glob 模式。
 *
 * 限制在 docs/ 根目录：`docs/` 后不能有额外的 `/`，
 * 避免误匹配 `docs/design/`、`docs/research/` 等子目录文档。
 */
function matchesSpecGlob(target: string, specGlobs: string[]): boolean {
  if (!target.startsWith('docs/')) return false
  const filename = target.slice(5) // after 'docs/'
  if (filename.includes('/')) return false // subdirectory → skip

  for (const glob of specGlobs) {
    // glob format: 'docs/*handoff*' → filename contains 'handoff'
    const globFilename = glob.startsWith('docs/') ? glob.slice(5) : glob
    const parts = globFilename.split('*')
    if (parts.every(part => filename.includes(part))) return true
  }
  return false
}

/**
 * 检测 recentToolHistory 中是否存在 "读 spec → 读源码 → 零验证" 的跳跃模式。
 */
export function detectSpecToExecuteJump(input: SpecVerifyGateInput): SpecVerifyGateResult {
  const {
    recentToolHistory,
    specGlobs = ['docs/*handoff*', 'docs/*-issue*'],
    windowSize = 20,
  } = input

  // 1. 在窗口内向前扫描，找第一条匹配 spec glob 的 read_file
  const window = recentToolHistory.slice(-windowSize)
  let specIdx = -1
  for (let i = window.length - 1; i >= 0; i--) {
    const h = window[i]!
    if (h.tool === 'read_file' && matchesSpecGlob(h.target, specGlobs)) {
      specIdx = i
      break
    }
  }
  if (specIdx === -1) return { triggered: false, missingVerifications: [] }

  const specDocPath = window[specIdx]!.target
  const afterSpec = window.slice(specIdx + 1)

  // 源文件调研：read_file(src/…) 或 grep(src/…)
  // 注意：grep 的 target 是搜索目录（来自 input.path），不是 pattern
  const hasSourceReads = afterSpec.some(
    h =>
      (h.tool === 'read_file' && h.target.startsWith('src/')) ||
      (h.tool === 'grep' && h.target.startsWith('src/')),
  )

  if (!hasSourceReads) return { triggered: false, missingVerifications: [] }

  // 2. isVerifyCall — 复用 self-verify-hook 的统一定义
  const hasVerifyCall = afterSpec.some(h => isVerifyCall(h))

  // 3. 测试文件读取
  const hasTestFileRead = afterSpec.some(
    h => h.tool === 'read_file' && /\.test\./.test(h.target),
  )

  // 4. 日志数据查询（read_file 或 bash 含 .rivet/sessions/）
  const hasLogRead = afterSpec.some(
    h =>
      (h.tool === 'read_file' || h.tool === 'bash') &&
      h.target.includes('.rivet/sessions/'),
  )

  const missingVerifications: string[] = []
  if (!hasVerifyCall) missingVerifications.push('run_tests')
  if (!hasTestFileRead) missingVerifications.push('test_file_read')
  if (!hasLogRead) missingVerifications.push('log_data_read')

  const triggered = !hasVerifyCall && !hasTestFileRead && !hasLogRead

  return { triggered, specDocPath, missingVerifications }
}
