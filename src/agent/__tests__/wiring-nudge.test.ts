import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import {
  detectWroteButNeverRead,
  formatWroteButNeverRead,
  detectReadButNeverProduced,
  formatReadButNeverProduced,
} from '../wiring-nudge.js'

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

describe('wiring-nudge — read-but-never-produced dual check (虚假绿灯 guard)', () => {
  let repo: string

  function seed(): void {
    repo = mkdtempSync(join(tmpdir(), 'rbnp-'))
    git(repo, ['init', '-q'])
    git(repo, ['config', 'user.email', 'test@test'])
    git(repo, ['config', 'user.name', 'test'])
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'src/__tests__'), { recursive: true })
    // Baseline: a type with the field declared, but no renderer yet.
    writeFileSync(join(repo, 'src/plan.ts'), [
      'export interface Contribution {',
      '  authority: string',
      '  reviewerScore?: string',
      '}',
      '',
    ].join('\n'))
    git(repo, ['add', '.'])
    git(repo, ['commit', '-qm', 'baseline'])
  }

  before(seed)
  after(() => rmSync(repo, { recursive: true, force: true }))

  it('subtype A: field read in prod, written only in test fixture → flagged', () => {
    // Renderer added that READS reviewerScore (production read).
    writeFileSync(join(repo, 'src/render.ts'), [
      'import type { Contribution } from "./plan.js"',
      'export function render(c: Contribution): string {',
      '  return c.reviewerScore ? `score: ${c.reviewerScore}` : ""',
      '}',
      '',
    ].join('\n'))
    // Only a TEST fixture ever assigns a value to reviewerScore.
    writeFileSync(join(repo, 'src/__tests__/render.test.ts'), [
      'const c = { authority: "x", reviewerScore: "A+" }',
      'console.log(c)',
      '',
    ].join('\n'))

    const findings = detectReadButNeverProduced(repo, ['src/render.ts'])
    const fields = findings.map(f => f.field)
    assert.ok(fields.includes('reviewerScore'), `expected reviewerScore flagged, got ${JSON.stringify(fields)}`)
    rmSync(join(repo, 'src/render.ts'))
    rmSync(join(repo, 'src/__tests__/render.test.ts'))
  })

  it('does not flag once a production value-write exists', () => {
    writeFileSync(join(repo, 'src/render.ts'), [
      'import type { Contribution } from "./plan.js"',
      'export function render(c: Contribution): string {',
      '  return c.reviewerScore ? `score: ${c.reviewerScore}` : ""',
      '}',
      '',
    ].join('\n'))
    // Production code now WRITES a real value.
    writeFileSync(join(repo, 'src/build.ts'), [
      'import type { Contribution } from "./plan.js"',
      'export function build(score: string): Contribution {',
      '  return { authority: "x", reviewerScore: score }',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(repo, 'src/__tests__/render.test.ts'), [
      'const c = { authority: "x", reviewerScore: "A+" }',
      'console.log(c)',
      '',
    ].join('\n'))

    const findings = detectReadButNeverProduced(repo, ['src/render.ts'])
    assert.ok(!findings.map(f => f.field).includes('reviewerScore'), 'prod write exists → not flagged')
    rmSync(join(repo, 'src/render.ts'))
    rmSync(join(repo, 'src/build.ts'))
    rmSync(join(repo, 'src/__tests__/render.test.ts'))
  })

  it('HONEST LIMITATION — subtype B (prod write line exists but runtime-dead) is NOT caught', () => {
    // The modelUsed class: a production write line exists (`reviewerScore: raw.reviewerScore`)
    // but `raw` never carries the field at runtime. grep sees the write site → silent.
    // This test pins the documented blind spot; subtype B is the review-gate's job.
    writeFileSync(join(repo, 'src/render.ts'), [
      'import type { Contribution } from "./plan.js"',
      'export function render(c: Contribution): string {',
      '  return c.reviewerScore ? `score: ${c.reviewerScore}` : ""',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(repo, 'src/parse.ts'), [
      'import type { Contribution } from "./plan.js"',
      'export function parse(raw: Partial<Contribution>): Contribution {',
      '  return { authority: "x", reviewerScore: raw.reviewerScore ?? "" }',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(repo, 'src/__tests__/render.test.ts'), [
      'const c = { authority: "x", reviewerScore: "A+" }',
      'console.log(c)',
      '',
    ].join('\n'))

    const findings = detectReadButNeverProduced(repo, ['src/render.ts'])
    // A prod write site exists (parse.ts), so the static check stays silent — as documented.
    assert.ok(!findings.map(f => f.field).includes('reviewerScore'), 'subtype B is a known blind spot, not flagged')
    rmSync(join(repo, 'src/render.ts'))
    rmSync(join(repo, 'src/parse.ts'))
    rmSync(join(repo, 'src/__tests__/render.test.ts'))
  })

  it('fails open (no findings) outside a git repo', () => {
    assert.deepEqual(detectReadButNeverProduced('/nonexistent-dir-for-test', ['src/a.ts']), [])
  })

  it('formats findings as a YELLOW non-blocking hint', () => {
    const lines = formatReadButNeverProduced([{ field: 'reviewerScore', file: 'src/render.ts' }])
    assert.match(lines.join('\n'), /read-but-never-produced/)
    assert.match(lines.join('\n'), /虚假绿灯/)
    assert.match(lines.join('\n'), /reviewerScore/)
    assert.equal(formatReadButNeverProduced([]).length, 0)
  })
})
