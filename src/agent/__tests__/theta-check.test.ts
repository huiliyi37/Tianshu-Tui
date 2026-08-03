import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runThetaCheck, clearThetaCache, trimCapturedOutput } from '../theta-check.js'

const tempDirs: string[] = []

function makeProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'theta-check-test-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
    include: ['*.ts'],
  }))
  return dir
}

afterEach(() => {
  clearThetaCache()
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('runThetaCheck', () => {
  it('returns empty errors for a valid TypeScript project', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'valid.ts'), 'export const x: number = 42\n')

    const result = await runThetaCheck(dir, 10_000)

    assert.deepEqual(result.errors, [])
    assert.ok(result.durationMs >= 0)
    assert.equal(result.timedOut, false)
  })

  it('returns error file paths for invalid TypeScript', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'broken.ts'), 'export const x: number = "not a number"\n')

    const result = await runThetaCheck(dir, 10_000)

    assert.ok(result.errors.length > 0)
    assert.ok(result.errors.some(e => e.endsWith('broken.ts')), `expected broken.ts in ${result.errors.join(', ')}`)
    assert.equal(result.timedOut, false)
  })

  it('returns empty errors when no parseable file errors are emitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'theta-check-empty-test-'))
    tempDirs.push(dir)

    const result = await runThetaCheck(dir, 10_000)

    assert.deepEqual(result.errors, [])
    assert.ok(result.durationMs >= 0)
    assert.equal(result.timedOut, false)
  })

  it('reports timeout metadata for very short timeouts', async () => {
    const dir = makeProject()
    writeFileSync(join(dir, 'valid.ts'), 'export const x: number = 42\n')

    const result = await runThetaCheck(dir, 1)

    assert.deepEqual(result.errors, [])
    assert.equal(result.timedOut, true)
  })
})

describe('trimCapturedOutput', () => {
  const line = (i: number) => `src/file${String(i).padStart(4, '0')}.ts(${i + 1},5): error TS2322: `.padEnd(150, 'x')

  it('passes small output through unchanged', () => {
    assert.equal(trimCapturedOutput('ok'), 'ok')
    assert.equal(trimCapturedOutput(''), '')
  })

  it('truncates to ~80KB at a line boundary (no partial diagnostics)', () => {
    const full = Array.from({ length: 1000 }, (_, i) => line(i)).join('\n')
    assert.ok(full.length > 100_000, 'fixture must exceed the 100KB threshold')

    const out = trimCapturedOutput(full)
    assert.ok(out.length <= 80_000, `got ${out.length}`)
    const lines = out.split('\n')
    // First and last lines are complete diagnostics — no partial line anywhere
    const diagRe = /^src\/file\d{4}\.ts\(\d+,\d+\): error TS\d+:/
    for (const l of lines) assert.match(l, diagRe, `partial line: ${l.slice(0, 60)}`)
  })

  it('falls back to raw slice when no newline exists after the cut point', () => {
    const full = 'A'.repeat(100_001) // no newlines at all
    const out = trimCapturedOutput(full)
    assert.equal(out, full.slice(full.length - 80_000))
  })
})
