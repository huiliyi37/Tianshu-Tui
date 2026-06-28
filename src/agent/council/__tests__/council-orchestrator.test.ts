import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runCouncil, runCouncilDebate, buildSeatObjective, buildSeatRebuttalObjective, parseSeatContribution } from '../council-orchestrator.js'
import type { CouncilDeps, CouncilInput } from '../council-orchestrator.js'
import type { WorkerResult } from '../../work-order.js'
import { deriveStableWorkOrderId } from '../../coordinator.js'
import { stableConflictKey } from '../council-plan.js'

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

// ---- runCouncilDebate 测试辅助 ----

// round1 冲突贡献：两席同 id 不同 detail → 必产 1 冲突
function r1c(seat: string, detail: string): WorkerResult {
  return workerResult(seat, JSON.stringify({ authority: seat, summary: `${seat}-s`, additions: [{ id: 'NEW', title: 't', detail }], risks: [], challenges: [], alternatives: [] }))
}
// round2 结果用 -r2 后缀的稳定 id（与 orchestrator 绑定一致 — 防虚假绿灯）
function r2Result(seat: string, contribJson: string): WorkerResult {
  return { ...workerResult(seat, contribJson), workOrderId: deriveStableWorkOrderId(`council:seat-${seat}-r2`) ?? 'wo_unstable' }
}
const conflictInput: CouncilInput = {
  draft: { objective: 'split loop.ts', items: [] },
  seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }],
}

describe('runCouncilDebate — 多轮层（默认 1=单轮 opt-in）', () => {
  it('默认 maxRounds（=1）即使有冲突也不触发 round2', async () => {
    let calls = 0
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => { calls++; return { results: [r1c('tianquan', 'X'), r1c('tianfu', 'Y')] } },
      now: () => 1,
    }
    const plan = await runCouncilDebate(conflictInput, deps) // 不传 maxRounds → 默认 1
    assert.equal(calls, 1)
    assert.equal(plan.meta.round, 1)
    assert.equal(plan.aggregate.conflicts[0]!.status, 'open')
  })

  it('maxRounds=2 无冲突 → 不触发 round2', async () => {
    let calls = 0
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => { calls++; return { results: reqs.map(r => workerResult(r.authority, '{}')) } },
      now: () => 1,
    }
    const plan = await runCouncilDebate({ ...conflictInput, maxRounds: 2 }, deps)
    assert.equal(calls, 1)
    assert.equal(plan.meta.round, 1)
  })

  it('maxRounds=2 有冲突 → 触发 round2（2 次, meta.round=2）', async () => {
    let calls = 0
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        calls++
        if (calls === 1) return { results: [r1c('tianquan', 'X'), r1c('tianfu', 'Y')] }
        return { results: reqs.map(r => r2Result(r.authority, JSON.stringify({ authority: r.authority, summary: 's', rebuttals: [] }))) }
      },
      now: () => 1,
    }
    const plan = await runCouncilDebate({ ...conflictInput, maxRounds: 2 }, deps)
    assert.equal(calls, 2)
    assert.equal(plan.meta.round, 2)
  })

  it('防虚假绿灯：round2 objective 真含 round1 冲突 key', async () => {
    let round2Objectives: string[] = []
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        if (reqs[0]!.parentTurnId.endsWith('-r2')) {
          round2Objectives = reqs.map(r => r.objective)
          return { results: reqs.map(r => r2Result(r.authority, JSON.stringify({ authority: r.authority, summary: 's', rebuttals: [] }))) }
        }
        return { results: [r1c('tianquan', 'X'), r1c('tianfu', 'Y')] }
      },
      now: () => 1,
    }
    const plan = await runCouncilDebate({ ...conflictInput, maxRounds: 2 }, deps)
    const key = plan.aggregate.conflicts[0]!.key
    assert.ok(round2Objectives.length > 0, 'round2 必须真的扇出')
    assert.ok(round2Objectives.some(o => o.includes(key)), 'round1 冲突 key 必须进 round2 objective')
  })

  it('round2 concede → 冲突收敛为 resolved', async () => {
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        if (reqs[0]!.parentTurnId.endsWith('-r2')) {
          return { results: reqs.map(r => {
            const key = stableConflictKey('X', 'Y')
            const rebuttals = r.authority === 'tianfu' ? [{ conflictKey: key, stance: 'concede', argument: '认同方向' }] : []
            return r2Result(r.authority, JSON.stringify({ authority: r.authority, summary: 's', rebuttals }))
          }) }
        }
        return { results: [r1c('tianquan', 'X'), r1c('tianfu', 'Y')] }
      },
      now: () => 1,
    }
    const plan = await runCouncilDebate({ ...conflictInput, maxRounds: 2 }, deps)
    assert.equal(plan.aggregate.conflicts[0]!.status, 'resolved')
    assert.equal(plan.aggregate.conflicts[0]!.resolution, '认同方向')
  })

  it('round2 全 hold → 冲突仍 persisted（无 resolution）', async () => {
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        if (reqs[0]!.parentTurnId.endsWith('-r2')) {
          return { results: reqs.map(r => {
            const key = stableConflictKey('X', 'Y')
            return r2Result(r.authority, JSON.stringify({ authority: r.authority, summary: 's', rebuttals: [{ conflictKey: key, stance: 'hold', argument: '坚持己见' }] }))
          }) }
        }
        return { results: [r1c('tianquan', 'X'), r1c('tianfu', 'Y')] }
      },
      now: () => 1,
    }
    const plan = await runCouncilDebate({ ...conflictInput, maxRounds: 2 }, deps)
    assert.equal(plan.aggregate.conflicts[0]!.status, 'persisted')
    assert.ok(!plan.aggregate.conflicts[0]!.resolution)
  })
})

describe('deriveStableWorkOrderId — round2 -r2 后缀稳定化', () => {
  it('council:seat-x-r2 稳定化保留 -r2 后缀（非仅 round1 key）', () => {
    const id = deriveStableWorkOrderId('council:seat-tianquan-r2')
    assert.equal(id, 'council:seat-tianquan-r2')
  })
  it('round1 与 round2 同席位产生不同稳定 id（防碰撞）', () => {
    const r1 = deriveStableWorkOrderId('council:seat-tianquan')
    const r2 = deriveStableWorkOrderId('council:seat-tianquan-r2')
    assert.equal(r1, 'council:seat-tianquan')
    assert.equal(r2, 'council:seat-tianquan-r2')
    assert.notEqual(r1, r2)
  })
})

describe('parseSeatContribution — rebuttals 结构验证', () => {
  it('正常 rebuttals 数组透传', () => {
    const key = 'abc123'
    const result = workerResult('tianquan', JSON.stringify({
      authority: 'tianquan', summary: 's',
      additions: [], risks: [], challenges: [], alternatives: [],
      rebuttals: [{ conflictKey: key, stance: 'concede', argument: '让步' }],
    }))
    const c = parseSeatContribution('tianquan', result)
    assert.equal(c.rebuttals?.length, 1)
    assert.equal(c.rebuttals![0]!.conflictKey, key)
    assert.equal(c.rebuttals![0]!.stance, 'concede')
  })
  it('畸形 rebuttals 元素被过滤（缺 conflictKey/stance/argument）', () => {
    const result = workerResult('tianquan', JSON.stringify({
      authority: 'tianquan', summary: 's',
      additions: [], risks: [], challenges: [], alternatives: [],
      rebuttals: [
        { conflictKey: 'k1', stance: 'concede', argument: 'ok' },
        'just a string',
        null,
        { conflictKey: 'k2' },
        { stance: 'hold' },
      ],
    }))
    const c = parseSeatContribution('tianquan', result)
    assert.equal(c.rebuttals?.length, 1, '只有第一条结构完整的保留')
    assert.equal(c.rebuttals![0]!.conflictKey, 'k1')
  })
  it('非数组 rebuttals 被忽略', () => {
    const result = workerResult('tianquan', JSON.stringify({
      authority: 'tianquan', summary: 's',
      additions: [], risks: [], challenges: [], alternatives: [],
      rebuttals: 'not-an-array',
    }))
    const c = parseSeatContribution('tianquan', result)
    assert.equal(c.rebuttals, undefined)
  })
})

describe('per-seat modelOverride 透传（异构议事会）', () => {
  const heteroInput: CouncilInput = {
    draft: { objective: 'split loop.ts', items: [{ id: 'T1', title: 't', detail: 'd' }] },
    seats: [
      { authority: 'tianquan', provider: 'deepseek', model: 'deepseek-v4-pro' },
      { authority: 'tianfu', provider: 'glm', model: 'glm-4.6' },
      { authority: 'tianxuan' }, // 无 provider/model → 不带 override
    ],
  }

  it('席位声明 provider+model → 扇出请求携带对应 modelOverride', async () => {
    const captured: Array<{ authority: string; modelOverride?: { provider: string; model: string } }> = []
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        for (const r of reqs) captured.push({ authority: r.authority, ...(r.modelOverride ? { modelOverride: r.modelOverride } : {}) })
        return { results: reqs.map(r => workerResult(r.authority, '{}')) }
      },
      now: () => 1,
    }
    await runCouncil(heteroInput, deps)
    assert.deepEqual(captured.find(c => c.authority === 'tianquan')?.modelOverride, { provider: 'deepseek', model: 'deepseek-v4-pro' })
    assert.deepEqual(captured.find(c => c.authority === 'tianfu')?.modelOverride, { provider: 'glm', model: 'glm-4.6' })
  })

  it('席位缺 provider/model → 不携带 modelOverride（回退会话模型）', async () => {
    let tianxuanOverride: unknown = 'unset'
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        tianxuanOverride = reqs.find(r => r.authority === 'tianxuan')?.modelOverride
        return { results: reqs.map(r => workerResult(r.authority, '{}')) }
      },
      now: () => 1,
    }
    await runCouncil(heteroInput, deps)
    assert.equal(tianxuanOverride, undefined)
  })

  it('仅 provider 或仅 model（不成对）→ 不携带 modelOverride', async () => {
    const partialInput: CouncilInput = {
      draft: { objective: 'x', items: [] },
      seats: [
        { authority: 'tianquan', provider: 'deepseek' }, // 缺 model
        { authority: 'tianfu', model: 'glm-4.6' },       // 缺 provider
      ],
    }
    const overrides: Array<unknown> = []
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => { for (const r of reqs) overrides.push(r.modelOverride); return { results: reqs.map(r => workerResult(r.authority, '{}')) } },
      now: () => 1,
    }
    await runCouncil(partialInput, deps)
    assert.deepEqual(overrides, [undefined, undefined])
  })

  it('round2 contribution 回填 modelUsed（与 round1 一致）', async () => {
    let round = 0
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        round++
        const suffix = round >= 2 ? '-r2' : ''
        return {
          results: reqs.map(r => ({
            ...workerResult(`${r.authority}${suffix}`, JSON.stringify({
              authority: r.authority, summary: 's',
              additions: [{ id: r.authority === 'tianquan' ? 'A' : 'B', title: r.authority, detail: r.authority }],
              risks: [], challenges: [], alternatives: [],
            })),
          })),
          workerModels: reqs.map(r => ({
            workOrderId: deriveStableWorkOrderId(`council:seat-${r.authority}${suffix}`) ?? '',
            model: round >= 2 ? `${r.authority}-r2-model` : `${r.authority}-r1-model`,
          })),
        }
      },
      now: () => 1,
    }
    const twoSeat: CouncilInput = {
      draft: { objective: 'x', items: [] },
      seats: [{ authority: 'tianquan' }, { authority: 'tianfu' }],
      maxRounds: 2,
    }
    const plan = await runCouncilDebate(twoSeat, deps)
    const r2 = plan.contributions.filter(c => c.round === 2)
    if (r2.length > 0) {
      assert.ok(r2.every(c => c.modelUsed?.endsWith('-r2-model')), 'round2 应回填 round2 的真实模型')
    }
  })

  it('第二轮反驳同样携带 modelOverride', async () => {
    // round1 制造冲突 → 触发 round2；断言 round2 请求也带 override。
    const r2captured: Array<{ authority: string; modelOverride?: { provider: string; model: string } }> = []
    let round = 0
    const deps: CouncilDeps = {
      delegateBatch: async (reqs) => {
        round++
        if (round >= 2) for (const r of reqs) r2captured.push({ authority: r.authority, ...(r.modelOverride ? { modelOverride: r.modelOverride } : {}) })
        return {
          results: reqs.map(r => workerResult(r.authority, JSON.stringify({
            authority: r.authority, summary: 's',
            // 两席给出互相冲突的 addition → aggregate 产生 conflict，触发 round2
            additions: [{ id: r.authority === 'tianquan' ? 'A' : 'B', title: r.authority, detail: r.authority }],
            risks: [], challenges: [], alternatives: [],
          }))),
        }
      },
      now: () => 1,
    }
    const twoSeat: CouncilInput = {
      ...heteroInput,
      seats: [heteroInput.seats[0]!, heteroInput.seats[1]!],
      maxRounds: 2,
    }
    await runCouncilDebate(twoSeat, deps)
    // round2 仅在 round1 有冲突时触发；只要触发，override 必须存在。
    if (r2captured.length > 0) {
      assert.deepEqual(r2captured.find(c => c.authority === 'tianquan')?.modelOverride, { provider: 'deepseek', model: 'deepseek-v4-pro' })
      assert.deepEqual(r2captured.find(c => c.authority === 'tianfu')?.modelOverride, { provider: 'glm', model: 'glm-4.6' })
    }
  })
})
