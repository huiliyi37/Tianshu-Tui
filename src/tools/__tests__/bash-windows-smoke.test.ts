import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BASH_TOOL } from '../bash.js'
import { getShellCommand } from '../../platform.js'
import type { ToolCallParams } from '../types.js'

/**
 * Real-execution smoke test for the Windows command path. This is the ONLY
 * coverage that exercises the actual shell pick (Git Bash on the windows-latest
 * runner) end-to-end: spawn → stdio pipe → output capture → file side effects.
 * It guards against the "exit=0, empty stdout, no file written" silent failure.
 *
 * Skipped off Windows (the host shell there is `sh`, a different path covered by
 * bash.test.ts). The matching CI job runs this on windows-latest.
 */
const winOnly = { skip: process.platform !== 'win32' }

function makeParams(command: string, cwd: string): ToolCallParams {
  return { input: { command }, toolUseId: `smoke-${Math.random().toString(36).slice(2)}`, cwd }
}

describe('Windows bash smoke (real execution)', winOnly, () => {
  it('selects Git Bash on the runner', () => {
    const shell = getShellCommand()
    // windows-latest ships Git for Windows; we expect the Git Bash path.
    assert.equal(shell.kind, 'bash', `expected Git Bash, got kind=${shell.kind} cmd=${shell.cmd}`)
  })

  it('echo produces visible stdout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-smoke-'))
    try {
      const result = await BASH_TOOL.execute(makeParams('echo smoke-hello', dir))
      assert.match(result.content, /smoke-hello/, 'echo stdout must be captured (empty = stdio pipe broken)')
      assert.equal(result.isError, false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('redirect actually writes a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-smoke-'))
    try {
      await BASH_TOOL.execute(makeParams('echo redirect-payload > out.txt', dir))
      const target = join(dir, 'out.txt')
      assert.ok(existsSync(target), 'redirect must create the file (missing = no side effect)')
      assert.match(readFileSync(target, 'utf-8'), /redirect-payload/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('pipe passes data between commands', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-smoke-'))
    try {
      const result = await BASH_TOOL.execute(makeParams('echo pipe-line | grep pipe', dir))
      assert.match(result.content, /pipe-line/, 'pipe output must be captured')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
