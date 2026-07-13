import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { resolveGitCommand, gitEnv, spawnGitSync, spawnGit } from '../spawn-git.js'

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
    const got = resolveGitCommand({ RIVET_GIT_PATH: '/nope/does/not/exist/git' })
    assert.notEqual(got, '/nope/does/not/exist/git')
  })

  it('Win: probes LOCALAPPDATA candidate when set', () => {
    if (!isWin) return
    const dir = tmpDir()
    const prev = process.env['LOCALAPPDATA']
    try {
      // Create a fake git.exe under LOCALAPPDATA\Programs\Git\cmd
      const gitDir = join(dir, 'Programs', 'Git', 'cmd')
      mkdirSync(gitDir, { recursive: true })
      const git = fakeGitExe(gitDir)
      process.env['LOCALAPPDATA'] = dir
      const got = resolveGitCommand({})
      assert.equal(got, git, 'should find git via LOCALAPPDATA candidate')
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (prev !== undefined) process.env['LOCALAPPDATA'] = prev
      else delete process.env['LOCALAPPDATA']
    }
  })

  it('Win: probes Program Files (x86) when that is the only hit', () => {
    const x86 = 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'
    const got = resolveGitCommand(
      { RIVET_GIT_PATH: '' },
      {
        platform: 'win32',
        existsSync: (p) => p === x86,
      },
    )
    assert.equal(got, x86, 'x86 candidate must be probed after Program Files')
  })

  it('Win: Program Files wins over x86 when both exist', () => {
    const pf = 'C:\\Program Files\\Git\\cmd\\git.exe'
    const x86 = 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'
    const got = resolveGitCommand(
      { RIVET_GIT_PATH: '' },
      {
        platform: 'win32',
        existsSync: (p) => p === pf || p === x86,
      },
    )
    assert.equal(got, pf)
  })

  it('Win: LOCALAPPDATA candidate via injected existsSync (cross-platform)', () => {
    const local = 'D:\\Users\\me\\AppData\\Local'
    const git = join(local, 'Programs', 'Git', 'cmd', 'git.exe')
    const got = resolveGitCommand(
      { RIVET_GIT_PATH: '', LOCALAPPDATA: local },
      {
        platform: 'win32',
        existsSync: (p) => p === git,
      },
    )
    assert.equal(got, git)
  })

  it('non-Win: returns "git" as fallback', () => {
    if (isWin) return
    const got = resolveGitCommand({})
    assert.equal(got, 'git')
  })

  it('falls back to process.env RIVET_GIT_PATH when opts.env is omitted', () => {
    const dir = tmpDir()
    const prev = process.env['RIVET_GIT_PATH']
    try {
      const git = fakeGitExe(dir)
      process.env['RIVET_GIT_PATH'] = git
      // No opts.env passed — verify process.env is consulted via merge
      const got = resolveGitCommand()
      assert.equal(got, git)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (prev !== undefined) process.env['RIVET_GIT_PATH'] = prev
      else delete process.env['RIVET_GIT_PATH']
    }
  })

  it('partial opts.env does not hide process.env RIVET_GIT_PATH', () => {
    const dir = tmpDir()
    const prev = process.env['RIVET_GIT_PATH']
    try {
      const git = fakeGitExe(dir)
      process.env['RIVET_GIT_PATH'] = git
      // Pass an empty env — should still see process.env via { ...process.env, ...opts.env }
      const got = resolveGitCommand({})
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

describe('spawnGitSync', () => {
  it('runs git --version and returns success', () => {
    const r = spawnGitSync(['--version'], { encoding: 'utf-8', timeout: 5000 })
    assert.equal(r.status, 0, `git --version should succeed, got: ${r.stderr}`)
    assert.ok(r.stdout.includes('git version'), `expected git version output, got: ${r.stdout}`)
  })

  it('passes cwd through to the child process', () => {
    const r = spawnGitSync(['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      timeout: 5000,
    })
    assert.equal(r.status, 0)
  })
})

describe('spawnGit (async)', () => {
  it('runs git --version and resolves with stdout', async () => {
    const child = spawnGit(['--version'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString() })
    await new Promise<void>((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`git --version exited ${code}`))
      })
      child.on('error', reject)
    })
    assert.ok(stdout.includes('git version'), `expected git version output, got: ${stdout}`)
  })
})
