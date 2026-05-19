import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { renderConstellation, renderConstellationCompact } from '../constellation.js'
import type { StarPhase } from '../../agent/star-event.js'

describe('renderConstellation', () => {
  it('returns array of strings', () => {
    const lines = renderConstellation('yuheng-implementing')
    assert.ok(Array.isArray(lines))
    assert.ok(lines.length >= 5)
  })

  it('highlights the active phase with brackets', () => {
    const lines = renderConstellation('yuheng-implementing')
    const joined = lines.join('\n')
    assert.ok(joined.includes('[铸形]'))
  })

  it('renders all 7 star names', () => {
    const lines = renderConstellation('tianshu-planning')
    const joined = lines.join('\n')
    for (const star of ['观局', '寻迹', '拆解', '定标', '铸形', '试锋', '归航']) {
      assert.ok(joined.includes(star), `Missing star: ${star}`)
    }
  })

  it('works for different active phases', () => {
    const phases: StarPhase[] = ['tianshu-planning', 'kaiyang-testing', 'yaoguang-delivering']
    for (const phase of phases) {
      const lines = renderConstellation(phase)
      assert.ok(lines.length >= 5)
    }
  })
})

describe('renderConstellationCompact', () => {
  it('returns a single string with all star names', () => {
    const line = renderConstellationCompact('yuheng-implementing')
    assert.equal(typeof line, 'string')
    assert.ok(line.includes('铸形'))
    assert.ok(line.includes('观局'))
  })
})
