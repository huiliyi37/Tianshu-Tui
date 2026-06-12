import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { wrapSandboxCommand } from '../bash.js'

describe('bash sandbox', () => {
  it('passes through when sandbox disabled', () => {
    const prev = process.env.RIVET_BASH_SANDBOX
    delete process.env.RIVET_BASH_SANDBOX
    const result = wrapSandboxCommand('echo hi')
    assert.equal(result.command, 'echo hi')
    assert.equal(result.sandboxed, false)
    if (prev) process.env.RIVET_BASH_SANDBOX = prev
  })

  it('attempts sandbox wrap when enabled', () => {
    const prev = process.env.RIVET_BASH_SANDBOX
    process.env.RIVET_BASH_SANDBOX = '1'
    const result = wrapSandboxCommand('echo hi')
    assert.ok(result.command.includes('echo hi'))
    process.env.RIVET_BASH_SANDBOX = prev
  })
})
