import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runCouncil, buildSeatObjective, parseSeatContribution } from '../council-orchestrator.js'
import type { CouncilDeps, CouncilInput } from '../council-orchestrator.js'
import type { WorkerResult } from '../../work-order.js'

function workerResult(seat: string, contribJson: string): WorkerResult {
  return {
    workOrderId: `council:seat-${seat}`,
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
  seats: ['tianquan', 'tianfu'],
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

  it('扇出请求均为 plan/reviewer/对应 authority（不携带执行语义）', async () => {
    const seen: string[] = []
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => { for (const r of reqs) { assert.equal(r.kind, 'plan'); assert.equal(r.profile, 'reviewer'); seen.push(r.authority) } ; return { results: reqs.map(r => workerResult(r.authority, '{}')) } },
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

  it('md 内 convenedAt 与返回 meta.convenedAt 一致（钉死双取时钟坑）', async () => {
    let t = 100
    const deps: CouncilDeps = { delegateBatch: async (reqs) => ({ results: reqs.map(r => workerResult(r.authority, '{}')) }), now: () => t++ }
    const plan = await runCouncil(input, deps)
    assert.match(plan.finalPlanMarkdown, new RegExp(`convenedAt=${plan.meta.convenedAt}`))
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
    const o = buildSeatObjective('tianquan', input.draft)
    assert.match(o, /tianquan/); assert.match(o, /seat-contribution/); assert.match(o, /split loop.ts/)
  })
})
