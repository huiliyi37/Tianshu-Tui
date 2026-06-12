import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { detectWroteButNeverRead, formatWroteButNeverRead } from '../wiring-nudge.js'

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf-8' })
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`)
}

describe('wiring-nudge — wrote-but-never-read static check (D-fix)', () => {
  let repo: string

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'wiring-nudge-'))
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'test@test'])
    git(repo, ['config', 'user.name', 'test'])
    mkdirSync(join(repo, 'src'), { recursive: true })
    // Baseline: schema file without the dead field.
    writeFileSync(join(repo, 'src/work-order.ts'), [
      'export interface WorkerBudget {',
      '  maxTurns: number',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(repo, 'src/coordinator.ts'), [
      'import type { WorkerBudget } from "./work-order.js"',
      'export function makeBudget(): WorkerBudget {',
      '  return { maxTurns: 5 }',
      '}',
      '',
    ].join('\n'))
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'baseline'])
  })

  after(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('flags a field that is declared and assigned but never read (modelOverride pattern)', () => {
    // Reproduce the exact P2 finding: field added to schema, written in
    // coordinator, read by nobody.
    writeFileSync(join(repo, 'src/work-order.ts'), [
      'export interface WorkerBudget {',
      '  maxTurns: number',
      '  strongModelOverride?: string',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(repo, 'src/coordinator.ts'), [
      'import type { WorkerBudget } from "./work-order.js"',
      'export function makeBudget(): WorkerBudget {',
      '  return { maxTurns: 5, strongModelOverride: "pro" }',
      '}',
      '',
    ].join('\n'))

    const findings = detectWroteButNeverRead(repo, ['src/work-order.ts', 'src/coordinator.ts'])
    const symbols = findings.map(f => f.symbol)
    assert.ok(symbols.includes('strongModelOverride'), `expected strongModelOverride in ${JSON.stringify(symbols)}`)
  })

  it('does not flag a field once a read-side consumer exists', () => {
    writeFileSync(join(repo, 'src/runtime.ts'), [
      'import { makeBudget } from "./coordinator.js"',
      'export function pickModel(): string {',
      '  const budget = makeBudget()',
      '  return budget.strongModelOverride ?? "flash"',
      '}',
      '',
    ].join('\n'))

    const findings = detectWroteButNeverRead(repo, ['src/work-order.ts', 'src/coordinator.ts'])
    const symbols = findings.map(f => f.symbol)
    assert.ok(!symbols.includes('strongModelOverride'), `read consumer exists, got ${JSON.stringify(symbols)}`)
    rmSync(join(repo, 'src/runtime.ts'))
  })

  it('ignores reads that only appear in test files', () => {
    mkdirSync(join(repo, 'src/__tests__'), { recursive: true })
    writeFileSync(join(repo, 'src/__tests__/budget.test.ts'), [
      'import { makeBudget } from "../coordinator.js"',
      'const b = makeBudget()',
      'console.log(b.strongModelOverride)',
      '',
    ].join('\n'))

    const findings = detectWroteButNeverRead(repo, ['src/work-order.ts', 'src/coordinator.ts'])
    const symbols = findings.map(f => f.symbol)
    assert.ok(symbols.includes('strongModelOverride'), 'test-only reads must not count as production consumers')
    rmSync(join(repo, 'src/__tests__'), { recursive: true, force: true })
  })

  it('fails open (no findings) outside a git repo', () => {
    const findings = detectWroteButNeverRead('/nonexistent-dir-for-test', ['src/a.ts'])
    assert.deepEqual(findings, [])
  })

  it('formats findings as a YELLOW non-blocking hint', () => {
    const lines = formatWroteButNeverRead([
      { symbol: 'strongModelOverride', file: 'src/work-order.ts', kind: 'field' },
    ])
    assert.match(lines.join('\n'), /wrote-but-never-read/)
    assert.match(lines.join('\n'), /YELLOW, non-blocking/)
    assert.match(lines.join('\n'), /strongModelOverride/)
    assert.equal(formatWroteButNeverRead([]).length, 0, 'no findings → no output lines')
  })
})
