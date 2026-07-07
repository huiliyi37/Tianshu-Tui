import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus, type AdvisoryEntry } from '../advisory-bus.js'
import { AdvisoryReadback } from '../advisory-readback.js'

/**
 * Phase 2 打断调度器测试 — 状态机转换（挂起/自愈/corroborate/TTL 强制送达）、
 * 阶段抑制（category 白名单 + 到限送达）、通道分级（system-reminder/status）。
 */

function watchEntry(key: string, over: Partial<AdvisoryEntry> = {}): AdvisoryEntry {
  return {
    key,
    priority: 0.6,
    category: 'discipline',
    content: `advice-${key}`,
    expect: { kind: 'verify_attempted', withinTurns: 2 },
    observe: { turns: 1 },
    ...over,
  }
}

describe('Phase 2 状态机 — 挂起观察', () => {
  it('observe 条目首轮挂起不渲染,到期(TTL 强制送达)后准时投递', () => {
    const bus = new AdvisoryBus()
    bus.submit(watchEntry('self-verify'))

    const first = bus.render(undefined, 5)
    assert.ok(!first.includes('self-verify'), '挂起轮不渲染')

    // 无自愈判定源 → 只按 TTL:observe.turns=1,第二次 render 到期送达
    const second = bus.render(undefined, 6)
    assert.ok(second.includes('self-verify'), `到期必须投递,got: ${second}`)

    const ledger = bus.drainLedger()
    assert.equal(ledger.deferred, 1)
    assert.equal(ledger.revoked, 0)
  })

  it('挂起期内自愈(expect 已被自发满足) → 撤销不投递,计入 revoked', () => {
    const bus = new AdvisoryBus()
    const rb = new AdvisoryReadback()
    bus.setSelfHealCheck((expect, since, now) => rb.wasSatisfiedBetween(expect, since, now))

    bus.submit(watchEntry('self-verify'))
    assert.ok(!bus.render(undefined, 5).includes('self-verify'), '挂起轮不渲染')

    // 模型自发跑了测试（没等提醒送达）
    rb.observeTool({ turn: 5, name: 'run_tests', target: '', isError: false })

    const second = bus.render(undefined, 6)
    assert.ok(!second.includes('self-verify'), '自愈后不投递')
    assert.equal(bus.drainLedger().revoked, 1)
  })

  it('合成回放:挂起后恶化(条件持续,无自愈) → 准时投递', () => {
    const bus = new AdvisoryBus()
    const rb = new AdvisoryReadback()
    bus.setSelfHealCheck((expect, since, now) => rb.wasSatisfiedBetween(expect, since, now))

    // turn 5: hook 检测到未验证 → 挂起
    bus.submit(watchEntry('self-verify', { observe: { turns: 2 } }))
    assert.ok(!bus.render(undefined, 5).includes('self-verify'))
    // turn 6: 模型继续只读没验证（恶化持续,hook 再次投递刷新内容）
    rb.observeTool({ turn: 6, name: 'read_file', target: 'src/a.ts', isError: false })
    bus.submit(watchEntry('self-verify', { observe: { turns: 2 } }))
    assert.ok(!bus.render(undefined, 6).includes('self-verify'), '观察进度保留,不因重复投递重置')
    // turn 7: 到期强制送达
    assert.ok(bus.render(undefined, 7).includes('self-verify'), '恶化路径准时投递')
  })

  it('corroborate 多信号确认:独立信号指认 → 挂起条目提前送达', () => {
    const bus = new AdvisoryBus()
    bus.submit(watchEntry('self-verify', { observe: { turns: 3 } }))
    assert.ok(!bus.render(undefined, 5).includes('self-verify'), '挂起')

    // CCR P1（不同 phase + 不同 category 的独立信号）指认 self-verify
    bus.submit({
      key: 'ccr-瑶光-P1', priority: 0.55, category: 'star_domain',
      content: '【瑶光】改了 3 个文件但还没验证', corroborates: ['self-verify', 'typecheck-reminder'],
    })
    const out = bus.render(undefined, 6)
    assert.ok(out.includes('self-verify'), `corroborate 提前确认,got: ${out}`)
    assert.ok(out.includes('ccr-瑶光-P1'), '指认方自身照常渲染')
  })

  it('immediate / constitutional 条目不受挂起(即使带 observe)', () => {
    const bus = new AdvisoryBus()
    bus.submit(watchEntry('urgent', { immediate: true }))
    bus.submit(watchEntry('hard-gate', { tier: 'constitutional', category: 'constitutional' }))
    const out = bus.render(undefined, 1)
    assert.ok(out.includes('urgent'), 'immediate 直达')
    assert.ok(out.includes('hard-gate'), 'constitutional 直达')
  })
})

describe('Phase 2 阶段抑制 — category 白名单', () => {
  function flowBus(inFlow: () => boolean): AdvisoryBus {
    const bus = new AdvisoryBus()
    bus.setFlowStateProvider(inFlow)
    return bus
  }

  it('产出流中 encouragement/informational 被推迟,discipline/star_domain 不受影响', () => {
    const bus = flowBus(() => true)
    bus.submit({ key: 'praise', priority: 0.4, category: 'encouragement', content: '干得好' })
    bus.submit({ key: 'info', priority: 0.45, category: 'star_domain', tier: 'informational', content: '胶囊召回' })
    bus.submit({ key: 'guard', priority: 0.6, category: 'discipline', content: '先验证' })
    bus.submit({ key: 'route', priority: 0.55, category: 'star_domain', content: '【天权】改道' })

    const out = bus.render(undefined, 1)
    assert.ok(!out.includes('praise'), 'encouragement 被抑制')
    assert.ok(!out.includes('info'), 'informational 被抑制')
    assert.ok(out.includes('guard'), 'discipline 守护不受阶段抑制')
    assert.ok(out.includes('route'), 'star_domain 改道不受阶段抑制')
    assert.equal(bus.drainLedger().deferred, 2)
  })

  it('推迟到 max deferrals 后强制送达(TTL 红线);产出流结束立即放行', () => {
    let inFlow = true
    const bus = flowBus(() => inFlow)
    bus.submit({ key: 'praise', priority: 0.4, category: 'encouragement', content: '干得好' })

    assert.ok(!bus.render(undefined, 1).includes('praise'), '第 1 次推迟')
    assert.ok(!bus.render(undefined, 2).includes('praise'), '第 2 次推迟')
    // 第 3 次:deferrals=2 到上限 → 即便仍在产出流也强制送达
    assert.ok(bus.render(undefined, 3).includes('praise'), '到限强制送达')

    // 产出流结束场景:推迟一次后流结束 → 立即放行
    bus.submit({ key: 'praise2', priority: 0.4, category: 'encouragement', content: 'nice' })
    assert.ok(!bus.render(undefined, 4).includes('praise2'))
    inFlow = false
    assert.ok(bus.render(undefined, 5).includes('praise2'), '流结束放行')
  })

  it('immediate 条目不受阶段抑制', () => {
    const bus = flowBus(() => true)
    bus.submit({ key: 'urgent-praise', priority: 0.4, category: 'encouragement', content: 'x', immediate: true })
    assert.ok(bus.render(undefined, 1).includes('urgent-praise'))
  })
})

describe('Phase 2 通道分级', () => {
  it('system-reminder 通道:不占 bus 预算,内容出队给消息流,计送达', () => {
    const bus = new AdvisoryBus()
    bus.submit({
      key: 'git-clear-after-fail', priority: 0.9, category: 'constitutional',
      tier: 'constitutional', content: '⚠ 清场守护', immediate: true, channel: 'system-reminder',
      expect: { kind: 'tool_appears', tools: ['read_file'], withinTurns: 2 },
    })
    // 3 条 operational 占满 bus Top-3 — SR 通道不与之竞争
    for (let i = 0; i < 3; i++) {
      bus.submit({ key: `op-${i}`, priority: 0.5, category: i === 0 ? 'discipline' : i === 1 ? 'repair' : 'mistake', content: `op${i}` })
    }

    const block = bus.render(undefined, 1)
    assert.ok(!block.includes('清场守护'), 'SR 条目不进 XML 块')
    const srs = bus.drainSystemReminders()
    assert.equal(srs.length, 1)
    assert.ok(srs[0]!.includes('清场守护'))
    assert.equal(bus.drainSystemReminders().length, 0, 'drain 后清空')

    // 送达追踪覆盖 SR 通道（核销闭环不因通道不同而断）
    const delivered = bus.drainDelivered()
    assert.ok(delivered.some(d => d.key === 'git-clear-after-fail' && d.expect))
  })

  it('status 通道:有 sink 时分流,无 sink 时回退 bus(不静默消失)', () => {
    const withSink = new AdvisoryBus()
    const statusReceived: string[] = []
    withSink.setStatusSink(entries => statusReceived.push(...entries.map(e => e.key)))
    withSink.submit({ key: 'bg-note', priority: 0.3, category: 'background', tier: 'informational', content: '后台作业中', channel: 'status' })
    const out1 = withSink.render(undefined, 1)
    assert.ok(!out1.includes('bg-note'), '有 sink:不进 prompt')
    assert.deepEqual(statusReceived, ['bg-note'])

    const noSink = new AdvisoryBus()
    noSink.submit({ key: 'bg-note', priority: 0.3, category: 'background', tier: 'informational', content: '后台作业中', channel: 'status' })
    assert.ok(noSink.render(undefined, 1).includes('bg-note'), '无 sink:回退 bus 渲染')
  })
})

describe('Phase 2 防回归 — 反刷屏三闸与既有行为保留', () => {
  it('无生命周期字段的条目行为与旧版完全一致', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'a', priority: 0.6, category: 'discipline', content: 'plain-a' })
    bus.submit({ key: 'b', priority: 0.5, category: 'repair', content: 'plain-b', ttl: 2 })
    const out = bus.render(undefined, 1)
    assert.ok(out.includes('plain-a') && out.includes('plain-b'))
    // ttl=2 存活到下轮
    assert.ok(bus.render(undefined, 2).includes('plain-b'))
  })

  it('render 不传 turn(旧调用点)不抛错', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'a', priority: 0.6, category: 'discipline', content: 'x' })
    assert.ok(bus.render().includes('x'))
  })
})
