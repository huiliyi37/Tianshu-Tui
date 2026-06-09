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

  it('preserves core prompt semantics', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // Key phrases from the current prompt contract must survive
    assert.ok(prompt.includes('有理有据'))
    assert.ok(prompt.includes('verify-first'))
    assert.ok(prompt.includes('read_file'))
    assert.ok(prompt.includes('edit_file'))
    assert.ok(prompt.includes('write_file'))
    assert.ok(prompt.includes('node:test'))
    assert.ok(prompt.includes('API key'))
  })

  it('includes read-loop escape guardrails', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('[diet:redundant]'))
    assert.ok(prompt.includes('[diet:useless]'))
    assert.ok(prompt.includes('禁止第 4 次对同一路径直接 read_file'))
    assert.ok(prompt.includes('策略 X 无效，切换到 Y'))
  })

  it('upgrades complex spec workflow from checklist to dataflow verification', () => {
    const prompt = buildSystemPrompt({ tools: [] })

    assert.ok(prompt.includes('复杂 spec / 跨模块集成任务不得只按 checklist 打勾'))
    assert.ok(prompt.includes('事实流图'))
    assert.ok(prompt.includes('条件矩阵'))
    assert.ok(prompt.includes('反证测试表'))
    assert.ok(prompt.includes('没有能打红错误实现的测试，不得声称 spec 已验证'))
  })

  it('includes only a short manifest entry for sensitive knowledge domains', () => {
    const prompt = buildSystemPrompt({ tools: [] })

    assert.ok(prompt.includes('.rivet/knowledge/manifest.md'))
    assert.ok(prompt.includes('prompt/identity/memory/recall/verification/ownership'))
  })

  it('includes delegation discipline guardrails', () => {
    const prompt = buildSystemPrompt({ tools: [] })

    assert.ok(prompt.includes('委派不是默认执行方式'))
    assert.ok(prompt.includes('当前计划的前置设计'))
    assert.ok(prompt.includes('3 个以上独立探索前线'))
    assert.ok(prompt.includes('用户明确说不要委派时'))
    assert.ok(prompt.includes('继续内联执行'))
  })

  it('does not reintroduce retired long-form warning sections', () => {
    const prompt = buildSystemPrompt({ tools: [] })

    assert.ok(!prompt.includes('Common Mistakes'))
    assert.ok(!prompt.includes('prefix cache 对静态提示词敏感'))
    assert.ok(!prompt.includes('891cc1b6'))
  })
})
