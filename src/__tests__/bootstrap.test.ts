import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupStaleWorkerSessionDirs, restorePlanModeFromMeta } from '../bootstrap.js'
import type { AgentLoop } from '../agent/loop.js'

describe('cleanupStaleWorkerSessionDirs', () => {
  let testCwd: string
  let sessionsDir: string
  let prevSessionDir: string | undefined

  before(() => {
    testCwd = mkdtempSync(join(tmpdir(), 'rivet-worker-cleanup-'))
    sessionsDir = join(testCwd, '.rivet', 'sessions')
    // getSessionDir(cwd) defaults to ~/.rivet/sessions/<slug>; pin it to the
    // test's own sessions dir so cleanup operates on the dirs we create here.
    prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_SESSION_DIR = sessionsDir
  })

  after(() => {
    if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
    else process.env.RIVET_SESSION_DIR = prevSessionDir
    rmSync(testCwd, { recursive: true, force: true })
  })

  it('removes stale worker dirs but keeps fresh ones and non-worker dirs', () => {
    // Stale worker dir — backdate mtime to 2 hours ago
    const staleDir = join(sessionsDir, 'worker-old')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'pheromones.json'), '{}')
    const twoHrsAgo = Date.now() / 1000 - 2 * 3600
    utimesSync(staleDir, twoHrsAgo, twoHrsAgo)

    // Fresh worker dir — just created, well within 1h threshold
    const freshDir = join(sessionsDir, 'worker-fresh')
    mkdirSync(freshDir, { recursive: true })
    writeFileSync(join(freshDir, 'pheromones.json'), '{}')

    // Non-worker dir — must never be touched regardless of age
    const mainDir = join(sessionsDir, 'main-session')
    mkdirSync(mainDir, { recursive: true })

    const cleaned = cleanupStaleWorkerSessionDirs(testCwd, 3_600_000)

    assert.equal(cleaned, 1)
    assert.ok(!existsSync(staleDir), 'stale worker dir should be removed')
    assert.ok(existsSync(freshDir), 'fresh worker dir should survive')
    assert.ok(existsSync(mainDir), 'non-worker dir must never be touched')
  })

  it('returns 0 when sessions dir does not exist', () => {
    const emptyCwd = mkdtempSync(join(tmpdir(), 'rivet-worker-empty-'))
    const saved = process.env.RIVET_SESSION_DIR
    process.env.RIVET_SESSION_DIR = join(emptyCwd, '.rivet', 'sessions')
    try {
      const cleaned = cleanupStaleWorkerSessionDirs(emptyCwd)
      assert.equal(cleaned, 0)
    } finally {
      process.env.RIVET_SESSION_DIR = saved
      rmSync(emptyCwd, { recursive: true, force: true })
    }
  })
})

describe('restorePlanModeFromMeta（计划模式跨重启恢复）', () => {
  function fakeAgent() {
    const calls: Array<{ planFilePath?: string }> = []
    const agent = { enterPlanMode: (opts?: { planFilePath?: string }) => { calls.push(opts ?? {}) } } as unknown as AgentLoop
    return { agent, calls }
  }

  it('meta 为 planning 且 draft 存在 → 重进计划模式并返回 draft 路径', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-plan-restore-'))
    try {
      const rel = '.rivet/plans/draft-123.md'
      mkdirSync(join(cwd, '.rivet', 'plans'), { recursive: true })
      writeFileSync(join(cwd, rel), '# 草稿')
      const { agent, calls } = fakeAgent()
      const restored = restorePlanModeFromMeta(agent, cwd, { planModeState: 'planning', activePlanFilePath: rel })
      assert.equal(restored, rel)
      assert.equal(calls.length, 1)
      assert.equal(calls[0]!.planFilePath, rel)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('draft 文件已删 → 静默降级为 off（不重进）', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-plan-restore-'))
    try {
      const { agent, calls } = fakeAgent()
      const restored = restorePlanModeFromMeta(agent, cwd, { planModeState: 'planning', activePlanFilePath: '.rivet/plans/draft-gone.md' })
      assert.equal(restored, null)
      assert.equal(calls.length, 0)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('meta 非 planning / 无 draft 指针 / null meta → 不动作', () => {
    const { agent, calls } = fakeAgent()
    assert.equal(restorePlanModeFromMeta(agent, '/tmp', { planModeState: 'off', activePlanFilePath: null }), null)
    assert.equal(restorePlanModeFromMeta(agent, '/tmp', { planModeState: 'planning' }), null)
    assert.equal(restorePlanModeFromMeta(agent, '/tmp', null), null)
    assert.equal(calls.length, 0)
  })

  it('Windows 反斜杠路径归一化后仍能命中', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-plan-restore-'))
    try {
      const rel = '.rivet/plans/draft-win.md'
      mkdirSync(join(cwd, '.rivet', 'plans'), { recursive: true })
      writeFileSync(join(cwd, rel), 'x')
      const { agent, calls } = fakeAgent()
      const restored = restorePlanModeFromMeta(agent, cwd, {
        planModeState: 'planning',
        activePlanFilePath: '.rivet\\plans\\draft-win.md',
      })
      assert.equal(restored, rel)
      assert.equal(calls[0]!.planFilePath, rel)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
