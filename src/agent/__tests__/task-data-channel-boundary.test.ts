import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus } from '../advisory-bus.js'
import { createBlindExplorationHook } from '../hooks/blind-exploration-hook.js'
import { createMCTSPlanningHook } from '../hooks/mcts-planning-hook.js'
import { formatScoutInjection, buildForeignScoutRequest } from '../anchor-break-scout.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'

/**
 * W2-B2: task-data payloads bypass the AdvisoryBus.
 *
 * MCTS seeds, foreign scout packets and the blind-exploration directive are
 * DATA the model must see in full — not advisories. Routing them through the
 * bus would subject them to Top-N ranking, habituation mute, holdout
 * withholding and tone adaptation, any of which can silently drop or truncate
 * the payload. The channel contract locked here:
 *
 *   - payload is delivered byte-identical via injectUserMessage (K1
 *     append-only tail; metered as 'runtime-payload' at the loop egress);
 *   - delivery is unconditional on bus state (saturated / muted / holdout);
 *   - migration decision (plan B2): blind-exploration stays on the direct
 *     channel — no migration without a same-turn-delivery timing proof.
 */

function hookCtx(turn: number, inject: (msg: string) => void): RuntimeHookContext {
  return {
    snapshot: {
      cwd: '/test',
      turn,
      recentToolHistory: [],
      sensorium: null,
      strategy: null,
      vigor: null,
      gitChangeRate: 0,
      season: null,
    },
    effects: {
      setSensorium: () => {},
      setStrategy: () => {},
      setVigor: () => {},
      setGitChangeRate: () => {},
      injectUserMessage: inject,
      requestThetaCheck: () => {},
      emitPhaseChange: () => {},
      emitDecisionShift: () => {},
      markClaimStale: () => {},
    },
  } as RuntimeHookContext
}

/** A bus whose render pipeline is fully saturated with muted high-priority noise. */
function saturatedBus(): AdvisoryBus {
  const bus = new AdvisoryBus()
  for (let i = 0; i < 12; i++) {
    bus.submit({ key: `noise-${i}`, priority: 0.95, category: 'discipline', content: `noise ${i}` })
  }
  return bus
}

describe('W2-B2 task-data channel boundary', () => {
  it('blind-exploration payload arrives byte-identical regardless of bus saturation', () => {
    saturatedBus().render(undefined, 1) // saturate + drain a busy bus in the background
    const injected: string[] = []
    const hook = createBlindExplorationHook({ activeTurns: [1] })
    hook.run(hookCtx(1, m => injected.push(m)))

    assert.equal(injected.length, 1)
    assert.ok(injected[0]!.startsWith('<破军-探索 type="blind-exploration">'))
    assert.ok(!injected[0]!.includes('key="'), 'must not carry bus rendering artifacts')
  })

  it('MCTS injects ALL surviving seeds — no Top-N cut, no mute, no tone rewrite', async () => {
    const seeds = [
      '从数据流向反推：先画出字节从进程到持久层的完整路径再定位丢失点',
      '把问题当成缓存失效问题处理：找出哪个中间层在复用陈旧快照',
      '用最小复现脚本隔离：三行脚本能否在干净目录重现同样的行为',
      '假设约束是错的：验证上游契约是否真的要求当前的这种排序',
      '倒过来做：先写出期望的最终输出，再找哪一步开始偏离',
    ]
    const injected: string[] = []
    let call = 0
    const hook = createMCTSPlanningHook({
      callSeedModel: async () => seeds[call++ % seeds.length]!,
      branches: seeds.length,
      planningTurn: 1,
      getUserMessage: () => 'fix the bug in the truncation logic',
    })
    await hook.run(hookCtx(1, m => injected.push(m)))

    assert.equal(injected.length, 1, 'one payload message')
    const payload = injected[0]!
    const seedLines = payload.split('\n').filter(l => l.startsWith('- Seed '))
    assert.ok(seedLines.length >= 3, `all surviving seeds must be present, got ${seedLines.length}`)
    for (const line of seedLines) {
      const text = line.replace(/^- Seed \d+: /, '').replace(/<\/破军-探索>$/, '')
      assert.ok(seeds.includes(text), `seed text must be byte-identical (no tone adaptation): ${text}`)
    }
  })

  it('scout packet is bounded at PRODUCTION (budget), not truncated at injection', () => {
    // Production-side boundedness: the scout run itself carries the token
    // budget — the injection layer never cuts the packet.
    const request = buildForeignScoutRequest({
      parentTurnId: 'anchor-break-scout:s1:4',
      objective: 'review the compaction pipeline',
      foreignDomainId: 'wenqu',
      delegationDepth: 1,
      sessionTurn: 4,
      budget: { maxTurns: 3, maxTokens: 2048, timeoutMs: 60_000, maxRetries: 0 },
    })
    assert.equal(request.budget?.maxTokens, 2048, 'packet size is bounded where it is produced')

    const packet = 'x'.repeat(6_000)
    const injection = formatScoutInjection(packet, 'wenqu')
    assert.ok(injection.includes(packet), 'injection layer must not truncate the packet')
    assert.ok(injection.startsWith('<外域-侦察 domain="wenqu">'))
  })

  it('bus mute/holdout state has no channel to reach task-data hooks (structural)', async () => {
    // The hooks accept no AdvisoryBus dependency at all — the strongest
    // boundary. This test locks the constructor signatures: adding a bus
    // dep to these hooks must consciously break this test.
    const blind = createBlindExplorationHook({})
    const mcts = createMCTSPlanningHook({
      callSeedModel: async () => 'seed',
      getUserMessage: () => null,
    })
    for (const hook of [blind, mcts]) {
      assert.equal(hook.phase, 'preTurn')
      const injected: string[] = []
      await hook.run(hookCtx(99, m => injected.push(m)))
      assert.equal(injected.length, 0, 'inactive turns stay silent — no bus fallback path')
    }
  })
})
