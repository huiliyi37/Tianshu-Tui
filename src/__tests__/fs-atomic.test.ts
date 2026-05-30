import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { writeFileAtomicAsync } from '../fs-atomic.js'

describe('writeFileAtomicAsync (S13)', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rivet-atomic-')) })
  afterEach(() => { if (existsSync(dir)) rmSync(dir, { recursive: true, force: true }) })

  it('writes data atomically and leaves no tmp file', async () => {
    const fp = join(dir, 'session.jsonl')
    await writeFileAtomicAsync(fp, 'line1\nline2\n')
    assert.equal(readFileSync(fp, 'utf-8'), 'line1\nline2\n')
    assert.equal(readdirSync(dir).filter(f => f.endsWith('.tmp')).length, 0)
  })
  it('overwrites existing file content', async () => {
    const fp = join(dir, 'session.jsonl')
    writeFileSync(fp, 'old')
    await writeFileAtomicAsync(fp, 'new')
    assert.equal(readFileSync(fp, 'utf-8'), 'new')
  })
  it('creates missing parent directory', async () => {
    const fp = join(dir, 'nested', 'deep', 'f.json')
    await writeFileAtomicAsync(fp, '{}')
    assert.equal(readFileSync(fp, 'utf-8'), '{}')
  })
})
