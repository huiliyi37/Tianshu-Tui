import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildNotFoundHint,
  extractMissingCommand,
  formatEnvGuidance,
  formatGitMissingBanner,
  getInstallCommand,
  isPythonProject,
  needsAutocrlfWarning,
  recommendUvSetup,
  resolveGitExePath,
  type GitExeProbeDeps,
} from '../env-check.js'

describe('env-check', () => {
  describe('formatGitMissingBanner', () => {
    it('returns empty string when git is available', () => {
      assert.equal(formatGitMissingBanner(true, 'win32'), '')
      assert.equal(formatGitMissingBanner(true, 'darwin'), '')
    })

    it('emphasizes Git Bash on Windows when git missing', () => {
      const banner = formatGitMissingBanner(false, 'win32')
      assert.match(banner, /Git Bash/)
      assert.match(banner, /git-scm\.com\/download\/win/)
    })

    it('gives repo-ops rationale on non-Windows when git missing', () => {
      const banner = formatGitMissingBanner(false, 'darwin')
      assert.match(banner, /未检测到 Git/)
      assert.ok(!banner.includes('Git Bash'))
    })
  })

  describe('needsAutocrlfWarning', () => {
    it('warns only for autocrlf=true on Windows', () => {
      assert.equal(needsAutocrlfWarning('true', 'win32'), true)
    })

    it('does not warn for input/false/unset on Windows', () => {
      assert.equal(needsAutocrlfWarning('input', 'win32'), false)
      assert.equal(needsAutocrlfWarning('false', 'win32'), false)
      assert.equal(needsAutocrlfWarning(undefined, 'win32'), false)
    })

    it('does not warn off Windows regardless of value', () => {
      assert.equal(needsAutocrlfWarning('true', 'darwin'), false)
      assert.equal(needsAutocrlfWarning('true', 'linux'), false)
    })
  })

  describe('buildNotFoundHint', () => {
    it('returns python install hint on macOS', () => {
      const hint = buildNotFoundHint('python3', 'darwin')
      assert.ok(hint.includes('brew install python'))
    })

    it('returns git install hint on linux', () => {
      const hint = buildNotFoundHint('git', 'linux')
      assert.ok(hint.includes('apt install git'))
    })

    it('returns uv install hint on windows', () => {
      const hint = buildNotFoundHint('uv', 'win32')
      assert.ok(hint.includes('astral.sh'))
    })

    it('returns empty for unrelated command', () => {
      const hint = buildNotFoundHint('foobar', 'linux')
      assert.equal(hint, '')
    })
  })

  describe('extractMissingCommand', () => {
    it('extracts from PowerShell term error', () => {
      const cmd = extractMissingCommand("The term 'python' is not recognized", 'python foo.py')
      assert.equal(cmd, 'python')
    })

    it('extracts from POSIX command not found', () => {
      const cmd = extractMissingCommand('zsh: command not found: python3', 'python3 foo.py')
      assert.equal(cmd, 'python3')
    })

    it('falls back to first token of command', () => {
      const cmd = extractMissingCommand('something else', 'uv sync')
      assert.equal(cmd, 'uv')
    })
  })

  describe('formatEnvGuidance', () => {
    it('guides python and git when both missing', () => {
      const text = formatEnvGuidance({
        python: { available: false, command: 'python3' },
        uv: { available: false, command: 'uv' },
        git: { available: false, command: 'git' },
        node: { available: true, command: 'node', version: 'v20.0.0' },
        java: { available: false, command: 'java' },
        maven: { available: false, command: 'mvn' },
        gradle: { available: false, command: 'gradle' },
        platform: 'darwin',
      })
      assert.ok(text.includes('brew install python'))
      assert.ok(text.includes('brew install git'))
    })

    it('recommends uv when python is present but uv missing', () => {
      const text = formatEnvGuidance({
        python: { available: true, command: 'python3', version: '3.12.0' },
        uv: { available: false, command: 'uv' },
        git: { available: true, command: 'git', version: '2.40.0' },
        node: { available: true, command: 'node', version: 'v20.0.0' },
        java: { available: false, command: 'java' },
        maven: { available: false, command: 'mvn' },
        gradle: { available: false, command: 'gradle' },
        platform: 'linux',
      })
      assert.ok(text.includes('uv'))
      assert.ok(text.includes('astral.sh'))
    })
  })

  describe('getInstallCommand', () => {
    it('covers all three tools on all platforms', () => {
      for (const platform of ['darwin', 'win32', 'linux'] as const) {
        for (const tool of ['python', 'git', 'uv'] as const) {
          const cmd = getInstallCommand(tool, platform)
          assert.ok(cmd.length > 0, `${tool} on ${platform} should have guidance`)
        }
      }
    })
  })

  describe('recommendUvSetup', () => {
    it('rejects non-python directory', () => {
      const result = recommendUvSetup('/tmp/empty-test-dir-xyz')
      assert.equal(result.ok, false)
    })
  })

  describe('resolveGitExePath — Windows git.exe probe with fallback', () => {
    const baseDeps = (over: Partial<GitExeProbeDeps>): GitExeProbeDeps => ({
      env: {},
      whichGit: async () => undefined,
      exists: () => false,
      ...over,
    })

    it('RIVET_GIT_PATH override wins when it exists', async () => {
      const expected = 'D:\\custom\\Git\\cmd\\git.exe'
      const got = await resolveGitExePath(baseDeps({
        env: { RIVET_GIT_PATH: expected },
        exists: (p) => p === expected,
      }))
      assert.equal(got, expected)
    })

    it('ignores RIVET_GIT_PATH override when the file does not exist', async () => {
      const got = await resolveGitExePath(baseDeps({
        env: { RIVET_GIT_PATH: 'D:\\nope\\git.exe' },
        whichGit: async () => 'C:\\Program Files\\Git\\cmd\\git.exe',
      }))
      assert.equal(got, 'C:\\Program Files\\Git\\cmd\\git.exe')
    })

    it('returns PATH git.exe when `which` finds it', async () => {
      const got = await resolveGitExePath(baseDeps({
        whichGit: async () => 'C:\\Program Files\\Git\\cmd\\git.exe',
      }))
      assert.equal(got, 'C:\\Program Files\\Git\\cmd\\git.exe')
    })

    it('falls back to C:\\Program Files\\Git\\cmd\\git.exe', async () => {
      const expected = 'C:\\Program Files\\Git\\cmd\\git.exe'
      const got = await resolveGitExePath(baseDeps({
        exists: (p) => p === expected,
      }))
      assert.equal(got, expected)
    })

    it('falls back to x86 install location', async () => {
      const expected = 'C:\\Program Files (x86)\\Git\\cmd\\git.exe'
      const got = await resolveGitExePath(baseDeps({
        exists: (p) => p === expected,
      }))
      assert.equal(got, expected)
    })

    it('falls back to LOCALAPPDATA portable install', async () => {
      const expected = 'C:\\Users\\me\\AppData\\Local\\Programs\\Git\\cmd\\git.exe'
      const got = await resolveGitExePath(baseDeps({
        env: { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' },
        exists: (p) => p === expected,
      }))
      assert.equal(got, expected)
    })

    it('prefers PATH hit over fallback locations', async () => {
      const pathHit = 'D:\\custom\\Git\\cmd\\git.exe'
      const fallback = 'C:\\Program Files\\Git\\cmd\\git.exe'
      const got = await resolveGitExePath(baseDeps({
        whichGit: async () => pathHit,
        exists: (p) => p === fallback,
      }))
      assert.equal(got, pathHit)
    })

    it('returns undefined when nothing is found', async () => {
      const got = await resolveGitExePath(baseDeps({}))
      assert.equal(got, undefined)
    })
  })

  describe('isPythonProject', () => {
    it('returns false for non-python cwd', () => {
      assert.equal(isPythonProject('/tmp/empty-test-dir-xyz'), false)
    })
  })
})
