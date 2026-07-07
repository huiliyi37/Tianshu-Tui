import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveHostEnv,
  applyConfigEnv,
  parseRegQuery,
  parseEnvDump,
  type ResolvedEnvDeps,
} from '../resolved-env.js'
import type { EnvConfig } from '../../config/schema.js'

const noEnvConfig: EnvConfig = { resolve: true, extraPath: [], extraVars: {} }

function winDeps(overrides: Partial<ResolvedEnvDeps> = {}): ResolvedEnvDeps {
  return {
    platform: 'win32',
    baseEnv: { Path: 'C:\\Windows;C:\\Windows\\System32' },
    readRegistryEnv: () => ({}),
    dumpLoginShellEnv: () => '',
    exists: () => false,
    ...overrides,
  }
}

function unixDeps(overrides: Partial<ResolvedEnvDeps> = {}): ResolvedEnvDeps {
  return {
    platform: 'linux',
    baseEnv: { PATH: '/usr/bin:/bin' },
    readRegistryEnv: () => ({}),
    dumpLoginShellEnv: () => '',
    exists: () => false,
    ...overrides,
  }
}

describe('parseRegQuery', () => {
  it('parses REG_SZ / REG_EXPAND_SZ key=value lines', () => {
    const out = parseRegQuery([
      '',
      'HKEY_LOCAL_MACHINE\\...\\Environment',
      '    Path    REG_EXPAND_SZ    C:\\Windows;C:\\Program Files\\Git\\cmd',
      '    JAVA_HOME    REG_SZ    C:\\jdk',
      '',
    ].join('\r\n'))
    assert.equal(out.Path, 'C:\\Windows;C:\\Program Files\\Git\\cmd')
    assert.equal(out.JAVA_HOME, 'C:\\jdk')
  })
})

describe('parseEnvDump', () => {
  it('parses KEY=VALUE lines and ignores noise', () => {
    const out = parseEnvDump('PATH=/usr/local/bin:/usr/bin\nJAVA_HOME=/opt/jdk\n# comment\nnot a var line\n')
    assert.equal(out.PATH, '/usr/local/bin:/usr/bin')
    assert.equal(out.JAVA_HOME, '/opt/jdk')
    assert.equal(out['# comment'], undefined)
  })
})

describe('resolveHostEnv — Windows', () => {
  it('merges Machine+User registry PATH (base first, dedup case-insensitive)', () => {
    const deps = winDeps({
      readRegistryEnv: (scope) => scope === 'machine'
        ? { Path: 'C:\\Windows;C:\\Program Files\\Git\\cmd' }
        : { Path: 'C:\\Users\\me\\bin' },
    })
    const res = resolveHostEnv(deps)
    const entries = res.path.split(';')
    assert.equal(res.pathKey, 'Path')
    // base entries come first
    assert.equal(entries[0], 'C:\\Windows')
    assert.equal(entries[1], 'C:\\Windows\\System32')
    // registry additions appended, C:\Windows not duplicated
    assert.ok(entries.includes('C:\\Program Files\\Git\\cmd'))
    assert.ok(entries.includes('C:\\Users\\me\\bin'))
    assert.equal(entries.filter(e => e === 'C:\\Windows').length, 1)
  })

  it('recovers missing toolchain vars and appends their bin dirs when they exist', () => {
    const deps = winDeps({
      readRegistryEnv: (scope): Record<string, string> => scope === 'machine'
        ? { JAVA_HOME: 'C:\\jdk' }
        : { MAVEN_HOME: 'C:\\maven' },
      exists: (p) => p === 'C:\\jdk\\bin' || p === 'C:\\maven\\bin',
    })
    const res = resolveHostEnv(deps)
    assert.equal(res.vars.JAVA_HOME, 'C:\\jdk')
    assert.equal(res.vars.MAVEN_HOME, 'C:\\maven')
    const entries = res.path.split(';')
    assert.ok(entries.includes('C:\\jdk\\bin'))
    assert.ok(entries.includes('C:\\maven\\bin'))
  })

  it('does not override a toolchain var already present in baseEnv', () => {
    const deps = winDeps({
      baseEnv: { Path: 'C:\\Windows', JAVA_HOME: 'C:\\existing-jdk' },
      readRegistryEnv: () => ({ JAVA_HOME: 'C:\\reg-jdk' }),
    })
    const res = resolveHostEnv(deps)
    assert.equal(res.vars.JAVA_HOME, undefined, 'should not shadow existing base var')
  })

  it('derives bin dir from a pre-existing base toolchain var', () => {
    const deps = winDeps({
      baseEnv: { Path: 'C:\\Windows', JAVA_HOME: 'C:\\jdk' },
      exists: (p) => p === 'C:\\jdk\\bin',
    })
    const res = resolveHostEnv(deps)
    assert.ok(res.path.split(';').includes('C:\\jdk\\bin'))
  })

  it('expands %VAR% in registry values', () => {
    const deps = winDeps({
      baseEnv: { Path: 'C:\\Windows', SystemRoot: 'C:\\Windows' },
      readRegistryEnv: (scope): Record<string, string> => scope === 'machine'
        ? { Path: '%SystemRoot%\\System32\\Wbem' }
        : {},
    })
    const res = resolveHostEnv(deps)
    assert.ok(res.path.split(';').includes('C:\\Windows\\System32\\Wbem'))
  })
})

describe('resolveHostEnv — Unix', () => {
  it('dumps login shell env only when PATH looks short, merges PATH + vars', () => {
    let dumped = 0
    const deps = unixDeps({
      dumpLoginShellEnv: () => { dumped++; return 'PATH=/usr/local/bin:/usr/bin:/opt/maven/bin\nJAVA_HOME=/opt/jdk\n' },
      exists: (p) => p === '/opt/jdk/bin',
    })
    const res = resolveHostEnv(deps)
    assert.equal(dumped, 1)
    const entries = res.path.split(':')
    assert.ok(entries.includes('/usr/local/bin'))
    assert.ok(entries.includes('/opt/maven/bin'))
    assert.equal(res.vars.JAVA_HOME, '/opt/jdk')
    assert.ok(entries.includes('/opt/jdk/bin'))
  })

  it('skips the login-shell dump when PATH already looks complete', () => {
    let dumped = 0
    const deps = unixDeps({
      baseEnv: { PATH: '/usr/local/bin:/usr/bin:/bin' },
      dumpLoginShellEnv: () => { dumped++; return 'PATH=/should/not/be/used' },
    })
    const res = resolveHostEnv(deps)
    assert.equal(dumped, 0)
    assert.ok(!res.path.includes('/should/not/be/used'))
  })

  it('falls back to appending common dirs when the shell dump fails', () => {
    const deps = unixDeps({
      dumpLoginShellEnv: () => '',
      exists: (p) => p === '/usr/local/bin' || p === '/opt/homebrew/bin',
    })
    const res = resolveHostEnv(deps)
    const entries = res.path.split(':')
    assert.ok(entries.includes('/usr/local/bin'))
    assert.ok(entries.includes('/opt/homebrew/bin'))
  })
})

describe('applyConfigEnv', () => {
  it('appends extraPath (dedup) and applies extraVars at highest priority', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', FOO: 'base' }
    const config: EnvConfig = {
      resolve: true,
      extraPath: ['/opt/tools/bin', '/usr/bin'],
      extraVars: { FOO: 'override', BAR: 'new' },
    }
    const out = applyConfigEnv(base, config, 'linux')
    const entries = (out.PATH ?? '').split(':')
    assert.ok(entries.includes('/opt/tools/bin'))
    // /usr/bin already present → not duplicated
    assert.equal(entries.filter(e => e === '/usr/bin').length, 1)
    assert.equal(out.FOO, 'override')
    assert.equal(out.BAR, 'new')
  })

  it('is a no-op on PATH when extraPath is empty', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' }
    const out = applyConfigEnv(base, noEnvConfig, 'linux')
    assert.equal(out.PATH, '/usr/bin')
  })

  it('appends to the Windows Path key case-insensitively', () => {
    const base: NodeJS.ProcessEnv = { Path: 'C:\\Windows' }
    const config: EnvConfig = { resolve: true, extraPath: ['C:\\tools'], extraVars: {} }
    const out = applyConfigEnv(base, config, 'win32')
    assert.equal(out.Path, 'C:\\Windows;C:\\tools')
    assert.equal(out.PATH, undefined, 'should not introduce a duplicate PATH key')
  })
})
