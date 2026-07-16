import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus, DISCIPLINE_REANCHOR_INTERVAL, disciplineReanchorEntry } from '../advisory-bus.js'

describe('AdvisoryBus', () => {
  it('renders empty when no entries', () => {
    const bus = new AdvisoryBus()
    assert.equal(bus.render(), '')
  })

  it('renders single entry as 星域-advisory XML', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'test', priority: 0.8, category: 'repair', content: 'check file X' })
    const result = bus.render()
    assert.match(result, /<星域-advisory>/)
    assert.match(result, /<entry key="test"/)
    assert.match(result, /check file X/)
    assert.match(result, /<\/星域-advisory>/)
  })

  it('deduplicates by key — keeps highest priority', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'dup', priority: 0.5, category: 'repair', content: 'low' })
    bus.submit({ key: 'dup', priority: 0.9, category: 'immune', content: 'high' })
    const result = bus.render()
    assert.match(result, /high/)
    assert.ok(!result.includes('low'), 'low priority entry should be deduped out')
  })

  it('limits to max 3 entries per turn (Top-3 by priority)', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'a', priority: 0.3, category: 'repair', content: 'A' })
    bus.submit({ key: 'b', priority: 0.9, category: 'immune', content: 'B' })
    bus.submit({ key: 'c', priority: 0.5, category: 'mistake', content: 'C' })
    bus.submit({ key: 'd', priority: 0.7, category: 'dedup', content: 'D' })
    bus.submit({ key: 'e', priority: 0.1, category: 'dead_end', content: 'E' })
    const result = bus.render()
    // Top 3 by priority: B(0.9), D(0.7), C(0.5)
    assert.match(result, /B/)
    assert.match(result, /D/)
    assert.match(result, /C/)
    assert.ok(!result.includes('A'), 'A (0.3) should be dropped')
    assert.ok(!result.includes('E'), 'E (0.1) should be dropped')
    // Count <entry> tags
    const entryCount = (result.match(/<entry /g) || []).length
    assert.equal(entryCount, 3)
  })

  it('TTL > 1 keeps entry alive across renders', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'persist', priority: 0.8, category: 'repair', content: 'persistent hint', ttl: 2 })
    const r1 = bus.render()
    assert.match(r1, /persistent hint/)
    // Next render — entry should still be alive (ttl decremented to 1)
    const r2 = bus.render()
    assert.match(r2, /persistent hint/)
    // Third render — ttl exhausted, entry gone
    const r3 = bus.render()
    assert.ok(!r3.includes('persistent hint'), 'TTL exhausted entry should be gone')
  })

  it('reset clears all state including alive entries', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'x', priority: 0.8, category: 'repair', content: 'X', ttl: 5 })
    bus.render()
    bus.reset()
    assert.equal(bus.render(), '')
  })

  it('XML special characters are escaped in content', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'esc', priority: 0.8, category: 'repair', content: 'use <file> & "path"' })
    const result = bus.render()
    assert.match(result, /&lt;file&gt;/)
    assert.match(result, /&amp;/)
    assert.match(result, /&quot;path&quot;/)
  })

  it('renders empty after consuming all entries', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'once', priority: 0.5, category: 'mistake', content: 'one time' })
    const r1 = bus.render()
    assert.match(r1, /one time/)
    const r2 = bus.render()
    assert.equal(r2, '')
  })
})

describe('W2 efficacy 负反馈环 (incident 20b9714e)', () => {
  /** 模拟真实接线：render 送达后 delivered++（AdvisoryReadback.track 的会话统计半边） */
  function makeStatsHarness(bus: AdvisoryBus) {
    const stats = new Map<string, { delivered: number; adopted: number }>()
    bus.setEfficacyStatsProvider(key => stats.get(key) ?? null)
    const trackDelivered = () => {
      for (const d of bus.drainDelivered()) {
        const s = stats.get(d.key) ?? { delivered: 0, adopted: 0 }
        s.delivered++
        stats.set(d.key, s)
      }
    }
    return { stats, trackDelivered }
  }

  it('zero-adoption key: cooldown doubles from the 4th delivery, session-silenced after the 6th', () => {
    const bus = new AdvisoryBus()
    const { trackDelivered } = makeStatsHarness(bus)

    const deliveredAtCycle: number[] = []
    for (let cycle = 1; cycle <= 32; cycle++) {
      bus.submit({ key: 'convergence', priority: 0.65, category: 'discipline', content: '请收敛' })
      const out = bus.render(undefined, cycle)
      if (out.includes('key="convergence"')) deliveredAtCycle.push(cycle)
      trackDelivered()
    }

    // 前 3 次无阻拦；第 4 次起进入冷却翻倍;delivered 到 6 后本会话静默。
    assert.deepEqual(deliveredAtCycle.slice(0, 3), [1, 2, 3], 'first three deliveries unthrottled')
    assert.equal(deliveredAtCycle.length, 6, `delivered cap must be 6, got ${deliveredAtCycle.length} at ${deliveredAtCycle}`)
    const gap45 = deliveredAtCycle[4]! - deliveredAtCycle[3]!
    const gap56 = deliveredAtCycle[5]! - deliveredAtCycle[4]!
    assert.ok(gap56 > gap45, `cooldown must double between deliveries: gaps ${gap45} → ${gap56}`)
    assert.ok(bus.isEfficacySilenced('convergence'), 'key must be session-silenced after 6 zero-adoption deliveries')
  })

  it('adopted key is never throttled or silenced', () => {
    const bus = new AdvisoryBus()
    const { stats, trackDelivered } = makeStatsHarness(bus)
    stats.set('helpful', { delivered: 10, adopted: 2 })

    let rendered = 0
    for (let cycle = 1; cycle <= 10; cycle++) {
      bus.submit({ key: 'helpful', priority: 0.6, category: 'repair', content: '有效提醒' })
      if (bus.render(undefined, cycle).includes('key="helpful"')) rendered++
      trackDelivered()
    }
    assert.equal(rendered, 10, 'adopted > 0 exempts the key from the feedback loop')
    assert.equal(bus.isEfficacySilenced('helpful'), false)
  })

  it('constitutional / high-priority entries are fail-open exempt', () => {
    const bus = new AdvisoryBus()
    const { stats, trackDelivered } = makeStatsHarness(bus)
    stats.set('guard', { delivered: 20, adopted: 0 })
    stats.set('hi-pri', { delivered: 20, adopted: 0 })

    let guardRendered = 0
    let hiPriRendered = 0
    for (let cycle = 1; cycle <= 8; cycle++) {
      bus.submit({ key: 'guard', priority: 0.9, category: 'constitutional', tier: 'constitutional', content: '宪法级' })
      bus.submit({ key: 'hi-pri', priority: 0.85, category: 'repair', content: '高优先级' })
      const out = bus.render(undefined, cycle)
      if (out.includes('key="guard"')) guardRendered++
      if (out.includes('key="hi-pri"')) hiPriRendered++
      trackDelivered()
    }
    assert.equal(guardRendered, 8, 'constitutional tier must never be silenced')
    assert.equal(hiPriRendered, 8, 'priority >= 0.8 must never be silenced')
  })

  it('no provider wired → loop is inert (backwards compatible)', () => {
    const bus = new AdvisoryBus()
    let rendered = 0
    for (let cycle = 1; cycle <= 10; cycle++) {
      bus.submit({ key: 'legacy', priority: 0.6, category: 'repair', content: '旧行为' })
      if (bus.render(undefined, cycle).includes('key="legacy"')) rendered++
    }
    assert.equal(rendered, 10)
  })
})

describe('W6 CVM overhead throttle — channel B degradation (incident 20b9714e)', () => {
  it('throttled: non-exempt entries deliver every other render cycle', () => {
    const bus = new AdvisoryBus()
    bus.setOverheadThrottled(true)
    const deliveredAt: number[] = []
    for (let cycle = 1; cycle <= 8; cycle++) {
      bus.submit({ key: 'noise', priority: 0.6, category: 'discipline', content: '普通提醒' })
      if (bus.render(undefined, cycle).includes('key="noise"')) deliveredAt.push(cycle)
    }
    assert.equal(deliveredAt.length, 4, `alternating delivery: expected 4/8, got ${deliveredAt.length} at ${deliveredAt}`)
    for (let i = 1; i < deliveredAt.length; i++) {
      assert.equal(deliveredAt[i]! - deliveredAt[i - 1]!, 2, 'gap between deliveries must be 2 cycles')
    }
  })

  it('throttled: constitutional / immediate / priority>=0.8 are exempt', () => {
    const bus = new AdvisoryBus()
    bus.setOverheadThrottled(true)
    let constitutional = 0
    let hiPri = 0
    for (let cycle = 1; cycle <= 6; cycle++) {
      bus.submit({ key: 'guard', priority: 0.9, category: 'constitutional', tier: 'constitutional', content: '宪法级' })
      bus.submit({ key: 'hi', priority: 0.85, category: 'repair', content: '高优先级' })
      const out = bus.render(undefined, cycle)
      if (out.includes('key="guard"')) constitutional++
      if (out.includes('key="hi"')) hiPri++
    }
    assert.equal(constitutional, 6, 'constitutional never throttled by overhead')
    assert.equal(hiPri, 6, 'priority >= 0.8 never throttled by overhead')
  })

  it('unthrottling resets the skip state — next render delivers', () => {
    const bus = new AdvisoryBus()
    bus.setOverheadThrottled(true)
    bus.submit({ key: 'a', priority: 0.6, category: 'discipline', content: 'x' })
    assert.ok(bus.render(undefined, 1).includes('key="a"'), 'first throttled render delivers')
    bus.setOverheadThrottled(false)
    bus.submit({ key: 'a', priority: 0.6, category: 'discipline', content: 'x' })
    assert.ok(bus.render(undefined, 2).includes('key="a"'), 'unthrottled render always delivers')
    bus.submit({ key: 'a', priority: 0.6, category: 'discipline', content: 'x' })
    assert.ok(bus.render(undefined, 3).includes('key="a"'), 'stays delivered while unthrottled')
  })
})

describe('discipline re-anchor (F-fix, session 803d897d)', () => {
  it('exposes a sane re-anchor interval', () => {
    assert.ok(DISCIPLINE_REANCHOR_INTERVAL >= 10 && DISCIPLINE_REANCHOR_INTERVAL <= 30)
  })

  it('renders the discipline summary through the bus, deduped by key', () => {
    const bus = new AdvisoryBus()
    bus.submit(disciplineReanchorEntry())
    bus.submit(disciplineReanchorEntry())
    const rendered = bus.render()
    assert.match(rendered, /category="discipline"/)
    assert.ok(rendered.includes('闭环') || rendered.includes('接线') || rendered.includes('自检') || rendered.includes('节奏') || rendered.includes('分波'), 'discipline content must contain core keyword')
    const occurrences = rendered.split('discipline-reanchor').length - 1
    assert.equal(occurrences, 1, 'same-key entries must dedupe to one line')
  })

  it('does not crowd out higher-priority corrective advisories', () => {
    const bus = new AdvisoryBus()
    bus.submit(disciplineReanchorEntry())
    bus.submit({ key: 'immune-1', priority: 0.9, category: 'immune', content: 'stop repeating failed edit' })
    bus.submit({ key: 'repair-1', priority: 0.8, category: 'repair', content: 'fix type error first' })
    bus.submit({ key: 'dedup-1', priority: 0.7, category: 'dedup', content: 'duplicate output detected' })
    const rendered = bus.render()
    assert.match(rendered, /immune-1/)
    assert.match(rendered, /repair-1/)
    assert.match(rendered, /dedup-1/)
    assert.doesNotMatch(rendered, /discipline-reanchor/, 'discipline anchor yields to top-3 corrective signals')
  })

  it('discipline variants rotate content for anti-habituation', () => {
    const contents = new Set<string>()
    for (let i = 0; i < 30; i++) {
      contents.add(disciplineReanchorEntry().content)
    }
    assert.ok(contents.size >= 2, `expected >=2 unique variants but got ${contents.size}`)
  })
})

// 2026-07-04：deprecated stalenessGateEntry / vigorLowEntry 死代码已删除
//（零生产调用方，宣称的 CCR P2 替代早已被裁）。胶囊召回改为 CCR 触发的
// 一等附属，见 cognitive-capsule-router.test.ts。

describe('star-domain render filter (2026-07-04 触发面修复)', () => {
  it('suppresses static same-domain manifesto entries (frozen-base duplicates)', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'discipline-reanchor', priority: 0.55, category: 'discipline', content: '【天权】静态宣言内容' })
    const rendered = bus.render('天权')
    assert.doesNotMatch(rendered, /discipline-reanchor/, '同星域静态条目应被冻结区 persona 顶掉')
  })

  it('does NOT suppress situational star_domain entries for the active domain', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'ccr-天权-P7', priority: 0.65, category: 'star_domain', content: '【天权】验证连续失败 2 次。换维度。' })
    bus.submit({ key: 'capsule-recall', priority: 0.45, category: 'star_domain', tier: 'informational', content: '【天权·胶囊】方法论 gist——recall_capsule("天权")。' })
    const rendered = bus.render('天权')
    assert.match(rendered, /ccr-天权-P7/, '同星域的情境性改道提醒不是宣言重复，必须渲染')
    assert.match(rendered, /capsule-recall/, '胶囊召回条目同样豁免')
  })

  it('star_domain category does not compete with discipline for MAX_PER_CATEGORY', () => {
    const bus = new AdvisoryBus()
    // 2 条 discipline 吃满类别预算
    bus.submit({ key: 'd1', priority: 0.9, category: 'discipline', content: 'D1' })
    bus.submit({ key: 'd2', priority: 0.85, category: 'discipline', content: 'D2' })
    // CCR 条目在独立类别 — 不再被 discipline 上限挤掉
    bus.submit({ key: 'ccr-瑶光-P1', priority: 0.55, category: 'star_domain', content: '【瑶光】去验证' })
    const rendered = bus.render()
    assert.match(rendered, /ccr-瑶光-P1/, 'star_domain 独立类别，不受 discipline MAX_PER_CATEGORY 影响')
  })
})

describe('advisory delivery ledger (Phase 0 观测)', () => {
  it('counts submitted, rendered and dropped entries', () => {
    const bus = new AdvisoryBus()
    for (let i = 0; i < 5; i++) {
      bus.submit({ key: `op-${i}`, priority: 0.9 - i * 0.1, category: 'repair', content: `OP-${i}` })
    }
    bus.render()
    const ledger = bus.drainLedger()
    assert.equal(ledger.submitted, 5)
    // repair 类别上限 2 → 渲染 2，丢 3
    assert.equal(ledger.rendered, 2)
    assert.equal(ledger.dropped, 3)
    assert.ok(ledger.droppedKeys.includes('op-2'))
  })

  it('drainLedger resets counters', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'a', priority: 0.5, category: 'repair', content: 'A' })
    bus.render()
    bus.drainLedger()
    const second = bus.drainLedger()
    assert.equal(second.submitted, 0)
    assert.equal(second.rendered, 0)
    assert.equal(second.dropped, 0)
  })

  it('records star-domain filter drops', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'static-persona', priority: 0.5, category: 'discipline', content: '【天枢】常驻宣言' })
    bus.render('天枢')
    const ledger = bus.drainLedger()
    assert.ok(ledger.droppedKeys.includes('static-persona'))
  })
})

describe('priority tier (constitutional/operational/informational)', () => {
  it('constitutional entries bypass Top-3 cap — 4 operational + 1 constitutional → 4 rendered', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'op-a', priority: 0.9, tier: 'operational', category: 'repair', content: 'OP-A' })
    bus.submit({ key: 'op-b', priority: 0.8, tier: 'operational', category: 'immune', content: 'OP-B' })
    bus.submit({ key: 'op-c', priority: 0.7, tier: 'operational', category: 'mistake', content: 'OP-C' })
    bus.submit({ key: 'op-d', priority: 0.6, tier: 'operational', category: 'dedup', content: 'OP-D' })
    bus.submit({ key: 'const', priority: 0.9, tier: 'constitutional', category: 'constitutional', content: 'CONST' })
    const result = bus.render()
    // Constitutional always renders
    assert.match(result, /CONST/)
    // Operational Top-3: OP-A(0.9), OP-B(0.8), OP-C(0.7) render; OP-D(0.6) dropped
    assert.match(result, /OP-A/)
    assert.match(result, /OP-B/)
    assert.match(result, /OP-C/)
    assert.ok(!result.includes('OP-D'), 'OP-D (0.6) should be dropped — operational capped at 3')
    const entryCount = (result.match(/<entry /g) || []).length
    assert.equal(entryCount, 4, '1 constitutional + 3 operational = 4 entries')
  })

  it('constitutional entries are not subject to category cap', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'c1', priority: 0.9, tier: 'constitutional', category: 'constitutional', content: 'C1' })
    bus.submit({ key: 'c2', priority: 0.8, tier: 'constitutional', category: 'constitutional', content: 'C2' })
    bus.submit({ key: 'c3', priority: 0.7, tier: 'constitutional', category: 'constitutional', content: 'C3' })
    const result = bus.render()
    assert.match(result, /C1/)
    assert.match(result, /C2/)
    assert.match(result, /C3/)
    const entryCount = (result.match(/<entry /g) || []).length
    assert.equal(entryCount, 3, 'all 3 constitutional entries render despite same category')
  })

  it('operational prioritised over informational for Top-3 slots', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'info-1', priority: 0.9, tier: 'informational', category: 'encouragement', content: 'INFO-HI' })
    bus.submit({ key: 'info-2', priority: 0.8, tier: 'informational', category: 'encouragement', content: 'INFO-MID' })
    bus.submit({ key: 'op-1', priority: 0.5, tier: 'operational', category: 'repair', content: 'OP-LOW' })
    bus.submit({ key: 'op-2', priority: 0.4, tier: 'operational', category: 'immune', content: 'OP-VLOW' })
    bus.submit({ key: 'op-3', priority: 0.3, tier: 'operational', category: 'mistake', content: 'OP-VVLOW' })
    const result = bus.render()
    // All 3 operational should render despite lower numeric priority
    assert.match(result, /OP-LOW/)
    assert.match(result, /OP-VLOW/)
    assert.match(result, /OP-VVLOW/)
    // INFO entries should NOT render — all 3 slots taken by operational
    assert.ok(!result.includes('INFO-HI'), 'INFO-HI should be dropped — operational takes priority')
    assert.ok(!result.includes('INFO-MID'), 'INFO-MID should be dropped — operational takes priority')
  })

  it('informational fills remaining slots after operational', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'op-1', priority: 0.6, tier: 'operational', category: 'repair', content: 'OP' })
    bus.submit({ key: 'info-1', priority: 0.5, tier: 'informational', category: 'encouragement', content: 'INFO1' })
    bus.submit({ key: 'info-2', priority: 0.4, tier: 'informational', category: 'encouragement', content: 'INFO2' })
    const result = bus.render()
    assert.match(result, /OP/)
    assert.match(result, /INFO1/)
    assert.match(result, /INFO2/)
    const entryCount = (result.match(/<entry /g) || []).length
    assert.equal(entryCount, 3, '1 operational + 2 informational fill 3 slots')
  })

  it('mixed tiers render constitutional first, then by priority', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'op', priority: 0.9, tier: 'operational', category: 'repair', content: 'OP' })
    bus.submit({ key: 'const', priority: 0.5, tier: 'constitutional', category: 'constitutional', content: 'CONST' })
    bus.submit({ key: 'info', priority: 0.8, tier: 'informational', category: 'encouragement', content: 'INFO' })
    const result = bus.render()
    // Constitutional always first despite lower numeric priority
    const constPos = result.indexOf('CONST')
    const opPos = result.indexOf('OP')
    assert.ok(constPos < opPos, 'constitutional should render before operational')
  })

  // ── CVM-vector v3.1 Wave 1: peekPendingKeys 无副作用观察口 ──

  describe('peekPendingKeys', () => {
    it('returns submitted keys before render', () => {
      const bus = new AdvisoryBus()
      bus.submit({ key: 'ccr-瑶光-P1', priority: 0.55, category: 'star_domain', content: 'X' })
      bus.submit({ key: 'self-verify', priority: 0.6, category: 'discipline', content: 'Y' })
      assert.deepEqual(new Set(bus.peekPendingKeys()), new Set(['ccr-瑶光-P1', 'self-verify']))
    })

    it('includes alive (ttl carried) entries after a render', () => {
      const bus = new AdvisoryBus()
      bus.submit({ key: 'persist', priority: 0.8, category: 'repair', content: 'P', ttl: 2 })
      bus.render()
      assert.ok(bus.peekPendingKeys().includes('persist'), 'alive entry should be visible to peek')
    })

    it('has zero side effects — render output byte-identical with and without peek', () => {
      const mkBus = () => {
        const bus = new AdvisoryBus()
        bus.submit({ key: 'a', priority: 0.7, category: 'repair', content: 'AAA', ttl: 2 })
        bus.submit({ key: 'b', priority: 0.5, category: 'mistake', content: 'BBB', expect: { kind: 'verify_attempted' } })
        bus.submit({ key: 'c', priority: 0.9, tier: 'constitutional', category: 'constitutional', content: 'CCC' })
        return bus
      }
      const peeked = mkBus()
      const control = mkBus()
      peeked.peekPendingKeys()
      peeked.peekPendingKeys() // 重复 peek 也不能改变任何东西
      const r1 = peeked.render(undefined, 3)
      const r2 = control.render(undefined, 3)
      assert.equal(r1, r2, 'peek must not perturb render output')
      // 账本与 delivered 快照也必须一致
      assert.deepEqual(peeked.drainLedger(), control.drainLedger())
      assert.deepEqual(peeked.drainDelivered(), control.drainDelivered())
      // 第二轮 render（alive 承接）也逐字节一致
      assert.equal(peeked.render(undefined, 4), control.render(undefined, 4))
    })

    it('does not drain entries — render after peek still delivers them', () => {
      const bus = new AdvisoryBus()
      bus.submit({ key: 'kept', priority: 0.8, category: 'repair', content: 'KEPT' })
      bus.peekPendingKeys()
      assert.match(bus.render(), /KEPT/)
    })
  })
})
