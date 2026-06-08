import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { detectCwdRelation } from '../self-recognition.js'

test('detectCwdRelation: .rivet/SELF marker present → self (home)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-recog-'))
  try {
    mkdirSync(join(dir, '.rivet'), { recursive: true })
    writeFileSync(join(dir, '.rivet', 'SELF'), 'body marker')
    assert.equal(detectCwdRelation(dir), 'self')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectCwdRelation: no marker → world (a developer project)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-recog-'))
  try {
    assert.equal(detectCwdRelation(dir), 'world')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectCwdRelation: .rivet/ exists but no SELF marker → world', () => {
  // A developer who uses 天枢 gets .rivet/knowledge/ auto-created, but never
  // .rivet/SELF. The marker must be the discriminator, not the .rivet dir.
  const dir = mkdtempSync(join(tmpdir(), 'self-recog-'))
  try {
    mkdirSync(join(dir, '.rivet', 'knowledge'), { recursive: true })
    writeFileSync(join(dir, '.rivet', 'knowledge', 'memory.jsonl'), '')
    assert.equal(detectCwdRelation(dir), 'world')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('detectCwdRelation: nonexistent path → world (fail toward guest)', () => {
  assert.equal(detectCwdRelation('/no/such/path/xyzzy-9f3a'), 'world')
})

test('detectCwdRelation: 天枢 recognizes his own body — the real repo is self', () => {
  // The committed .rivet/SELF marker lives in 天枢's own source. Tests run from
  // the repo root, so his body recognizes itself.
  assert.equal(detectCwdRelation(process.cwd()), 'self')
})
