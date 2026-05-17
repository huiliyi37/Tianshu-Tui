import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BASH_TOOL } from '../bash.js'

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

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
