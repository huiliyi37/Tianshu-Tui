import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { wrapSandboxCommand } from '../bash.js'

describe('bash sandbox (wrapper)', () => {
  it('passes through unchanged by default (sandbox OFF)', () => {
    const result = wrapSandboxCommand('echo hi')
    assert.equal(result.command, 'echo hi')
    assert.equal(result.sandboxed, false)
  })

  it('preserves the original command inside the wrap', () => {
    // Default: sandbox OFF — command passes through unchanged
    const result = wrapSandboxCommand('echo hi', process.cwd())
    assert.ok(result.command.includes('echo hi'))
    assert.equal(result.sandboxed, false)
  })
})
