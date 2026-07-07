import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Chronicle } from '../chronicle.js'

describe('Chronicle', () => {
  it('records a phase transition entry', () => {
    const chronicle = new Chronicle()
    chronicle.addPhaseTransition({
      fromPhase: 'tianshu-planning',
      toPhase: 'yuheng-implementing',
      turn: 5,
      summary: '[天枢] 开始修改。',
    })
    const entries = chronicle.getEntries()
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.type, 'phase-transition')
    assert.equal(entries[0]!.turn, 5)
  })

  it('records a milestone entry', () => {
    const chronicle = new Chronicle()
    chronicle.addMilestone({ kind: 'test_fail', turn: 10, summary: '[天枢] ✗ 测试失败', files: ['auth.test.ts'] })
    assert.equal(chronicle.getEntries().length, 1)
    assert.equal(chronicle.getEntries()[0]!.type, 'milestone')
  })

  it('records a radio message', () => {
    const chronicle = new Chronicle()
    chronicle.addRadio('[天枢] 已读取 5 个文件。', 3)
    assert.equal(chronicle.getEntries()[0]!.type, 'radio')
    assert.ok(chronicle.getEntries()[0]!.summary.includes('天枢'))
  })

  it('getRecentRadio returns last N messages', () => {
    const chronicle = new Chronicle()
    for (let i = 0; i < 10; i++) chronicle.addRadio(`msg ${i}`, i)
    const recent = chronicle.getRecentRadio(5)
    assert.equal(recent.length, 5)
    assert.ok(recent[0]!.summary.includes('msg 5'))
  })

  it('getPhaseSegments groups entries by phase', () => {
    const chronicle = new Chronicle()
    chronicle.addPhaseTransition({ fromPhase: 'tianshu-planning', toPhase: 'tianxuan-locating', turn: 0, summary: 'start' })
    chronicle.addRadio('reading', 1)
    chronicle.addPhaseTransition({ fromPhase: 'tianxuan-locating', toPhase: 'yuheng-implementing', turn: 5, summary: 'coding' })
    chronicle.addRadio('writing', 6)
    const segments = chronicle.getPhaseSegments()
    assert.equal(segments.length, 2)
    assert.equal(segments[0]!.phase, 'tianxuan-locating')
    assert.equal(segments[0]!.entries.length, 1)
  })

  it('toMarkdown produces structured output', () => {
    const chronicle = new Chronicle()
    chronicle.addPhaseTransition({ fromPhase: 'tianshu-planning', toPhase: 'yuheng-implementing', turn: 0, summary: 'start' })
    chronicle.addRadio('[天枢] writing', 3)
    const md = chronicle.toMarkdown()
    assert.ok(md.includes('星辰编年史'))
  })
})
