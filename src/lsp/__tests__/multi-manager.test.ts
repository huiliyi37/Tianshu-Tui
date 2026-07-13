import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createMultiLspManager, defaultLspSpawn, type MultiLspOptions } from '../multi-manager.js'
import type { LspServerDef } from '../server-registry.js'
import type { ChildProcess } from 'node:child_process'

function mockChild(): ChildProcess {
  return { kill: () => true, on: () => {}, pid: 0 } as unknown as ChildProcess
}

describe('createMultiLspManager spawnFor wiring', () => {
  it('routes npx def to spawnFor for .ts files', () => {
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

describe('defaultLspSpawn', () => {
  it('rewrites npx to node + npx-cli.js via resolveNpmCliCommand', () => {
    const captured: Array<{ command: string; args: string[] }> = []
    const spawnFn = (cmd: string, args: string[]) => {
      captured.push({ command: cmd, args })
      return mockChild()
    }

    const npxDef: LspServerDef = {
      id: 'test-npx',
      extensions: ['.ts'],
      command: 'npx',
      args: ['-y', 'typescript-language-server', '--stdio'],
      languageId: 'typescript',
      alwaysAvailable: true,
    }

    defaultLspSpawn(npxDef, '/tmp', spawnFn as (cmd: string, args: string[], opts: Record<string, unknown>) => ChildProcess)

    assert.equal(captured.length, 1, 'spawnFn should be called once')
    // If someone removes resolveNpmCliCommand from defaultLspSpawn,
    // command will be 'npx' instead of process.execPath → test goes RED.
    assert.equal(captured[0]!.command, process.execPath, 'command should be node binary, not npx')
    assert.ok(captured[0]!.args[0]!.includes('npx-cli.js'), `args[0] should be npx-cli.js, got ${captured[0]!.args[0]}`)
  })
})
