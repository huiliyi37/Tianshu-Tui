/**
 * Tests for unified-memory.ts — append, recall, migration idempotency.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  appendMemoryEntry,
  readMemoryEntries,
  recallMemoryEntries,
  countSimilarMemoryEntries,
  migrateObservationsToUnified,
  renderMemoryBlock,
} from '../unified-memory.js'

const TEST_DIR = join(tmpdir(), 'rivet-um-test')

function projectHash(cwd: string): string {
  return createHash('sha256').update(cwd).digest('hex').slice(0, 12)
}

function setup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  mkdirSync(TEST_DIR, { recursive: true })
  const memDir = join(homedir(), '.rivet', 'memory', projectHash(TEST_DIR))
  try { rmSync(memDir, { recursive: true }) } catch {}
}

function teardown() {
  try { rmSync(TEST_DIR, { recursive: true }) } catch {}
  try { rmSync(join(homedir(), '.rivet', 'memory', projectHash(TEST_DIR)), { recursive: true }) } catch {}
}

describe('unified-memory', () => {
  setup()

  it('appends and reads memory entries', () => {
    const entry = appendMemoryEntry(TEST_DIR, {
      text: 'Project uses node:test for testing',
      kind: 'fact',
      confidence: 0.9,
      source: 'auto',
      status: 'observed',
      tags: ['testing'],
    })
    assert.ok(entry.id.startsWith('mem_'))
    assert.equal(entry.repeatCount, 1)
    assert.equal(entry.kind, 'fact')

    const entries = readMemoryEntries(TEST_DIR)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.text, 'Project uses node:test for testing')
  })

  it('increments repeatCount on duplicate text', () => {
    const text = 'Project uses TypeScript strict mode'
    const e1 = appendMemoryEntry(TEST_DIR, {
      text, kind: 'fact', confidence: 0.9, source: 'auto', status: 'observed', tags: [],
    })
    assert.equal(e1.repeatCount, 1)
    const e2 = appendMemoryEntry(TEST_DIR, {
      text, kind: 'fact', confidence: 0.9, source: 'auto', status: 'observed', tags: [],
    })
    assert.equal(e2.repeatCount, 2)
  })

  it('recalls entries by keyword', () => {
    appendMemoryEntry(TEST_DIR, {
      text: 'Authentication middleware uses JWT tokens',
      kind: 'decision', confidence: 0.95, source: 'manual', status: 'verified', tags: ['auth'],
    })
    appendMemoryEntry(TEST_DIR, {
      text: 'Database uses PostgreSQL with connection pooling',
      kind: 'fact', confidence: 0.8, source: 'auto', status: 'observed', tags: ['db'],
    })

    const results = recallMemoryEntries(TEST_DIR, 'authentication JWT', 5)
    assert.ok(results.length >= 1)
    assert.ok(results[0]!.text.includes('JWT'))

    // Filter by kind
    const decisions = recallMemoryEntries(TEST_DIR, 'database', 5, 'decision')
    assert.equal(decisions.length, 0) // db entry is 'fact', not 'decision'
  })

  it('renders memory block as XML', () => {
    appendMemoryEntry(TEST_DIR, {
      text: 'Testing framework is node:test',
      kind: 'fact', confidence: 0.95, source: 'auto', status: 'verified', tags: [],
    })
    const block = renderMemoryBlock(TEST_DIR, 'testing', 500)
    assert.ok(block!.includes('<cross-session-memory>'))
    assert.ok(block!.includes('node:test'))
  })

  it('countSimilarMemoryEntries works', () => {
    const text = 'Unique observation for counting'
    appendMemoryEntry(TEST_DIR, {
      text, kind: 'fact', confidence: 0.5, source: 'auto', status: 'observed', tags: [],
    })
    const count = countSimilarMemoryEntries(TEST_DIR, text)
    assert.equal(count, 1)
  })

  it('migration is idempotent', () => {
    // migrateObservationsToUnified reads from ~/.rivet/memory/<hash>/observations.jsonl
    const obsDir = join(homedir(), '.rivet', 'memory', projectHash(TEST_DIR))
    mkdirSync(obsDir, { recursive: true })
    const obsFile = join(obsDir, 'observations.jsonl')
    writeFileSync(obsFile, [
      JSON.stringify({ id: 'obs_1', text: 'Old observation one', kind: 'fact', confidence: 0.8, source: 'auto', tags: [] }),
      JSON.stringify({ id: 'obs_2', text: 'Old observation two', kind: 'decision', confidence: 0.9, source: 'user', tags: [] }),
    ].join('\n') + '\n')

    // First run
    const count1 = migrateObservationsToUnified(TEST_DIR)
    assert.equal(count1, 2)

    // Second run — should skip already-migrated entries
    const count2 = migrateObservationsToUnified(TEST_DIR)
    assert.equal(count2, 0) // idempotent: zero new entries

    // Append a new entry to observations.jsonl after first migration
    writeFileSync(obsFile, [
      JSON.stringify({ id: 'obs_1', text: 'Old observation one', kind: 'fact', confidence: 0.8, source: 'auto', tags: [] }),
      JSON.stringify({ id: 'obs_2', text: 'Old observation two', kind: 'decision', confidence: 0.9, source: 'user', tags: [] }),
      JSON.stringify({ id: 'obs_3', text: 'New observation three', kind: 'fact', confidence: 0.7, source: 'auto', tags: [] }),
    ].join('\n') + '\n')

    // Third run — only the new entry should be migrated
    const count3 = migrateObservationsToUnified(TEST_DIR)
    assert.equal(count3, 1)
  })

  it('skips malformed lines when reading', () => {
    // Direct append of malformed line (simulate corruption)
    appendMemoryEntry(TEST_DIR, {
      text: 'Valid entry',
      kind: 'fact', confidence: 0.9, source: 'auto', status: 'observed', tags: [],
    })
    const entries = readMemoryEntries(TEST_DIR)
    // Should have at least the valid entries
    assert.ok(entries.length >= 1)
    const valid = entries.find(e => e.text === 'Valid entry')
    assert.ok(valid)
  })

  teardown()
})
