import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createGalaxyTool, type GalaxyCoordinator } from '../galaxy.js'
import { deriveStableWorkOrderId, type CoordinatorRun, type DelegationRequest } from '../../agent/coordinator.js'

function makeRun(requests: DelegationRequest[]): CoordinatorRun {
  return {
    status: 'completed',
    results: requests.map(r => ({
      workOrderId: deriveStableWorkOrderId(r.parentTurnId ?? '') ?? r.parentTurnId ?? 'wo_unknown',
      status: 'passed',
      summary: 'Worker completed.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified',
      // 真实 coordinator 会把派发侧身份盖章进 WorkerResult（work-order.ts
      // workerResultSchema.profile/authority）——mock 同形，供终态透传断言。
      profile: r.profile,
      authority: r.authority,
    })),
    packet: '<worker_results>packet</worker_results>',
  }
}

function capturingCoordinator(calls: Array<{ requests: DelegationRequest[] }>): GalaxyCoordinator {
  return {
    delegateBatch: async (requests) => {
      calls.push({ requests })
      return makeRun(requests)
    },
  }
}

describe('GALAXY_TOOL', () => {
  it('DP 副本跨维度不撞 work order ID（B2 回归）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_dp',
      cwd: '/repo',
      input: {
        objective: '两个 DP 维度各两个只读副本',
        dimensions: [
          { name: 'verify', objective: '独立验证同一证据', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'research', objective: '独立调研同一问题', authority: 'tianxuan', parallelism: 'data', replicas: 2 },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const ids = calls[0]!.requests.map(r => deriveStableWorkOrderId(r.parentTurnId ?? ''))
    assert.equal(ids.length, 4)
    assert.equal(new Set(ids).size, 4, `work order IDs must be unique, got: ${ids.join(', ')}`)
  })

  it('只读单 authority 维度不追加写工 TDD 要求（W4）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_ro',
      cwd: '/repo',
      input: {
        objective: '一个写工维度 + 一个只读维度',
        dimensions: [
          { name: 'frontend', objective: '实现 UI 组件', authority: 'wenqu' },
          { name: 'search', objective: '检索相关代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const reqs = calls[0]!.requests
    const writer = reqs.find(r => r.profile === 'patcher')!
    const reader = reqs.find(r => r.profile === 'code_scout')!
    assert.ok(writer.objective.includes('工业级交付要求'), 'write-capable worker should get TDD requirements')
    assert.ok(!reader.objective.includes('工业级交付要求'), 'read-only worker must not get TDD requirements')
    assert.ok(reader.objective.includes('只读分析'), 'read-only worker should get read-only instructions')
  })

  it('外层超时按有效 profile 与 autoReview 波次放宽（W2）', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun([]) })
    const execDims = [
      { name: 'frontend', objective: '实现 UI', authority: 'wenqu' },
      { name: 'backend', objective: '实现逻辑', authority: 'tianji' },
    ]

    const withReview = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: execDims, autoReview: true } } as any)
    const withoutReview = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: execDims, autoReview: false } } as any)
    assert.ok(withReview! > withoutReview!, `autoReview wave must widen the budget (${withReview} vs ${withoutReview})`)

    // profile 省略时执行侧会落到 patcher（写工，续跑轮次更多）——外层不能按只读算
    const readOnlyDims = execDims.map(d => ({ ...d, profile: 'code_scout' }))
    const writeBudget = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: execDims, autoReview: false } } as any)
    const readBudget = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: readOnlyDims, autoReview: false } } as any)
    assert.ok(writeBudget! > readBudget!, `effective write profile must widen the budget (${writeBudget} vs ${readBudget})`)
  })

  it('tierFloor=strong 维度按 1.5x 放大外层超时预算（P2-5）', async () => {
    const tool = createGalaxyTool({ delegateBatch: async () => makeRun([]) })
    const dims = [
      { name: 'review', objective: '审查改动', authority: 'yaoguang' },
      { name: 'search', objective: '检索代码', authority: 'tianji', profile: 'code_scout' },
    ]
    const base = tool.timeoutMs?.({ sessionTurnCount: 5, input: { dimensions: dims, autoReview: false } } as any)
    const strong = tool.timeoutMs?.({ sessionTurnCount: 5, input: {
      dimensions: dims.map(d => ({ ...d, tierFloor: 'strong' })),
      autoReview: false,
    } } as any)
    assert.ok(strong! > base!, `strong tierFloor must widen the timeout (${strong} vs ${base})`)
  })

  it('报告展示聚合缓存用量与 DP per-replica cacheRead（P0-2）', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => ({
        status: 'completed',
        results: requests.map((r, i) => ({
          workOrderId: deriveStableWorkOrderId(r.parentTurnId ?? '') ?? r.parentTurnId ?? 'wo_unknown',
          status: 'passed' as const,
          summary: 'Worker completed.',
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified' as const,
          usage: { input_tokens: 1000, output_tokens: 50, cache_read_input_tokens: (i + 1) * 100 },
        })),
        packet: '',
      }),
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_usage',
      cwd: '/repo',
      input: {
        objective: 'DP 用量展示',
        dimensions: [
          { name: 'verify', objective: '独立验证同一证据', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '检索相关代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.ok(result.content.includes('缓存用量'), '报告必须含聚合缓存用量行')
    assert.ok(result.content.includes('input Σ3000'), `聚合 input 应求和，got:\n${result.content}`)
    assert.ok(result.content.includes('cacheRead Σ600'), `聚合 cacheRead 应求和，got:\n${result.content}`)
    assert.ok(result.content.includes('replica cacheRead: 100 / 200'), `DP 组必须含 per-replica cacheRead 行，got:\n${result.content}`)
  })

  it('终态事件与批次进度经 onWorkerActivity/onOutput 上行（P1-2）', async () => {
    const terminalEvents: Array<{ workOrderId?: string; status?: string; authority?: string; profile?: string }> = []
    const outputs: string[] = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests, _policy, _signal, onProgress, onWorkerSettled) => {
        const run = makeRun(requests)
        for (const r of run.results) onWorkerSettled?.(r)
        onProgress?.(run.results.length, requests.length)
        return run
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_stream',
      cwd: '/repo',
      input: {
        objective: '终态事件上行',
        dimensions: [
          { name: 'frontend', objective: '实现 UI', authority: 'wenqu' },
          { name: 'backend', objective: '实现逻辑', authority: 'tianji' },
        ],
        autoReview: false,
        confirm: true,
      },
      onWorkerActivity: (ev: any) => { if (ev.status) terminalEvents.push(ev) },
      onOutput: (text: string) => outputs.push(text),
    } as any)

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.equal(terminalEvents.length, 2, '每个 worker 落定必须发一条终态事件')
    assert.ok(terminalEvents.every(e => e.status === 'passed'))
    // 终态必须带派发侧身份——否则 worker 完成后面板星域信息断流（回退机器 ID 脸）。
    const authorities = terminalEvents.map(e => e.authority).sort()
    assert.deepEqual(authorities, ['tianji', 'wenqu'], '终态事件必须透传 authority')
    assert.ok(terminalEvents.every(e => typeof e.profile === 'string' && e.profile.length > 0), '终态事件必须透传 profile')
    assert.ok(outputs.some(t => t.includes('galaxy progress: 2/2')), `批次进度必须走 onOutput，got: ${outputs.join('')}`)
  })

  it('未核验发现触发核验护栏行（P1-2）', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => {
        const run = makeRun(requests)
        run.results[0]!.findings.push({ claim: '疑似空指针', evidence: ['src/a.ts:12'] } as any)
        return run
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_guard',
      cwd: '/repo',
      input: {
        objective: '护栏行',
        dimensions: [
          { name: 'search', objective: '检索相关代码', authority: 'tianji', profile: 'code_scout' },
          { name: 'research', objective: '调研方案', authority: 'tianxuan' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.ok(result.content.includes('待核验假设'), `有未核验发现时必须出现护栏行，got:\n${result.content}`)
  })

  it('文件重叠：只读维度不去重、可写维度剥离且显式进报告（P2-1）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_overlap',
      cwd: '/repo',
      input: {
        objective: '两个写工维度文件重叠 + 一个只读维度同文件',
        dimensions: [
          { name: 'frontend', objective: '实现 UI', authority: 'wenqu', files: ['src/a.ts', 'src/b.ts'] },
          { name: 'backend', objective: '实现逻辑', authority: 'tianji', files: ['src/a.ts', 'src/c.ts'] },
          { name: 'search', objective: '只读检索同一文件', authority: 'tianxuan', profile: 'code_scout', files: ['src/a.ts'] },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const reqs = calls[0]!.requests
    const byProfile = (p: string) => reqs.filter(r => r.profile === p)
    const frontend = byProfile('patcher').find(r => r.authority === 'wenqu')!
    const backend = byProfile('patcher').find(r => r.authority === 'tianji')!
    const reader = byProfile('code_scout')[0]!
    assert.deepEqual(frontend.scope?.files, ['src/a.ts', 'src/b.ts'], '首个可写维度保留全部文件')
    assert.deepEqual(backend.scope?.files, ['src/c.ts'], '后写维度被剥离重叠文件')
    assert.deepEqual(reader.scope?.files, ['src/a.ts'], '只读维度不参与去重')
    assert.ok(result.content.includes('文件重叠已剥离'), `剥离清单必须进报告，got:\n${result.content}`)
    assert.ok(result.content.includes('src/a.ts'), '被剥离文件必须可见')
  })

  it('文件全被夺走的写维度被跳过并入报告（M3：不派到 scope 闸撞墙）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_emptied',
      cwd: '/repo',
      input: {
        objective: '两个写维度文件完全相同——后者全部文件被夺走',
        dimensions: [
          { name: 'frontend', objective: '实现 UI', authority: 'wenqu', files: ['src/a.ts'] },
          { name: 'backend', objective: '实现逻辑', authority: 'tianji', files: ['src/a.ts'] },
          { name: 'search', objective: '检索相关代码', authority: 'tianxuan', profile: 'code_scout', files: ['src/z.ts'] },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const reqs = calls[0]!.requests
    assert.ok(reqs.some(r => r.authority === 'wenqu'), '首个写维度保留并派发')
    assert.ok(!reqs.some(r => r.authority === 'tianji' && r.profile === 'patcher'), '文件全被夺走的写维度不再派发')
    assert.ok(reqs.some(r => r.profile === 'code_scout'), '只读维度不受影响')
    assert.ok(result.content.includes('已跳过派发'), `被夺走维度必须入报告，got:\n${result.content}`)
    assert.ok(result.content.includes('backend'), '被跳过维度名必须可见')
  })

  it('tierFloor 透传到 DelegationRequest（P2-2）', async () => {
    const calls: Array<{ requests: DelegationRequest[] }> = []
    const tool = createGalaxyTool(capturingCoordinator(calls))

    const result = await tool.execute({
      toolUseId: 'tu_floor',
      cwd: '/repo',
      input: {
        objective: '护栏席位声明 strong 档',
        dimensions: [
          { name: 'review', objective: '审查改动', authority: 'yaoguang', tierFloor: 'strong' },
          { name: 'search', objective: '检索代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const review = calls[0]!.requests.find(r => r.tierFloor === 'strong')
    assert.ok(review, 'tierFloor 必须透传到 request')
  })

  it('modelOverride 与实际模型不一致时报告标注回退（P2-3）', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => ({
        ...makeRun(requests),
        workerModels: requests.map(r => ({
          workOrderId: deriveStableWorkOrderId(r.parentTurnId ?? '') ?? r.parentTurnId ?? 'wo_unknown',
          model: 'actual-cheap-model',
        })),
      }),
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_fb',
      cwd: '/repo',
      input: {
        objective: '回退可见性',
        dimensions: [
          { name: 'review', objective: '强模型审查', authority: 'yaoguang', modelOverride: { provider: 'deepseek', model: 'requested-strong-model' } },
          { name: 'search', objective: '检索代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    assert.ok(
      result.content.includes('模型回退：请求 requested-strong-model → 实际 actual-cheap-model'),
      `静默回退必须进报告，got:\n${result.content}`,
    )
  })

  it('DP quorum 未达成时 tool result 标记 isError（P2-4 判定层断层修复）', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => {
        const run = makeRun(requests)
        // DP 组两个副本都 failed——quorum 应为 2/2+1=2，0 passed < 2 → not reached
        for (const r of run.results) {
          r.status = 'failed'
          r.summary = 'replica failed'
        }
        return run
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_quorum_fail',
      cwd: '/repo',
      input: {
        objective: 'DP quorum 失败',
        dimensions: [
          { name: 'verify', objective: '独立验证同一证据', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '检索相关代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, true, `DP quorum 未达成时 isError 必须为 true，got: ${result.isError}`)
    assert.ok(result.content.includes('quorum not reached'), `报告必须含 quorum 失败信息，got:\n${result.content}`)
  })

  it('DP quorum 达成时 tool result 不标记 isError（P2-4 回归）', async () => {
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => ({
        ...makeRun(requests),
        // 两个副本都 passed——quorum 达成
      }),
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_quorum_pass',
      cwd: '/repo',
      input: {
        objective: 'DP quorum 通过',
        dimensions: [
          { name: 'verify', objective: '独立验证同一证据', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '检索相关代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `quorum 达成时 isError 应为 undefined，got: ${result.isError}`)
    assert.ok(result.content.includes('quorum reached'), `报告必须含 quorum 达成信息，got:\n${result.content}`)
  })

  it('DP 存在时顶层 policy 为 quorum 且请求带组级 quorumK（收编 #1 透传）', async () => {
    let capturedPolicy: import('../../agent/work-order.js').AggregationPolicy | undefined
    let capturedRequests: DelegationRequest[] = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests, policy) => {
        capturedPolicy = policy
        capturedRequests = requests
        return makeRun(requests)
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_qk',
      cwd: '/repo',
      input: {
        objective: 'DP 加 EP 混合',
        dimensions: [
          { name: 'verify', objective: '独立验证同一证据', authority: 'yaoguang', parallelism: 'data', replicas: 3 },
          { name: 'search', objective: '检索相关代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    // 顶层 policy：DP 存在 → quorum 对象（无组 worker 独立判定 k=1）
    assert.equal(typeof capturedPolicy, 'object')
    assert.equal((capturedPolicy as { kind: string }).kind, 'quorum')
    // DP 请求带组级 quorumK = floor(3/2)+1 = 2；EP 请求不携带
    const dpReqs = capturedRequests.filter(r => r.groupId?.startsWith('galaxy:data:'))
    const epReqs = capturedRequests.filter(r => !r.groupId)
    assert.equal(dpReqs.length, 3)
    assert.ok(dpReqs.every(r => r.quorumK === 2), `DP quorumK 应为 2，got: ${dpReqs.map(r => r.quorumK).join(',')}`)
    assert.equal(epReqs.length, 1)
    assert.equal(epReqs[0]!.quorumK, undefined)
  })

  it('DP quorumK 公式：2 副本必须 k=2（双证据采信，ceil 退化为 1 的回归钉死）', async () => {
    let capturedRequests: DelegationRequest[] = []
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests) => {
        capturedRequests = requests
        return makeRun(requests)
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({
      toolUseId: 'tu_qk2',
      cwd: '/repo',
      input: {
        objective: 'DP 双副本独立验证同一证据的强一致判定',
        dimensions: [
          { name: 'verify', objective: '独立验证同一证据', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '检索相关代码', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
      },
    })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const dpReqs = capturedRequests.filter(r => r.groupId?.startsWith('galaxy:data:'))
    assert.equal(dpReqs.length, 2)
    // floor(2/2)+1 = 2：双副本必须双双通过才采信组结论；ceil(2/2)=1 会让
    // 单副本通过即放行（单证据关闭），DP 冗余语义尽失。
    assert.ok(dpReqs.every(r => r.quorumK === 2), `DP quorumK 应为 2，got: ${dpReqs.map(r => r.quorumK).join(',')}`)
  })

  it('无 DP 时 policy 保持用户显式值；DP 显式 quorum 通过拦截（收编 #1 拦截适配）', async () => {
    let capturedPolicy: import('../../agent/work-order.js').AggregationPolicy | undefined
    const coordinator: GalaxyCoordinator = {
      delegateBatch: async (requests, policy) => {
        capturedPolicy = policy
        return makeRun(requests)
      },
    }
    const tool = createGalaxyTool(coordinator)

    // 无 DP：显式 all_required 原样透传
    const ep = await tool.execute({
      toolUseId: 'tu_ep',
      cwd: '/repo',
      input: {
        objective: 'EP 场景',
        dimensions: [
          { name: 'search', objective: '检索', authority: 'tianji', profile: 'code_scout' },
          { name: 'plan', objective: '规划', authority: 'tianquan', profile: 'planner' },
        ],
        autoReview: false,
        confirm: true,
        policy: 'all_required',
      },
    })
    assert.equal(ep.isError, undefined)
    assert.equal(capturedPolicy, 'all_required')

    // DP + 显式 quorum：放行（此前拦截 all_required 以外的所有策略）
    const dp = await tool.execute({
      toolUseId: 'tu_dp_q',
      cwd: '/repo',
      input: {
        objective: 'DP quorum 显式',
        dimensions: [
          { name: 'verify', objective: '独立验证', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '检索', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
        policy: { kind: 'quorum', k: 2 },
      },
    })
    assert.equal(dp.isError, undefined, `DP 显式 quorum 应放行，got: ${dp.content}`)
    assert.equal((capturedPolicy as unknown as { kind: 'quorum'; k: number }).k, 2)

    // DP + first_success：仍拦截
    const blocked = await tool.execute({
      toolUseId: 'tu_dp_fs',
      cwd: '/repo',
      input: {
        objective: 'DP 非法策略',
        dimensions: [
          { name: 'verify', objective: '独立验证', authority: 'yaoguang', parallelism: 'data', replicas: 2 },
          { name: 'search', objective: '检索', authority: 'tianji', profile: 'code_scout' },
        ],
        autoReview: false,
        confirm: true,
        policy: 'first_success',
      },
    })
    assert.equal(blocked.isError, true)
    assert.ok(blocked.content.includes('拦截'))
  })
})

describe('GALAXY_TOOL — DP 证据冗余（收编 #2）', () => {
  function dpInput() {
    return {
      objective: '双副本验证同一证据',
      dimensions: [
        { name: 'verify', objective: '独立验证注入链', authority: 'yaoguang', parallelism: 'data', replicas: 2, files: ['src/a.ts'] },
        { name: 'search', objective: '检索代码', authority: 'tianji', profile: 'code_scout' },
      ],
      autoReview: false,
      confirm: true,
    }
  }

  it('k 个独立 verified 副本凑齐 → 冗余义务 satisfied', async () => {
    const { ObligationTracker } = await import('../../agent/obligation-tracker.js')
    const tracker = new ObligationTracker()
    const tool = createGalaxyTool({ ...capturingCoordinator([]), obligationTracker: tracker })

    const result = await tool.execute({ toolUseId: 'tu_ob1', cwd: '/repo', input: dpInput() })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const obs = tracker.getStore().obligations
    assert.equal(obs.length, 1, 'DP 维度必须创建一条冗余义务')
    assert.equal(obs[0]!.redundancy?.k, 2)
    assert.equal(obs[0]!.satisfyCount, 2)
    assert.equal(obs[0]!.state, 'satisfied')
  })

  it('只有 1 个 verified 副本 → 义务保持 attempted（deliver 门禁会拦）', async () => {
    const { ObligationTracker } = await import('../../agent/obligation-tracker.js')
    const tracker = new ObligationTracker()
    const coordinator: GalaxyCoordinator = {
      obligationTracker: tracker,
      delegateBatch: async (requests) => {
        const run = makeRun(requests)
        // 第二个 DP 副本自我降级 unverified（冒烟真实形态）
        const dpIds = requests
          .filter(r => r.parentTurnId?.includes('-galaxy-0:'))
          .map(r => deriveStableWorkOrderId(r.parentTurnId ?? '') ?? '')
        const second = run.results.find(r => r.workOrderId === dpIds[1])
        if (second) (second as any).evidenceStatus = 'unverified'
        return run
      },
    }
    const tool = createGalaxyTool(coordinator)

    const result = await tool.execute({ toolUseId: 'tu_ob2', cwd: '/repo', input: dpInput() })

    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
    const obs = tracker.getStore().obligations
    assert.equal(obs.length, 1)
    assert.equal(obs[0]!.satisfyCount, 1, 'unverified 副本不计数')
    assert.equal(obs[0]!.state, 'attempted', 'k=2 未凑齐不得关闭')
  })

  it('无 obligationTracker 时不创建义务（向后兼容）', async () => {
    const tool = createGalaxyTool(capturingCoordinator([]))
    const result = await tool.execute({ toolUseId: 'tu_ob3', cwd: '/repo', input: dpInput() })
    assert.equal(result.isError, undefined, `unexpected error: ${result.content}`)
  })
})
