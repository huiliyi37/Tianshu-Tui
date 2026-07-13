import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
  resolveNpmCliCommand,
  buildStdioEnvWithNodePath,
} from '../resolve-node-cli.js'

describe('resolveNpmCliCommand', () => {
  it('rewrites bare npx to node + npx-cli.js on win32 layout', () => {
    const execPath = 'C:\\app\\node-runtime\\win-x64\\node.exe'
    const cli = 'C:\\app\\node-runtime\\win-x64\\node_modules\\npm\\bin\\npx-cli.js'
    const r = resolveNpmCliCommand('npx', ['-y', '@pkg/mcp'], {
      execPath,
      platform: 'win32',
      existsSync: (p) => p === cli,
    })
    assert.equal(r.command, execPath)
    assert.deepEqual(r.args, [cli, '-y', '@pkg/mcp'])
  })

  it('rewrites npx.cmd the same way', () => {
    const execPath = 'C:\\app\\node.exe'
    const cli = 'C:\\app\\node_modules\\npm\\bin\\npx-cli.js'
    const r = resolveNpmCliCommand('npx.cmd', ['-y', 'x'], {
      execPath,
      platform: 'win32',
      existsSync: (p) => p === cli,
    })
    assert.equal(r.command, execPath)
    assert.equal(r.args[0], cli)
  })

  it('rewrites npm on unix lib/ layout', () => {
    const execPath = '/opt/node/bin/node'
    const cli = '/opt/node/lib/node_modules/npm/bin/npm-cli.js'
    const r = resolveNpmCliCommand('npm', ['install'], {
      execPath,
      platform: 'darwin',
      existsSync: (p) => p === cli,
    })
    assert.equal(r.command, execPath)
    assert.deepEqual(r.args, [cli, 'install'])
  })

  it('passes through unknown commands', () => {
    const r = resolveNpmCliCommand('python', ['-m', 'server'], {
      existsSync: () => true,
    })
    assert.equal(r.command, 'python')
    assert.deepEqual(r.args, ['-m', 'server'])
  })

  it('passes through npx when cli.js is missing', () => {
    const r = resolveNpmCliCommand('npx', ['-y', 'x'], {
      execPath: '/usr/bin/node',
      platform: 'linux',
      existsSync: () => false,
    })
    assert.equal(r.command, 'npx')
    assert.deepEqual(r.args, ['-y', 'x'])
  })
})

describe('buildStdioEnvWithNodePath', () => {
  it('always prepends nodeDir and keeps user PATH after it', () => {
    const env = buildStdioEnvWithNodePath(
      { PATH: '/usr/bin', TOKEN: 'secret' },
      {
        execPath: '/opt/node/bin/node',
        platform: 'linux',
        getDefaultEnvironment: () => ({ PATH: '/default', HOME: '/home/u' }),
      },
    )
    assert.equal(env.TOKEN, 'secret')
    assert.equal(env.HOME, '/home/u')
    assert.equal(env.PATH, '/opt/node/bin:/usr/bin')
  })

  it('user PATH cannot displace nodeDir (written last)', () => {
    const env = buildStdioEnvWithNodePath(
      { PATH: 'C:\\Users\\me' },
      {
        execPath: 'C:\\app\\node.exe',
        platform: 'win32',
        getDefaultEnvironment: () => ({ PATH: 'C:\\Windows' }),
      },
    )
    assert.ok(env.PATH.startsWith(`C:\\app;`))
    assert.ok(env.PATH.includes('C:\\Users\\me'))
  })

  it('works when cfg.env is omitted', () => {
    const env = buildStdioEnvWithNodePath(undefined, {
      execPath: join('/opt', 'node', 'bin', 'node'),
      platform: 'darwin',
      getDefaultEnvironment: () => ({ PATH: '/usr/bin' }),
    })
    assert.ok(env.PATH.startsWith(join('/opt', 'node', 'bin') + ':'))
  })
})
