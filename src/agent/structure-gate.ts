/**
 * structure-gate — 行数棘轮的单一事实来源 + 交付门预警检查。
 *
 * 基线表与红线被两处消费：
 * 1. src/__tests__/architecture-guards.test.ts 的 max-lines ratchet（硬门，
 *    npm test / npm run structure:check 红绿判定）；
 * 2. deliver_task 的 structure gate（YELLOW 预警，不阻断交付——在 CI 变红
 *    之前把棘轮命中和可执行的拆分建议摆到模型面前）。
 *
 * 语义：表内点名巨石 ceiling 只降不升（存量不追溯）；表外产品源文件超
 * MAX_LINES_REDLINE 即命中。增长必须在同一 PR 修改本文件的基线表并说明理由。
 *
 * @module structure-gate
 */

import { readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'

/** 表外产品源文件的新增红线（物理行）。 */
export const MAX_LINES_REDLINE = 800

/**
 * 巨石点名 ceiling：取录入时现值，只降不升——增长必须在同一 PR 里改这张表，
 * review 可见；拆分落地后手动收紧对应条目（或直接删掉让红线接管）。
 * 存量不追溯：表内文件不因历史体量翻红，只拦继续膨胀。
 * __tests__ 不在守备范围（与 architecture-guards 其余 guard 的豁免口径一致）。
 */
export const MAX_LINES_BASELINE: ReadonlyArray<readonly [string, number]> = [
  ['src/tui/engine/app.ts', 6527],
  ['src/server/session-manager.ts', 5739],
  ['src/tui/slash-commands.ts', 4350],
  ['src/agent/coordinator.ts', 3383],
  ['src/agent/loop.ts', 2837],
  ['src/bootstrap.ts', 2503],
  ['src/config/manager.ts', 2144],
  ['src/main.ts', 2126],
  ['src/tui/pi/latex-to-unicode.ts', 2071],
  ['src/agent/tool-pipeline.ts', 2070],
  ['src/server/session-routes.ts', 1995],
  ['src/prompt/engine.ts', 1624],
  ['src/agent/compaction-controller.ts', 1621],
  // 1595→1613：本文件的 YELLOW 预警门接线（ctx 钩子 + 检查块）落在 deliver-task。
  ['src/agent/deliver-task.ts', 1613],
  ['src/tui/format/overlay.ts', 1492],
  ['src/api/openai-client.ts', 1492],
  ['src/agent/turn-orchestrator.ts', 1462],
  ['src/agent/loop-factory.ts', 1450],
  ['src/agent/advisory-bus.ts', 1273],
  ['src/agent/convergence-detector.ts', 1260],
  ['src/tui/engine/input-line.ts', 1235],
  ['src/prompt/volatile.ts', 1197],
  ['src/agent/turn-step-producer.ts', 1169],
  ['src/agent/worker-session.ts', 1155],
  ['src/tools/galaxy.ts', 1136],
  ['src/pro/computer-use/windows-driver.ts', 1136],
  ['src/tools/read-file.ts', 1123],
  ['src/server/serve-agent.ts', 1118],
  ['src/tools/browser-debug/tool.ts', 1084],
  ['src/server/session-persistence.ts', 1062],
  ['src/agent/problem-attack-loop.ts', 1027],
  ['src/agent/hooks/cognitive-capsule-router.ts', 1026],
  ['src/agent/work-order.ts', 1004],
  ['src/tools/run-tests.ts', 995],
  ['src/server/serve.ts', 989],
  ['src/agent/starflow-orchestrator.ts', 988],
  ['src/pro/computer-use/macos-driver.ts', 976],
  ['src/agent/create-runtime-hooks.ts', 958],
  ['src/tools/bash.ts', 943],
  ['src/skills/skill-loader.ts', 941],
  ['src/config/env-registry.ts', 914],
  ['src/server/config-routes.ts', 899],
  ['src/pro/computer-use/cdp/driver.ts', 899],
  ['src/pro/computer-use/tool.ts', 891],
  ['src/pro/computer-use/windows-uia-com.ts', 888],
  ['src/config/schema.ts', 879],
  ['src/agent/session-persist.ts', 874],
  ['src/tui/settings-model.ts', 865],
]

/** 物理行数（wc -l 口径：按换行计，仓规尾部单换行时恰为可见行数）。 */
export function countPhysicalLines(content: string): number {
  if (content.length === 0) return 0
  const segments = content.split('\n').length
  return content.endsWith('\n') ? segments - 1 : segments
}

/** 单个棘轮命中：表内文件超 ceiling，或表外文件超红线。 */
export interface StructureViolation {
  /** 仓库相对路径（posix 分隔） */
  file: string
  /** 当前物理行数 */
  lines: number
  /** 命中的上限（ceiling 或红线值） */
  limit: number
  /** ceiling=点名巨石超其棘轮值；redline=表外文件超新增红线 */
  kind: 'ceiling' | 'redline'
}

/** 交付门结构检查报告（形态对齐 commit-cohesion 的 CohesionReport）。 */
export interface StructureGateReport {
  violations: StructureViolation[]
  /** 是否应显示预警（YELLOW，不阻断） */
  needsWarning: boolean
  /** 人类可读的警告行，含可执行的拆分/豁免路径 */
  warningLines: string[]
}

/** 守备范围判定：src/ 下产品 .ts 源文件（口径与 architecture-guards 一致）。 */
function isGuardedSourcePath(relPosix: string): boolean {
  if (!relPosix.startsWith('src/')) return false
  if (!relPosix.endsWith('.ts') || relPosix.endsWith('.d.ts')) return false
  if (relPosix.includes('/__tests__/')) return false
  return true
}

/**
 * 检查即将提交的文件是否命中行数棘轮。fs 重扫为准（与 probe 门同理：
 * 后续编辑已把文件拆小的不再命中）。文件缺失（已删除）跳过。
 *
 * @param files 即将提交的文件路径（相对 cwd 或绝对，均可）
 * @param cwd 仓库根
 * @param readFile 注入的读取器（测试用）；缺省用 readFileSync，读不到返回 null
 */
export function checkStructureGate(
  files: string[],
  cwd: string,
  readFile: (absPath: string) => string | null = (p) => {
    try { return readFileSync(p, 'utf-8') } catch { return null }
  },
): StructureGateReport {
  const baseline = new Map<string, number>(MAX_LINES_BASELINE)
  const violations: StructureViolation[] = []

  for (const filePath of files) {
    const abs = isAbsolute(filePath) ? filePath : join(cwd, filePath)
    const relPosix = relative(cwd, abs).split(sep).join('/')
    if (!isGuardedSourcePath(relPosix)) continue
    const content = readFile(abs)
    if (content === null) continue // 文件可能已被删除
    const lines = countPhysicalLines(content)
    const ceiling = baseline.get(relPosix)
    if (ceiling !== undefined) {
      if (lines > ceiling) violations.push({ file: relPosix, lines, limit: ceiling, kind: 'ceiling' })
    } else if (lines > MAX_LINES_REDLINE) {
      violations.push({ file: relPosix, lines, limit: MAX_LINES_REDLINE, kind: 'redline' })
    }
  }

  const needsWarning = violations.length > 0
  const warningLines: string[] = []
  if (needsWarning) {
    warningLines.push('⚠️ Structure gate（预警，不阻断）：本次提交命中行数棘轮，npm test 的 architecture-guards 会红：')
    for (const v of violations) {
      const hint = v.kind === 'ceiling' ? '点名巨石只降不升' : `表外文件红线 ${MAX_LINES_REDLINE}`
      warningLines.push(`  ${v.file}: ${v.lines} 行 > ${v.kind} ${v.limit}（${hint}）`)
    }
    warningLines.push('沿接缝拆分：提取子模块后按区域分批 deliver_task，而不是继续膨胀。')
    warningLines.push('确需增长/确属单一职责：在同一 PR 修改 src/agent/structure-gate.ts 的 MAX_LINES_BASELINE 并说明理由。')
    warningLines.push('验证：npm run structure:check')
  }

  return { violations, needsWarning, warningLines }
}
