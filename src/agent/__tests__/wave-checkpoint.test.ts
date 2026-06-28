import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveCheckpoint, loadCheckpoint, clearCheckpoint, listCheckpoints, formatCheckpointList, type WaveCheckpoint } from '../wave-checkpoint.js'

function mkCheckpoint(overrides: Partial<WaveCheckpoint> = {}): WaveCheckpoint {
  return {
    groupId: 'team-auth-123',
    timestamp: Date.now(),
    lastCompletedWave: 0,
    completedResults: [],
    remainingOrders: [{ id: 'T2', objective: 'task 2', profile: 'patcher', kind: 'patch_proposal', scope: {}, authority: 'tianquan' }],
    objective: 'refactor auth',
    totalWaves: 3,
    ...overrides,
  }
}

// ── saveCheckpoint / loadCheckpoint ────────────────────────────

test('saveCheckpoint: creates directory and writes file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cp-'))
  try {
    saveCheckpoint(dir, mkCheckpoint())
    const loaded = loadCheckpoint(dir, 'team-auth-123')
    assert.ok(loaded, 'checkpoint loaded')
    assert.equal(loaded!.groupId, 'team-auth-123')
    assert.equal(loaded!.lastCompletedWave, 0)
    assert.equal(loaded!.totalWaves, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('loadCheckpoint: returns null when not found', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cp-'))
  try {
    assert.equal(loadCheckpoint(dir, 'nonexistent'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('saveCheckpoint: overwrites existing checkpoint', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cp-'))
  try {
    saveCheckpoint(dir, mkCheckpoint({ lastCompletedWave: 0 }))
    saveCheckpoint(dir, mkCheckpoint({ lastCompletedWave: 1 }))
    const loaded = loadCheckpoint(dir, 'team-auth-123')
    assert.equal(loaded!.lastCompletedWave, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── clearCheckpoint ────────────────────────────────────────────

test('clearCheckpoint: removes the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cp-'))
  try {
    saveCheckpoint(dir, mkCheckpoint())
    clearCheckpoint(dir, 'team-auth-123')
    assert.equal(loadCheckpoint(dir, 'team-auth-123'), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('clearCheckpoint: no error when checkpoint does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cp-'))
  try {
    clearCheckpoint(dir, 'nonexistent') // should not throw
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── listCheckpoints ────────────────────────────────────────────

test('listCheckpoints: returns empty when dir does not exist', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cp-'))
  try {
    assert.equal(listCheckpoints(dir).length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listCheckpoints: returns sorted by timestamp descending', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cp-'))
  try {
    saveCheckpoint(dir, mkCheckpoint({ groupId: 'old', timestamp: 1000 }))
    saveCheckpoint(dir, mkCheckpoint({ groupId: 'new', timestamp: 2000 }))
    const list = listCheckpoints(dir)
    assert.equal(list.length, 2)
    assert.equal(list[0]!.groupId, 'new') // newest first
    assert.equal(list[1]!.groupId, 'old')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ── formatCheckpointList ───────────────────────────────────────

test('formatCheckpointList: empty shows message', () => {
  assert.ok(formatCheckpointList([]).includes('No checkpoints'))
})

test('formatCheckpointList: shows group ids and wave info', () => {
  const text = formatCheckpointList([
    { groupId: 'team-fix-1', wave: 1, totalWaves: 3, timestamp: Date.now() },
  ])
  assert.ok(text.includes('team-fix-1'))
  assert.ok(text.includes('wave 2/3'))
})

// ── WaveCheckpoint data integrity ──────────────────────────────

test('WaveCheckpoint: completedResults and remainingOrders preserved through round-trip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-cp-'))
  try {
    const cp = mkCheckpoint({
      lastCompletedWave: 1,
      completedResults: [
        { workOrderId: 'T1', status: 'passed', summary: 'done', findings: [], risks: [], changedFiles: [], evidenceStatus: 'verified', artifacts: [], modelUsed: 'test', usage: { input_tokens: 100, output_tokens: 50 } },
      ],
      remainingOrders: [
        { id: 'T2', objective: 'fix tests', profile: 'patcher', kind: 'patch_proposal', scope: {}, authority: 'tianquan' },
        { id: 'T3', objective: 'review', profile: 'adversarial_verifier', kind: 'verify', scope: {}, authority: 'tianxuan' },
      ],
    })
    saveCheckpoint(dir, cp)
    const loaded = loadCheckpoint(dir, cp.groupId)
    assert.equal(loaded!.completedResults.length, 1)
    assert.equal(loaded!.remainingOrders.length, 2)
    assert.equal(loaded!.remainingOrders[1]!.profile, 'adversarial_verifier')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
