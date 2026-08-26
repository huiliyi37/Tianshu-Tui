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
import budgetsManifest from '../../scripts/source-budgets.manifest.json' with { type: 'json' }

/** 表外产品源文件的新增红线（物理行）。单一事实源在 manifest（redline 字段）。 */
export const MAX_LINES_REDLINE: number = budgetsManifest.redline

/**
 * 巨石点名 ceiling：取录入时现值，只降不升——增长必须在同一 PR 里改
 * scripts/source-budgets.manifest.json（纯数据 diff，review 可见）；拆分落地
 * 后收紧对应条目（或直接删掉让红线接管）。存量不追溯。__tests__ 不在守备
 * 范围（与 architecture-guards 其余 guard 的豁免口径一致）。
 * JSON import 由 tsup 内联进 bundle（esbuild 原生支持）——npm 安装态不依赖
 * scripts/ 目录随包分发。
 */
export const MAX_LINES_BASELINE: ReadonlyArray<readonly [string, number]> = Object.entries(
  budgetsManifest.budgets,
).map(([file, spec]) => [file, spec.ceiling] as const)

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
    warningLines.push('确需增长/确属单一职责：在同一 PR 修改 scripts/source-budgets.manifest.json 并说明理由（纯数据 diff）。')
    warningLines.push('验证：npm run structure:check')
  }

  return { violations, needsWarning, warningLines }
}
