/**
 * /handoff 交接能力 — buildHandoffPrompt / formatHandoffNudge 纯函数契约。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { HANDOFF_NUDGE_RATIO, buildHandoffPrompt, formatHandoffNudge } from '../handoff.js'

describe('buildHandoffPrompt — 交接指令', () => {
  const PATH = '/proj/.rivet/HANDOFF.md'

  it('含绝对路径与 write_file 覆盖写指示', () => {
    const p = buildHandoffPrompt(PATH)
    assert.ok(p.includes(PATH), '含目标绝对路径')
    assert.match(p, /write_file/)
    assert.match(p, /覆盖写/)
  })

  it('固定五章节齐全：任务目标/已完成/当前卡点/下一步/坑', () => {
    const p = buildHandoffPrompt(PATH)
    for (const section of ['## 任务目标', '## 已完成', '## 当前卡点', '## 下一步', '## 坑']) {
      assert.ok(p.includes(section), `缺章节 ${section}`)
    }
  })

  it('自包含契约：禁止引用上文、不许编造', () => {
    const p = buildHandoffPrompt(PATH)
    assert.match(p, /自包含/)
    assert.match(p, /不要编造/)
  })

  it('note 作为用户补充指示追加；空 note 不产生该行', () => {
    assert.match(buildHandoffPrompt(PATH, '重点记下缓存方案'), /用户补充指示：重点记下缓存方案/)
    assert.ok(!buildHandoffPrompt(PATH).includes('用户补充指示'))
    assert.ok(!buildHandoffPrompt(PATH, '   ').includes('用户补充指示'))
  })
})

describe('formatHandoffNudge — 60% 交接提醒', () => {
  it('文案含百分比与 /handoff 指引', () => {
    const s = formatHandoffNudge(0.63)
    assert.ok(s.includes('63%'), `含百分比: ${s}`)
    assert.ok(s.includes('/handoff'), `含命令指引: ${s}`)
    assert.match(s, /省前缀重建成本/)
  })

  it('阈值常量为 0.6', () => {
    assert.equal(HANDOFF_NUDGE_RATIO, 0.6)
  })
})
