/**
 * structure-gate 单测 — 行数棘轮交付门预警的红绿两路。
 *
 * 硬门（超限即红）在 architecture-guards.test.ts 的 max-lines ratchet；
 * 这里验证共享判定逻辑与 deliver_task 侧的 YELLOW 报告形态：
 * 命中给可执行建议（拆分/改基线表/验证命令），未命中零输出。
 */
import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  MAX_LINES_BASELINE,
  MAX_LINES_REDLINE,
  checkStructureGate,
  countPhysicalLines,
} from '../structure-gate.js'

const CWD = '/repo'

/** 生成恰好 n 物理行、带仓规尾换行的内容。 */
function contentOfLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i}`).join('\n') + '\n'
}

/** path(绝对) → content 的注入读取器；缺失返回 null（模拟已删除）。 */
function readerOf(files: Record<string, string>): (abs: string) => string | null {
  return (abs) => files[abs] ?? null
}

describe('countPhysicalLines', () => {
  test('wc -l 口径：空 0 行，尾换行恰为可见行数，无尾换行仍计末行', () => {
    assert.equal(countPhysicalLines(''), 0)
    assert.equal(countPhysicalLines('one\n'), 1)
    assert.equal(countPhysicalLines('one\ntwo\n'), 2)
    assert.equal(countPhysicalLines('one\ntwo'), 2)
  })
})

describe('checkStructureGate', () => {
  test('限额内安静：基线文件恰在 ceiling、表外文件恰在红线均不预警', () => {
    const [monolith, ceiling] = MAX_LINES_BASELINE[0]!
    const report = checkStructureGate(
      [monolith, 'src/agent/fresh.ts'],
      CWD,
      readerOf({
        [join(CWD, monolith)]: contentOfLines(ceiling),
        [join(CWD, 'src/agent/fresh.ts')]: contentOfLines(MAX_LINES_REDLINE),
      }),
    )
    assert.equal(report.needsWarning, false)
    assert.deepEqual(report.violations, [])
    assert.deepEqual(report.warningLines, [])
  })

  test('点名巨石超 ceiling → kind=ceiling，报告含行数与可执行路径', () => {
    const [monolith, ceiling] = MAX_LINES_BASELINE[0]!
    const report = checkStructureGate(
      [monolith],
      CWD,
      readerOf({ [join(CWD, monolith)]: contentOfLines(ceiling + 1) }),
    )
    assert.equal(report.needsWarning, true)
    assert.deepEqual(report.violations, [
      { file: monolith, lines: ceiling + 1, limit: ceiling, kind: 'ceiling' },
    ])
    const text = report.warningLines.join('\n')
    assert.ok(text.includes(monolith), 'must name the file')
    assert.ok(text.includes(`${ceiling + 1} 行`), 'must show the current line count')
    assert.ok(text.includes('拆分'), 'must suggest splitting, not just report numbers')
    assert.ok(text.includes('MAX_LINES_BASELINE'), 'must point at the baseline table for intentional growth')
    assert.ok(text.includes('npm run structure:check'), 'must give the verify command')
  })

  test('表外文件超红线 → kind=redline', () => {
    const report = checkStructureGate(
      ['src/agent/new-monolith.ts'],
      CWD,
      readerOf({ [join(CWD, 'src/agent/new-monolith.ts')]: contentOfLines(MAX_LINES_REDLINE + 1) }),
    )
    assert.deepEqual(report.violations, [
      {
        file: 'src/agent/new-monolith.ts',
        lines: MAX_LINES_REDLINE + 1,
        limit: MAX_LINES_REDLINE,
        kind: 'redline',
      },
    ])
  })

  test('守备口径：__tests__、src 外、非 .ts、.d.ts、已删除文件全部跳过', () => {
    const oversized = contentOfLines(MAX_LINES_REDLINE + 100)
    const report = checkStructureGate(
      [
        'src/agent/__tests__/huge.test.ts',
        'scripts/huge.ts',
        'src/agent/notes.md',
        'src/agent/huge.d.ts',
        'src/agent/deleted.ts', // reader 返回 null
      ],
      CWD,
      readerOf({
        [join(CWD, 'src/agent/__tests__/huge.test.ts')]: oversized,
        [join(CWD, 'scripts/huge.ts')]: oversized,
        [join(CWD, 'src/agent/notes.md')]: oversized,
        [join(CWD, 'src/agent/huge.d.ts')]: oversized,
      }),
    )
    assert.equal(report.needsWarning, false)
    assert.deepEqual(report.violations, [])
  })

  test('绝对路径与相对路径同判（probe 门同款路径归一）', () => {
    const abs = join(CWD, 'src/agent/new-monolith.ts')
    const report = checkStructureGate(
      [abs],
      CWD,
      readerOf({ [abs]: contentOfLines(MAX_LINES_REDLINE + 1) }),
    )
    assert.equal(report.violations.length, 1)
    assert.equal(report.violations[0]!.file, 'src/agent/new-monolith.ts')
  })
})
