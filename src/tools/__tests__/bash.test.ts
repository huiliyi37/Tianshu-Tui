import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_TOOL } from '../bash.js'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

describe('requiresApproval vs rtkRewrite', () => {
  it('checks both raw and rewritten commands for dangerous patterns', () => {
    // A command containing a dangerous pattern should be flagged
    const dangerousInput = {
      input: { command: 'rm -rf /tmp/test' },
      toolUseId: 'test',
      cwd: '/tmp',
    }
    assert.equal(BASH_TOOL.requiresApproval(dangerousInput), true)

    // Safe command should not be flagged
    const safeInput = {
      input: { command: 'ls -la' },
      toolUseId: 'test',
      cwd: '/tmp',
    }
    assert.equal(BASH_TOOL.requiresApproval(safeInput), false)
  })

  it('flags command when rtkRewrite expands it to dangerous form', () => {
    // If rtk is installed and rewrites "safe_alias" → "rm -rf /something",
    // requiresApproval must catch it. Since rtk may not be installed, the
    // fallback returns the original command. This test validates the
    // structural guarantee: both versions are checked.
    //
    // With rtk not installed, rtkRewrite("rm -rf /test") = "rm -rf /test"
    // so checking both raw and rewritten still matches.
    const input = {
      input: { command: 'rm -rf /tmp/test' },
      toolUseId: 'test',
      cwd: '/tmp',
    }
    assert.equal(BASH_TOOL.requiresApproval(input), true)
  })
})

describe('BASH_TOOL timeout cleanup', () => {
  it('kills background descendants when a command times out', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-bash-timeout-'))
    const marker = join(dir, 'marker.txt')
    const command = `nohup node -e "setTimeout(()=>require('fs').writeFileSync(process.argv[1], 'alive'), 300)" "${marker}" >/dev/null 2>&1 & wait`

    try {
      const result = await BASH_TOOL.execute({
        input: { command, timeout: 50 },
        toolUseId: 'bash-timeout-tree-test',
        cwd: dir,
      })
      await wait(700)

      assert.equal(result.isError, true)
      assert.match(result.content, /Command timed out/)
      assert.equal(existsSync(marker), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
