import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupStaleWorkerSessionDirs, restorePlanModeFromMeta, switchAgentCwd, resolveProviderAndAuth, type BootstrapContext } from '../bootstrap.js'
import { loadConfig } from '../config/manager.js'
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

  it('清理超龄 worker 文件（jsonl/meta），新鲜 worker 文件与主会话文件不动', () => {
    // evict 额度池已排除 worker——不清文件的话 worker jsonl 无限累积
    //（实测 46/65 个坑），这里接管其生命周期：7 天（fileThresholdMs）。
    const eightDaysAgo = Date.now() / 1000 - 8 * 24 * 3600
    const staleJsonl = join(sessionsDir, 'worker-wo_stale-1a2b3.jsonl')
    writeFileSync(staleJsonl, '{}\n')
    utimesSync(staleJsonl, eightDaysAgo, eightDaysAgo)
    const staleMeta = join(sessionsDir, 'worker-wo_stale-1a2b3.meta.json')
    writeFileSync(staleMeta, '{}')
    utimesSync(staleMeta, eightDaysAgo, eightDaysAgo)

    // 新鲜 worker 文件（刚写，7 天窗口内）
    const freshJsonl = join(sessionsDir, 'worker-wo_fresh-9z8y7.jsonl')
    writeFileSync(freshJsonl, '{}\n')

    // 主会话文件：无论多老都绝不能被 worker 清理碰到
    const mainJsonl = join(sessionsDir, 'main-old-session.jsonl')
    writeFileSync(mainJsonl, '{}\n')
    utimesSync(mainJsonl, eightDaysAgo, eightDaysAgo)

    const cleaned = cleanupStaleWorkerSessionDirs(testCwd)

    assert.equal(cleaned, 2, 'stale jsonl + meta 各计一次')
    assert.ok(!existsSync(staleJsonl), '超龄 worker jsonl 应被清理')
    assert.ok(!existsSync(staleMeta), '超龄 worker meta 应被清理')
    assert.ok(existsSync(freshJsonl), '窗口内 worker 文件应幸存')
    assert.ok(existsSync(mainJsonl), '主会话文件绝不能被 worker 清理碰到')
  })

  it('worker 文件阈值独立于目录阈值（1h 目录阈值不误伤 2h 前的 worker 文件）', () => {
    const twoHrsAgo = Date.now() / 1000 - 2 * 3600
    const file = join(sessionsDir, 'worker-wo_2h-file.jsonl')
    writeFileSync(file, '{}\n')
    utimesSync(file, twoHrsAgo, twoHrsAgo)

    const dir = join(sessionsDir, 'worker-2h-dir')
    mkdirSync(dir, { recursive: true })
    utimesSync(dir, twoHrsAgo, twoHrsAgo)

    const cleaned = cleanupStaleWorkerSessionDirs(testCwd)

    assert.ok(!existsSync(dir), '2h 目录超过 1h 阈值 → 清理')
    assert.ok(existsSync(file), '2h 文件在 7 天窗口内 → 保留（排查资产）')
    assert.equal(cleaned, 1)
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

describe('switchAgentCwd 守卫', () => {
  // 守卫（目录存在 → worker 存活 → plan mode）都在重建 machinery 之前，
  // 用最小假 ctx 即可驱动——guard 拒绝时函数不触碰其余字段。

  function fakeCtx(overrides: {
    cwd: string
    planModeState?: 'off' | 'planning' | 'approved'
    hasRunningWork?: boolean
  }): BootstrapContext {
    return {
      cwd: overrides.cwd,
      sessionId: 'guard-test',
      agent: {
        getPlanModeState: () => overrides.planModeState ?? 'off',
      },
      refs: {
        coordinator: overrides.hasRunningWork ? { hasRunningWork: () => true } : null,
      },
    } as unknown as BootstrapContext
  }

  it('目标目录不存在 → 拒绝', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cd-guard-'))
    try {
      const res = await switchAgentCwd(fakeCtx({ cwd }), join(cwd, 'no-such-dir'))
      assert.equal(res.ok, false)
      assert.match(res.error!, /目录不存在/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('worker 运行中 → 拒绝', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cd-guard-a-'))
    const target = mkdtempSync(join(tmpdir(), 'rivet-cd-guard-b-'))
    try {
      const res = await switchAgentCwd(fakeCtx({ cwd, hasRunningWork: true }), target)
      assert.equal(res.ok, false)
      assert.match(res.error!, /worker/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })

  it('plan mode 进行中（planning/approved）→ 拒绝，off 不拦', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'rivet-cd-guard-c-'))
    const target = mkdtempSync(join(tmpdir(), 'rivet-cd-guard-d-'))
    try {
      for (const state of ['planning', 'approved'] as const) {
        const res = await switchAgentCwd(fakeCtx({ cwd, planModeState: state }), target)
        assert.equal(res.ok, false, `${state} should be refused`)
        assert.match(res.error!, /Plan Mode/)
      }
      // 'off' 会穿过守卫进入后续迁移/重建流程——本测试只验证守卫不拦：
      // 用相同的 cwd 当 target，触发「已经在该目录中」提前返回即可证明越过了 plan 守卫。
      const res = await switchAgentCwd(fakeCtx({ cwd, planModeState: 'off' }), cwd)
      assert.match(res.error!, /已经在该目录中/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
})

describe('resolveProviderAndAuth allowMissingKey', () => {
  let dir = ''
  const envKeys = ['DEEPSEEK_API_KEY', 'ZHIPU_API_KEY']

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-resolve-auth-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
    for (const k of envKeys) delete process.env[k]
  })
  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    for (const k of envKeys) delete process.env[k]
    rmSync(dir, { recursive: true, force: true })
  })

  it('throws on missing key without allowMissingKey (原有行为)', () => {
    const config = loadConfig()  // DEFAULT_CONFIG 的 deepseek provider 无 inline key、env 也无
    assert.throws(
      () => resolveProviderAndAuth(config, 'deepseek'),
      /No API key configured/,
    )
  })

  it('returns empty apiKey with allowMissingKey (降级模式)', () => {
    const config = loadConfig()
    const result = resolveProviderAndAuth(config, 'deepseek', { allowMissingKey: true })
    assert.equal(result.apiKey, '')
    assert.equal(result.provider.name, 'deepseek')
    assert.equal(result.auth, undefined)
  })

  it('returns real apiKey when key is present even with allowMissingKey', () => {
    process.env.DEEPSEEK_API_KEY = 'sk-test-12345'
    const config = loadConfig()
    const result = resolveProviderAndAuth(config, 'deepseek', { allowMissingKey: true })
    assert.equal(result.apiKey, 'sk-test-12345', '有 key 时正常返回，allowMissingKey 不影响')
  })
})
