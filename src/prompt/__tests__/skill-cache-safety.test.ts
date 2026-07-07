import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildDynamicAppendix } from '../volatile.js'
import { buildSystemPrompt } from '../static.js'
import { SkillRegistry } from '../../skills/skill-loader.js'

const big = (n: number): string => 'z'.repeat(n)

describe('skill progressive-disclosure cache safety', () => {
  it('discovery block lives in the dynamic appendix, never carries the body', () => {
    const reg = new SkillRegistry()
    reg.register({ name: 'deployer', description: 'how to deploy', triggers: [/deploy/i], body: big(8_000) })

    const block = reg.renderDiscoveryBlock('deploy now')
    assert.ok(block)

    const appendix = buildDynamicAppendix({ cwd: '/project', skillAdvisoryBlock: block })
    // Discovery (name + description) is present...
    assert.ok(appendix.includes('name="deployer"'))
    assert.ok(appendix.includes('how to deploy'))
    // ...but the 8KB body is NOT injected anywhere in the volatile appendix.
    assert.ok(!appendix.includes(big(100)))
  })

  it('static system prompt contains no skill body and no concrete skill name', () => {
    const prompt = buildSystemPrompt({ tools: [], modelFamily: 'deepseek' })
    // The static prefix must stay byte-stable regardless of which skills exist.
    assert.ok(!prompt.includes('available-skills'))
    assert.ok(!prompt.includes('how to deploy'))
    assert.ok(!prompt.includes(big(100)))
  })
})
