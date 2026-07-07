import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { ctclSanitizerPass } from '../ctcl-sanitizer.js'
import type { RepairContext } from '../repair-pipeline.js'

function ctxFor(name: string, schema: Record<string, unknown>): RepairContext {
  return {
    toolName: name,
    schema: schema as RepairContext['schema'],
  }
}

describe('ctclSanitizerPass', () => {
  // ── Key alias mapping ──

  it('maps path → file_path for file tools', () => {
    const schema = {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
      required: ['file_path'],
    }
    const result = ctclSanitizerPass.run(
      { path: '/tmp/test.ts', content: 'hello' },
      ctxFor('write_file', schema),
    )
    assert.equal(result.applied, true)
    assert.equal(result.output.file_path, '/tmp/test.ts')
    assert.equal(result.output.path, undefined)
    assert.equal(result.output.content, 'hello')
  })

  it('maps cmd → command for bash', () => {
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    }
    const result = ctclSanitizerPass.run(
      { cmd: 'ls -la' },
      ctxFor('bash', schema),
    )
    assert.equal(result.applied, true)
    assert.equal(result.output.command, 'ls -la')
    assert.equal(result.output.cmd, undefined)
  })

  it('maps search → pattern for grep', () => {
    const schema = {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
      },
      required: ['pattern'],
    }
    const result = ctclSanitizerPass.run(
      { search: 'import.*from', path: 'src/' },
      ctxFor('grep', schema),
    )
    assert.equal(result.applied, true)
    assert.equal(result.output.pattern, 'import.*from')
    assert.equal(result.output.search, undefined)
    // path → file_path alias only applies to file_path key; 'path' is valid for grep
    assert.equal(result.output.path, 'src/')
  })

  it('does not overwrite existing canonical key', () => {
    const schema = {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
      },
    }
    const result = ctclSanitizerPass.run(
      { file_path: '/tmp/orig.ts', path: '/tmp/alias.ts' },
      ctxFor('read_file', schema),
    )
    assert.equal(result.applied, false)
    assert.equal(result.output.file_path, '/tmp/orig.ts')
  })

  it('does not remap to keys not in schema', () => {
    const schema = {
      type: 'object',
      properties: { content: { type: 'string' } },
    }
    // file_path is not in schema, so path → file_path should NOT happen
    const result = ctclSanitizerPass.run(
      { path: '/tmp/test.ts', content: 'hello' },
      ctxFor('unknown_tool', schema),
    )
    assert.equal(result.output.path, '/tmp/test.ts')
    assert.equal(result.output.file_path, undefined)
  })

  it('maps oldString → old_string for edit_file', () => {
    const schema = {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    }
    const result = ctclSanitizerPass.run(
      { file_path: '/tmp/e.ts', oldString: 'hello', newString: 'world' },
      ctxFor('edit_file', schema),
    )
    assert.equal(result.applied, true)
    assert.equal(result.output.old_string, 'hello')
    assert.equal(result.output.new_string, 'world')
    assert.equal(result.output.oldString, undefined)
    assert.equal(result.output.newString, undefined)
  })

  // ── Nested command unwrap ──

  it('unwraps nested command object for bash', () => {
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    }
    const result = ctclSanitizerPass.run(
      { command: { command: 'npx tsc --noEmit' } },
      ctxFor('bash', schema),
    )
    assert.equal(result.applied, true)
    assert.equal(result.output.command, 'npx tsc --noEmit')
  })

  it('does not unwrap for non-bash tools', () => {
    const schema = {
      type: 'object',
      properties: { content: { type: 'string' } },
    }
    const result = ctclSanitizerPass.run(
      { content: { command: 'ls' } },
      ctxFor('write_file', schema),
    )
    assert.equal(result.applied, false)
    assert.deepEqual(result.output.content, { command: 'ls' })
  })

  it('does not unwrap command when it is already a string', () => {
    const schema = {
      type: 'object',
      properties: { command: { type: 'string' } },
    }
    const result = ctclSanitizerPass.run(
      { command: 'ls -la' },
      ctxFor('bash', schema),
    )
    assert.equal(result.applied, false)
    assert.equal(result.output.command, 'ls -la')
  })

  // ── Path normalization ──

  it('strips leading ./ from file paths', () => {
    const schema = {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
    }
    const result = ctclSanitizerPass.run(
      { file_path: './src/main.ts', content: 'x' },
      ctxFor('read_file', schema),
    )
    assert.equal(result.applied, true)
    assert.equal(result.output.file_path, 'src/main.ts')
  })

  it('leaves just ./ unchanged', () => {
    const schema = {
      type: 'object',
      properties: { file_path: { type: 'string' } },
    }
    const result = ctclSanitizerPass.run(
      { file_path: './' },
      ctxFor('read_file', schema),
    )
    assert.equal(result.applied, false)
    assert.equal(result.output.file_path, './')
  })

  // ── Type coercion ──

  it('coerces string "true"/"false" to boolean', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
    }
    const result = ctclSanitizerPass.run(
      { name: 'test', replace_all: 'true' },
      ctxFor('edit_file', schema),
    )
    assert.equal(result.applied, true)
    assert.equal(result.output.replace_all, true)
  })

  it('coerces numeric string to number for integer params', () => {
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'integer' },
      },
    }
    const result = ctclSanitizerPass.run(
      { command: 'ls', timeout: '5000' },
      ctxFor('bash', schema),
    )
    assert.equal(result.applied, true)
    assert.equal(result.output.timeout, 5000)
  })

  it('does not coerce non-numeric strings to number', () => {
    const schema = {
      type: 'object',
      properties: { max_tokens: { type: 'integer' } },
    }
    const result = ctclSanitizerPass.run(
      { max_tokens: 'auto' },
      ctxFor('unknown', schema),
    )
    assert.equal(result.output.max_tokens, 'auto')
  })

  // ── Combined fixes ──

  it('applies multiple fix categories in one pass', () => {
    const schema = {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        new_string: { type: 'string' },
        old_string: { type: 'string' },
        replace_all: { type: 'boolean' },
      },
      required: ['file_path', 'old_string', 'new_string'],
    }
    const result = ctclSanitizerPass.run(
      {
        path: './src/app.ts',
        oldString: 'hello',
        newString: 'world',
        replaceAll: 'true',
      },
      ctxFor('edit_file', schema),
    )
    assert.equal(result.applied, true)
    assert.equal(result.output.file_path, 'src/app.ts')
    assert.equal(result.output.old_string, 'hello')
    assert.equal(result.output.new_string, 'world')
    assert.equal(result.output.replace_all, true)
    assert.equal(result.output.path, undefined)
    assert.equal(result.output.oldString, undefined)
    assert.equal(result.output.newString, undefined)
    assert.equal(result.output.replaceAll, undefined)
  })

  it('returns applied=false when no fixes needed', () => {
    const schema = {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
        content: { type: 'string' },
      },
    }
    const result = ctclSanitizerPass.run(
      { file_path: '/abs/path.ts', content: 'valid' },
      ctxFor('write_file', schema),
    )
    assert.equal(result.applied, false)
    assert.deepEqual(result.output, { file_path: '/abs/path.ts', content: 'valid' })
  })
})
