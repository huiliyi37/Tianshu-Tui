/**
 * Tool Output Sanitizer — 工具输出噪声裁剪(主控工作流缺口 B,2026-07-04)。
 *
 * 工具输出直接进会话历史,大量字节是上下文噪声:npm 的 spinner/进度、
 * test runner 的逐条 ✔ 通过行、ANSI 转义码。这些计入 input tokens 但
 * attention 信息量接近零。裁剪的不是 API 费用,是信息密度。
 *
 * 关键顺序约束(天枢文档核查修正):裁剪必须发生在失败分类器
 * (classifyFailure/classifyTestRun)、修复提示、artifact 拦截之后——
 * 它们依赖原始输出(stack trace、"Found N errors" 行)。接线点是
 * tool-execution.ts 的 addToolResults 边界:session 只存裁剪版,
 * UI 回调(onToolResult)在此之前已收到全文,保真不受影响。
 *
 * 保守原则:
 *   - 白名单规则(按 toolName + 命令特征),不做通用正则扫描
 *   - 失败诊断信息永不裁剪(✖ 行、error 行、assertion diff、stack)
 *   - 裁剪收益 < MIN_SAVINGS 时返回原文(不为几十字节引入抖动)
 *   - 裁空时保底一行摘要
 */

import { stripAnsi } from './run-tests.js'

/** 低于此字节数的输出不裁剪(收益不值得) */
const MIN_CONTENT_LENGTH = 500
/** 裁剪节省低于此字节数时返回原文 */
const MIN_SAVINGS = 200

export interface SanitizeResult {
  content: string
  /** 实际去除的字节数;0 = 未裁剪 */
  trimmedBytes: number
}

const NPM_INSTALL_RE = /\bnpm\s+(install|i|ci|add|update)\b/
const TSC_RE = /\btsc\b/
const NODE_TEST_RE = /\b(node|tsx)\b[^|;&]*--test\b|\bnpm\s+(run\s+)?test\b/

/** npm 噪声行:日志级别前缀、spinner 残留、进度条、reify 内部计时 */
const NPM_NOISE_LINE_RE = /^(npm\s+(timing|http|sill|verb|notice)\b|[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏\s]*$|\[[#=.\s]*\]|reify:)/
/** test runner 逐条通过行(✔ / ok N / TAP 子测试通过)——失败诊断的反面,纯噪声 */
const TEST_PASS_LINE_RE = /^\s*(✔|ok\s+\d)/

function command(input: Record<string, unknown> | undefined): string {
  const cmd = input?.command
  return typeof cmd === 'string' ? cmd : ''
}

function withMarker(kept: string, original: string, fallback: string): SanitizeResult {
  let content = kept.replace(/\n{3,}/g, '\n\n').trim()
  if (content.length === 0) content = fallback
  const trimmedBytes = original.length - content.length
  if (trimmedBytes < MIN_SAVINGS) return { content: original, trimmedBytes: 0 }
  return {
    content: `${content}\n[output trimmed: ${trimmedBytes} bytes of noise removed]`,
    trimmedBytes,
  }
}

/**
 * 裁剪工具输出。纯函数;调用方(tool-execution)负责 env 开关与遥测。
 * 返回原文(trimmedBytes=0)表示无需替换。
 */
export function sanitizeToolOutput(
  toolName: string,
  input: Record<string, unknown> | undefined,
  content: string,
): SanitizeResult {
  if (content.length < MIN_CONTENT_LENGTH) return { content, trimmedBytes: 0 }

  if (toolName === 'run_tests') {
    // run_tests 内容是格式化摘要,只剥 ANSI(其余已是有效信息)
    const clean = stripAnsi(content)
    const trimmedBytes = content.length - clean.length
    if (trimmedBytes < MIN_SAVINGS) return { content, trimmedBytes: 0 }
    return { content: clean, trimmedBytes }
  }

  if (toolName !== 'bash') return { content, trimmedBytes: 0 }

  const cmd = command(input)
  const clean = stripAnsi(content)
  const lines = clean.split('\n')

  if (TSC_RE.test(cmd)) {
    // 只留 error TS 行与统计尾行;无错误时保底一行
    const kept = lines.filter(l => /error TS\d+/.test(l) || /Found \d+ errors?/.test(l))
    return withMarker(kept.join('\n'), content, 'tsc: no errors reported')
  }

  if (NODE_TEST_RE.test(cmd)) {
    // 失败诊断(✖ 行、assertion diff、stack)全保留;只裁逐条通过行。
    // 全绿时逐条 ✔ 是最大的噪声源(数百行),统计块(ℹ tests/pass/fail)保留。
    const kept = lines.filter(l => !TEST_PASS_LINE_RE.test(l))
    return withMarker(kept.join('\n'), content, 'tests: all passed (details trimmed)')
  }

  if (NPM_INSTALL_RE.test(cmd)) {
    // 去日志级别/spinner/进度噪声,保留摘要(added N packages)、警告与错误
    const kept = lines.filter(l => !NPM_NOISE_LINE_RE.test(l))
    return withMarker(kept.join('\n'), content, 'npm: completed (output trimmed)')
  }

  // 其余 bash:仅当 ANSI 剥离本身有可观收益时替换
  const ansiTrimmed = content.length - clean.length
  if (ansiTrimmed >= MIN_SAVINGS) return { content: clean, trimmedBytes: ansiTrimmed }
  return { content, trimmedBytes: 0 }
}
