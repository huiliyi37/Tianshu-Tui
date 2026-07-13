import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { win32 as winPath } from 'node:path'
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
  it('rewrites npx against desktop bundled node-runtime layout (win-x64)', () => {
    // Simulate fetch-node-runtime Windows layout — NOT the host Homebrew Node:
    //   resources/node-runtime/win-x64/node.exe
    //   resources/node-runtime/win-x64/node_modules/npm/bin/npx-cli.js
    const execPath = 'C:\\App\\resources\\node-runtime\\win-x64\\node.exe'
    const cli = winPath.join(
      'C:\\App\\resources\\node-runtime\\win-x64',
      'node_modules', 'npm', 'bin', 'npx-cli.js',
    )

    const captured: Array<{ command: string; args: string[]; env?: Record<string, string> }> = []
    const spawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
      captured.push({
        command: cmd,
        args,
        env: opts.env as Record<string, string> | undefined,
      })
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

    defaultLspSpawn(npxDef, 'C:\\proj', spawnFn, {
      execPath,
      platform: 'win32',
      existsSync: (p) => p === cli,
    })

    assert.equal(captured.length, 1, 'spawnFn should be called once')
    // Deleting resolveNpmCliCommand from defaultLspSpawn → command stays 'npx' → RED.
    assert.equal(captured[0]!.command, execPath, 'command should be bundled node.exe, not bare npx')
    assert.equal(captured[0]!.args[0], cli)
    assert.deepEqual(captured[0]!.args.slice(1), ['-y', 'typescript-language-server', '--stdio'])
    assert.ok(
      captured[0]!.env?.PATH?.startsWith('C:\\App\\resources\\node-runtime\\win-x64;'),
      `PATH should prepend bundled nodeDir, got ${captured[0]!.env?.PATH}`,
    )
  })
})
