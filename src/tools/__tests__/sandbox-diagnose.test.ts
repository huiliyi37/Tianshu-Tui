import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  classifySandboxDenial,
  extractDeniedPaths,
  buildSandboxDenialHint,
  recordSandboxLearn,
} from '../sandbox-diagnose.js'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Real stderr captured from `sandbox-exec` on macOS 2026-07-26 with a
// workspace-only profile (see plan 瑶光反证).
const SEATBELT_MKDIR = 'mkdir: /Users/b/Library/Developer/Xcode/DerivedData: Operation not permitted'
const SEATBELT_NODE = "Error: EPERM: operation not permitted, mkdir '/Users/b/Library/Developer/Xcode/D2'"
const SEATBELT_REDIRECT = 'sh: /Users/b/out.txt: Operation not permitted'
const SEATBELT_TOUCH = 'touch: /opt/probe: Operation not permitted'
const BWRAP_EROFS = "Error: EROFS: read-only file system, open '/opt/homebrew/bin/foo'"
const BWRAP_SELF = "bwrap: Can't create file at /nonexistent/x: No such file or directory"

describe('extractDeniedPaths', () => {
  it('extracts from coreutils wording', () => {
    assert.deepEqual(extractDeniedPaths(SEATBELT_MKDIR), ['/Users/b/Library/Developer/Xcode/DerivedData'])
  })
  it('extracts from Node EPERM wording', () => {
    assert.deepEqual(extractDeniedPaths(SEATBELT_NODE), ['/Users/b/Library/Developer/Xcode/D2'])
  })
  it('extracts from shell redirect wording', () => {
    assert.deepEqual(extractDeniedPaths(SEATBELT_REDIRECT), ['/Users/b/out.txt'])
  })
  it('extracts from touch wording', () => {
    assert.deepEqual(extractDeniedPaths(SEATBELT_TOUCH), ['/opt/probe'])
  })
  it('extracts from bwrap EROFS wording', () => {
    assert.deepEqual(extractDeniedPaths(BWRAP_EROFS), ['/opt/homebrew/bin/foo'])
  })
  it('extracts from bwrap self-failure wording without the trailing colon', () => {
    // deepEqual, not includes(): a weaker assertion passes even when a second,
    // colon-suffixed variant leaks in from a stale pattern.
    assert.deepEqual(extractDeniedPaths(BWRAP_SELF), ['/nonexistent/x'])
  })
  it('dedupes repeated paths across patterns', () => {
    const both = `${SEATBELT_MKDIR}\n${SEATBELT_MKDIR}`
    assert.equal(extractDeniedPaths(both).length, 1)
  })
  it('returns empty for unrelated stderr', () => {
    assert.deepEqual(extractDeniedPaths('npm ERR! 404 Not Found'), [])
  })
})

describe('classifySandboxDenial', () => {
  it('classifies a Seatbelt denial outside the writable roots', () => {
    const d = classifySandboxDenial({
      stderr: SEATBELT_MKDIR,
      backend: 'seatbelt',
      writableRoots: ['/Users/b/proj', '/tmp'],
    })
    assert.ok(d)
    assert.equal(d.backend, 'seatbelt')
    assert.deepEqual(d.paths, ['/Users/b/Library/Developer/Xcode/DerivedData'])
  })

  it('stays silent when the denied path is already writable (not a boundary problem)', () => {
    const d = classifySandboxDenial({
      stderr: 'mkdir: /Users/b/proj/build: Operation not permitted',
      backend: 'seatbelt',
      writableRoots: ['/Users/b/proj'],
    })
    assert.equal(d, null)
  })

  it('stays silent when no sandbox backend was applied', () => {
    const d = classifySandboxDenial({
      stderr: SEATBELT_MKDIR,
      backend: 'none',
      writableRoots: [],
    })
    assert.equal(d, null)
  })

  it('stays silent on unrelated failures', () => {
    const d = classifySandboxDenial({
      stderr: 'error TS2345: Argument of type string is not assignable',
      backend: 'seatbelt',
      writableRoots: ['/Users/b/proj'],
    })
    assert.equal(d, null)
  })

  it('reports a pathless denial when markers are present but nothing extractable', () => {
    const d = classifySandboxDenial({
      stderr: 'fatal: Operation not permitted',
      backend: 'seatbelt',
      writableRoots: ['/Users/b/proj'],
    })
    assert.ok(d)
    assert.deepEqual(d.paths, [])
  })
})

describe('buildSandboxDenialHint', () => {
  it('names the path and routes to request_path_access', () => {
    const hint = buildSandboxDenialHint({
      backend: 'seatbelt',
      paths: ['/Users/b/Library/Developer/Xcode/DerivedData'],
    })
    assert.ok(hint.includes('/Users/b/Library/Developer/Xcode/DerivedData'))
    assert.ok(hint.includes('request_path_access'))
    assert.ok(hint.includes('remember: true'))
  })

  it('forbids the sudo/chmod doom-loop explicitly', () => {
    const hint = buildSandboxDenialHint({ backend: 'seatbelt', paths: ['/opt/x'] })
    assert.ok(hint.includes('sudo'))
    assert.ok(hint.includes('chmod'))
  })

  it('degrades honestly when no path could be located', () => {
    const hint = buildSandboxDenialHint({ backend: 'bwrap', paths: [] })
    assert.ok(hint.includes('未能从输出中定位具体路径'))
    assert.ok(hint.includes('request_path_access'))
  })
})

describe('recordSandboxLearn', () => {
  it('appends one JSON line per observation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-learn-'))
    recordSandboxLearn({
      cwd: '/w', command: 'npm run tauri build', backend: 'seatbelt',
      deniedPaths: ['/h/Library/Developer/Xcode/DerivedData'], retried: true,
    }, dir)
    recordSandboxLearn({
      cwd: '/w', command: 'codesign x', backend: 'seatbelt',
      deniedPaths: ['/h/Library/Keychains'], retried: false,
    }, dir)
    const lines = readFileSync(join(dir, 'sandbox-learn.jsonl'), 'utf-8').trim().split('\n')
    assert.equal(lines.length, 2)
    const first = JSON.parse(lines[0]!)
    assert.equal(first.command, 'npm run tauri build')
    assert.deepEqual(first.deniedPaths, ['/h/Library/Developer/Xcode/DerivedData'])
    assert.equal(typeof first.ts, 'number')
    rmSync(dir, { recursive: true, force: true })
  })

  it('never throws when the target directory is unwritable', () => {
    assert.doesNotThrow(() => recordSandboxLearn({
      cwd: '/w', command: 'x', backend: 'none', deniedPaths: [], retried: false,
    // Path under an existing FILE: mkdir fails ENOTDIR everywhere, fast.
    // NOT a /proc/... path — on WSL2, mkdir on procfs returns ENOENT, and
    // Node's recursive mkdirSync reads that as "parent missing", retrying the
    // same mkdir forever (infinite loop, ~100% CPU). ENOTDIR terminates it.
    }, '/dev/null/nonexistent-rivet-learn'))
  })
})
