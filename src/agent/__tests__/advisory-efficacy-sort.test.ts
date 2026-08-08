import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import {
  AdvisoryBus,
  CONSTITUTIONAL_PRIORITY,
  DEFAULT_EFFICACY_PRIORITY_SPAN,
  EFFICACY_CONFIDENT_SAMPLES,
  parseEfficacySpan,
  type AdvisoryEntry,
  type EfficacySignalProvider,
} from '../advisory-bus.js'

function entry(overrides: Partial<AdvisoryEntry> & { key: string }): AdvisoryEntry {
  return {
    priority: 0.6,
    category: 'discipline',
    content: `advice for ${overrides.key}`,
    ...overrides,
  }
}

/** Order of entry keys as they appear in the rendered advisory block. */
function renderedOrder(xml: string): string[] {
  return [...xml.matchAll(/<entry key="([^"]+)"/g)].map(m => m[1]!)
}

/** key -> the priority attribute actually written into the prompt. */
function renderedPriorities(xml: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of xml.matchAll(/<entry key="([^"]+)" priority="([^"]+)"/g)) {
    out.set(m[1]!, m[2]!)
  }
  return out
}

/** Signal provider from a key -> [score, confidence] table. Missing key = no sample. */
function signals(table: Record<string, [number, number]>): EfficacySignalProvider {
  return key => {
    const hit = table[key]
    return hit ? { score: hit[0], confidence: hit[1] } : null
  }
}

describe('parseEfficacySpan', () => {
  test('缺省与空串取默认幅度', () => {
    assert.equal(parseEfficacySpan(undefined), DEFAULT_EFFICACY_PRIORITY_SPAN)
    assert.equal(parseEfficacySpan(''), DEFAULT_EFFICACY_PRIORITY_SPAN)
  })

  test('合法 [0,0.5] 生效，0 表示关闭调整', () => {
    assert.equal(parseEfficacySpan('0'), 0)
    assert.equal(parseEfficacySpan('0.2'), 0.2)
    assert.equal(parseEfficacySpan('0.5'), 0.5)
  })

  test('越界与非法值回退默认（不静默放大调整幅度）', () => {
    assert.equal(parseEfficacySpan('0.9'), DEFAULT_EFFICACY_PRIORITY_SPAN)
    assert.equal(parseEfficacySpan('-1'), DEFAULT_EFFICACY_PRIORITY_SPAN)
    assert.equal(parseEfficacySpan('abc'), DEFAULT_EFFICACY_PRIORITY_SPAN)
  })
})

describe('T7 效力排序：效力跨 priority 参与竞争', () => {
  // 复刻两天日志里的真实错配：self-verify 采纳 77% 但 priority 0.58，
  // todo-missing 采纳 12% 但 priority 0.70 —— 改动前 0.70 恒胜，效力从不被查询。
  test('高采纳低 priority 反超低采纳高 priority', () => {
    const bus = new AdvisoryBus()
    bus.setEfficacySignalProvider(signals({
      'self-verify': [0.77, 1],
      'todo-missing': [0.12, 1],
    }))
    bus.submit(entry({ key: 'todo-missing', priority: 0.7, category: 'todo' }))
    bus.submit(entry({ key: 'self-verify', priority: 0.58, category: 'discipline' }))

    assert.deepEqual(renderedOrder(bus.render()), ['self-verify', 'todo-missing'])
  })

  test('无 provider 时保持改动前的 priority 主导顺序', () => {
    const bus = new AdvisoryBus()
    bus.submit(entry({ key: 'todo-missing', priority: 0.7, category: 'todo' }))
    bus.submit(entry({ key: 'self-verify', priority: 0.58, category: 'discipline' }))

    assert.deepEqual(renderedOrder(bus.render()), ['todo-missing', 'self-verify'])
  })

  test('无效力样本的 key 视为中性，不因缺数据被惩罚', () => {
    const bus = new AdvisoryBus()
    bus.setEfficacySignalProvider(signals({ 'low-adopt': [0.1, 1] }))
    bus.submit(entry({ key: 'low-adopt', priority: 0.7, category: 'todo' }))
    bus.submit(entry({ key: 'unknown', priority: 0.65, category: 'discipline' }))

    assert.deepEqual(renderedOrder(bus.render()), ['unknown', 'low-adopt'])
  })

  test('低置信度只产生小幅调整，不足以翻转排序', () => {
    const bus = new AdvisoryBus()
    // 1/5 置信度把 0.77 的满幅 +0.081 缩到 +0.016，追不平 0.12 的基础差距
    bus.setEfficacySignalProvider(signals({
      'self-verify': [0.77, 1 / EFFICACY_CONFIDENT_SAMPLES],
      'todo-missing': [0.12, 1 / EFFICACY_CONFIDENT_SAMPLES],
    }))
    bus.submit(entry({ key: 'todo-missing', priority: 0.7, category: 'todo' }))
    bus.submit(entry({ key: 'self-verify', priority: 0.58, category: 'discipline' }))

    assert.deepEqual(renderedOrder(bus.render()), ['todo-missing', 'self-verify'])
  })

  test('零采纳的高 priority 条目被挤出预算', () => {
    const bus = new AdvisoryBus()
    bus.setEfficacySignalProvider(signals({
      'high-a': [1, 1],
      'high-b': [1, 1],
      'high-c': [1, 1],
      'dead-key': [0, 1],
    }))
    // 4 条竞争 3 个槽位；category 分散以规避 MAX_PER_CATEGORY 干扰
    bus.submit(entry({ key: 'dead-key', priority: 0.75, category: 'todo' }))
    bus.submit(entry({ key: 'high-a', priority: 0.6, category: 'discipline' }))
    bus.submit(entry({ key: 'high-b', priority: 0.6, category: 'delegation' }))
    bus.submit(entry({ key: 'high-c', priority: 0.6, category: 'background' }))

    const order = renderedOrder(bus.render())
    assert.equal(order.length, 3)
    assert.ok(!order.includes('dead-key'), '零采纳的高 priority 条目应被挤出预算')
  })
})

describe('T7 效力排序：边界与豁免', () => {
  test('上调不越 0.79，不得触及 0.8 的 efficacy fail-open 豁免线', () => {
    const bus = new AdvisoryBus()
    bus.setEfficacySignalProvider(signals({ perfect: [1, 1] }))
    // 未 cap 时 0.75 + 0.15 = 0.90，会反超 0.80 的对照条目
    assert.ok(0.75 + DEFAULT_EFFICACY_PRIORITY_SPAN > 0.8)
    bus.submit(entry({ key: 'perfect', priority: 0.75, category: 'discipline' }))
    bus.submit(entry({ key: 'ceiling', priority: 0.8, category: 'todo' }))

    assert.deepEqual(renderedOrder(bus.render()), ['ceiling', 'perfect'])
  })

  test('下调不低于 0.05，最差的 key 仍保留参赛资格', () => {
    const bus = new AdvisoryBus()
    bus.setEfficacySignalProvider(signals({ terrible: [0, 1] }))
    // 未设下限时 0.1 - 0.15 = -0.05，会掉到 0.03 的对照之后
    bus.submit(entry({ key: 'terrible', priority: 0.1, category: 'discipline' }))
    bus.submit(entry({ key: 'floor-probe', priority: 0.03, category: 'todo' }))

    assert.deepEqual(renderedOrder(bus.render()), ['terrible', 'floor-probe'])
  })

  test('constitutional 条目不受效力影响，始终排在最前', () => {
    const bus = new AdvisoryBus()
    bus.setEfficacySignalProvider(signals({ charter: [0, 1], 'high-adopt': [1, 1] }))
    bus.submit(entry({ key: 'high-adopt', priority: 0.7, category: 'todo' }))
    bus.submit(entry({
      key: 'charter',
      priority: CONSTITUTIONAL_PRIORITY,
      tier: 'constitutional',
    }))

    assert.deepEqual(renderedOrder(bus.render()), ['charter', 'high-adopt'])
  })

  test('immediate 条目豁免效力调整', () => {
    const bus = new AdvisoryBus()
    // urgent 效力最差；若未豁免则 0.7-0.15=0.55，会掉到中性的 0.6 之后
    bus.setEfficacySignalProvider(signals({ urgent: [0, 1], neutral: [0.5, 1] }))
    bus.submit(entry({ key: 'neutral', priority: 0.6, category: 'todo' }))
    bus.submit(entry({ key: 'urgent', priority: 0.7, immediate: true, category: 'discipline' }))

    assert.deepEqual(renderedOrder(bus.render()), ['urgent', 'neutral'])
  })

  test('star_domain 条目豁免效力调整', () => {
    const bus = new AdvisoryBus()
    bus.setEfficacySignalProvider(signals({ domain: [0, 1], neutral: [0.5, 1] }))
    bus.submit(entry({ key: 'neutral', priority: 0.6, category: 'todo' }))
    bus.submit(entry({ key: 'domain', priority: 0.7, category: 'star_domain' }))

    assert.deepEqual(renderedOrder(bus.render()), ['domain', 'neutral'])
  })

  test('RIVET_ADVISORY_EFFICACY_SPAN=0 关闭调整，回退纯 priority 排序', () => {
    const prev = process.env.RIVET_ADVISORY_EFFICACY_SPAN
    process.env.RIVET_ADVISORY_EFFICACY_SPAN = '0'
    try {
      const bus = new AdvisoryBus()
      bus.setEfficacySignalProvider(signals({ 'self-verify': [1, 1], 'todo-missing': [0, 1] }))
      bus.submit(entry({ key: 'todo-missing', priority: 0.7, category: 'todo' }))
      bus.submit(entry({ key: 'self-verify', priority: 0.58, category: 'discipline' }))
      assert.deepEqual(renderedOrder(bus.render()), ['todo-missing', 'self-verify'])
    } finally {
      if (prev === undefined) delete process.env.RIVET_ADVISORY_EFFICACY_SPAN
      else process.env.RIVET_ADVISORY_EFFICACY_SPAN = prev
    }
  })
})

describe('T7 效力排序：不污染条目与注入字节', () => {
  // alive 跨渲染周期持有同一批条目引用——原地累加会复合放大并击穿豁免线。
  test('多轮 render 后条目自身的 priority 不被 mutation', () => {
    const bus = new AdvisoryBus()
    bus.setEfficacySignalProvider(signals({ persistent: [1, 1] }))
    const e = entry({ key: 'persistent', priority: 0.6, ttl: 3 })
    bus.submit(e)
    bus.render()
    bus.render()
    bus.render()
    assert.equal(e.priority, 0.6)
  })

  // advisory 走 appendix 通道（前缀缓存敏感）：效力逐轮变化，若把有效优先级
  // 写进注入文本，同一条 ttl>1 的建议会在 alive 周期内字节抖动。
  test('注入文本写的是原始 priority，不是排序用的有效优先级', () => {
    const bus = new AdvisoryBus()
    bus.setEfficacySignalProvider(signals({ shifty: [1, 1] }))
    bus.submit(entry({ key: 'shifty', priority: 0.6, category: 'discipline' }))
    assert.equal(renderedPriorities(bus.render()).get('shifty'), '0.60')
  })

  test('效力分逐轮变化时同一条建议的注入字节保持稳定', () => {
    const bus = new AdvisoryBus()
    let score = 0.1
    bus.setEfficacySignalProvider(() => ({ score, confidence: 1 }))

    bus.submit(entry({ key: 'stable', priority: 0.6, category: 'discipline' }))
    const first = bus.render()
    score = 0.95
    bus.submit(entry({ key: 'stable', priority: 0.6, category: 'discipline' }))
    const second = bus.render()

    assert.equal(first, second)
  })
})
