import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { appendObservation, recallObservations, readObservations } from '../observation-store.js'
import { extractObservations } from '../observation-extractor.js'

describe('observation-store', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'rivet-mem-'))

  it('appends and recalls observations', () => {
    appendObservation(cwd, {
      text: 'Project uses node:test for testing',
      kind: 'fact',
      confidence: 0.9,
      source: 'auto',
      tags: ['testing'],
    })
    appendObservation(cwd, {
      text: 'Prefer immutable patterns with spread operator',
      kind: 'preference',
      confidence: 0.8,
      source: 'auto',
      tags: ['style'],
    })

    assert.equal(readObservations(cwd).length, 2)
    const recalled = recallObservations(cwd, 'node test testing framework')
    assert.ok(recalled.length >= 1)
    assert.match(recalled[0]!.text, /node:test/)
  })

  it('extracts test framework facts from assistant text', () => {
    const obs = extractObservations('We decided to use node:test instead of Jest for this repo.')
    assert.ok(obs.some(o => o.text.includes('node:test')))
  })

  after(() => {
    rmSync(cwd, { recursive: true, force: true })
  })
})
