import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RepairPipeline, summarizeRepairTelemetry } from '../repair-pipeline.js'
import type { RepairPass, RepairContext } from '../repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass, fixAutoLinks } from '../repair-passes.js'
import { RepairHintTracker } from '../repair-hint.js'

// --- Pipeline skeleton tests ---

describe('RepairPipeline', () => {
  it('runs passes in order and collects telemetry', () => {
    const pass1: RepairPass = {
      name: 'test-pass-1',
      run(input) { return { output: { ...input, added: true }, applied: true, fixType: 'test1' } },
    }
    const pass2: RepairPass = {
      name: 'test-pass-2',
      run(input) { return { output: input, applied: false } },
    }
    const pipeline = new RepairPipeline([pass1, pass2])
    const ctx: RepairContext = { toolName: 'bash', schema: { type: 'object', properties: {}, required: [] } }
    const result = pipeline.run({ command: 'ls' }, ctx)

    assert.equal(result.output.added, true)
    assert.equal(result.telemetry.length, 1)
    assert.equal(result.telemetry[0]!.pass, 'test-pass-1')
  })

  it('returns empty telemetry when no pass applied', () => {
    const noop: RepairPass = { name: 'noop', run(input) { return { output: input, applied: false } } }
    const pipeline = new RepairPipeline([noop])
    const ctx: RepairContext = { toolName: 'bash', schema: { type: 'object', properties: {}, required: [] } }
    const result = pipeline.run({ x: 1 }, ctx)
    assert.equal(result.telemetry.length, 0)
  })
})

describe('summarizeRepairTelemetry', () => {
  it('summarizes repair telemetry for trace output', () => {
    const summary = summarizeRepairTelemetry([
      { pass: 'four-horsemen', fixType: 'fourHorsemen', toolName: 'edit_file', timestamp: 1 },
      { pass: 'semantic-repair', fixType: 'autoLink', toolName: 'write_file', timestamp: 2 },
    ])

    assert.equal(summary, 'repair: fourHorsemen(edit_file), autoLink(write_file)')
  })
})

// --- Four Horsemen tests ---

const editSchema = { type: 'object' as const, properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } }, required: ['file_path', 'old_string', 'new_string'] }
const grepSchema = { type: 'object' as const, properties: { pattern: { type: 'string' }, include: { type: 'array', items: { type: 'string' } } }, required: ['pattern'] }

describe('fourHorsemenPass', () => {
  it('Fix 1: null → omit for optional', () => {
    const r = fourHorsemenPass.run({ file_path: '/a.ts', old_string: 'x', new_string: 'y', replace_all: null }, { toolName: 'edit_file', schema: editSchema })
    assert.equal(r.applied, true)
    assert.equal(r.output.replace_all, undefined)
    assert.equal(r.output.file_path, '/a.ts')
  })

  it('Fix 1: keeps null for required', () => {
    const r = fourHorsemenPass.run({ file_path: null, old_string: 'x', new_string: 'y' }, { toolName: 'edit_file', schema: editSchema })
    assert.equal(r.output.file_path, null)
  })

  it('Fix 2: JSON array string → array', () => {
    const r = fourHorsemenPass.run({ pattern: 'TODO', include: '["*.ts","*.tsx"]' }, { toolName: 'grep', schema: grepSchema })
    assert.deepEqual(r.output.include, ['*.ts', '*.tsx'])
    assert.equal(r.applied, true)
  })

  it('Fix 3: numeric-keyed object → array', () => {
    const r = fourHorsemenPass.run({ pattern: 'TODO', include: { '0': '*.ts', '1': '*.tsx' } }, { toolName: 'grep', schema: grepSchema })
    assert.deepEqual(r.output.include, ['*.ts', '*.tsx'])
  })

  it('Fix 4: bare string → array', () => {
    const r = fourHorsemenPass.run({ pattern: 'TODO', include: '*.ts' }, { toolName: 'grep', schema: grepSchema })
    assert.deepEqual(r.output.include, ['*.ts'])
  })

  it('no-op on valid input', () => {
    const r = fourHorsemenPass.run({ pattern: 'TODO', include: ['*.ts'] }, { toolName: 'grep', schema: grepSchema })
    assert.equal(r.applied, false)
  })
})

// --- Semantic repair tests ---

describe('semanticRepairPass', () => {
  it('cleans autolinks in string fields', () => {
    const r = semanticRepairPass.run({ file_path: '[notes.md](http://notes.md)' }, { toolName: 'read_file', schema: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } })
    assert.equal(r.applied, true)
    assert.equal(r.output.file_path, 'notes.md')
  })

  it('preserves real markdown links', () => {
    const r = semanticRepairPass.run({ text: '[click](https://example.com/docs)' }, { toolName: 'x', schema: { type: 'object', properties: {}, required: [] } })
    assert.equal(r.applied, false)
  })
})

describe('fixAutoLinks', () => {
  it('strips degraded autolink', () => {
    assert.equal(fixAutoLinks('[README.md](http://README.md)').fixed, 'README.md')
  })

  it('preserves real link', () => {
    const input = '[click here](https://example.com/docs)'
    assert.equal(fixAutoLinks(input).fixed, input)
  })
})

// --- RepairHintTracker tests ---

describe('RepairHintTracker', () => {
  it('returns null when no consecutive failures', () => {
    const t = new RepairHintTracker()
    t.recordFailure('edit_file', 'type_error')
    assert.equal(t.getHint(), null)
  })

  it('returns hint after 2 consecutive same-type failures', () => {
    const t = new RepairHintTracker()
    t.recordFailure('edit_file', 'type_error')
    t.recordFailure('edit_file', 'type_error')
    const hint = t.getHint()
    assert.ok(hint)
    assert.ok(hint.includes('edit_file'))
  })

  it('resets on success', () => {
    const t = new RepairHintTracker()
    t.recordFailure('edit_file', 'type_error')
    t.recordSuccess('edit_file')
    t.recordFailure('edit_file', 'type_error')
    assert.equal(t.getHint(), null)
  })

  it('does not trigger for different failure types', () => {
    const t = new RepairHintTracker()
    t.recordFailure('edit_file', 'type_error')
    t.recordFailure('edit_file', 'assertion')
    assert.equal(t.getHint(), null)
  })

  it('stops hinting after exhaustion limit', () => {
    const t = new RepairHintTracker()
    t.recordFailure('bash', 'timeout')
    t.recordFailure('bash', 'timeout')
    t.recordFailure('bash', 'timeout')
    t.recordFailure('bash', 'timeout')
    assert.equal(t.getHint(), null)
  })
})
