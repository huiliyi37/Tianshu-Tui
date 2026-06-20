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

  it('includes context-update-protocol rule for delta semantics', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('context-update-protocol'), 'should contain the rule name')
    assert.ok(prompt.includes('累积的'), 'should describe cumulative semantics')
    assert.ok(prompt.includes('未变化'), 'should explain absent = unchanged')
  })

  it('wraps tool usage in <tool-usage> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<tool-usage>'))
    assert.ok(prompt.includes('</tool-usage>'))
  })

  it('teaches parallel fan-out of independent探索 tools', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('并行'), '应含并行指令')
    assert.ok(
      prompt.includes('一条消息') || prompt.includes('单条消息') || prompt.includes('一次发出'),
      '应教在一条消息里一起发多个工具',
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

  it('scopes fan-out to read-only tools — serial tools sent one at a time', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('只读工具可一批发'), '应限定只读工具可批发')
    assert.ok(
      prompt.includes('run_tests') && prompt.includes('git'),
      '应点名 run_tests/git 等串行工具（防过度泛化）',
    )
    assert.ok(
      prompt.includes('逐个串行'),
      '应要求串行工具逐个执行',
    )
  })

  it('wraps workflow in <workflow> tags', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('<workflow>'))
    assert.ok(prompt.includes('</workflow>'))
  })

  it('includes external-source-verification rule with concrete methods', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    assert.ok(prompt.includes('external-source-verification'), '应有独立的外部方案验证规则')
    assert.ok(prompt.includes('RED→GREEN'), '应含复现验证方法')
    assert.ok(prompt.includes('恒等式自检'), '应含数据自检方法')
    assert.ok(prompt.includes('格式完整不是可信度信号'), '应含核心原则')
    // workflow 应有触发指针但不重复核验方法细节
    assert.ok(prompt.includes('external-source-verification 规则'), 'workflow 应指向规则名')
  })

  it('includes self-verification rule — 复现即证 standing across all domains', () => {
    const prompt = buildSystemPrompt({ tools: [] })
    // 瑶光的"复现即证"必须常驻在 base 护栏,而非仅在瑶光域或按需 advisory。
    assert.ok(prompt.includes('self-verification'), '应有独立的自我验证规则')
    assert.ok(prompt.includes('绿非证明'), '应含"绿非证明"核心')
    assert.ok(prompt.includes('你自己刚下的结论'), '应把验证标准转向自身结论(反身之道)')
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
    assert.ok(deepseek.includes('grep 验证消费方'))

    const mimo = buildSystemPrompt({ tools: [], modelFamily: 'mimo' })
    assert.ok(mimo.includes('<calibration>'))
    assert.ok(!mimo.includes('family='))
    assert.ok(mimo.includes('收敛'))

    const glm = buildSystemPrompt({ tools: [], modelFamily: 'glm' })
    assert.ok(glm.includes('<calibration>'))
    assert.ok(!glm.includes('family='))
    assert.ok(glm.includes('不要把"穷尽查证"理解为无限工具调用'))
    assert.ok(glm.includes('同一工具同一错误连续 2 次'))
    assert.ok(glm.includes('每轮最多围绕一个假设查 3 个关键证据'))
    assert.ok(glm.includes('步骤纪律'))
    assert.ok(glm.includes('先建 todo 列表再执行'))

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
