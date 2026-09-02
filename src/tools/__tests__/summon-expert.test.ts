import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CoordinatorRun, DelegationRequest } from '../../agent/coordinator.js'
import type { WorkerResult } from '../../agent/work-order.js'
import { createSummonExpertTool } from '../summon-expert.js'
import { expertBenchStorageKey } from '../../agent/worker-session-persist.js'

function passed(id: string): WorkerResult {
  return {
    workOrderId: id,
    status: 'passed',
    summary: 'root cause found',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: ['apply minimal fix'],
    evidenceStatus: 'verified',
  } as WorkerResult
}

function coordinator(captured: DelegationRequest[], orderId = 'order-1') {
  return {
    delegate: async (request: DelegationRequest, _signal?: AbortSignal, onOrderCreated?: (id: string) => void) => {
      captured.push(request)
      onOrderCreated?.(orderId)
      const run: CoordinatorRun = {
        status: 'completed',
        results: [passed(orderId)],
        packet: 'ok',
        selectedModel: 'deepseek-v4-flash',
      }
      return run
    },
  }
}

describe('summon_expert（P2c）', () => {
  it('root_cause 展开为 troubleshooter+tianji+方法包+额外工具，并沉淀路由账本', async () => {
    const captured: DelegationRequest[] = []
    const saved: Array<{ kind: string; json: string }> = []
    const tool = createSummonExpertTool(coordinator(captured), {
      routingStore: { saveBanditState: (kind, json) => { saved.push({ kind, json }) } },
    })

    const result = await tool.execute({
      toolUseId: 'tu_sea',
      cwd: '/repo',
      sessionId: 's-sea',
      input: {
        expert: 'root_cause',
        objective: '定位 tsc 类型错误根因',
        files: ['src/a.ts'],
        evidence: ['TS2322: x not assignable to y'],
        trigger: 'verification-broken',
      },
    })

    assert.equal(result.isError, undefined)
    const req = captured[0]!
    assert.equal(req.profile, 'troubleshooter')
    assert.equal(req.authority, 'tianji')
    assert.equal(req.kind, 'code_search')
    assert.ok(req.extraAllowedTools?.includes('recall_capsule'))
    assert.ok(req.extraAllowedTools?.includes('run_tests'))
    assert.ok(req.constraints?.some(c => c.includes('诊断阶梯')), '方法包必须下传')
    assert.ok(req.constraints?.some(c => c.includes('TS2322')), '证据必须下传')
    assert.equal(req.budget?.maxTurns, 32)
    assert.equal(req.budget?.maxTokens, 32768, '专家上下文 token 上限必须下传')
    assert.equal(result.orchestration?.kind, 'expert')
    assert.equal((result.orchestration as { expert?: string }).expert, 'root_cause')
    assert.equal(saved.length, 1, '学习账本必须沉淀一条路由事实')
    const record = JSON.parse(saved[0]!.json) as { expert?: string; momentKind?: string; status?: string }
    assert.equal(record.expert, 'root_cause')
    assert.equal(record.momentKind, 'verification-broken')
    assert.equal(record.status, 'passed')
  })

  it('surgeon 首批 fail-closed，不派发', async () => {
    const captured: DelegationRequest[] = []
    const tool = createSummonExpertTool(coordinator(captured))

    const result = await tool.execute({
      toolUseId: 'tu_surgeon',
      cwd: '/repo',
      input: { expert: 'surgeon', objective: 'fix it', files: ['src/a.ts'] },
    })

    assert.equal(result.isError, true)
    assert.match(result.content, /首批未开放/)
    assert.equal(captured.length, 0)
  })

  it('expert bench：resume=true 复用进程内驻场 order id（键按项目隔离）', async () => {
    const captured: DelegationRequest[] = []
    const resumeStore = new Map<string, string>()
    const tool = createSummonExpertTool(coordinator(captured, 'expert-order-1'), { resumeStore })

    await tool.execute({ toolUseId: 'tu1', cwd: '/repo', input: { expert: 'root_cause', objective: 'first' } })
    await tool.execute({ toolUseId: 'tu2', cwd: '/repo', input: { expert: 'root_cause', objective: 'second', resume: true } })

    assert.equal(captured[0]!.resumeWorkOrderId, undefined, '首召无驻场 id')
    assert.equal(captured[1]!.resumeWorkOrderId, 'expert:root_cause', '续召复用稳定驻场 id')
    const storeKey = expertBenchStorageKey('expert:root_cause')
    assert.equal(resumeStore.get(storeKey), 'expert:root_cause', '进程内驻场记忆必须用项目隔离键（不再裸用 expert id）')
  })

  it('evidence 证据包下传不被任务级 400 字符预算截断（对齐证据级 4000 预算）', async () => {
    const captured: DelegationRequest[] = []
    const tool = createSummonExpertTool(coordinator(captured))
    // 拼出 >400 字符的证据文本：旧链路会在 work-order withTaskConstraints 被砍到 400。
    // （schema 上限 10 条，每条拉长凑体积。）
    const longEvidence = Array.from({ length: 10 }, (_, i) => `TS2322-${i}: ${'x'.repeat(90)}`)

    await tool.execute({
      toolUseId: 'tu_ev',
      cwd: '/repo',
      input: { expert: 'root_cause', objective: '定位根因', evidence: longEvidence },
    })

    const evidence = captured[0]!.constraints?.find(c => c.startsWith('[evidence]'))
    assert.ok(evidence, '证据约束必须存在')
    assert.ok(evidence.length > 400, `证据包必须保住 4000 预算（实际 ${evidence.length}）`)
    assert.ok(evidence.length <= 4000, '不得超出证据级上限')
    assert.ok(evidence.includes('TS2322-9'), '最后一条证据必须完整到达 work-order 约束')
  })

  it('escalated 结果必须带 failureReason（学习账本按基础设施失败剔除，不污染胜率）', async () => {
    const captured: DelegationRequest[] = []
    const saved: Array<{ kind: string; json: string }> = []
    const escalating = coordinator(captured, 'order-esc')
    escalating.delegate = async (request, _signal, onOrderCreated) => {
      onOrderCreated?.('order-esc')
      return {
        status: 'completed',
        results: [{ ...passed('order-esc'), status: 'escalated' } as WorkerResult],
        packet: 'ok',
      } as CoordinatorRun
    }
    const tool = createSummonExpertTool(escalating, {
      routingStore: { saveBanditState: (kind, json) => { saved.push({ kind, json }) } },
    })

    await tool.execute({ toolUseId: 'tu_esc', cwd: '/repo', input: { expert: 'root_cause', objective: 'x' } })

    assert.equal(saved.length, 1)
    const record = JSON.parse(saved[0]!.json) as { status?: string; failureReason?: string }
    assert.equal(record.status, 'failed')
    assert.equal(record.failureReason, 'escalated', 'escalated 必须可被闸门剔除')
  })
})
