import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createDelegateTaskTool, formatUiContent, type DelegateTaskCoordinator } from '../delegate-task.js'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import { profileRegistry } from '../../agent/profile-registry.js'
import { MAX_BUDGET_CONTINUATIONS, MAX_HANDS_EXTRA_RUNS } from '../../agent/worker-continuation.js'
import { starDomainRegistry } from '../../agent/star-domain-registry.js'

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function makeRun(): CoordinatorRun {
  return {
    status: 'completed',
    selectedModel: 'deepseek-v4-pro',
    results: [{
      workOrderId: 'wo_1',
      status: 'passed',
      summary: 'Worker found the seam.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
    }],
    packet: '<worker_results>packet</worker_results>',
  }
}

describe('DELEGATE_TASK_TOOL', () => {
  it('终态经 mapper.finish 排在合并尾沿之后，延迟 timer 不再补发 running', async () => {
    const events: Array<{ status: string; eventKind?: string; eventDetail?: string }> = []
    const coordinator: DelegateTaskCoordinator = {
      delegate: async request => {
        request.onActivity?.({
          workOrderId: 'wo_1',
          profile: 'code_scout',
          kind: 'text',
          detail: 'tail',
        })
        return makeRun()
      },
    }
    const tool = createDelegateTaskTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_mapper_finish',
      cwd: '/repo',
      input: { objective: 'flush the activity tail' },
      onWorkerActivity: (event: any) => events.push(event),
    } as any)

    assert.deepEqual(events.map(event => [event.status, event.eventKind, event.eventDetail]), [
      ['running', 'text', 'tail'],
      ['passed', undefined, undefined],
    ])
    await sleep(150)
    assert.equal(events.length, 2)
  })

  it('validates input and calls the coordinator', async () => {
    const calls: DelegationRequest[] = []
    const coordinator: DelegateTaskCoordinator = {
      delegate: async request => {
        calls.push(request)
        return makeRun()
      },
    }
    const tool = createDelegateTaskTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      reviewDepth: 2,
      input: {
        objective: 'Find routing seams across the runtime modules.',
        files: ['src/main.tsx', 'src/agent/loop.ts'],
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.parentTurnId, 'tu_delegate')
    assert.equal(calls[0]!.kind, 'code_search')
    assert.equal(calls[0]!.profile, 'code_scout')
    assert.deepEqual(calls[0]!.scope.files, ['src/main.tsx', 'src/agent/loop.ts'])
    assert.equal(calls[0]!.reviewDepth, 2)
    assert.equal(result.isError, false)
    assert.ok(result.content.includes('<worker_results>'))
    assert.ok(result.uiContent!.includes('delegate_task · 1/1 通过'))
  })

  it('passes authority through to the coordinator', async () => {
    const calls: DelegationRequest[] = []
    const coordinator: DelegateTaskCoordinator = {
      delegate: async request => {
        calls.push(request)
        return makeRun()
      },
    }
    const tool = createDelegateTaskTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: {
        objective: 'Review the architecture of the routing layer.',
        authority: 'tianquan',
      },
    })

    assert.equal(result.isError, false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.authority, 'tianquan')
  })

  it('rejects an unknown authority value', async () => {
    const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
    const result = await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: { objective: 'do a thing', authority: 'not_a_domain' },
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('无效的 delegate_task 输入'))
  })

  it('accepts authority values from the star-domain registry (schema slimmed to plain string)', () => {
    // P0 schema slimming (commit 2b04fddd) dropped the inline `enum` on authority to
    // save prefix-cache tokens; validation is now a dynamic refine against the
    // star-domain registry (so user-loaded domains are accepted too). Assert the
    // registry exposes the built-in domain ids and the schema stays a bare string.
    const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
    const authoritySchema = tool.definition.input_schema!.properties.authority as { type: string; enum?: string[] }
    assert.equal(authoritySchema.type, 'string')
    assert.equal(authoritySchema.enum, undefined, 'authority schema should be slimmed (no inline enum)')
    const domainIds = starDomainRegistry.getDomainIds()
    assert.ok(domainIds.includes('tianquan'))
    assert.ok(domainIds.includes('tianji'))
  })

  it('exposes profile schema from the profile registry', () => {
    const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
    const profileSchema = tool.definition.input_schema!.properties.profile as { enum: string[] }

    assert.deepEqual(profileSchema.enum, profileRegistry.getProfileNames())
    assert.ok(profileSchema.enum.includes('adversarial_verifier'))
    assert.ok(profileSchema.enum.includes('architect'))
    assert.ok(profileSchema.enum.includes('troubleshooter'))
  })

  it('reports invalid input as a tool error', async () => {
    const coordinator: DelegateTaskCoordinator = {
      delegate: async () => makeRun(),
    }
    const tool = createDelegateTaskTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: { objective: '' },
    })

    assert.equal(result.isError, true)
    assert.ok(result.content.includes('无效的 delegate_task 输入'))
  })

  it('does not require approval and is concurrency safe', () => {
    const tool = createDelegateTaskTool({ delegate: async () => makeRun() })

    assert.equal(tool.requiresApproval({ toolUseId: 'x', cwd: '/repo', input: {} }), false)
    assert.equal(tool.isConcurrencySafe(), true)
    assert.equal(tool.isEnabled(), true)
  })

  it('passes resume param through to the coordinator', async () => {
    const calls: DelegationRequest[] = []
    const coordinator: DelegateTaskCoordinator = {
      delegate: async request => {
        calls.push(request)
        return makeRun()
      },
    }
    const tool = createDelegateTaskTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: {
        objective: 'Continue the previous search with a different angle.',
        resume: 'wo_abc123',
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.resumeWorkOrderId, 'wo_abc123')
  })

  it('resume is optional — not passing it yields undefined resumeWorkOrderId', async () => {
    const calls: DelegationRequest[] = []
    const coordinator: DelegateTaskCoordinator = {
      delegate: async request => {
        calls.push(request)
        return makeRun()
      },
    }
    const tool = createDelegateTaskTool(coordinator)

    await tool.execute({
      toolUseId: 'tu_delegate',
      cwd: '/repo',
      input: {
        objective: 'Find routing seams across the runtime modules.',
      },
    })

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.resumeWorkOrderId, undefined)
  })

  describe('progressive timeout', () => {
    const base = { input: {}, toolUseId: 'tu', cwd: '/tmp' }
    // P0: tool-level timeout = ladder/profile budget + 30s exit grace, so the
    // worker's internal budget timer always fires first (preserving partial output).
    const GRACE = 30_000
    // 预算耗尽会自动续跑，每一轮都是一次带完整 budget 的 runWorker——外层必须覆盖
    // 最坏运行次数，否则续跑撞上工具层硬 reject，连首轮 partial 都一起丢。
    const RUNS = 1 + MAX_BUDGET_CONTINUATIONS
    const HANDS_RUNS = 1 + MAX_HANDS_EXTRA_RUNS

    it('returns 120s ladder × runs + grace for turn 0-1 (cold open)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 0 }), 120_000 * RUNS + GRACE)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 1 }), 120_000 * RUNS + GRACE)
    })

    it('returns 240s ladder × runs + grace for turn 2-4 (warming)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 2 }), 240_000 * RUNS + GRACE)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 4 }), 240_000 * RUNS + GRACE)
    })

    it('returns 480s ladder × runs + grace for turn 5+ (mature)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 5 }), 480_000 * RUNS + GRACE)
      assert.equal(tool.timeoutMs?.({ ...base, sessionTurnCount: 30 }), 480_000 * RUNS + GRACE)
    })

    it('defaults to mature when sessionTurnCount is undefined', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(tool.timeoutMs?.(base), 480_000 * RUNS + GRACE)
      assert.equal(tool.timeoutMs?.(), 480_000 * RUNS + GRACE)
    })

    it('profile defaultTimeoutMs dominates the ladder (reviewer = 600s)', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(
        tool.timeoutMs?.({ ...base, input: { profile: 'reviewer' }, sessionTurnCount: 0 }),
        600_000 * RUNS + GRACE,
      )
      // Scouts now carry their own 480s budget (session 2c1186f5: 240s ladder
      // hard-killed scouts mid-report) — no longer a ladder example.
      assert.equal(
        tool.timeoutMs?.({ ...base, input: { profile: 'code_scout' }, sessionTurnCount: 0 }),
        480_000 * RUNS + GRACE,
      )
      // Profiles without defaultTimeoutMs keep the ladder；verifier 是写工，
      // 它在 worktree 内的续跑与两轮修复共用 MAX_HANDS_EXTRA_RUNS 的总账。
      assert.equal(
        tool.timeoutMs?.({ ...base, input: { profile: 'verifier' }, sessionTurnCount: 0 }),
        120_000 * HANDS_RUNS + GRACE,
      )
    })

    it('按次 timeoutMs 抬高外层天花板——否则调大的内层预算会被外层先开枪打断', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      assert.equal(
        tool.timeoutMs?.({ ...base, input: { profile: 'architect', timeoutMs: 900_000 }, sessionTurnCount: 0 }),
        900_000 * RUNS + GRACE,
      )
      // 调小不收紧外层：内层自己会先开枪，外层留富余只是天花板。
      assert.equal(
        tool.timeoutMs?.({ ...base, input: { profile: 'reviewer', timeoutMs: 60_000 }, sessionTurnCount: 0 }),
        600_000 * RUNS + GRACE,
      )
    })
  })

  describe('按次预算（Wave 9）', () => {
    it('maxTurns / timeoutMs 透传成 WorkOrder budget 覆盖', async () => {
      const calls: DelegationRequest[] = []
      const tool = createDelegateTaskTool({ delegate: async r => { calls.push(r); return makeRun() } })

      await tool.execute({
        toolUseId: 'tu',
        cwd: '/repo',
        input: { objective: '查一个 URL 的当前状态', maxTurns: 6, timeoutMs: 60_000 },
      })

      assert.deepEqual(calls[0]!.budget, { maxTurns: 6, timeoutMs: 60_000 })
    })

    it('不给预算就不覆盖——profile 默认值继续生效', async () => {
      const calls: DelegationRequest[] = []
      const tool = createDelegateTaskTool({ delegate: async r => { calls.push(r); return makeRun() } })
      await tool.execute({ toolUseId: 'tu', cwd: '/repo', input: { objective: '扫一遍路由层' } })
      assert.equal(calls[0]!.budget, undefined)
    })

    it('越界预算被 schema 拦下，不静默夹紧', async () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      const tooManyTurns = await tool.execute({
        toolUseId: 'tu', cwd: '/repo', input: { objective: 'x', maxTurns: 500 },
      })
      assert.equal(tooManyTurns.isError, true)
      const tooShort = await tool.execute({
        toolUseId: 'tu', cwd: '/repo', input: { objective: 'x', timeoutMs: 1000 },
      })
      assert.equal(tooShort.isError, true)
    })

    it('两个预算字段都出现在工具 schema 里', () => {
      const tool = createDelegateTaskTool({ delegate: async () => makeRun() })
      const props = tool.definition.input_schema!.properties
      assert.equal((props.maxTurns as { type: string }).type, 'integer')
      assert.equal((props.timeoutMs as { type: string }).type, 'integer')
    })
  })
})

describe('formatUiContent 多 worker digest 带身份', () => {
  it('派发侧盖章的 profile/authority 进 digest 行——匿名摘要映射不回任务', () => {
    const run: CoordinatorRun = {
      status: 'completed',
      selectedModel: 'm',
      results: [
        { workOrderId: 'wo_1', status: 'passed', summary: '查完了认证模块', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified', profile: 'code_scout', authority: 'tianxuan' },
        { workOrderId: 'wo_2', status: 'blocked', summary: '没找到入口', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified', profile: 'doc_scout' },
      ],
      packet: '',
    }
    const ui = formatUiContent(run)
    assert.ok(ui.includes('天璇·侦察代码'), `行内应有星域+职能身份：${ui}`)
    // 无 authority 的行退化为纯职能身份，两条结果可以区分
    assert.ok(ui.includes('侦察文档'), `第二行应有可区分身份：${ui}`)
  })
})
