import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus, LIFT_MUTE_RENDERS, type AdvisoryEntry } from '../advisory-bus.js'
import { AdvisoryReadback, MATURE_LIFT_MIN_DECIDED, MATURE_LIFT_MIN_SHADOW } from '../advisory-readback.js'

function entry(overrides: Partial<AdvisoryEntry> & { key: string }): AdvisoryEntry {
  return {
    priority: 0.6,
    category: 'discipline',
    content: `advice for ${overrides.key}`,
    expect: { kind: 'verify_attempted', withinTurns: 2 },
    ...overrides,
  }
}

describe('AdvisoryReadback.getMatureLift 成熟度门', () => {
  test('样本不足返回 null(不下结论)', () => {
    const rb = new AdvisoryReadback()
    assert.equal(rb.getMatureLift('k'), null)
    // 决出样本够但 shadow 不足
    rb.seedPriors([['k', { delivered: 10, adopted: 6, ignored: 4, shadowHeld: MATURE_LIFT_MIN_SHADOW - 1, shadowSatisfied: 1 }]])
    assert.equal(rb.getMatureLift('k'), null)
    // shadow 够但决出不足
    rb.seedPriors([['k', { delivered: 3, adopted: 2, ignored: 1, shadowHeld: 5, shadowSatisfied: 1 }]])
    assert.ok(2 + 1 < MATURE_LIFT_MIN_DECIDED)
    assert.equal(rb.getMatureLift('k'), null)
  })

  test('会话实测 + 先验合并计算 lift', () => {
    const rb = new AdvisoryReadback()
    // 先验:决出 4(3 adopted + 1 ignored),shadow 2/1
    rb.seedPriors([['k', { delivered: 4, adopted: 3, ignored: 1, shadowHeld: 2, shadowSatisfied: 1 }]])
    // 会话:1 次真实采纳 + 1 次 shadow 未满足 → 合并后决出 5、shadow 3
    rb.track([{ key: 'k', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 1 } }], 1)
    rb.observeTool({ turn: 1, name: 'run_tests', target: '', isError: false })
    rb.evaluate(1)
    rb.track([{ key: 'k', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 1 }, shadow: true }], 3)
    rb.evaluate(3)
    // 投递组:(3+1)/(3+1+1)=0.8;扣留组:(1+0)/(2+1)=0.333
    const lift = rb.getMatureLift('k')
    assert.ok(lift !== null)
    assert.ok(Math.abs(lift! - (4 / 5 - 1 / 3)) < 1e-9)
  })

  test('纯会话 getLift 不受先验影响(保持原语义)', () => {
    const rb = new AdvisoryReadback()
    rb.seedPriors([['k', { delivered: 10, adopted: 8, ignored: 2, shadowHeld: 5, shadowSatisfied: 1 }]])
    assert.equal(rb.getLift('k'), null) // 会话内无实测
  })
})

describe('AdvisoryBus 负 lift 静音', () => {
  test('成熟 lift ≤ 0 → 静音丢弃,账本计 liftMuted', () => {
    const bus = new AdvisoryBus()
    bus.setLiftProvider(() => -0.2)
    bus.submit(entry({ key: 'noise' }))
    assert.equal(bus.render(undefined, 1), '')
    const ledger = bus.drainLedger()
    assert.equal(ledger.liftMuted, 1)
    assert.equal(ledger.dropped, 1)
    assert.ok(ledger.droppedKeys.includes('noise'))
    assert.equal(bus.drainDelivered().length, 0)
  })

  test('lift=null(样本不足)不静音', () => {
    const bus = new AdvisoryBus()
    bus.setLiftProvider(() => null)
    bus.submit(entry({ key: 'a' }))
    assert.match(bus.render(undefined, 1), /key="a"/)
    assert.equal(bus.drainLedger().liftMuted, 0)
  })

  test('正 lift 不静音', () => {
    const bus = new AdvisoryBus()
    bus.setLiftProvider(() => 0.3)
    bus.submit(entry({ key: 'a' }))
    assert.match(bus.render(undefined, 1), /key="a"/)
  })

  test('豁免名单:constitutional/immediate/star_domain 永不静音', () => {
    const bus = new AdvisoryBus()
    bus.setLiftProvider(() => -1)
    bus.submitAll([
      entry({ key: 'const', tier: 'constitutional', priority: 0.9 }),
      entry({ key: 'imm', immediate: true }),
      entry({ key: 'star', category: 'star_domain' }),
    ])
    const xml = bus.render(undefined, 1)
    for (const k of ['const', 'imm', 'star']) {
      assert.match(xml, new RegExp(`key="${k}"`), `${k} 应照常渲染`)
    }
    assert.equal(bus.drainLedger().liftMuted, 0)
  })

  test('静音持续 LIFT_MUTE_RENDERS 周期,期满 probation 放行一次后可再静音', () => {
    const bus = new AdvisoryBus()
    bus.setLiftProvider(() => -0.5)
    // 首次触发静音
    bus.submit(entry({ key: 'k' }))
    assert.equal(bus.render(undefined, 1), '')
    // 静音期内持续丢弃(计时随渲染周期流逝)
    for (let i = 0; i < LIFT_MUTE_RENDERS - 1; i++) {
      bus.submit(entry({ key: 'k' }))
      assert.equal(bus.render(undefined, i + 2), '', `第 ${i + 1} 个静音周期应丢弃`)
    }
    // 期满 → probation 放行一次
    bus.submit(entry({ key: 'k' }))
    assert.match(bus.render(undefined, 99), /key="k"/, 'probation 应放行一次')
    // probation 消费后 lift 仍 ≤0 → 再次静音
    bus.submit(entry({ key: 'k' }))
    assert.equal(bus.render(undefined, 100), '')
    const ledger = bus.drainLedger()
    assert.ok(ledger.liftMuted >= LIFT_MUTE_RENDERS + 1)
  })

  test('getSilencedKeys 汇报 lift 静音(cockpit 观测口)', () => {
    const bus = new AdvisoryBus()
    bus.setLiftProvider(k => (k === 'noise' ? -0.2 : null))
    bus.submitAll([entry({ key: 'noise' }), entry({ key: 'ok' })])
    bus.render(undefined, 1)
    const silenced = bus.getSilencedKeys()
    assert.equal(silenced.length, 1)
    assert.equal(silenced[0]!.key, 'noise')
    assert.equal(silenced[0]!.reason, 'lift')
    assert.ok(silenced[0]!.remaining > 0)
  })

  test('未注入 liftProvider 时零行为变化', () => {
    const bus = new AdvisoryBus()
    bus.submit(entry({ key: 'a' }))
    assert.match(bus.render(undefined, 1), /key="a"/)
    assert.equal(bus.drainLedger().liftMuted, 0)
  })
})

describe('AdvisoryBus Top-N 排序 lift 升级', () => {
  test('同 priority:成熟 lift 高者优先于采纳率', () => {
    const bus = new AdvisoryBus()
    // lift: a=0.4, b=null(回退采纳率)
    bus.setLiftProvider(k => (k === 'a' ? 0.4 : null))
    // 采纳率: b=0.95(高) — 但 a 的 lift 归一 (0.4+1)/2=0.7 < 0.95,b 应在前
    bus.setAdoptionRateProvider(k => (k === 'b' ? 0.95 : null))
    // 用不同 category 避免类别上限干扰;同 priority 竞争 Top-N
    bus.submitAll([
      entry({ key: 'a', category: 'repair' }),
      entry({ key: 'b', category: 'mistake' }),
      entry({ key: 'c', category: 'dedup' }),
      entry({ key: 'd', category: 'todo' }),
    ])
    const xml = bus.render(undefined, 1)
    const order = ['a', 'b', 'c', 'd'].map(k => ({ k, at: xml.indexOf(`key="${k}"`) })).filter(o => o.at >= 0)
    assert.ok(order.length === 3, 'Top-3 截断')
    const bAt = xml.indexOf('key="b"')
    const aAt = xml.indexOf('key="a"')
    assert.ok(bAt >= 0 && aAt >= 0 && bAt < aAt, '采纳率 0.95 的 b 应排在 lift 归一 0.7 的 a 之前')
  })

  test('负 lift 排在中性(null)之后', () => {
    const bus = new AdvisoryBus()
    // 负 lift 但未触发静音路径:用 immediate 豁免静音,只测排序
    bus.setLiftProvider(k => (k === 'neg' ? -0.4 : null))
    bus.submitAll([
      entry({ key: 'neg', category: 'repair', immediate: true }),
      entry({ key: 'neutral', category: 'mistake', immediate: true }),
    ])
    const xml = bus.render(undefined, 1)
    const negAt = xml.indexOf('key="neg"')
    const neutralAt = xml.indexOf('key="neutral"')
    assert.ok(neutralAt >= 0 && negAt >= 0 && neutralAt < negAt, '中性 0.5 应排在负 lift 归一 0.3 之前')
  })
})
