import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SkillRegistry } from '../skill-loader.js'

const big = (n: number): string => 'x'.repeat(n)

describe('skill discovery (Tier-1)', () => {
  it('renders only name+description, never the body', () => {
    const reg = new SkillRegistry()
    reg.register({
      name: 'huge',
      description: 'A skill with a very large body',
      triggers: [/huge/i],
      body: big(10_000),
    })

    const block = reg.renderDiscoveryBlock('please use huge')
    assert.ok(block)
    assert.ok(block!.includes('name="huge"'))
    assert.ok(block!.includes('A skill with a very large body'))
    // The 10KB body must NOT leak into the discovery block.
    assert.ok(!block!.includes(big(100)))
  })

  it('a 10KB-body skill still appears in discovery (old auto-trigger dropped it)', () => {
    const reg = new SkillRegistry()
    reg.register({ name: 'tiny', description: 'small', triggers: [/tiny/i], body: 'ok' })
    reg.register({ name: 'whale', description: 'enormous body', triggers: [/whale/i], body: big(10_000) })

    const block = reg.renderDiscoveryBlock('tiny and whale')
    assert.ok(block!.includes('name="tiny"'))
    assert.ok(block!.includes('name="whale"'))
  })

  it('two matches, first one oversized — both still listed (no break drop)', () => {
    const reg = new SkillRegistry()
    reg.register({ name: 'first', description: 'huge first one ' + big(50), triggers: [/go/i], body: big(9_000) })
    reg.register({ name: 'second', description: 'normal', triggers: [/go/i], body: 'short' })

    const block = reg.renderDiscoveryBlock('go')
    assert.ok(block!.includes('name="first"'))
    assert.ok(block!.includes('name="second"'))
  })

  it('excludes per-session disabled skills from the discovery block', () => {
    const reg = new SkillRegistry()
    reg.register({ name: 'keep', description: 'stays visible', triggers: [/go/i], body: 'b' })
    reg.register({ name: 'drop', description: 'hidden when disabled', triggers: [/go/i], body: 'b' })

    const block = reg.renderDiscoveryBlock('go', { exclude: new Set(['drop']) })!
    assert.ok(block.includes('name="keep"'))
    assert.ok(!block.includes('name="drop"'))
  })

  it('returns null when every skill is excluded', () => {
    const reg = new SkillRegistry()
    reg.register({ name: 'only', description: 'sole skill', triggers: [/go/i], body: 'b' })
    assert.equal(reg.renderDiscoveryBlock('go', { exclude: new Set(['only']) }), null)
  })

  it('marks hint matches relevant and surfaces them first', () => {
    const reg = new SkillRegistry()
    reg.register({ name: 'zeta', description: 'unrelated', triggers: [/zeta/i], body: 'b' })
    reg.register({ name: 'alpha', description: 'matches the query', triggers: [/deploy/i], body: 'b' })

    const block = reg.renderDiscoveryBlock('time to deploy')!
    assert.match(block, /name="alpha" relevant="true"/)
    assert.ok(!/name="zeta" relevant="true"/.test(block))
    // relevant alpha precedes non-relevant zeta despite alphabetical order
    assert.ok(block.indexOf('name="alpha"') < block.indexOf('name="zeta"'))
  })

  it('truncates long descriptions to maxDescChars', () => {
    const reg = new SkillRegistry()
    reg.register({ name: 'verbose', description: big(500), triggers: [/v/i], body: 'b' })
    const block = reg.renderDiscoveryBlock('v', { maxDescChars: 50 })!
    assert.ok(block.includes(big(50)))
    assert.ok(!block.includes(big(51)))
  })

  it('returns null when no skills are registered', () => {
    const reg = new SkillRegistry()
    assert.equal(reg.renderDiscoveryBlock('anything'), null)
  })

  it('skips oversized entries but includes smaller ones after (budget overflow)', () => {
    const reg = new SkillRegistry()
    // After truncation to maxDescChars (default 200), this line is ~220 chars
    reg.register({ name: 'huge', description: big(600), triggers: [/h/i], body: 'b' })
    // This small entry MUST still appear despite being after the oversized one
    reg.register({ name: 'tiny', description: 'fits', triggers: [/t/i], body: 'b' })

    // Budget of 100 chars: huge entry (~220 after truncation) won't fit, tiny (~24) will
    const block = reg.renderDiscoveryBlock('h t', { maxChars: 100 })
    assert.ok(block, 'block should not be null when at least one entry fits')
    assert.ok(block!.includes('name="tiny"'), 'small entry after oversized one must appear')
    assert.ok(!block!.includes('name="huge"'), 'oversized entry must be skipped')
  })

  it('emits <more count="N"> when budget overflow drops entries', () => {
    const reg = new SkillRegistry()
    // several long-description skills so the small budget can't fit them all
    for (let i = 0; i < 5; i++) {
      reg.register({ name: `s${i}`, description: big(180), triggers: [/go/i], body: 'b' })
    }
    const block = reg.renderDiscoveryBlock('go', { maxChars: 250 })!
    assert.match(block, /<more count="\d+"/)
  })

  it('omits <more> when the budget fits every skill', () => {
    const reg = new SkillRegistry()
    reg.register({ name: 'a', description: 'short', triggers: [/go/i], body: 'b' })
    reg.register({ name: 'b', description: 'short', triggers: [/go/i], body: 'b' })
    const block = reg.renderDiscoveryBlock('go')!
    assert.ok(!block.includes('<more'))
  })

  it('renderMatchedBlock (deprecated) uses continue not break — oversized skill does not drop subsequent ones', () => {
    const reg = new SkillRegistry()
    // First skill has a body that exceeds the budget
    reg.register({ name: 'oversized', description: 'big', triggers: [/go/i], body: big(5000) })
    // Second skill is small and must still appear
    reg.register({ name: 'normal', description: 'small', triggers: [/go/i], body: 'do it' })

    const block = reg.renderMatchedBlock('go', 4000)
    assert.ok(block)
    // The oversized skill is skipped (continue), but the normal one is included
    assert.ok(block!.includes('name="normal"'), 'normal skill must appear after oversized skip')
    assert.ok(!block!.includes('name="oversized"'), 'oversized skill must be skipped')
  })

  it('loads .claude/skills/<name>/SKILL.md and records source + bodyPath', () => {
    const root = mkdtempSync(join(tmpdir(), 'rivet-claude-skills-'))
    const skillDir = join(root, 'my-skill')
    mkdirSync(skillDir, { recursive: true })
    const file = join(skillDir, 'SKILL.md')
    writeFileSync(file, `---
description: A claude-format skill
---

Body content here.`, 'utf-8')

    const reg = new SkillRegistry()
    const res = reg.loadFromClaudeDirectory(root, 'project-claude')
    assert.deepEqual(res.loaded, ['my-skill'])
    const def = reg.get('my-skill')!
    assert.equal(def.source, 'project-claude')
    assert.equal(def.bodyPath, file)
    assert.equal(def.description, 'A claude-format skill')
    assert.equal(def.body, 'Body content here.')
  })
})
