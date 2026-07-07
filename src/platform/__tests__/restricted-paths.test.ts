import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isRestrictedPath } from '../restricted-paths.js'

describe('isRestrictedPath', () => {
  // ── Positive matches (code='EPERM' or 'EACCES') ──────────────────

  it('matches Windows AppData\\Local\\ElevatedDiagnostics (EPERM)', () => {
    assert.equal(isRestrictedPath('C:\\Users\\x\\AppData\\Local\\ElevatedDiagnostics', 'EPERM'), true)
  })

  it('matches Windows AppData\\Local\\ElevatedDiagnostics (EACCES)', () => {
    assert.equal(isRestrictedPath('C:\\Users\\x\\AppData\\Local\\ElevatedDiagnostics', 'EACCES'), true)
  })

  it('matches Windows AppData\\Local\\Packages\\SomeUwpApp', () => {
    assert.equal(isRestrictedPath('C:\\Users\\x\\AppData\\Local\\Packages\\SomeUwpApp', 'EPERM'), true)
  })

  it('matches Windows $RECYCLE.BIN (uppercase)', () => {
    assert.equal(isRestrictedPath('C:\\$RECYCLE.BIN', 'EPERM'), true)
  })

  it('matches Windows $Recycle.Bin (mixed case)', () => {
    assert.equal(isRestrictedPath('C:\\$Recycle.Bin', 'EPERM'), true)
  })

  it('matches Windows System Volume Information', () => {
    assert.equal(isRestrictedPath('D:\\System Volume Information', 'EPERM'), true)
  })

  it('matches macOS .Spotlight-V100', () => {
    assert.equal(isRestrictedPath('/Volumes/ext/.Spotlight-V100', 'EPERM'), true)
  })

  it('matches Linux /proc/<pid>/fd', () => {
    assert.equal(isRestrictedPath('/proc/1234/fd', 'EACCES'), true)
  })

  // ── Negative matches (must NOT suppress) ─────────────────────────

  it('does NOT match AppData\\Local\\.rivet — Rivet data directory', () => {
    assert.equal(isRestrictedPath('C:\\Users\\x\\AppData\\Local\\.rivet\\sessions\\abc.jsonl', 'EPERM'), false)
  })

  it('does NOT match AppData\\Local\\Temp (legitimate temp dir)', () => {
    assert.equal(isRestrictedPath('C:\\Users\\x\\AppData\\Local\\Temp\\my-project', 'EPERM'), false)
  })

  it('does NOT match AppData\\Local\\MyApp (ordinary user app)', () => {
    assert.equal(isRestrictedPath('C:\\Users\\x\\AppData\\Local\\MyApp\\data', 'EPERM'), false)
  })

  it('does NOT match bare-substring user path (anchoring regression)', () => {
    assert.equal(isRestrictedPath('/home/user/project/my-elevateddiagnostics-notes/readme.md', 'EPERM'), false)
  })

  it('does NOT match ordinary project path', () => {
    assert.equal(isRestrictedPath('/home/user/project/src', 'EPERM'), false)
  })

  it('does NOT match when code is ENOENT', () => {
    assert.equal(isRestrictedPath('C:\\Users\\x\\AppData\\Local\\ElevatedDiagnostics', 'ENOENT'), false)
  })

  it('does NOT match when code is empty string', () => {
    assert.equal(isRestrictedPath('C:\\Users\\x\\AppData\\Local\\ElevatedDiagnostics', ''), false)
  })

  it('does NOT match when path is empty', () => {
    assert.equal(isRestrictedPath('', 'EPERM'), false)
  })
})
