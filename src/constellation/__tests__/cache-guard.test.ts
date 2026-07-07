/**
 * Cache-safety regression guard for the Project Constellation feature.
 *
 * The whole feature must live in post-session side effects and render-only
 * layers — never in the system prompt, anchors, or any pre-turn flow that would
 * perturb the prefix cache. These tests pin those invariants.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConstellationRuntimeHook } from '../../agent/hooks/constellation-hook.js'
import { loadConstellation, constellationPath } from '../store.js'
import { renderStarmap } from '../../tui/format/overlay.js'
import type { StarmapData } from '../../tui/format/overlay.js'
import { getTheme } from '../../tui/theme.js'
import type { TaskLedgerSummary } from '../../agent/task-ledger.js'

function summary(over: Partial<TaskLedgerSummary> = {}): TaskLedgerSummary {
  return {
    taskId: 't', eventCount: 5, readFileCount: 2, writeFileCount: 2, ownedFileCount: 2,
    verificationCount: 1, verificationStatus: 'verified', firstEventAt: 1, lastEventAt: 2,
    ...over,
  }
}

test('constellation hook runs only in the postSession phase', () => {
  const hook = createConstellationRuntimeHook({
    enabled: true, cwd: '/tmp', sessionId: 's', getTaskSummary: () => null,
  })
  assert.equal(hook.phase, 'postSession')
})

test('agent-left mark is sealed with its self-chosen symbol', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cguard-'))
  try {
    const hook = createConstellationRuntimeHook({
      enabled: true, cwd, sessionId: 'sess',
      getPendingMark: () => ({ symbol: '⚘', summary: 'wired the starmap', type: 'feature' }),
      getTaskSummary: () => summary({ writeFileCount: 3 }),
      getChronicleEntries: () => [{ type: 'milestone', turn: 1, timestamp: 1, summary: 'noise', files: ['a.ts'] }],
      now: () => 5000,
    })
    await hook.run({} as never)
    const c = loadConstellation(cwd)
    assert.ok(c)
    assert.equal(c!.milestones.length, 1)
    assert.equal(c!.milestones[0]!.agentMark.symbol, '⚘')
    assert.equal(c!.milestones[0]!.summary, 'wired the starmap')
    assert.equal(c!.milestones[0]!.type, 'feature')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('disabled hook is inert (no file written)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cguard-'))
  try {
    const hook = createConstellationRuntimeHook({
      enabled: false, cwd, sessionId: 's', getTaskSummary: () => summary(),
    })
    await hook.run({} as never)
    assert.equal(existsSync(constellationPath(cwd)), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('no milestone is written when no mark was left (safety-net removed)', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cguard-'))
  try {
    const hook = createConstellationRuntimeHook({
      enabled: true, cwd, sessionId: 'sess',
      getTaskSummary: () => summary({ writeFileCount: 3 }),
      getChronicleEntries: () => [{ type: 'milestone', turn: 1, timestamp: 1, summary: 'shipped X', files: ['a.ts'] }],
      now: () => 5000,
    })
    await hook.run({} as never)
    const c = loadConstellation(cwd)
    assert.equal(c?.milestones.length ?? 0, 0)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('no constellation file created when session changed no files and no mark left', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cguard-'))
  try {
    const hook = createConstellationRuntimeHook({
      enabled: true, cwd, sessionId: 'sess',
      getTaskSummary: () => summary({ writeFileCount: 0 }),
      getChronicleEntries: () => [],
      now: () => 5000,
    })
    await hook.run({} as never)
    assert.equal(existsSync(constellationPath(cwd)), false)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('enabled hook never throws even when a source explodes', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'cguard-'))
  try {
    const hook = createConstellationRuntimeHook({
      enabled: true, cwd, sessionId: 's',
      getTaskSummary: () => { throw new Error('boom') },
    })
    await assert.doesNotReject(async () => { await hook.run({} as never) })
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('milestone layer is render-only: appears in overlay output, not session state', () => {
  const theme = getTheme()
  const data: StarmapData = {
    entries: [{ name: 'yaoguang', glyph: '✦', description: 'deliver', active: true }],
    milestones: ['● ✓ shipped the thing — yaoguang·#7281·⚘, 2h ago'],
    recognitionLine: '↻ kindred agent #4242·⚘ returns (sim 0.82)',
  }
  const lines = renderStarmap(data, 80, 24, theme)
  const text = lines.join('\n').replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
  assert.match(text, /Milestones/)
  assert.match(text, /shipped the thing/)
  assert.match(text, /kindred agent/)
})
