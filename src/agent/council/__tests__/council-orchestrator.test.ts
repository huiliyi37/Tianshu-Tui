import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runCouncil, buildSeatObjective, parseSeatContribution } from '../council-orchestrator.js'
import type { CouncilDeps, CouncilInput } from '../council-orchestrator.js'
import type { WorkerResult } from '../../work-order.js'
import { deriveStableWorkOrderId } from '../../coordinator.js'

// 用真实 id 推导生成 workOrderId（而非手设 `council:seat-${seat}`），让测试反映
// coordinator 实际产出的 id。若 coordinator 不再稳定化 council:，这里退化为
// 不可绑定 id，下方「席位结果按真实 workOrderId 绑定」回归会变红 —— 防虚假绿灯。
function workerResult(seat: string, contribJson: string): WorkerResult {
  return {
    workOrderId: deriveStableWorkOrderId(`council:seat-${seat}`) ?? 'wo_unstable',
    status: 'passed',
    summary: `${seat} done`,
    findings: [],
    artifacts: [{ kind: 'note', title: 'seat-contribution', content: contribJson }],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
  }
}

const input: CouncilInput = {
  draft: { objective: 'split loop.ts', items: [{ id: 'T1', title: 't', detail: 'd' }] },
  seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }],
}

describe('runCouncil — 单轮 + 解耦', () => {
  it('delegateBatch 恰调用一次', async () => {
    let calls = 0
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => { calls++; return { results: reqs.map(r => workerResult(r.authority, JSON.stringify({ authority: r.authority, summary: 's', additions: [], risks: [], challenges: [], alternatives: [] }))) } },
      now: () => 1000,
    }
    await runCouncil(input, deps)
    assert.equal(calls, 1)
  })

  it('扇出请求均为 plan/council_expert/对应 authority（不携带执行语义）', async () => {
    const seen: string[] = []
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => { for (const r of reqs) { assert.equal(r.kind, 'plan'); assert.equal(r.profile, 'council_expert'); seen.push(r.authority) } ; return { results: reqs.map(r => workerResult(r.authority, '{}')) } },
      now: () => 1,
    }
    await runCouncil(input, deps)
    assert.deepEqual(seen, ['tianquan', 'tianfu'])
  })

  it('某席无结果 → 降级空贡献，不抛错', async () => {
    const deps: CouncilDeps = {
      delegateBatch: async () => ({ results: [workerResult('tianquan', JSON.stringify({ authority: 'tianquan', summary: 'ok', additions: [], risks: [], challenges: [], alternatives: [] }))] }),
      now: () => 1,
    }
    const plan = await runCouncil(input, deps)
    assert.equal(plan.contributions.length, 2)
    assert.equal(plan.contributions[1]!.authority, 'tianfu')
  })

  it('席位结果按真实 workOrderId 绑定（coordinator 稳定化 council: — 防虚假绿灯）', async () => {
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => ({ results: reqs.map(r => workerResult(r.authority, JSON.stringify({ authority: r.authority, summary: `${r.authority}-real`, additions: [], risks: [], challenges: [], alternatives: [] }))) }),
      now: () => 1,
    }
    const plan = await runCouncil(input, deps)
    // 绑定成功 → 解析到席位真实 summary；绑定失败会退化为空字符串。
    assert.equal(plan.contributions[0]!.summary, 'tianquan-real')
    assert.equal(plan.contributions[1]!.summary, 'tianfu-real')
  })

  it('workerModels 回填 modelUsed → contribution（非 worker 自报）', async () => {
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => ({
        results: reqs.map(r => workerResult(r.authority, JSON.stringify({ authority: r.authority, summary: `${r.authority}-x`, additions: [], risks: [], challenges: [], alternatives: [] }))),
        workerModels: [
          { workOrderId: deriveStableWorkOrderId('council:seat-tianquan') ?? '', model: 'deepseek-v4' },
          { workOrderId: deriveStableWorkOrderId('council:seat-tianfu') ?? '', model: 'glm-5.2' },
        ],
      }),
      now: () => 1,
    }
    const plan = await runCouncil(input, deps)
    assert.equal(plan.contributions[0]!.modelUsed, 'deepseek-v4')
    assert.equal(plan.contributions[1]!.modelUsed, 'glm-5.2')
  })

  it('md 内 convenedAt 与返回 meta.convenedAt 一致（钉死双取时钟坑）', async () => {
    let t = 100
    const deps: CouncilDeps = { delegateBatch: async (reqs) => ({ results: reqs.map(r => workerResult(r.authority, '{}')) }), now: () => t++ }
    const plan = await runCouncil(input, deps)
    assert.match(plan.finalPlanMarkdown, new RegExp(`convenedAt=${plan.meta.convenedAt}`))
  })

  it('recordRoutingShadow 旁路：每席记一次，不改 contributions/seats', async () => {
    const shadows: string[] = []
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => ({ results: reqs.map(r => workerResult(r.authority, JSON.stringify({ authority: r.authority, summary: `${r.authority}-x`, additions: [], risks: [], challenges: [], alternatives: [] }))) }),
      now: () => 7,
      sessionId: 'sess-1',
      recordRoutingShadow: ev => shadows.push(`${ev.seat}:${ev.finalTier}`),
    }
    const plan = await runCouncil(input, deps)
    assert.deepEqual(shadows, ['tianquan:cheap', 'tianfu:balanced'])
    // 旁路不改派发结果。
    assert.deepEqual(plan.seats, ['tianquan', 'tianfu'])
    assert.equal(plan.contributions[1]!.summary, 'tianfu-x')
  })

  it('缺省 recordRoutingShadow 时不报错（shadow 默认关）', async () => {
    const deps: CouncilDeps = { delegateBatch: async (reqs) => ({ results: reqs.map(r => workerResult(r.authority, '{}')) }), now: () => 1 }
    const plan = await runCouncil(input, deps)
    assert.equal(plan.seats.length, 2)
  })
})

describe('parseSeatContribution — 降级兜底', () => {
  it('artifact 空 content → 空贡献带 summary', () => {
    const c = parseSeatContribution('tianji', workerResult('tianji', ''))
    assert.equal(c.summary, 'tianji done')
    assert.deepEqual(c.additions, [])
  })
  it('artifact 缺失 → 空贡献带 summary（分支真空覆盖）', () => {
    const result = workerResult('tianji', '')
    // 移除 artifacts 条目，触发 if (!artifact) return empty 分支
    result.artifacts = result.artifacts.filter(a => a.title !== 'seat-contribution')
    const c = parseSeatContribution('tianji', result)
    assert.equal(c.summary, 'tianji done')
    assert.deepEqual(c.additions, [])
  })
  it('artifact 畸形 JSON → 空贡献不抛', () => {
    const c = parseSeatContribution('tianji', workerResult('tianji', '{not json'))
    assert.equal(c.authority, 'tianji')
  })
})

describe('buildSeatObjective', () => {
  it('含席位名 + schema 指令 + objective', () => {
    const o = buildSeatObjective({ authority: 'tianquan' }, input.draft)
    assert.match(o, /tianquan/); assert.match(o, /seat-contribution/); assert.match(o, /split loop.ts/)
  })
})
