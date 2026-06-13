import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AdvisoryBus, DISCIPLINE_REANCHOR_INTERVAL, STALENESS_GATE_TURN_THRESHOLD, STALENESS_GATE_QUIET_WINDOW, disciplineReanchorEntry, stalenessGateEntry, vigorLowEntry } from '../advisory-bus.js'

describe('AdvisoryBus', () => {
  it('renders empty when no entries', () => {
    const bus = new AdvisoryBus()
    assert.equal(bus.render(), '')
  })

  it('renders single entry as harness-advisory XML', () => {
    const bus = new AdvisoryBus()
    bus.submit({ key: 'test', priority: 0.8, category: 'repair', content: 'check file X' })
    const result = bus.render()
    assert.match(result, /<harness-advisory>/)
    assert.match(result, /<entry key="test"/)
    assert.match(result, /check file X/)
    assert.match(result, /<\/harness-advisory>/)
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
    assert.ok(rendered.includes('闭环') || rendered.includes('接线') || rendered.includes('自检'), 'discipline content must contain core keyword')
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

describe('anti-habituation: staleness gate & vigor-low', () => {
  it('staleness gate has sane thresholds', () => {
    assert.ok(STALENESS_GATE_TURN_THRESHOLD >= 10 && STALENESS_GATE_TURN_THRESHOLD <= 40)
    assert.ok(STALENESS_GATE_QUIET_WINDOW >= 5 && STALENESS_GATE_QUIET_WINDOW <= 20)
  })

  it('staleness gate entry includes turn count and has TTL 2', () => {
    const entry = stalenessGateEntry(15)
    assert.equal(entry.key, 'staleness-gate')
    assert.equal(entry.category, 'discipline')
    assert.equal(entry.ttl, 2)
    assert.ok(entry.content.includes('15'))
  })

  it('vigor-low entry has appropriate priority and TTL 1', () => {
    const entry = vigorLowEntry()
    assert.equal(entry.key, 'vigor-low-refresh')
    assert.equal(entry.category, 'discipline')
    assert.equal(entry.ttl, 1)
    assert.ok(entry.priority > 0.5, 'vigor-low should have moderate-high priority')
  })

  it('staleness and vigor-low can coexist in advisory bus', () => {
    const bus = new AdvisoryBus()
    bus.submit(stalenessGateEntry(20))
    bus.submit(vigorLowEntry())
    const rendered = bus.render()
    assert.ok(rendered.includes('staleness-gate'))
    assert.ok(rendered.includes('vigor-low-refresh'))
  })
})
