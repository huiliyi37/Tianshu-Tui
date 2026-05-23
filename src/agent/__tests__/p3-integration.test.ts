import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { P3Integration } from '../p3-integration.js'

describe('P3Integration', () => {
  it('creates all subsystems', () => {
    const p3 = new P3Integration()
    assert.ok(p3.miner)
    assert.ok(p3.queue)
    assert.ok(p3.idleSpec)
    assert.ok(p3.notebook)
  })

  it('records tool patterns and enables speculation', () => {
    const p3 = new P3Integration()
    // Repeat pattern to build strong signal: grep → read_file
    for (let i = 0; i < 3; i++) {
      p3.onToolStart('grep')
      p3.onToolComplete('grep', 'src/foo.ts', false)
      p3.onToolStart('read_file')
      p3.onToolComplete('read_file', 'src/foo.ts', false)
    }
    const predictions = p3.miner.predict('grep')
    assert.ok(predictions.length > 0)
    const readFilePred = predictions.find(p => p.tool === 'read_file')
    assert.ok(readFilePred, 'should predict read_file after grep')
  })

  it('records and retrieves mistakes', () => {
    const p3 = new P3Integration()
    p3.recordMistake(
      'Cannot find module ./foo.js',
      'edit_file src/bar.ts',
      'Add .js extension to ESM imports',
      ['esm', 'typescript'],
    )
    const hints = p3.getMistakeHints('Cannot find module ./baz.js', 'edit_file src/qux.ts')
    assert.ok(hints.includes('mistake-hints'))
    assert.ok(hints.includes('.js extension'))
  })

  it('returns empty hints for unrelated errors', () => {
    const p3 = new P3Integration()
    p3.recordMistake('Cannot find module', 'edit_file', 'fix import', ['esm'])
    const hints = p3.getMistakeHints('ECONNREFUSED', 'bash curl')
    assert.equal(hints, '')
  })

  it('assesses trajectory health', () => {
    const p3 = new P3Integration()
    const signal = p3.assessHealth(
      [
        { status: 'failed', turn: 1 },
        { status: 'failed', turn: 2 },
        { status: 'failed', turn: 3 },
      ],
      4,
      'flash',
    )
    assert.equal(signal, 'escalate')
  })

  it('applies agent diet to messages', () => {
    const p3 = new P3Integration()
    const messages = [
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
      { role: 'tool' as const, content: 'file content A', tool_call_id: 'tc1' },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'tool' as const, content: 'file content B', tool_call_id: 'tc2' },
      { role: 'assistant' as const, content: 'done' },
      { role: 'tool' as const, content: 'result', tool_call_id: 'tc3' },
      { role: 'assistant' as const, content: 'final' },
    ]
    const result = p3.dietMessages(messages)
    assert.ok(result.removedCount >= 0)
  })
})
