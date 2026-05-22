import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RepairPipeline } from '../agent/repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass } from '../agent/repair-passes.js'
import { RepairHintTracker } from '../agent/repair-hint.js'
import { validateRequiredFields } from '../agent/repair-pipeline.js'

describe('repair pipeline integration', () => {
  const pipeline = new RepairPipeline([fourHorsemenPass, semanticRepairPass])
  const grepSchema = {
    type: 'object' as const,
    properties: { pattern: { type: 'string' }, include: { type: 'array', items: { type: 'string' } } },
    required: ['pattern'],
  }

  it('applies four horsemen + semantic repair in sequence', () => {
    // Input has null optional, JSON string array, and autolink
    const input = {
      pattern: 'TODO',
      include: '["*.ts","*.tsx"]',
      replace_all: null,
    }
    const result = pipeline.run(input, { toolName: 'grep', schema: grepSchema })

    // Fix 1: null omitted, Fix 2: JSON string parsed
    assert.equal(result.output.replace_all, undefined)
    assert.deepEqual(result.output.include, ['*.ts', '*.tsx'])
    assert.equal(result.telemetry.length, 1) // fourHorsemen applied
    assert.equal(result.telemetry[0]!.fixType, 'fourHorsemen')
  })

  it('applies semantic repair for autolink in tool input', () => {
    const input = {
      file_path: '[README.md](http://README.md)',
      old_string: 'old',
      new_string: 'new',
    }
    const result = pipeline.run(input, {
      toolName: 'edit_file',
      schema: {
        type: 'object' as const,
        properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
        required: ['file_path', 'old_string', 'new_string'],
      },
    })

    assert.equal(result.output.file_path, 'README.md')
    assert.equal(result.telemetry.length, 1)
    assert.equal(result.telemetry[0]!.fixType, 'autoLink')
  })

  it('returns empty telemetry for clean input', () => {
    const input = { pattern: 'TODO', include: ['*.ts'] }
    const result = pipeline.run(input, { toolName: 'grep', schema: grepSchema })
    assert.equal(result.telemetry.length, 0)
    assert.deepEqual(result.output, input)
  })
})

describe('schema gate integration', () => {
  it('validates required fields before execution', () => {
    const missing = validateRequiredFields({ file_path: '/a.ts' }, ['file_path', 'old_string', 'new_string'])
    assert.deepEqual(missing, ['old_string', 'new_string'])
  })

  it('passes when all required fields present', () => {
    const missing = validateRequiredFields({ command: 'ls', cwd: '/tmp' }, ['command'])
    assert.deepEqual(missing, [])
  })
})

describe('adaptive repair hint integration', () => {
  it('triggers hint after 2 consecutive same-type failures', () => {
    const tracker = new RepairHintTracker()
    tracker.recordFailure('edit_file', 'type_error')
    assert.equal(tracker.getHint(), null)

    tracker.recordFailure('edit_file', 'type_error')
    const hint = tracker.getHint()
    assert.ok(hint)
    assert.ok(hint.includes('edit_file'))
    assert.ok(hint.includes('types'))
  })

  it('clears hint on success', () => {
    const tracker = new RepairHintTracker()
    tracker.recordFailure('bash', 'timeout')
    tracker.recordFailure('bash', 'timeout')
    assert.ok(tracker.getHint())

    tracker.recordSuccess('bash')
    assert.equal(tracker.getHint(), null)
  })

  it('stops hinting after exhaustion (4 failures)', () => {
    const tracker = new RepairHintTracker()
    for (let i = 0; i < 4; i++) tracker.recordFailure('bash', 'timeout')
    assert.equal(tracker.getHint(), null)
  })

  it('uses failure-classifier categories', () => {
    const tracker = new RepairHintTracker()
    tracker.recordFailure('edit_file', 'assertion')
    tracker.recordFailure('edit_file', 'assertion')
    const hint = tracker.getHint()
    assert.ok(hint)
    assert.ok(hint.includes('assertion') || hint.includes('Verify'))
  })
})
