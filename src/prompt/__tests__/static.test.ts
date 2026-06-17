import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildSystemPrompt, detectModelFamily } from '../static.js'

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
    assert.ok(prompt.includes('evidence-scope'))
  })

  it('wraps tool usage in <tool-usage> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<tool-usage>'))
    assert.ok(prompt.includes('</tool-usage>'))
  })

  it('teaches parallel fan-out of independent探索 tools', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // 必须出现"并行/一次扇出"语义的指令，且点名探索工具
    assert.ok(prompt.includes('并行'), '应含并行指令')
    assert.ok(
      prompt.includes('单条消息') || prompt.includes('一次发出') || prompt.includes('一次扇出'),
      '应教在单条消息里一次发出多个工具',
    )
  })

  it('warns不要在并行批中插入写操作 (contiguous-block constraint)', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // 引擎只并行"连续"safe 块；写操作会切断批次 → 必须显式告诫
    assert.ok(
      prompt.includes('写操作') || prompt.includes('edit_file') || prompt.includes('write_file'),
      '应提醒并行批中不要混入写操作',
    )
  })

  it('no longer teaches串行 "由粗到细" navigation chain', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // 旧的串行链描述应被移除或改写，避免与并行指令冲突
    assert.ok(!prompt.includes('由粗到细'), '串行链描述应已移除')
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
    assert.ok(prompt.includes('有理有据'))
    assert.ok(prompt.includes('改代码前先读'))
    assert.ok(prompt.includes('read_file'))
    assert.ok(prompt.includes('edit_file'))
    assert.ok(prompt.includes('write_file'))
    assert.ok(prompt.includes('node:test'))
    assert.ok(prompt.includes('API key'))
  })

  it('includes beliefs as situational triggers', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('当你发现更优方案时'))
    assert.ok(prompt.includes('当用户指令偏离用户意图时'))
    assert.ok(prompt.includes('确认理解'))
  })

  it('includes task completion reporting requirements', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('遗留项'))
    assert.ok(prompt.includes('设计偏离'))
    assert.ok(prompt.includes('交付物'))
  })

  it('includes only a short manifest entry for sensitive knowledge domains', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('.rivet/knowledge/manifest.md'))
    assert.ok(prompt.includes('prompt/identity/memory/recall/verification/ownership'))
  })

  it('includes delegation discipline guardrails', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('委派不是默认推进方式'))
    assert.ok(prompt.includes('3+ 独立探索前线'))
    assert.ok(prompt.includes('用户说不要委派时'))
    assert.ok(prompt.includes('继续内联执行'))
  })

  it('applies behavioral calibration without exposing model identity', () => {
    const deepseek = buildSystemPrompt({ tools: [], modelFamily: 'deepseek' })
    assert.ok(deepseek.includes('<calibration>'))
    assert.ok(!deepseek.includes('family='))
    assert.ok(deepseek.includes('跨模块边界'))

    const mimo = buildSystemPrompt({ tools: [], modelFamily: 'mimo' })
    assert.ok(mimo.includes('<calibration>'))
    assert.ok(!mimo.includes('family='))
    assert.ok(mimo.includes('收敛'))

    const glm = buildSystemPrompt({ tools: [], modelFamily: 'glm' })
    assert.ok(glm.includes('<calibration>'))
    assert.ok(!glm.includes('family='))

    const unknown = buildSystemPrompt({ tools: [], modelFamily: 'unknown' })
    assert.ok(!unknown.includes('<calibration>'))
  })

  it('does not reintroduce retired long-form warning sections', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(!prompt.includes('Common Mistakes'))
    assert.ok(!prompt.includes('prefix cache 对静态提示词敏感'))
    assert.ok(!prompt.includes('891cc1b6'))
  })
})

describe('detectModelFamily', () => {
  it('detects deepseek models', () => {
    assert.equal(detectModelFamily('deepseek-v4-0324'), 'deepseek')
    assert.equal(detectModelFamily('DeepSeek-V4-Flash'), 'deepseek')
  })

  it('detects mimo models', () => {
    assert.equal(detectModelFamily('MiMo-7B'), 'mimo')
  })

  it('detects glm models', () => {
    assert.equal(detectModelFamily('glm-4-plus'), 'glm')
  })

  it('detects openai models', () => {
    assert.equal(detectModelFamily('gpt-4o'), 'openai')
    assert.equal(detectModelFamily('o3-mini'), 'openai')
  })

  it('detects anthropic models', () => {
    assert.equal(detectModelFamily('claude-opus-4'), 'anthropic')
    assert.equal(detectModelFamily('claude-sonnet-4'), 'anthropic')
  })

  it('returns unknown for unrecognized models', () => {
    assert.equal(detectModelFamily('custom-model-v1'), 'unknown')
  })
})
