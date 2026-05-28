import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt } from '../static.js'

describe('buildSystemPrompt', () => {
  it('wraps identity in <identity> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<identity>'))
    assert.ok(prompt.includes('</identity>'))
    assert.ok(prompt.includes('天枢'))
  })

  it('wraps rules in <rules> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<rules>'))
    assert.ok(prompt.includes('</rules>'))
    assert.ok(prompt.includes('verify-first'))
  })

  it('wraps tool usage in <tool-usage> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<tool-usage>'))
    assert.ok(prompt.includes('</tool-usage>'))
  })

  it('wraps workflow in <workflow> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<workflow>'))
    assert.ok(prompt.includes('</workflow>'))
  })

  it('wraps security in <security> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<security>'))
    assert.ok(prompt.includes('</security>'))
  })

  it('does NOT include tool summary section', () => {
    const tools = [{ name: 'bash', description: 'Run commands', input_schema: { type: 'object' as const, properties: {} } }]
    const prompt = buildSystemPrompt({ tools })
    assert.ok(!prompt.includes('## Tools'))
    assert.ok(!prompt.includes('- **bash**'))
  })

  it('has no markdown ## headers', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // Match only level-2 headers (## at line start), not ### sub-headers
    assert.ok(!/^## /m.test(prompt))
  })

  it('nesting depth is max 2 levels', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // No triple-nested tags like <a><b><c>
    const threeDeep = /<[a-z-]+>\s*<[a-z-]+>\s*<[a-z-]+>/
    assert.ok(!threeDeep.test(prompt))
  })

  it('includes git section in <git> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<git>'))
    assert.ok(prompt.includes('</git>'))
  })

  it('preserves all original content semantics', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // Key phrases from original prompt must survive
    assert.ok(prompt.includes('想象力'))
    assert.ok(prompt.includes('verify-first'))
    assert.ok(prompt.includes('read_file'))
    assert.ok(prompt.includes('edit_file'))
    assert.ok(prompt.includes('write_file'))
    assert.ok(prompt.includes('node:test'))
    assert.ok(prompt.includes('API keys'))
  })

  it('includes only a short manifest entry for sensitive knowledge domains', () => {
    const prompt = buildSystemPrompt({ tools: [] })

    assert.ok(prompt.includes('.rivet/knowledge/manifest.md'))
    assert.ok(prompt.includes('prompt, identity, memory, recall, auto-writer, verification, or ownership'))
  })

  it('does not reintroduce retired long-form warning sections', () => {
    const prompt = buildSystemPrompt({ tools: [] })

    assert.ok(!prompt.includes('Common Mistakes'))
    assert.ok(!prompt.includes('prefix cache 对静态提示词敏感'))
    assert.ok(!prompt.includes('891cc1b6'))
  })
})
