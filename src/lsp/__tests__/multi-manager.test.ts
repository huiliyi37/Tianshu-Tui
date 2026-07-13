import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMultiLspManager, type MultiLspOptions } from '../multi-manager.js'
import type { LspServerDef } from '../server-registry.js'
import type { ChildProcess } from 'node:child_process'

function mockChild(): ChildProcess {
  return { kill: () => true, on: () => {}, pid: 0 } as unknown as ChildProcess
}

describe('createMultiLspManager spawnFor wiring', () => {
  it('routes npx def to spawnFor for .ts files', () => {
    // Inject a capture-only spawnFor. The DEFAULT implementation calls
    // resolveNpmCliCommand + buildStdioEnvWithNodePath; those are tested in
    // resolve-node-cli.test.ts. Here we verify the wiring layer: that the
    // framework passes the correct def (command='npx', args with -y) to
    // spawnFor when gotoDefinition targets a .ts file.
    const captured: Array<{ command: string; args: string[] }> = []

    const opts: MultiLspOptions = {
      which: () => true,
      spawnFor: (def: LspServerDef) => {
        captured.push({ command: def.command, args: def.args ?? [] })
        return mockChild()
      },
    }

    const mgr = createMultiLspManager('/tmp', opts)
    void mgr.gotoDefinition('test.ts', 1, 0)

    assert.equal(captured.length, 1, 'spawnFor should be called once')
    assert.equal(captured[0]!.command, 'npx', 'TS LSP def command should be npx')
    assert.ok(captured[0]!.args.includes('-y'), 'args should include -y')
  })

  it('routes non-npx def to spawnFor for .go files', () => {
    const captured: Array<{ command: string; args: string[] }> = []

    const opts: MultiLspOptions = {
      which: () => true,
      spawnFor: (def: LspServerDef) => {
        captured.push({ command: def.command, args: def.args ?? [] })
        return mockChild()
      },
    }

    const mgr = createMultiLspManager('/tmp', opts)
    void mgr.gotoDefinition('main.go', 1, 0)

    assert.equal(captured.length, 1)
    assert.equal(captured[0]!.command, 'gopls', 'gopls def command should pass through')
    assert.deepEqual(captured[0]!.args, [])
  })
})
