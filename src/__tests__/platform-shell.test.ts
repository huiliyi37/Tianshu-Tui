import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveGitBashPath,
  resolveShellCommand,
  rewriteWindowsNullRedirect,
  rewritePowershellNullRedirect,
  type GitBashProbeDeps,
  type ShellProbeDeps,
} from '../platform.js'

describe('resolveGitBashPath — probe order', () => {
  const baseDeps = (over: Partial<GitBashProbeDeps>): GitBashProbeDeps => ({
    isWindows: true,
    env: {},
    whichGit: () => undefined,
    exists: () => false,
    ...over,
  })

  it('returns null on non-Windows', () => {
    assert.equal(resolveGitBashPath(baseDeps({ isWindows: false })), null)
  })

  it('1. RIVET_GIT_BASH_PATH override wins when it exists', () => {
    const custom = 'D:\\tools\\git\\bin\\bash.exe'
    const got = resolveGitBashPath(baseDeps({
      env: { RIVET_GIT_BASH_PATH: custom },
      exists: (p) => p === custom,
    }))
    assert.equal(got, custom)
  })

  it('1b. override ignored when the path does not exist', () => {
    const got = resolveGitBashPath(baseDeps({
      env: { RIVET_GIT_BASH_PATH: 'D:\\nope\\bash.exe' },
      exists: () => false,
    }))
    assert.equal(got, null)
  })

  it('2. derives bash.exe from `where git` (…\\Git\\cmd\\git.exe → …\\Git\\bin\\bash.exe)', () => {
    const expected = 'C:\\Program Files\\Git\\bin\\bash.exe'
    const got = resolveGitBashPath(baseDeps({
      whichGit: () => 'C:\\Program Files\\Git\\cmd\\git.exe',
      exists: (p) => p === expected,
    }))
    assert.equal(got, expected)
  })

  it('3. falls back to common install locations', () => {
    const expected = 'C:\\Program Files\\Git\\bin\\bash.exe'
    const got = resolveGitBashPath(baseDeps({
      exists: (p) => p === expected,
    }))
    assert.equal(got, expected)
  })

  it('3b. uses LOCALAPPDATA portable install', () => {
    const expected = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\bin\\bash.exe'
    const got = resolveGitBashPath(baseDeps({
      env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
      exists: (p) => p === expected,
    }))
    assert.equal(got, expected)
  })

  it('returns null when nothing is found', () => {
    assert.equal(resolveGitBashPath(baseDeps({})), null)
  })
})

describe('resolveShellCommand — Windows priority Git Bash > PowerShell > cmd', () => {
  const winDeps = (over: Partial<ShellProbeDeps>): ShellProbeDeps => ({
    isWindows: true,
    env: {},
    gitBashPath: null,
    hasPwsh: () => false,
    ...over,
  })

  it('prefers Git Bash with plain -c (no login shell, aligns with Claude Code)', () => {
    const shell = resolveShellCommand(winDeps({ gitBashPath: 'C:\\Git\\bin\\bash.exe' }))
    assert.equal(shell.kind, 'bash')
    assert.equal(shell.cmd, 'C:\\Git\\bin\\bash.exe')
    assert.deepEqual(shell.args, ['-c'])
  })

  it('falls back to PowerShell with -NonInteractive when Git Bash absent', () => {
    const shell = resolveShellCommand(winDeps({ hasPwsh: (c) => c === 'pwsh.exe' }))
    assert.equal(shell.kind, 'powershell')
    assert.equal(shell.cmd, 'pwsh.exe')
    assert.deepEqual(shell.args, ['-NoProfile', '-NonInteractive', '-Command'])
  })

  it('prefers pwsh.exe over powershell.exe', () => {
    const shell = resolveShellCommand(winDeps({ hasPwsh: () => true }))
    assert.equal(shell.cmd, 'pwsh.exe')
  })

  it('uses powershell.exe when only it is present', () => {
    const shell = resolveShellCommand(winDeps({ hasPwsh: (c) => c === 'powershell.exe' }))
    assert.equal(shell.cmd, 'powershell.exe')
    assert.equal(shell.kind, 'powershell')
  })

  it('falls back to cmd.exe (ComSpec) when no PowerShell', () => {
    const shell = resolveShellCommand(winDeps({ env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' } }))
    assert.equal(shell.kind, 'cmd')
    assert.equal(shell.cmd, 'C:\\Windows\\System32\\cmd.exe')
    assert.deepEqual(shell.args, ['/c'])
  })

  it('defaults to cmd.exe when ComSpec unset', () => {
    const shell = resolveShellCommand(winDeps({}))
    assert.equal(shell.cmd, 'cmd.exe')
  })

  it('uses sh -c on non-Windows', () => {
    const shell = resolveShellCommand({ isWindows: false, env: {}, gitBashPath: null, hasPwsh: () => false })
    assert.equal(shell.kind, 'sh')
    assert.equal(shell.cmd, 'sh')
    assert.deepEqual(shell.args, ['-c'])
  })

  it('RIVET_USE_POWERSHELL=1 forces PowerShell even when Git Bash is present', () => {
    const shell = resolveShellCommand(winDeps({
      env: { RIVET_USE_POWERSHELL: '1' },
      gitBashPath: 'C:\\Git\\bin\\bash.exe',
      hasPwsh: (c) => c === 'pwsh.exe',
    }))
    assert.equal(shell.kind, 'powershell')
    assert.equal(shell.cmd, 'pwsh.exe')
  })

  it('RIVET_USE_POWERSHELL falls through to cmd when no PowerShell present', () => {
    const shell = resolveShellCommand(winDeps({
      env: { RIVET_USE_POWERSHELL: 'true', ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
      gitBashPath: 'C:\\Git\\bin\\bash.exe',
    }))
    assert.equal(shell.kind, 'cmd')
  })

  it('RIVET_USE_POWERSHELL=0 keeps Git Bash preference', () => {
    const shell = resolveShellCommand(winDeps({
      env: { RIVET_USE_POWERSHELL: '0' },
      gitBashPath: 'C:\\Git\\bin\\bash.exe',
    }))
    assert.equal(shell.kind, 'bash')
  })
})

describe('rewritePowershellNullRedirect', () => {
  it('rewrites cmd-style 2>nul to 2>$null', () => {
    assert.equal(rewritePowershellNullRedirect('dir 2>nul'), 'dir 2>$null')
  })

  it('rewrites POSIX 2>/dev/null to 2>$null', () => {
    assert.equal(rewritePowershellNullRedirect('git status 2>/dev/null'), 'git status 2>$null')
  })

  it('rewrites bare >nul and > /dev/null', () => {
    assert.equal(rewritePowershellNullRedirect('echo hi >nul'), 'echo hi >$null')
    assert.equal(rewritePowershellNullRedirect('echo hi > /dev/null'), 'echo hi >$null')
  })

  it('leaves 2>&1 untouched', () => {
    assert.equal(rewritePowershellNullRedirect('cmd >/dev/null 2>&1'), 'cmd >$null 2>&1')
  })

  it('does not touch a filename that merely contains nul', () => {
    assert.equal(rewritePowershellNullRedirect('Get-Content nullable.txt'), 'Get-Content nullable.txt')
  })

  it('is a no-op when there is no null redirect', () => {
    assert.equal(rewritePowershellNullRedirect('Get-ChildItem'), 'Get-ChildItem')
  })
})

describe('rewriteWindowsNullRedirect', () => {
  it('rewrites 2>nul to 2>/dev/null', () => {
    assert.equal(rewriteWindowsNullRedirect('dir 2>nul'), 'dir 2>/dev/null')
  })

  it('rewrites bare >nul', () => {
    assert.equal(rewriteWindowsNullRedirect('echo hi >nul'), 'echo hi >/dev/null')
  })

  it('rewrites spaced redirect > nul', () => {
    assert.equal(rewriteWindowsNullRedirect('echo hi > nul'), 'echo hi >/dev/null')
  })

  it('leaves 2>&1 untouched', () => {
    assert.equal(rewriteWindowsNullRedirect('cmd >nul 2>&1'), 'cmd >/dev/null 2>&1')
  })

  it('does not touch a filename that merely contains nul', () => {
    assert.equal(rewriteWindowsNullRedirect('cat nullable.txt'), 'cat nullable.txt')
  })

  it('handles redirect before a pipe', () => {
    assert.equal(rewriteWindowsNullRedirect('a 2>nul | b'), 'a 2>/dev/null | b')
  })

  it('is a no-op when there is no null redirect', () => {
    assert.equal(rewriteWindowsNullRedirect('git status'), 'git status')
  })
})
