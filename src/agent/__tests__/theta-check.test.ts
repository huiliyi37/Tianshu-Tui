import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runThetaCheck, clearThetaCache } from '../theta-check.js'

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
