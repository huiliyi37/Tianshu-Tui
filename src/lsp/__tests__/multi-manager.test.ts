import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMultiLspManager, type MultiLspOptions } from '../multi-manager.js'
import { resolveNpmCliCommand } from '../../platform/resolve-node-cli.js'
import type { ChildProcess } from 'node:child_process'

function mockChild(): ChildProcess {
  return { kill: () => true, on: () => {}, pid: 0 } as unknown as ChildProcess
}

describe('createMultiLspManager spawnFor wiring', () => {
  it('rewrites npx command to node + npx-cli.js via injected spawnFor', () => {
    // Inject spawnFor that mirrors the default's rewriting logic, then
    // verify via gotoDefinition which triggers ensure → spawnFor synchronously.
    const captured: Array<{ command: string; args: string[] }> = []

    const opts: MultiLspOptions = {
      which: () => true,
      spawnFor: (def: LspServerDef) => {
        const resolved = resolveNpmCliCommand(def.command, def.args ?? [])
        captured.push({ command: resolved.command, args: resolved.args })
        return mockChild()
      },
    }

    const mgr = createMultiLspManager('/tmp', opts)
    assert.ok(mgr.isReady())

    // gotoDefinition → ensure() → spawnFor() is called synchronously
    // (before the first await inside ensure), so captured is populated
    // immediately after the call returns.
    void mgr.gotoDefinition('test.ts', 1, 0)

    assert.equal(captured.length, 1, 'spawnFor should have been called once')
    const call = captured[0]!
    assert.equal(call.command, process.execPath, 'npx should resolve to node binary')
    assert.ok(call.args[0]!.includes('npx-cli.js'), `args[0] should be npx-cli.js, got ${call.args[0]}`)
  })

  it('passes through non-npx commands unchanged', () => {
    const captured: Array<{ command: string; args: string[] }> = []

    const opts: MultiLspOptions = {
      which: () => true,
      spawnFor: (def: LspServerDef) => {
        const resolved = resolveNpmCliCommand(def.command, def.args ?? [])
        captured.push({ command: resolved.command, args: resolved.args })
        return mockChild()
      },
    }

    const mgr = createMultiLspManager('/tmp', opts)
    assert.ok(mgr.isReady())

    void mgr.gotoDefinition('main.go', 1, 0)

    assert.equal(captured.length, 1)
    const call = captured[0]!
    assert.equal(call.command, 'gopls', 'non-npx command should pass through unchanged')
    assert.deepEqual(call.args, [])
  })
})
