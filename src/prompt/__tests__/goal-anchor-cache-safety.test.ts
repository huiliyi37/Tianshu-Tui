import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * Goal anchor 缓存安全模拟测试（计划 Wave 2 任务 7b——用户驳回点实证闭环）。
 *
 * 背景：用户指出「dynamic appendix 每轮在变」的类比论证不成立（git status
 * 有 30s TTL + 3 消息门控，多数轮次字节稳定），缓存安全必须实测。
 * 本文件复用两个既有形态：
 *  - cache-prefix-replay.test.ts 的 earliestDivergence（本地确定性前缀门禁）
 *  - appendix-ledger.test.ts 的 appendixDelta 记账（字节稳定 charge 0）
 * 不 mock 中间层——真实 PromptEngine + 真实 buildOaiRequest 全链路。
 *
 * 证明目标：目标不变时 `<current-goal>` 零字节抖动（cacheRead 可命中）；
 * 目标切换只影响新 tail（earliestDivergence = null，历史前缀不碎裂）。
 */

const CONTEXT_WINDOW = 200_000

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 4096,
    appendixDelta: true,
    staticCtx: { tools: [] },
    volatileCtx: {
      cwd: '/test/project',
      rivetMd: '# Test Project',
    },
  })
}

interface DivergenceReport {
  index: number
  prev: string
  cur: string
}

/** 返回 prev 不是 cur 字节前缀的首个位置，或 null（prev 是 cur 的前缀）。 */
function earliestDivergence(prev: string[], cur: string[]): DivergenceReport | null {
  for (let i = 0; i < prev.length; i++) {
    if (i >= cur.length) {
      return { index: i, prev: prev[i]!, cur: '<missing — request shrank>' }
    }
    if (prev[i] !== cur[i]) {
      return { index: i, prev: prev[i]!, cur: cur[i]! }
    }
  }
  return null
}

function serialize(messages: OaiMessage[]): string[] {
  return messages.map(m => JSON.stringify(m))
}

function userTurn(text: string): OaiMessage[] {
  return [{ role: 'user', content: text }]
}

/** 从 serialized 消息里数出 current-goal 段出现的消息数（应为 0 或 1：只在新 tail）。 */
function currentGoalCount(bytes: string[]): number {
  return bytes.filter(b => b.includes('<current-goal')).length
}

describe('goal anchor cache safety', () => {
  it('用例 1: 目标不变 → 连续轮次字节全同（appendixDelta steady state，cacheRead 可命中）', () => {
    const engine = makeEngine()
    engine.setGoalAnchor('修复侧边栏宽度，避免一行重叠成两行')

    const conv: OaiMessage[] = []
    let prev: string[] | null = null
    for (let turn = 1; turn <= 6; turn++) {
      conv.push({ role: 'user', content: `question ${turn}` })
      const req = engine.buildOaiRequest(conv, undefined, CONTEXT_WINDOW)
      const bytes = serialize(req.messages)
      // 每轮都应携带 <current-goal>（目标在 dynamic appendix 常驻回显）
      assert.ok(currentGoalCount(bytes) >= 1, `turn ${turn} 应渲染 <current-goal>`)
      if (prev !== null) {
        const div = earliestDivergence(prev, bytes)
        assert.equal(div, null, div ? `turn ${turn} 在 index ${div.index} 提前发散（目标未变但字节变了）` : undefined)
      }
      prev = bytes
    }
  })

  it('用例 2: 目标切换只影响新 tail，历史前缀不碎裂（earliestDivergence = null）', () => {
    const engine = makeEngine()
    engine.setGoalAnchor('修复侧边栏宽度')

    const conv: OaiMessage[] = [{ role: 'user', content: 'q1' }]
    const req1 = engine.buildOaiRequest(conv, undefined, CONTEXT_WINDOW)
    const bytes1 = serialize(req1.messages)

    // 目标切换（用户发新指令）
    engine.setGoalAnchor('悬浮位置放错，移动到输入框外面')
    conv.push({ role: 'assistant', content: 'a1' })
    conv.push({ role: 'user', content: 'q2' })
    const req2 = engine.buildOaiRequest(conv, undefined, CONTEXT_WINDOW)
    const bytes2 = serialize(req2.messages)

    // 历史消息必须保持字节前缀——冻结的 q1 保留 v1 目标，earliestDivergence = null
    const div = earliestDivergence(bytes1, bytes2)
    assert.equal(div, null, div ? `divergence at ${div.index}` : undefined)
    // 新目标 v2 只出现在新 tail，不得泄漏进已冻结历史
    assert.equal(currentGoalCount(bytes2), 2, 'q1(v1 冻结) + q2(v2 新) 各一处')
    assert.ok(bytes2[1]!.includes('修复侧边栏宽度'), '历史 q1 保留旧目标（缓存前缀）')
    assert.ok(bytes2.at(-1)!.includes('悬浮位置放错'), '新 tail 含新目标')
    for (const b of bytes2.slice(0, -1)) {
      assert.ok(!b.includes('悬浮位置'), '新目标不得泄漏进历史消息')
    }
  })

  it('用例 3: appendixDelta 输出——目标不变自闭合（seq 无内容），目标切换只发 goal 块 delta', () => {
    const engine = makeEngine()
    engine.setGoalAnchor('v1 目标：修复侧边栏宽度')

    // 首轮：baseline 全量含 current-goal
    const req1 = engine.buildOaiRequest(userTurn('first'), undefined, CONTEXT_WINDOW)
    const appendix1 = req1.messages.at(-1)!.content as string
    assert.ok(appendix1.includes('<current-goal'), 'baseline 应含 current-goal')

    // 同一目标、新用户轮次：appendixDelta 自闭合（无 current-goal 内容 = 字节零变化）
    const req2 = engine.buildOaiRequest(userTurn('second'), undefined, CONTEXT_WINDOW)
    const appendix2 = req2.messages.at(-1)!.content as string
    assert.ok(appendix2.includes('<context-update seq='), 'delta 轮应有 context-update')
    assert.ok(!appendix2.includes('<current-goal'), '目标未变时 delta 不得重发 current-goal（字节稳定，cacheRead 命中）')
    assert.ok(appendix2.includes('/>') || appendix2.includes('mode="delta"'), 'delta 轮为自闭合或 delta 模式')

    // 目标切换：delta 含新目标，且不含旧目标
    engine.setGoalAnchor('v2 目标：悬浮位置移到输入框外')
    const req3 = engine.buildOaiRequest(userTurn('third'), undefined, CONTEXT_WINDOW)
    const appendix3 = req3.messages.at(-1)!.content as string
    assert.ok(appendix3.includes('<current-goal'), '目标切换时 delta 应含 current-goal')
    assert.ok(appendix3.includes('v2 目标'), 'delta 含新目标文本')
    assert.ok(!appendix3.includes('v1 目标'), 'delta 不得含旧目标文本')
  })
})
