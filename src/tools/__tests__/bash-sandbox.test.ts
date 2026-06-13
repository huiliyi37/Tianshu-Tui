import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { wrapSandboxCommand } from '../bash.js'

describe('bash sandbox (wrapper)', () => {
  it('passes through unchanged when RIVET_NO_SANDBOX=1', () => {
    const prev = process.env.RIVET_NO_SANDBOX
    process.env.RIVET_NO_SANDBOX = '1'
    try {
      const result = wrapSandboxCommand('echo hi')
      assert.equal(result.command, 'echo hi')
      assert.equal(result.sandboxed, false)
    } finally {
      if (prev === undefined) delete process.env.RIVET_NO_SANDBOX
      else process.env.RIVET_NO_SANDBOX = prev
    }
  })

  it('always preserves the original command inside the wrap', () => {
    const prev = process.env.RIVET_NO_SANDBOX
    delete process.env.RIVET_NO_SANDBOX
    try {
      const result = wrapSandboxCommand('echo hi', process.cwd())
      assert.ok(result.command.includes('echo hi'))
    } finally {
      if (prev !== undefined) process.env.RIVET_NO_SANDBOX = prev
    }
  })
})
