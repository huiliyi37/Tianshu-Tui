import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildSeatbeltProfile,
  buildSeatbeltCommand,
  buildBwrapCommand,
  buildFirejailCommand,
  defaultWritableRoots,
  detectWsl,
  selectSandboxBackend,
  wrapSandboxCommand,
  shSingleQuote,
  getSandboxStartupNotice,
  maybeWarnNoSandbox,
  _resetSandboxWarningLatch,
} from '../sandbox-profile.js'
import { grantPath, _resetGrantsForTest } from '../path-grants.js'
import { mkdtempSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('sandbox-profile: shSingleQuote', () => {
  it('wraps in single quotes', () => {
    assert.equal(shSingleQuote('echo hi'), `'echo hi'`)
  })
  it('escapes embedded single quotes', () => {
    assert.equal(shSingleQuote(`it's`), `'it'\\''s'`)
  })
})

describe('sandbox-profile: defaultWritableRoots', () => {
  it('always includes cwd and a temp dir', () => {
    const roots = defaultWritableRoots({ cwd: '/work/proj', env: { HOME: '/home/u', TMPDIR: '/tmp/x' } })
    assert.ok(roots.includes('/work/proj'))
    assert.ok(roots.includes('/tmp/x'))
  })
  it('includes package caches under HOME', () => {
    const roots = defaultWritableRoots({ cwd: '/w', env: { HOME: '/home/u' } })
    assert.ok(roots.includes('/home/u/.npm'))
    assert.ok(roots.includes('/home/u/.cargo'))
  })
  it('honors RIVET_SANDBOX_WRITABLE extra roots', () => {
    const roots = defaultWritableRoots({ cwd: '/w', env: { HOME: '/home/u', RIVET_SANDBOX_WRITABLE: '/data:/scratch' } })
    assert.ok(roots.includes('/data'))
    assert.ok(roots.includes('/scratch'))
  })
  it('includes user-approved WRITE grants, excludes read-only grants', () => {
    _resetGrantsForTest()
    const wdir = mkdtempSync(join(tmpdir(), 'rivet-w-'))
    const rdir = mkdtempSync(join(tmpdir(), 'rivet-r-'))
    try {
      grantPath(wdir, 'write')
      grantPath(rdir, 'read')
      const roots = defaultWritableRoots({ cwd: '/w', env: { HOME: '/home/u' } })
      const canonicalW = realpathSync(wdir)
      const canonicalR = realpathSync(rdir)
      assert.ok(roots.includes(canonicalW), 'write-granted root present')
      assert.ok(!roots.includes(canonicalR), 'read-only grant must NOT be writable')
    } finally {
      _resetGrantsForTest()
      rmSync(wdir, { recursive: true, force: true })
      rmSync(rdir, { recursive: true, force: true })
    }
  })
})

describe('sandbox-profile: Seatbelt', () => {
  it('denies writes globally then re-allows roots', () => {
    const profile = buildSeatbeltProfile(['/work/proj', '/tmp'])
    assert.ok(profile.includes('(deny file-write*)'))
    assert.ok(profile.includes('(subpath "/work/proj")'))
    assert.ok(profile.includes('(subpath "/tmp")'))
    // /dev/null must stay writable or most commands break.
    assert.ok(profile.includes('/dev/null'))
  })
  it('builds a sandbox-exec command that preserves the inner command', () => {
    const cmd = buildSeatbeltCommand('npm test', ['/work'])
    assert.ok(cmd.startsWith('sandbox-exec -p '))
    assert.ok(cmd.includes('npm test'))
  })
})

describe('sandbox-profile: bwrap/firejail', () => {
  it('bwrap binds the workspace read-write over a read-only root', () => {
    const cmd = buildBwrapCommand('make', ['/work/proj'])
    assert.ok(cmd.startsWith('bwrap '))
    assert.ok(cmd.includes('--ro-bind / /'))
    assert.ok(cmd.includes('/work/proj'))
    assert.ok(cmd.includes('make'))
    // network must NOT be unshared
    assert.ok(!cmd.includes('--unshare-net'))
  })
  it('firejail keeps root read-only with explicit writable roots', () => {
    const cmd = buildFirejailCommand('go build', ['/work'])
    assert.ok(cmd.includes('--read-only=/'))
    assert.ok(cmd.includes('--read-write='))
    assert.ok(cmd.includes('go build'))
  })
})

describe('sandbox-profile: detectWsl', () => {
  it('detects via WSL_DISTRO_NAME', () => {
    assert.equal(detectWsl(() => null, { WSL_DISTRO_NAME: 'Ubuntu' }), true)
  })
  it('detects via /proc/version microsoft marker', () => {
    assert.equal(detectWsl(() => 'Linux ... microsoft-standard-WSL2 ...', {}), true)
  })
  it('returns false on a real Linux kernel', () => {
    assert.equal(detectWsl(() => 'Linux version 6.1.0 (gcc ...)', {}), false)
  })
})

describe('sandbox-profile: selectSandboxBackend', () => {
  it('macOS picks seatbelt when sandbox-exec exists', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'darwin', which: () => true }), 'seatbelt')
  })
  it('macOS falls back to none without sandbox-exec', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'darwin', which: () => false }), 'none')
  })
  it('linux prefers bwrap', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'linux', which: (b) => b === 'bwrap' }), 'bwrap')
  })
  it('linux uses firejail when bwrap missing', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'linux', which: (b) => b === 'firejail' }), 'firejail')
  })
  it('linux without tools is none', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'linux', which: () => false }), 'none')
  })
  it('native windows is none', () => {
    assert.equal(selectSandboxBackend({ cwd: '/w', platform: 'win32', which: () => true }), 'none')
  })
})

describe('sandbox-profile: wrapSandboxCommand', () => {
  const base = { cwd: '/work/proj', env: { HOME: '/home/u' } as NodeJS.ProcessEnv }

  it('opts out cleanly with RIVET_NO_SANDBOX=1', () => {
    const d = wrapSandboxCommand('echo hi', { ...base, env: { ...base.env, RIVET_NO_SANDBOX: '1' } })
    assert.equal(d.sandboxed, false)
    assert.equal(d.command, 'echo hi')
  })
  it('wraps with seatbelt on macOS', () => {
    const d = wrapSandboxCommand('echo hi', { ...base, platform: 'darwin', which: () => true })
    assert.equal(d.sandboxed, true)
    assert.equal(d.backend, 'seatbelt')
    assert.ok(d.command.includes('echo hi'))
  })
  it('fails soft on native windows with an explanatory note', () => {
    const d = wrapSandboxCommand('echo hi', { ...base, platform: 'win32', which: () => false })
    assert.equal(d.sandboxed, false)
    assert.equal(d.backend, 'none')
    assert.match(d.note ?? '', /Windows|rollback/i)
  })
  it('notes WSL when on linux without tools', () => {
    const d = wrapSandboxCommand('echo hi', {
      ...base, platform: 'linux', which: () => false,
      env: { ...base.env, WSL_DISTRO_NAME: 'Ubuntu' },
      readProcVersion: () => 'microsoft',
    })
    assert.equal(d.sandboxed, false)
    assert.match(d.note ?? '', /WSL|bubblewrap/i)
  })
})

describe('sandbox-profile: getSandboxStartupNotice', () => {
  const env = { HOME: '/home/u' } as NodeJS.ProcessEnv

  it('returns null when a real boundary is active (no noise)', () => {
    assert.equal(getSandboxStartupNotice({ cwd: '/w', platform: 'darwin', which: () => true, env }), null)
    assert.equal(getSandboxStartupNotice({ cwd: '/w', platform: 'linux', which: (b) => b === 'bwrap', env }), null)
  })

  it('warns sternly on native Windows with no backend', () => {
    const n = getSandboxStartupNotice({ cwd: '/w', platform: 'win32', which: () => false, env })
    assert.ok(n)
    assert.equal(n!.level, 'warn')
    assert.match(n!.message, /Windows/)
    assert.match(n!.message, /回滚|rollback|WSL/i)
  })

  it('warns on RIVET_NO_SANDBOX with extra Windows emphasis', () => {
    const generic = getSandboxStartupNotice({ cwd: '/w', platform: 'linux', which: () => true, env: { ...env, RIVET_NO_SANDBOX: '1' } })
    assert.ok(generic)
    assert.match(generic!.message, /RIVET_NO_SANDBOX/)

    const win = getSandboxStartupNotice({ cwd: '/w', platform: 'win32', which: () => true, env: { ...env, RIVET_NO_SANDBOX: '1' } })
    assert.match(win!.message, /Windows/)
  })

  it('warns when WSL detected but bwrap missing', () => {
    const n = getSandboxStartupNotice({
      cwd: '/w', platform: 'linux', which: () => false,
      env: { ...env, WSL_DISTRO_NAME: 'Ubuntu' }, readProcVersion: () => 'microsoft',
    })
    assert.ok(n)
    assert.match(n!.message, /WSL|bubblewrap/i)
  })
})

describe('sandbox-profile: maybeWarnNoSandbox (one-shot)', () => {
  it('emits at most once per process and stays silent when sandboxed', () => {
    _resetSandboxWarningLatch()
    const logs: string[] = []
    const log = (m: string) => logs.push(m)

    // Sandboxed → no emission.
    maybeWarnNoSandbox({ cwd: '/w', platform: 'darwin', which: () => true }, log)
    assert.equal(logs.length, 0)

    // First no-sandbox call emits once...
    maybeWarnNoSandbox({ cwd: '/w', platform: 'win32', which: () => false }, log)
    assert.equal(logs.length, 1)
    assert.match(logs[0]!, /\[sandbox\]/)

    // ...subsequent calls are latched.
    maybeWarnNoSandbox({ cwd: '/w', platform: 'win32', which: () => false }, log)
    assert.equal(logs.length, 1)
    _resetSandboxWarningLatch()
  })
})
