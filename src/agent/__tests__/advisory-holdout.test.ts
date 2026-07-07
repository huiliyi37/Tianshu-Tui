import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus, parseHoldoutRate, DEFAULT_HOLDOUT_RATE, type AdvisoryEntry } from '../advisory-bus.js'
import { AdvisoryReadback } from '../advisory-readback.js'

function entry(overrides: Partial<AdvisoryEntry> & { key: string }): AdvisoryEntry {
  return {
    priority: 0.6,
    category: 'discipline',
    content: `advice for ${overrides.key}`,
    expect: { kind: 'verify_attempted', withinTurns: 2 },
    ...overrides,
  }
}

describe('AdvisoryBus holdout 反事实抽样', () => {
  test('rng 命中时条目被扣留:不渲染、delivered 带 shadow、账本计 heldOut', () => {
    const bus = new AdvisoryBus()
    bus.setHoldoutPolicy({ rate: 0.5, isEligible: () => true, rng: () => 0.1 })
    bus.submit(entry({ key: 'a' }))
    const xml = bus.render(undefined, 1)
    assert.equal(xml, '')
    const delivered = bus.drainDelivered()
    assert.equal(delivered.length, 1)
    assert.equal(delivered[0]!.key, 'a')
    assert.equal(delivered[0]!.shadow, true)
    const ledger = bus.drainLedger()
    assert.equal(ledger.heldOut, 1)
    assert.equal(ledger.rendered, 0)
    assert.equal(ledger.dropped, 0) // 扣留 ≠ 丢弃
  })

  test('rng 未命中时照常渲染,无 shadow 标记', () => {
    const bus = new AdvisoryBus()
    bus.setHoldoutPolicy({ rate: 0.5, isEligible: () => true, rng: () => 0.9 })
    bus.submit(entry({ key: 'a' }))
    const xml = bus.render(undefined, 1)
    assert.match(xml, /key="a"/)
    const delivered = bus.drainDelivered()
    assert.equal(delivered[0]!.shadow, undefined)
    assert.equal(bus.drainLedger().heldOut, 0)
  })

  test('豁免白名单:constitutional/immediate/star_domain/无 expect 永不扣留', () => {
    const bus = new AdvisoryBus()
    bus.setHoldoutPolicy({ rate: 1, isEligible: () => true, rng: () => 0 })
    bus.submitAll([
      entry({ key: 'const', tier: 'constitutional', priority: 0.9 }),
      entry({ key: 'imm', immediate: true }),
      entry({ key: 'star', category: 'star_domain' }),
      entry({ key: 'noexpect', expect: undefined }),
    ])
    const xml = bus.render(undefined, 1)
    for (const k of ['const', 'imm', 'star', 'noexpect']) {
      assert.match(xml, new RegExp(`key="${k}"`), `${k} 应照常渲染`)
    }
    assert.equal(bus.drainLedger().heldOut, 0)
  })

  test('isEligible=false(冷 key)不扣留', () => {
    const bus = new AdvisoryBus()
    bus.setHoldoutPolicy({ rate: 1, isEligible: () => false, rng: () => 0 })
    bus.submit(entry({ key: 'cold' }))
    assert.match(bus.render(undefined, 1), /key="cold"/)
    assert.equal(bus.drainLedger().heldOut, 0)
  })

  test('rate=0 关闭抽样', () => {
    const bus = new AdvisoryBus()
    bus.setHoldoutPolicy({ rate: 0, isEligible: () => true, rng: () => 0 })
    bus.submit(entry({ key: 'a' }))
    assert.match(bus.render(undefined, 1), /key="a"/)
    assert.equal(bus.drainLedger().heldOut, 0)
  })
})

describe('AdvisoryReadback shadow 桶隔离', () => {
  test('shadow 送达计 shadowHeld 不计 delivered;满足谓词进 shadowSatisfied,不动 adopted/streak', () => {
    const rb = new AdvisoryReadback()
    rb.track([{ key: 'k', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 2 }, shadow: true }], 1)
    rb.observeTool({ turn: 1, name: 'run_tests', target: '', isError: false })
    rb.evaluate(1)
    const s = rb.getStats().get('k')!
    assert.equal(s.shadowHeld, 1)
    assert.equal(s.shadowSatisfied, 1)
    assert.equal(s.delivered, 0)
    assert.equal(s.adopted, 0)
    assert.equal(s.ignored, 0)
    assert.equal(s.ignoredStreak, 0)
    // 判定事件带 shadow 标记(遥测 kind 分流依据)
    const outcomes = rb.drainOutcomes()
    assert.equal(outcomes.length, 1)
    assert.equal(outcomes[0]!.shadow, true)
    // getTotals 不受污染(副驾闸门数据)
    assert.deepEqual(rb.getTotals(), { adopted: 0, ignored: 0 })
  })

  test('shadow 到期未满足:不计 ignored、不涨 ignoredStreak', () => {
    const rb = new AdvisoryReadback()
    rb.track([{ key: 'k', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 1 }, shadow: true }], 1)
    rb.evaluate(1) // deadline = 1,无验证事件 → shadow 判 ignored
    const s = rb.getStats().get('k')!
    assert.equal(s.shadowHeld, 1)
    assert.equal(s.shadowSatisfied, 0)
    assert.equal(s.ignored, 0)
    assert.equal(s.ignoredStreak, 0)
  })

  test('getLift:投递组采纳率 − 扣留组自发完成率;数据不足返回 null', () => {
    const rb = new AdvisoryReadback()
    assert.equal(rb.getLift('k'), null)
    // 投递组:2 送达 2 采纳(采纳率 1.0)
    for (const t of [1, 3]) {
      rb.track([{ key: 'k', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 1 } }], t)
      rb.observeTool({ turn: t, name: 'run_tests', target: '', isError: false })
      rb.evaluate(t)
    }
    assert.equal(rb.getLift('k'), null) // 无 shadow 样本仍 null
    // 扣留组:2 held 1 自发完成(基线 0.5)
    rb.track([{ key: 'k', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 1 }, shadow: true }], 5)
    rb.observeTool({ turn: 5, name: 'run_tests', target: '', isError: false })
    rb.evaluate(5)
    rb.track([{ key: 'k', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 1 }, shadow: true }], 7)
    rb.evaluate(7)
    const lift = rb.getLift('k')
    assert.ok(lift !== null && Math.abs(lift - 0.5) < 1e-9, `lift 应为 0.5,实际 ${lift}`)
  })

  test('getDeliveredCount 只数真实送达(holdout 资格判定入口)', () => {
    const rb = new AdvisoryReadback()
    rb.track([{ key: 'k', category: 'discipline' }], 1)
    rb.track([{ key: 'k', category: 'discipline', shadow: true }], 2)
    assert.equal(rb.getDeliveredCount('k'), 1)
  })

  test('shadow 状态翻转作废反事实 trial:真实 pending 存在时新扣留回滚 shadowHeld', () => {
    const rb = new AdvisoryReadback()
    const expect_ = { kind: 'verify_attempted' as const, withinTurns: 3 }
    rb.track([{ key: 'k', category: 'discipline', expect: expect_ }], 1)
    rb.track([{ key: 'k', category: 'discipline', expect: expect_, shadow: true }], 2)
    const s = rb.getStats().get('k')!
    assert.equal(s.shadowHeld, 0) // 模型近期已见过提醒,扣留无对照价值
    assert.equal(s.delivered, 1)
  })

  test('shadow pending 被真实送达打断:扣留期作废,转为真实观察', () => {
    const rb = new AdvisoryReadback()
    const expect_ = { kind: 'verify_attempted' as const, withinTurns: 3 }
    rb.track([{ key: 'k', category: 'discipline', expect: expect_, shadow: true }], 1)
    rb.track([{ key: 'k', category: 'discipline', expect: expect_ }], 2)
    rb.observeTool({ turn: 2, name: 'run_tests', target: '', isError: false })
    rb.evaluate(2)
    const s = rb.getStats().get('k')!
    assert.equal(s.shadowHeld, 0)
    assert.equal(s.adopted, 1)
  })
})

describe('跨会话先验三消费方(B)', () => {
  function seeded(): AdvisoryReadback {
    const rb = new AdvisoryReadback()
    rb.seedPriors([['k', { delivered: 5, adopted: 4, ignored: 1, shadowHeld: 2, shadowSatisfied: 1 }]])
    return rb
  }

  test('holdout 资格:getDeliveredCount 含先验,新会话即可开始抽样', () => {
    const rb = seeded()
    assert.equal(rb.getDeliveredCount('k'), 5)
    rb.track([{ key: 'k', category: 'discipline' }], 1)
    assert.equal(rb.getDeliveredCount('k'), 6)
  })

  test('副驾闸门:getTotalsWithPriors 含先验,getTotals 保持会话纯度', () => {
    const rb = seeded()
    assert.deepEqual(rb.getTotals(), { adopted: 0, ignored: 0 })
    const t = rb.getTotalsWithPriors()
    assert.equal(t.adopted, 4)
    assert.equal(t.ignored, 1)
  })

  test('副驾闸门:先验决出样本超上限时按比例缩放保采纳率', () => {
    const rb = new AdvisoryReadback()
    rb.seedPriors([['big', { delivered: 100, adopted: 60, ignored: 40, shadowHeld: 0, shadowSatisfied: 0 }]])
    const t = rb.getTotalsWithPriors()
    assert.ok(Math.abs(t.adopted + t.ignored - 20) < 1e-9, `决出贡献应为上限 20,实际 ${t.adopted + t.ignored}`)
    assert.ok(Math.abs(t.adopted / (t.adopted + t.ignored) - 0.6) < 1e-9, '采纳率应保持 0.6')
  })

  test('Top-N 次级排序:同 priority 时历史采纳率高者胜出', () => {
    const rb = new AdvisoryReadback()
    rb.seedPriors([
      ['good', { delivered: 5, adopted: 5, ignored: 0, shadowHeld: 0, shadowSatisfied: 0 }],
      ['bad', { delivered: 5, adopted: 0, ignored: 5, shadowHeld: 0, shadowSatisfied: 0 }],
    ])
    const bus = new AdvisoryBus()
    bus.setAdoptionRateProvider(key => rb.getAdoptionRate(key))
    // 4 条同 priority(discipline 类别上限 2)——good 应挤掉 bad
    bus.submitAll([
      entry({ key: 'bad', priority: 0.6 }),
      entry({ key: 'good', priority: 0.6 }),
      entry({ key: 'neutral1', priority: 0.6, category: 'repair' }),
      entry({ key: 'neutral2', priority: 0.6, category: 'typecheck' }),
    ])
    const xml = bus.render(undefined, 1)
    assert.match(xml, /key="good"/)
    assert.doesNotMatch(xml, /key="bad"/)
  })

  test('getAdoptionRate 合并先验与会话实测;无数据返回 null', () => {
    const rb = seeded()
    assert.equal(rb.getAdoptionRate('unknown'), null)
    assert.ok(Math.abs(rb.getAdoptionRate('k')! - 0.8) < 1e-9)
    // 会话内 1 次 ignored → (4)/(4+1+1) ≈ 0.667
    rb.track([{ key: 'k', category: 'discipline', expect: { kind: 'verify_attempted', withinTurns: 1 } }], 1)
    rb.evaluate(1)
    assert.ok(Math.abs(rb.getAdoptionRate('k')! - 4 / 6) < 1e-9)
  })

  test('习惯化不吃先验:seedPriors 不影响 ignoredStreak', () => {
    const rb = new AdvisoryReadback()
    rb.seedPriors([['k', { delivered: 10, adopted: 0, ignored: 10, shadowHeld: 0, shadowSatisfied: 0 }]])
    assert.equal(rb.getIgnoredStreak('k'), 0)
  })
})

describe('parseHoldoutRate', () => {
  test('缺省/非法回默认率,合法值与 0 生效', () => {
    assert.equal(parseHoldoutRate(undefined), DEFAULT_HOLDOUT_RATE)
    assert.equal(parseHoldoutRate(''), DEFAULT_HOLDOUT_RATE)
    assert.equal(parseHoldoutRate('abc'), DEFAULT_HOLDOUT_RATE)
    assert.equal(parseHoldoutRate('1.5'), DEFAULT_HOLDOUT_RATE)
    assert.equal(parseHoldoutRate('-0.1'), DEFAULT_HOLDOUT_RATE)
    assert.equal(parseHoldoutRate('0'), 0)
    assert.equal(parseHoldoutRate('0.25'), 0.25)
  })
})
