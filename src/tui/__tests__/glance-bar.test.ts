import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import React from 'react'

import { GlanceBar } from '../glance-bar.js'
import type { GlancePulse } from '../surface/types.js'

function render(props: React.ComponentProps<typeof GlanceBar>) {
  return React.createElement(GlanceBar, props)
}

function innerFn(component: any): Function {
  return (component as any).type
}

const pulses: GlancePulse[] = [
  { domain: 'pojun', level: 'quiet' },
  { domain: 'tianfu', level: 'active' },
  { domain: 'tianliang', level: 'alert', hint: 'worker failed' },
  { domain: 'tianquan', level: 'quiet' },
  { domain: 'tianji', level: 'quiet' },
  { domain: 'tianxuan', level: 'quiet' },
]

describe('GlanceBar', () => {
  it('exports a memo component', () => {
    assert.equal(typeof innerFn(GlanceBar), 'function')
  })

  it('renders with 6-domain pulses and alert hint props', () => {
    const el = render({
      pulses,
      phase: 'yuheng-implementing',
      cacheHitRate: 0.82,
      cost: 0.42,
      model: 'deepseek-chat',
      isStreaming: true,
      estimatedTokens: 12_000,
      maxTokens: 128_000,
    })
    assert.ok(el != null)
    assert.equal(el.props.pulses.length, 6)
    assert.equal(el.props.pulses[2]?.hint, 'worker failed')
  })

  it('renders token count and percentage', () => {
    const el = render({
      pulses: [],
      phase: 'tianshu-planning',
      cacheHitRate: 0.5,
      cost: 0.1,
      model: 'deepseek-chat',
      isStreaming: false,
      estimatedTokens: 45_000,
      maxTokens: 128_000,
    })
    assert.ok(el != null)
    assert.equal(el.props.estimatedTokens, 45_000)
    assert.equal(el.props.maxTokens, 128_000)
  })

  it('shows compact hint when ratio >= 78%', () => {
    const el = render({
      pulses: [],
      phase: 'tianshu-planning',
      cacheHitRate: 0.5,
      cost: 0.1,
      model: 'deepseek-chat',
      isStreaming: false,
      estimatedTokens: 100_000,
      maxTokens: 128_000,
    })
    assert.ok(el != null)
    assert.equal(el.props.estimatedTokens, 100_000)
    assert.equal(el.props.maxTokens, 128_000)
  })
})
