import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RepairPipeline } from '../repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass } from '../repair-passes.js'
import { validateRequiredFields } from '../repair-pipeline.js'

describe('CTCL parity — full pipeline', () => {
  const pipeline = new RepairPipeline([fourHorsemenPass, semanticRepairPass])
  const bashSchema = {
    type: 'object' as const,
    properties: { command: { type: 'string' }, timeout: { type: 'number' }, args: { type: 'array', items: { type: 'string' } } },
    required: ['command'],
  }

  it('null optional → omit', () => {
    const { output, telemetry } = pipeline.run({ command: 'ls', timeout: null }, { toolName: 'bash', schema: bashSchema })
    assert.equal(output.command, 'ls')
    assert.equal('timeout' in output, false)
    assert.ok(telemetry.length > 0)
  })

  it('JSON array string → array', () => {
    const { output } = pipeline.run({ command: 'ls', args: '["-la","-h"]' }, { toolName: 'bash', schema: bashSchema })
    assert.deepEqual(output.args, ['-la', '-h'])
  })

  it('bare string → array', () => {
    const { output } = pipeline.run({ command: 'ls', args: '-la' }, { toolName: 'bash', schema: bashSchema })
    assert.deepEqual(output.args, ['-la'])
  })

  it('autolink in path field gets cleaned', () => {
    const editSchema = {
      type: 'object' as const,
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['file_path', 'old_string', 'new_string'],
    }
    const { output } = pipeline.run(
      { file_path: '[notes.md](http://notes.md)', old_string: 'x', new_string: 'y' },
      { toolName: 'edit_file', schema: editSchema },
    )
    assert.equal(output.file_path, 'notes.md')
  })

  it('no fix on valid input', () => {
    const { output, telemetry } = pipeline.run({ command: 'ls', args: ['-la'] }, { toolName: 'bash', schema: bashSchema })
    assert.deepEqual(output.args, ['-la'])
    assert.equal(telemetry.length, 0)
  })

  it('schema gate catches missing required fields', () => {
    const missing = validateRequiredFields({}, ['command'])
    assert.deepEqual(missing, ['command'])
  })

  it('schema gate passes valid input', () => {
    const missing = validateRequiredFields({ command: 'pwd' }, ['command'])
    assert.deepEqual(missing, [])
  })

  it('combined: null optional + autolink in same input', () => {
    const editSchema = {
      type: 'object' as const,
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
      required: ['file_path', 'old_string', 'new_string'],
    }
    const { output, telemetry } = pipeline.run(
      { file_path: '[src/main.ts](http://src/main.ts)', old_string: 'x', new_string: 'y', replace_all: null },
      { toolName: 'edit_file', schema: editSchema },
    )
    assert.equal(output.file_path, 'src/main.ts')
    assert.equal('replace_all' in output, false)
    assert.equal(telemetry.length, 2)
  })
})
