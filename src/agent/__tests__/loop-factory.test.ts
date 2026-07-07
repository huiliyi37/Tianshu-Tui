import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentLoop } from '../loop.js'
import { buildRuntimeSnapshot, createToolExecutionController, createSidePathUsageRecorder } from '../loop-factory.js'

/**
 * Safety net for the loop.ts decomposition (mid-loop). `buildRuntimeSnapshot`
 * is the field-mapping seam every RuntimeHook reads through; pinning it here
 * means a future extraction of snapshot construction out of AgentLoop cannot
 * silently drop or rename a field. It reads a bounded slice of AgentLoop, so a
 * structural stub is enough — no full loop wiring required.
 */
function fakeLoop(over: Partial<Record<string, unknown>> = {}): AgentLoop {
  const base = {
    cwd: '/work',
    session: { getTurnCount: () => 7 },
    recentToolHistory: [
      { tool: 'bash', status: 'ok', target: 'ls', extra: 'dropped' },
      { tool: 'read_file', status: 'error', target: 'a.ts' },
    ],
    sensorium: { mood: 'calm' },
    strategy: 'explore',
    vigorState: { level: 3 },
    gitChangeRate: 0.42,
    currentSeason: 'summer',
    thetaTelemetry: { lastTimedOut: true, consecutiveTimeouts: 2 },
    // 推理螺旋守护（886e85c7）后 snapshot 读取的新字段 — stub 必须补齐。
    lastThinkingContent: '',
    ...over,
  }
  return base as unknown as AgentLoop
}

test('buildRuntimeSnapshot maps the bounded AgentLoop slice into a snapshot', () => {
  const snap = buildRuntimeSnapshot(fakeLoop())
  assert.equal(snap.cwd, '/work')
  assert.equal(snap.turn, 7)
  assert.equal(snap.strategy, 'explore')
  assert.equal(snap.gitChangeRate, 0.42)
  assert.equal(snap.season, 'summer')
  assert.deepEqual(snap.vigor, { level: 3 })
  assert.deepEqual(snap.sensorium, { mood: 'calm' })
  assert.deepEqual(snap.thetaTelemetry, { lastTimedOut: true, consecutiveTimeouts: 2 })
})

test('buildRuntimeSnapshot projects recentToolHistory to tool/status/target only', () => {
  const snap = buildRuntimeSnapshot(fakeLoop())
  assert.deepEqual(snap.recentToolHistory, [
    { tool: 'bash', status: 'ok', target: 'ls', argsHash: undefined },
    { tool: 'read_file', status: 'error', target: 'a.ts', argsHash: undefined },
  ])
  // the source object's extra keys must not leak into the snapshot
  assert.equal('extra' in (snap.recentToolHistory[0] as object), false)
})

test('buildRuntimeSnapshot lets extra override mapped fields (hook augmentation)', () => {
  const snap = buildRuntimeSnapshot(fakeLoop(), { turn: 99, gitChangeRate: 1 })
  assert.equal(snap.turn, 99)
  assert.equal(snap.gitChangeRate, 1)
  // unrelated fields stay intact
  assert.equal(snap.cwd, '/work')
  assert.equal(snap.season, 'summer')
})

test('buildRuntimeSnapshot reads turn count live from the session each call', () => {
  let turns = 1
  const loop = fakeLoop({ session: { getTurnCount: () => turns } })
  assert.equal(buildRuntimeSnapshot(loop).turn, 1)
  turns = 5
  assert.equal(buildRuntimeSnapshot(loop).turn, 5)
})

/**
 * 防伪闭环 wiring: plan_close's evidence gate is only real if loop-factory threads
 * both accessors into the tool-execution deps. Pin the seam so a rename/drop of
 * either accessor fails here instead of silently degrading plan_close to legacy
 * trust-claimed behavior.
 */
test('createToolExecutionController wires assessDelivery + getVerificationEvidence when a gate exists', () => {
  const summary = { total: 0, verified: 0, pending: 0, files: [] }
  const gate = () => ({ state: 'GREEN' }) as never
  const self = {
    config: { deliveryGateV2: gate },
    evidence: { getVerificationSummary: () => summary },
  } as unknown as AgentLoop

  const controller = createToolExecutionController(self)
  const deps = (controller as unknown as { deps: Record<string, unknown> }).deps
  assert.equal(typeof deps.assessDelivery, 'function')
  assert.equal(typeof deps.getVerificationEvidence, 'function')
  assert.equal((deps.getVerificationEvidence as () => unknown)(), summary)
})

test('createToolExecutionController leaves assessDelivery undefined without a gate (graceful degradation)', () => {
  const self = {
    config: {},
    evidence: { getVerificationSummary: () => ({ total: 0, verified: 0, pending: 0, files: [] }) },
  } as unknown as AgentLoop

  const controller = createToolExecutionController(self)
  const deps = (controller as unknown as { deps: Record<string, unknown> }).deps
  assert.equal(deps.assessDelivery, undefined)
  assert.equal(typeof deps.getVerificationEvidence, 'function')
})

/**
 * 侧路 usage 记账（2026-07-06 成本盲区修复）：recorder 必须①走
 * addSidePathUsage（不污染占用估计锚点）②往 cache-log 落 event:'side_path'
 * 行。RIVET_SESSION_DIR 重定向到临时目录验证落盘字节。
 */
test('createSidePathUsageRecorder books usage and appends a side_path cache-log line', async () => {
  const { mkdtempSync, readFileSync, existsSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')

  const tmp = mkdtempSync(join(tmpdir(), 'sidepath-usage-'))
  const prevEnv = process.env.RIVET_SESSION_DIR
  process.env.RIVET_SESSION_DIR = tmp
  try {
    const booked: Array<Record<string, unknown>> = []
    const self = {
      cwd: '/work',
      session: { addSidePathUsage: (u: Record<string, unknown>) => { booked.push(u) } },
      config: { sessionId: 'test-session', promptEngine: { getModel: () => 'deepseek-v4' } },
    } as unknown as AgentLoop

    const record = createSidePathUsageRecorder(self)
    record('llm-speculation', {
      input_tokens: 95_000,
      output_tokens: 320,
      cache_read_input_tokens: 94_000,
      cache_creation_input_tokens: 500,
    })

    assert.equal(booked.length, 1)
    assert.equal(booked[0]!.input_tokens, 95_000)

    // cache-log write is fire-and-forget — poll briefly for the file.
    const logPath = join(tmp, 'test-session', 'cache-log.jsonl')
    const deadline = Date.now() + 2_000
    while (!existsSync(logPath)) {
      if (Date.now() > deadline) throw new Error('cache-log line never appeared')
      await new Promise(r => setTimeout(r, 10))
    }
    const line = JSON.parse(readFileSync(logPath, 'utf-8').trim())
    assert.equal(line.event, 'side_path')
    assert.equal(line.kind, 'llm-speculation')
    assert.equal(line.model, 'deepseek-v4')
    assert.equal(line.input, 95_000)
    assert.equal(line.cacheRead, 94_000)
    assert.equal(line.cacheCreate, 500)
    assert.equal(line.output, 320)
    assert.equal(line.hitRate, '98.9%')
  } finally {
    if (prevEnv === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prevEnv
  }
})

test('createSidePathUsageRecorder skips empty usage (no totals pollution, no log line)', () => {
  const booked: unknown[] = []
  const self = {
    cwd: '/work',
    session: { addSidePathUsage: (u: unknown) => { booked.push(u) } },
    config: { sessionId: 'test-session', promptEngine: { getModel: () => 'deepseek-v4' } },
  } as unknown as AgentLoop

  createSidePathUsageRecorder(self)('llm-speculation', {})
  assert.equal(booked.length, 0)
})
