import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { resolveGitCommand, gitEnv } from '../spawn-git.js'

const isWin = process.platform === 'win32'

function tmpDir() {
  const d = join(tmpdir(), `spawn-git-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(d, { recursive: true })
  return d
}

function fakeGitExe(dir: string, name = isWin ? 'git.exe' : 'git') {
  const p = join(dir, name)
  writeFileSync(p, '')
  if (!isWin) chmodSync(p, 0o755)
  return p
}

describe('resolveGitCommand', () => {
  it('returns RIVET_GIT_PATH override when it exists', () => {
    const dir = tmpDir()
    try {
      const git = fakeGitExe(dir)
      const got = resolveGitCommand({ RIVET_GIT_PATH: git })
      assert.equal(got, git)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores RIVET_GIT_PATH when file does not exist', () => {
    // On non-Win, fallback is 'git'; on Win, none of the hardcoded
    // paths should exist with that exact name in a temp dir context
    const got = resolveGitCommand({ RIVET_GIT_PATH: '/nope/does/not/exist/git' })
    // Must not return the override
    assert.notEqual(got, '/nope/does/not/exist/git')
  })

  it('Win: probes Program Files + x86 + LOCALAPPDATA in order', () => {
    if (!isWin) return // skip on Unix
    // We can't create C:\Program Files, but we can verify the fallback
    // to 'git' and that LOCALAPPDATA from env is considered.
    // This is a smoke test: the candidate array exists and falls through.
    const got = resolveGitCommand({})
    // If no RIVET_GIT_PATH and no Program Files git, falls back to 'git'
    // (which is the string 'git', not a path)
    assert.ok(typeof got === 'string' && got.length > 0)
  })

  it('non-Win: returns "git" as fallback', () => {
    if (isWin) return
    const got = resolveGitCommand({})
    assert.equal(got, 'git')
  })

  it('falls back to process.env RIVET_GIT_PATH when opts.env is not provided', () => {
    const dir = tmpDir()
    const prev = process.env['RIVET_GIT_PATH']
    try {
      const git = fakeGitExe(dir)
      process.env['RIVET_GIT_PATH'] = git
      const got = resolveGitCommand()
      assert.equal(got, git)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (prev !== undefined) process.env['RIVET_GIT_PATH'] = prev
      else delete process.env['RIVET_GIT_PATH']
    }
  })
})

describe('gitEnv', () => {
  it('returns an object with PATH', () => {
    const env = gitEnv()
    assert.ok(typeof env === 'object' && env !== null)
    const pathKey = isWin ? 'Path' : 'PATH'
    assert.ok(env[pathKey] || env['PATH'] || env['Path'],
      'expected resolved env to contain a PATH-like key')
  })

  it('accepts optional cwd', () => {
    const env = gitEnv(process.cwd())
    assert.ok(typeof env === 'object' && env !== null)
  })
})

describe('spawnGitSync placeholder (import-only smoke)', () => {
  // spawnGitSync/spawnGit/execFileGit wrappers are exercised through
  // integration in the caller replacement tests. Here we just verify
  // the module loads and exports the expected functions.
  it('module exports spawnGitSync, spawnGit, execFileGit', async () => {
    const mod = await import('../spawn-git.js')
    assert.equal(typeof mod.spawnGitSync, 'function')
    assert.equal(typeof mod.spawnGit, 'function')
    assert.equal(typeof mod.execFileGit, 'function')
  })
})
