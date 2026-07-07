/**
 * 探针残留检测 — 纯函数模块，供 probe-tracking hook 和 deliver-task gate 共用。
 *
 * prompt 约束（`<rule name="test-harness">` hard-gate）：
 *   临时探针（console.log、assert、debugger）修复后必须清理。残留 = 任务未完成。
 *
 * 探针模式来源（grep src/ 真实残留样本）：
 *   - `console.log(...)`    → src/cache/cache-audit-cli.ts:7, src/server/serve.ts:1205
 *   - `console.debug(...)`  → 调试用，无生产样本（正是要防的）
 *   - `debugger`            → 独立语句断点
 *   - `it.only`/`describe.only`/`test.only` → node:test 支持，静默吞掉整个套件
 *   - `console.dir`/`console.trace` → 调试专用，非结构化日志
 *
 * 非探针（白名单）：
 *   - `console.error`/`console.warn` → 错误/警告通道，非调试探针
 *   - 结构化日志：`this.logger.*`、`log.info(*)`、`logger.*` 等命名化日志调用
 *   - 测试文件 `*.test.ts`：assert/console.log 在测试中合法
 *   - `scripts/`、`bin/`：CLI 工具脚本，console.log 是正常输出
 *   - logger 实现文件本身（如 telemetry-writer.ts）
 */

import { isAbsolute, join } from 'node:path'

/** 单条探针命中记录 */
export interface ProbeHit {
  /** 相对路径 */
  filePath: string
  /** 探针模式名 */
  pattern: string
  /** 命中的行内容（截断到 120 字符防止巨型行） */
  line: string
  /** 行号（1-based，从增量行计数；交付时 fs 重扫后为实际文件行号） */
  lineNumber: number
}

// ── 探针正则 ────────────────────────────────────────────────────
// 每个正则注释来源：匹配的真实文本片段 + 出现位置。
// 使用 multiline + global flag，逐行扫描。

/**
 * console.log / console.debug / console.dir / console.trace
 * 来源：src/cache/cache-audit-cli.ts:7 `console.log(\`${finding.level...}\`)`
 *   匹配 `console.log(`，但不匹配 `console.error(` / `console.warn(`。
 *   排除已被注释的行（// console.log）。
 */
const CONSOLE_PROBE_RE = /(^|[^.])\bconsole\.(log|debug|dir|trace)\s*\(/gm

/**
 * debugger 独立语句
 * 来源：JS 标准断点语句，无项目样本（正是要防的——调试后遗忘）
 * 匹配 `debugger` 作为独立 token（前后单词边界），不匹配 `debuggerMode` 等。
 */
const DEBUGGER_RE = /\bdebugger\b/g

/**
 * .only() 测试隔离——it.only / describe.only / test.only
 * 来源：node:test / vitest / jest 通用模式
 *   `it.only('xxx',`  → 会静默吞掉整个测试套件（只跑这一个）
 *   匹配 name.only( 但不匹配 name.monly( 或 nameOnly(
 */
const ONLY_PROBE_RE = /\b(it|describe|test|xit|xdescribe|xit)\.only\s*\(/g

/**
 * 裸 assert( 调用——非测试文件中的运行时断言
 * 来源：计划文档缺口① 落地修正清单第 3 点"本仓库约定 assert 只出现在
 *   测试里，排除 *.test.ts 后剩下的裸 assert( 新增行都可疑"
 * 匹配 `assert(` 但不匹配 `console.assert(`（已被 console 模式管）
 * 也不匹配 import 语句中的 assert 关键字
 */
const ASSERT_PROBE_RE = /(^|[^.\w])assert\s*\(/gm

/** 所有探针正则集合 */
const PROBE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'console.log/debug/dir/trace', re: CONSOLE_PROBE_RE },
  { name: 'debugger', re: DEBUGGER_RE },
  { name: '.only() test isolation', re: ONLY_PROBE_RE },
  { name: 'bare assert()', re: ASSERT_PROBE_RE },
]

// ── 白名单 ──────────────────────────────────────────────────────

/** 白名单路径前缀：这些目录里的 console.log 是正常输出 */
const WHITELIST_PREFIXES = [
  'scripts/',
  'bin/',
  'src/server/serve.ts', // API server startup logs
]

/** 白名单文件后缀 */
const WHITELIST_SUFFIXES = [
  '.test.ts',
  '.test.tsx',
  '.test.js',
  '.spec.ts',
]

/** 命名 logger 调用前缀——不是探针。
 *  匹配 `logger.info(` / `this.logger.debug(` / `log.trace(`。
 *  console 自带的不在此列（CONSOLE_PROBE_RE 专门管 console）。
 *  匹配 `.` 前有标识符且该标识符不是 `console` 的情况。 */
const STRUCTURED_LOG_RE = /\b(?!console\b)\w+(?:\.\w+)*\.(info|warn|error|debug|trace|verbose|silly|fatal)\s*\(/

/**
 * 判断文件路径是否在白名单中（不需要检测探针）。
 */
export function isWhitelistedPath(filePath: string): boolean {
  const normalized = filePath.replace(/^\.\//, '')
  for (const suffix of WHITELIST_SUFFIXES) {
    if (normalized.endsWith(suffix)) return true
  }
  for (const prefix of WHITELIST_PREFIXES) {
    if (normalized.startsWith(prefix)) return true
  }
  return false
}

/**
 * 检测文本增量中的探针命中。
 * 只扫描新增行（以 `+` 开头但不以 `+++` 开头的 diff 行），
 * 或直接扫描完整内容（write_file 场景）。
 *
 * @param content 工具写入的完整内容（write_file）或 new_string（edit_file/hash_edit）
 * @param filePath 文件相对路径（用于白名单判断）
 * @returns 探针命中列表（可能为空）
 */
export function detectProbes(content: string, filePath: string): ProbeHit[] {
  if (isWhitelistedPath(filePath)) return []

  const lines = content.split('\n')
  const hits: ProbeHit[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.length > 120) continue // 跳过巨型行（压缩代码等）

    // 跳过注释行（// 或 * 开头的注释）
    const trimmed = line.trimStart()
    if (trimmed.startsWith('//') || trimmed.startsWith('*')) continue

    for (const { name, re } of PROBE_PATTERNS) {
      // Reset regex lastIndex（global flag 会有状态）
      re.lastIndex = 0
      if (re.test(line)) {
        // 排除结构化日志：logger.info( 不算探针
        if (name === 'console.log/debug/dir/trace' && STRUCTURED_LOG_RE.test(line)) {
          continue
        }
        hits.push({
          filePath,
          pattern: name,
          line: line.length > 120 ? line.slice(0, 120) + '...' : line,
          lineNumber: i + 1,
        })
      }
      re.lastIndex = 0
    }
  }

  return hits
}

/**
 * 从工具输入中提取写入内容。
 * 覆盖三个写工具：edit_file (new_string)、write_file (content)、hash_edit (new_string)。
 *
 * @returns 写入内容和文件路径，或 null（非写工具/无法提取）
 */
export function extractWriteContent(
  toolName: string,
  input: Record<string, unknown> | undefined,
): { content: string; filePath: string } | null {
  if (!input) return null

  const filePath =
    typeof input.file_path === 'string' ? input.file_path : null
  if (!filePath) return null

  let content: string | null = null

  if (toolName === 'write_file' && typeof input.content === 'string') {
    content = input.content
  } else if (
    (toolName === 'edit_file' || toolName === 'hash_edit') &&
    typeof input.new_string === 'string'
  ) {
    content = input.new_string
  }

  if (content === null) return null
  return { content, filePath }
}

/**
 * 扫描磁盘上的文件，检查当前是否仍有探针残留。
 * 用于 deliver_task gate 的 fs 重扫兜底——跟踪表记的探针可能已被清理。
 *
 * @param filePaths 要扫描的文件相对路径列表
 * @param cwd 项目根目录
 * @param readFile fs 读取函数（注入以便测试）
 * @returns 所有文件中的探针命中列表
 */
export function scanFilesForProbes(
  filePaths: string[],
  cwd: string,
  readFile: (path: string) => string | null,
): ProbeHit[] {
  const allHits: ProbeHit[] = []
  for (const filePath of filePaths) {
    if (isWhitelistedPath(filePath)) continue
    // isAbsolute + join 而非 startsWith('/') + 字符串拼接：Windows 绝对路径
    // D:\... 不以 '/' 开头，旧写法拼成 `${cwd}/D:\...`，readFile 必失败 →
    // 探针检测在 Windows 上对绝对路径静默失明。
    const content = readFile(isAbsolute(filePath) ? filePath : join(cwd, filePath))
    if (content === null) continue // 文件可能已被删除
    const hits = detectProbes(content, filePath)
    allHits.push(...hits)
  }
  return allHits
}

/**
 * 格式化探针命中列表为人类可读的警告文本。
 */
export function formatProbeHits(hits: ProbeHit[]): string[] {
  if (hits.length === 0) return []
  const lines: string[] = [
    '',
    '⚠️  探针残留检测 — 以下文件包含调试探针（console.log/debugger/.only 等），交付前应清理：',
  ]
  // 按文件分组
  const byFile = new Map<string, ProbeHit[]>()
  for (const hit of hits) {
    const existing = byFile.get(hit.filePath) ?? []
    existing.push(hit)
    byFile.set(hit.filePath, existing)
  }
  for (const [filePath, fileHits] of byFile) {
    lines.push(`  ${filePath}:`)
    for (const h of fileHits.slice(0, 3)) {
      lines.push(`    L${h.lineNumber} [${h.pattern}] ${h.line.trim()}`)
    }
    if (fileHits.length > 3) {
      lines.push(`    ... +${fileHits.length - 3} more`)
    }
  }
  lines.push('  清理探针后重新交付。如果是有意添加的日志，请使用结构化日志（logger.info 等）。')
  return lines
}
