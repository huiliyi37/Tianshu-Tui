/**
 * 测试存在性门禁 — 交付级"新代码必须带测试"的轻量判定（2026-07-07）。
 *
 * 背景：TDD 硬门禁（per-edit 拦截）诱发 rewrite 循环后降级为 suggest-only，
 * 但天枢长任务复盘显示"可检查处满足、检查不到处省略"——内核有 wave-gate 查
 * typecheck 所以写了测试，插件交付物没人查就零测试。本模块补交付级检查：
 * 一个波改动了 ≥threshold 个源文件却不含任何测试文件 → 违规。
 *
 * 纯函数，无 I/O。由 wave-gate（blocking）和 deliver_task（advisory）消费。
 * 逃生阀：RIVET_TEST_PRESENCE_GATE=0。
 */

export interface TestPresenceResult {
  /** true = 无违规（有测试、或源文件数低于阈值、或门禁关闭场景由调用方判断）。 */
  ok: boolean
  /** 被判定为源代码的文件（相对/绝对路径原样保留）。 */
  sourceFiles: string[]
  /** 被判定为测试的文件。 */
  testFiles: string[]
  /** 违规时的人类可读说明（含未测试文件清单与补救指引）。 */
  detail?: string
}

/** 测试文件判定：__tests__/ 目录、*.test.* / *.spec.*（覆盖 plugins/** 自带测试）。 */
export function isTestFilePath(path: string): boolean {
  return /[\\/]__tests__[\\/]/i.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/i.test(path)
}

/** 源文件判定：.ts/.tsx/.js/.jsx/.mjs/.cjs，非测试、非 docs/、非声明文件。 */
export function isSourceFilePath(path: string): boolean {
  if (isTestFilePath(path)) return false
  if (/\.d\.[cm]?ts$/i.test(path)) return false
  if (!/\.[cm]?[jt]sx?$/i.test(path)) return false
  const normalized = path.replace(/\\/g, '/')
  if (/(^|\/)(docs|doc|examples?|scripts)\//i.test(normalized)) return false
  // 顶层配置形状（eslint.config.js、vitest.config.ts 等）不算业务源码。
  const base = normalized.split('/').pop() ?? ''
  if (/\.config\.[cm]?[jt]s$/i.test(base)) return false
  return true
}

export function testPresenceGateEnabled(): boolean {
  return process.env.RIVET_TEST_PRESENCE_GATE !== '0'
}

/**
 * 判定一批变更文件是否满足测试存在性。
 *
 * 触发条件：源文件数 ≥ threshold 且测试文件数 = 0。
 * 只统计文件路径形状，不看内容——这是存在性检查，不是覆盖率检查。
 */
export function evaluateTestPresence(
  changedFiles: readonly string[],
  threshold = 3,
): TestPresenceResult {
  const sourceFiles = changedFiles.filter(isSourceFilePath)
  const testFiles = changedFiles.filter(isTestFilePath)

  if (sourceFiles.length >= threshold && testFiles.length === 0) {
    const list = sourceFiles.slice(0, 10).join(', ')
    const more = sourceFiles.length > 10 ? ` (+${sourceFiles.length - 10} more)` : ''
    return {
      ok: false,
      sourceFiles,
      testFiles,
      detail:
        `${sourceFiles.length} 个源文件变更但零测试文件：${list}${more}。` +
        `为核心行为补测试文件（__tests__/*.test.ts 或同名 *.test.*）后自动放行。`,
    }
  }

  return { ok: true, sourceFiles, testFiles }
}
