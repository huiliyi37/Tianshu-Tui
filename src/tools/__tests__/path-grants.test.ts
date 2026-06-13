import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'

import {
  grantPath,
  isReadGranted,
  isWriteGranted,
  writeGrantedRoots,
  listGrants,
  loadPersistedGrants,
  _resetGrantsForTest,
} from '../path-grants.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-grants-'))
}

describe('path-grants', () => {
  beforeEach(() => _resetGrantsForTest())

  it('grants a directory subtree (read)', () => {
    const dir = tmp()
    try {
      grantPath(dir, 'read')
      assert.equal(isReadGranted(join(dir, 'a/b/c.txt')), true)
      assert.equal(isReadGranted(dir), true)
      // read grant does not satisfy a write check
      assert.equal(isWriteGranted(join(dir, 'a.txt')), false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('write grant satisfies both read and write', () => {
    const dir = tmp()
    try {
      grantPath(dir, 'write')
      assert.equal(isWriteGranted(join(dir, 'out.zip')), true)
      assert.equal(isReadGranted(join(dir, 'out.zip')), true)
      assert.deepEqual(writeGrantedRoots().length, 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('upgrades read → write but never downgrades', () => {
    const dir = tmp()
    try {
      grantPath(dir, 'read')
      grantPath(dir, 'write')
      assert.equal(isWriteGranted(join(dir, 'x')), true)
      assert.equal(listGrants().length, 1, 'same root deduped')
      grantPath(dir, 'read') // must not downgrade
      assert.equal(isWriteGranted(join(dir, 'x')), true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('respects path-separator boundary (no prefix bleed)', () => {
    const base = tmp()
    try {
      const granted = join(base, 'proj')
      mkdirSync(granted)
      mkdirSync(join(base, 'proj-backup'))
      grantPath(granted, 'write')
      assert.equal(isWriteGranted(join(granted, 'f.txt')), true)
      assert.equal(isWriteGranted(join(base, 'proj-backup', 'secret')), false, 'sibling with common prefix must not match')
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('canonicalizes symlinks so a grant cannot be escaped or missed', () => {
    const base = tmp()
    try {
      const realDir = join(base, 'real')
      mkdirSync(realDir)
      const link = join(base, 'link')
      symlinkSync(realDir, link)
      // Grant via the symlink; a check on the real path must still match.
      grantPath(link, 'write')
      assert.equal(isWriteGranted(join(realDir, 'a.txt')), true)
      assert.equal(isWriteGranted(join(link, 'a.txt')), true)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  })

  it('persist round-trips per-workspace and isolates between workspaces', () => {
    const cwdA = tmp()
    const cwdB = tmp()
    const target = tmp()
    try {
      grantPath(target, 'write', { persist: true, cwd: cwdA })
      const file = join(homedir(), '.rivet')
      assert.ok(existsSync(file), '.rivet dir exists')

      // Fresh process simulation: reset memory, hydrate from B → nothing.
      _resetGrantsForTest()
      loadPersistedGrants(cwdB)
      assert.equal(isWriteGranted(join(target, 'x')), false, 'grant for A must not leak into B')

      // Hydrate from A → grant restored.
      _resetGrantsForTest()
      loadPersistedGrants(cwdA)
      assert.equal(isWriteGranted(join(target, 'x')), true, 'A grant restored from disk')
    } finally {
      for (const d of [cwdA, cwdB, target]) rmSync(d, { recursive: true, force: true })
    }
  })

  it('session-only grants do not persist', () => {
    const cwd = tmp()
    const target = tmp()
    try {
      grantPath(target, 'write') // no persist
      _resetGrantsForTest()
      loadPersistedGrants(cwd)
      assert.equal(isWriteGranted(join(target, 'x')), false)
    } finally {
      for (const d of [cwd, target]) rmSync(d, { recursive: true, force: true })
    }
  })
})
