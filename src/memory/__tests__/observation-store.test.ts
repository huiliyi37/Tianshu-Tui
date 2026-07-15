import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { memoryDir } from '../../config/paths.js'
import { appendObservation, readObservations } from '../observation-store.js'
import { extractObservations } from '../observation-extractor.js'

describe('observation-store — Wave 2 write path disabled', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-mem-'))

  it('appendObservation constructs the record but persists nothing', () => {
    const record = appendObservation(cwd, {
      text: 'Project uses node:test for testing',
      kind: 'fact',
      confidence: 0.9,
      source: 'auto',
      tags: ['testing'],
    })

    assert.ok(record.id.startsWith('obs_'))
    assert.equal(record.text, 'Project uses node:test for testing')

    // 正则观察不再落盘——legacy observations.jsonl 与项目知识库都不得有写入
    const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 12)
    assert.equal(existsSync(join(memoryDir(hash), 'observations.jsonl')), false)
    assert.equal(existsSync(join(cwd, '.rivet', 'knowledge', 'memory.jsonl')), false)
    assert.equal(readObservations(cwd).length, 0)
  })

  it('extracts test framework facts from assistant text (extraction still works)', () => {
    const obs = extractObservations('We decided to use node:test instead of Jest for this repo.')
    assert.ok(obs.some(o => o.text.includes('node:test')))
  })

  after(() => {
    rmSync(cwd, { recursive: true, force: true })
  })
})
