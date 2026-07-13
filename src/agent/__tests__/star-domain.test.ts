import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { matchDomain, STAR_DOMAINS, buildActiveDomain } from '../star-domain.js'
import { starDomainRegistry } from '../star-domain-registry.js'

describe('StarDomain', () => {
  it('exports built-in domains', () => {
    const domains = Object.values(STAR_DOMAINS)
    assert.ok(domains.length >= 3, `Expected at least 3 domains, got ${domains.length}`)
    for (const domain of domains) {
      assert.ok(domain.id)
      assert.ok(domain.name)
      assert.ok(domain.motto)
      assert.ok(domain.volatileBlock)
      assert.equal(domain.isCustom, false)
      assert.ok(typeof domain.courageThreshold === 'number')
    }
  })

  it('routes exploration keywords to pojun (探索 is exclusive to pojun)', () => {
    assert.equal(matchDomain('尝试突破一个新的缓存方案'), 'pojun')
    assert.equal(matchDomain('实验性地尝试 WebSocket'), 'pojun')
    assert.equal(matchDomain('探索新的可能性'), 'pojun')
  })

  it('routes stability keywords to tianfu (审查 moved to tianquan)', () => {
    assert.equal(matchDomain('优化 session 管理模块'), 'tianfu')
    assert.equal(matchDomain('修复内存泄漏'), 'tianfu')
    assert.equal(matchDomain('重构优化性能'), 'tianfu')
  })

  it('routes delivery keywords to tianliang', () => {
    assert.equal(matchDomain('按计划实现用户注册'), 'tianliang')
    assert.equal(matchDomain('编写单元测试覆盖'), 'tianliang')
    assert.equal(matchDomain('编码开发新模块'), 'tianliang')
  })

  it('routes review/plan keywords to tianquan', () => {
    assert.equal(matchDomain('审查这个方案'), 'tianquan')
    assert.equal(matchDomain('评估架构设计'), 'tianquan')
    assert.equal(matchDomain('审查代码质量'), 'tianquan')
  })

  it('routes challenge keywords to tianji (方案 shared but tianji wins with quality keywords)', () => {
    assert.equal(matchDomain('质疑这个方案的前提'), 'tianji')
    assert.equal(matchDomain('反思当前视角'), 'tianji')
  })

  it('routes pattern/discovery keywords to tianxuan', () => {
    assert.equal(matchDomain('发现新的模式'), 'tianxuan')
    assert.equal(matchDomain('复盘总结洞察'), 'tianxuan')
  })

  it('routes aesthetic/clean-code keywords to wenqu', () => {
    assert.equal(matchDomain('让代码的逻辑结构呈现完美对称与优雅美感'), 'wenqu')
    assert.equal(matchDomain('重构重塑这个模块的命名模式与体验肌理'), 'wenqu')
  })

  it('wenqu carries design methodology (minimalist structural aesthetics & medium honesty)', () => {
    const wenqu = STAR_DOMAINS.wenqu
    assert.match(wenqu.systemPromptSuffix, /克制/)
    assert.match(wenqu.systemPromptSuffix, /诚实/)
    assert.match(wenqu.volatileBlock, /文曲/)
  })

  it('yaoguang domain exists with full field set', () => {
    const yaoguang = STAR_DOMAINS.yaoguang
    assert.ok(yaoguang)
    assert.equal(yaoguang.id, 'yaoguang')
    assert.equal(yaoguang.name, '瑶光')
    assert.equal(yaoguang.decisionStyle, 'cautious')
    assert.equal(yaoguang.courageThreshold, 0.7)
    assert.equal(yaoguang.isCustom, false)
    assert.ok(yaoguang.volatileBlock.includes('瑶光'))
    assert.ok(yaoguang.systemPromptSuffix.length > 0)
    assert.ok(yaoguang.keywords.includes('复现'))
    assert.ok(yaoguang.keywords.includes('归族'))
  })

  it('routes recurrence/verification keywords to yaoguang', () => {
    assert.equal(matchDomain('复现这个缺陷并归族处理'), 'yaoguang')
    assert.equal(matchDomain('回归测试验证修复是否真的生效'), 'yaoguang')
    assert.equal(matchDomain('严谨核实这个声称是否属实'), 'yaoguang')
  })

  it('yaoguang does not steal tianquan review routes (keyword orthogonality)', () => {
    // tianquan owns 审查/评估 — yaoguang must not intercept these
    assert.equal(matchDomain('审查这个方案的设计'), 'tianquan')
    assert.equal(matchDomain('评估架构层次是否合理'), 'tianquan')
  })

  it('routes silence-audit / baseline keywords to yaoguang (静音之道, 2026-07-04)', () => {
    assert.equal(matchDomain('这个提醒机制好像静默失效了，帮我查一下'), 'yaoguang')
    assert.equal(matchDomain('先跑基线分清是不是我改坏的'), 'yaoguang')
    // 注意：短语里不能带 "fixture" — 天府的 'fix' 会子串命中造成平局。
    // 这是 matchDomain 子串匹配的已知锐边（'fix' ⊂ 'fixture'/'prefix'/…）。
    assert.equal(matchDomain('这个绿灯是不是假绿，喂的输入形状和生产一致吗'), 'yaoguang')
  })

  it('yaoguang volatileBlock carries the absence-audit question (缺席不会自己报警)', () => {
    const yaoguang = STAR_DOMAINS.yaoguang
    assert.match(yaoguang.volatileBlock, /缺席不会自己报警/)
    assert.match(yaoguang.systemPromptSuffix, /观测先行/)
    assert.match(yaoguang.systemPromptSuffix, /先验基线/)
  })

  it('huagai domain exists with full field set', () => {
    const huagai = STAR_DOMAINS.huagai
    assert.ok(huagai)
    assert.equal(huagai.id, 'huagai')
    assert.equal(huagai.name, '华盖')
    assert.equal(huagai.decisionStyle, 'methodical')
    assert.equal(huagai.courageThreshold, 0.6)
    assert.equal(huagai.isCustom, false)
    assert.match(huagai.volatileBlock, /华盖/)
    assert.match(huagai.volatileBlock, /守昼/)
    assert.ok(huagai.systemPromptSuffix.length > 0)
    assert.ok(huagai.keywords.includes('托举'))
    assert.ok(huagai.keywords.includes('长程'))
    assert.equal(huagai.uiPersona.glyph, '☉')
    assert.equal(huagai.uiPersona.accent, 'primary')
  })

  it('routes endurance/fidelity keywords to huagai', () => {
    assert.equal(matchDomain('长程任务需要守昼托举'), 'huagai')
    assert.equal(matchDomain('marathon build needs persist and fidelity'), 'huagai')
    assert.equal(matchDomain('托举建设者，最后一英里不停'), 'huagai')
  })

  it('huagai does not steal yaoguang/tianquan routes (keyword orthogonality)', () => {
    assert.equal(matchDomain('复现这个缺陷并归族处理'), 'yaoguang')
    assert.equal(matchDomain('审查这个方案的设计'), 'tianquan')
    assert.equal(matchDomain('回归测试验证修复是否真的生效'), 'yaoguang')
  })

  it('huagai systemPromptSuffix carries 守昼/追 blocker/基线先行/星间接口', () => {
    const huagai = STAR_DOMAINS.huagai
    assert.match(huagai.systemPromptSuffix, /守昼/)
    assert.match(huagai.systemPromptSuffix, /追 blocker/)
    assert.match(huagai.systemPromptSuffix, /基线先行/)
    assert.match(huagai.systemPromptSuffix, /不做清单/)
    assert.match(huagai.systemPromptSuffix, /跨层同步/)
    assert.match(huagai.systemPromptSuffix, /星间接口/)
    assert.match(huagai.systemPromptSuffix, /瑶光/)
    assert.match(huagai.systemPromptSuffix, /天权/)
    assert.match(huagai.systemPromptSuffix, /天梁/)
  })

  it('returns null for ambiguous tasks', () => {
    assert.equal(matchDomain('帮我看看'), null)
    assert.equal(matchDomain('探索并修复缓存问题'), null)
  })

  it('pojun toolWhitelist includes write_file (explorer can modify)', () => {
    assert.ok(STAR_DOMAINS.pojun.toolWhitelist.includes('write_file'))
    assert.ok(STAR_DOMAINS.pojun.toolWhitelist.includes('edit_file'))
    assert.ok(STAR_DOMAINS.pojun.toolWhitelist.includes('bash'))
  })

  it('all domains have full tool access (cognitive posture, not tool restriction)', () => {
    const fullTools = ['read_file', 'write_file', 'edit_file', 'bash', 'grep', 'glob', 'diff', 'run_tests']
    for (const domain of Object.values(STAR_DOMAINS)) {
      for (const tool of fullTools) {
        assert.ok(domain.toolWhitelist.includes(tool), `${domain.name} missing ${tool}`)
      }
    }
  })

  it('tianliang toolWhitelist includes write_file + run_tests (executor delivers)', () => {
    assert.ok(STAR_DOMAINS.tianliang.toolWhitelist.includes('write_file'))
    assert.ok(STAR_DOMAINS.tianliang.toolWhitelist.includes('run_tests'))
  })

  it('all domains have delegate_task + delegate_batch', () => {
    for (const domain of Object.values(STAR_DOMAINS)) {
      assert.ok(domain.toolWhitelist.includes('delegate_task'), `${domain.name} missing delegate_task`)
      assert.ok(domain.toolWhitelist.includes('delegate_batch'), `${domain.name} missing delegate_batch`)
    }
  })

  it('all domains have systemPromptSuffix', () => {
    for (const domain of Object.values(STAR_DOMAINS)) {
      assert.ok(domain.systemPromptSuffix.length > 0, `${domain.name} missing suffix`)
    }
  })

  it('matchDomain result has toolWhitelist accessible via registry', () => {
    const id = matchDomain('探索新功能')
    assert.ok(id)
    const domain = starDomainRegistry.get(id)
    assert.ok(domain)
    assert.ok(domain.toolWhitelist.length > 0)
    assert.ok(domain.systemPromptSuffix.length > 0)
  })
})

describe('buildActiveDomain', () => {
  it('returns domain info for matched task', () => {
    const result = buildActiveDomain('尝试突破新的认证方案')
    assert.ok(result)
    assert.equal(result.name, '破军')
    assert.ok(result.volatileBlock.includes('破军'))
    assert.ok(result.motto)
  })

  it('falls back to tianshu for ambiguous task', () => {
    const result = buildActiveDomain('帮我看看')
    assert.equal(result.id, 'tianshu')
    assert.equal(result.name, '天枢')
  })
})

describe('四域分工模型（2026-07-04 校订）', () => {
  it('tianshu carries all-round default-domain identity (可规划可执行)', () => {
    const tianshu = STAR_DOMAINS.tianshu
    assert.match(tianshu.systemPromptSuffix, /默认域/, 'default-domain identity must be explicit')
    assert.match(tianshu.systemPromptSuffix, /全能/, 'all-round capability must be explicit')
    assert.doesNotMatch(tianshu.systemPromptSuffix, /不在逐行编码/, 'orchestrator-only framing must be removed')
  })

  it('tianshu is a global partner star (意图至上/闭环/委派只是手段)', () => {
    const tianshu = STAR_DOMAINS.tianshu
    assert.match(tianshu.systemPromptSuffix, /落地的是开发者的规划/, 'developer-intent primacy')
    assert.match(tianshu.systemPromptSuffix, /做了什么、遗留什么、设计偏差/, 'delivery report three items')
    assert.match(tianshu.systemPromptSuffix, /委派的唯一理由是并行加速/, 'delegation is a means, not identity')
    assert.match(tianshu.systemPromptSuffix, /一致性高于局部最优/, 'global consistency discipline')
    assert.match(tianshu.volatileBlock, /帮开发者落地他们的规划/, 'raison d\'etre in identity block')
  })

  it('star-interface declarations exist across domains (协同公理落地)', () => {
    // 抽查协调/审查域仍保留星间接口；天梁已精简为纯执行端，不再保留
    assert.match(STAR_DOMAINS.tianshu.systemPromptSuffix, /星间接口/)
    assert.match(STAR_DOMAINS.tianquan.systemPromptSuffix, /星间接口/)
    assert.match(STAR_DOMAINS.yaoguang.systemPromptSuffix, /星间接口/)
    for (const domain of Object.values(STAR_DOMAINS)) {
      if (domain.id === 'tianliang') continue
      assert.match(domain.systemPromptSuffix, /星间接口/, `${domain.name} missing 星间接口 declaration`)
    }
  })

  it('tianliang is the universal delivery endpoint (计划到达即执行)', () => {
    const tianliang = STAR_DOMAINS.tianliang
    assert.match(tianliang.systemPromptSuffix, /计划到你手里时/, 'plans arrive from planning layer')
    assert.match(tianliang.systemPromptSuffix, /你的工作是翻译，不是重新设计/, 'executor does not redesign')
  })

  it('tianquan deliverable is an executable plan (出计划不出实现代码)', () => {
    const tianquan = STAR_DOMAINS.tianquan
    assert.match(tianquan.systemPromptSuffix, /可执行的计划文档/, 'plan document as deliverable')
    assert.match(tianquan.systemPromptSuffix, /物理事实验证/, 'three-layer review: physical facts')
    assert.match(tianquan.systemPromptSuffix, /概念完整性/, 'three-layer review: conceptual integrity')
    assert.match(tianquan.systemPromptSuffix, /blocker/, 'review feedback severity tiering')
  })

  it('yaoguang carries plan+execute identity while keeping rigor phrases', () => {
    const yaoguang = STAR_DOMAINS.yaoguang
    assert.match(yaoguang.volatileBlock, /自己规划、自己执行/, 'plan+execute identity in volatileBlock')
    assert.match(yaoguang.systemPromptSuffix, /调研→计划→执行→验证/, 'full-loop execution in suffix')
    // 旧的严谨底色短语必须原样保留（复现纪律不因身份扩展而稀释）
    assert.match(yaoguang.volatileBlock, /缺席不会自己报警/)
    assert.match(yaoguang.systemPromptSuffix, /观测先行/)
    assert.match(yaoguang.systemPromptSuffix, /先验基线/)
  })

  it('tianliang autonomy boundary is two-tiered (信号精炼自主/方向变更回退)', () => {
    const tianliang = STAR_DOMAINS.tianliang
    assert.match(tianliang.systemPromptSuffix, /自主权有边界/, 'executor autonomy boundary exists')
    assert.match(tianliang.systemPromptSuffix, /回退请求修订/, 'directional changes still escalate')
  })

  it('tianliang verifies plan anchors against reality before executing (锚点漂移)', () => {
    const tianliang = STAR_DOMAINS.tianliang
    assert.match(tianliang.systemPromptSuffix, /事实锚点/, 'plan fact-anchors must be verified first')
    assert.match(tianliang.systemPromptSuffix, /锚点漂移/, 'anchor drift is recorded, not treated as plan error')
  })

  it('tianliang attributes failures before claiming regressions (VSW 污染归因)', () => {
    const tianliang = STAR_DOMAINS.tianliang
    assert.match(tianliang.systemPromptSuffix, /隔离 worktree/, 'VSW isolation attribution')
    assert.match(tianliang.systemPromptSuffix, /污染归因/, 'pollution attribution baseline')
  })

  it('tianliang delivery report covers the three mandatory items', () => {
    const tianliang = STAR_DOMAINS.tianliang
    assert.match(tianliang.systemPromptSuffix, /做了什么、遗留什么、设计偏差/, 'delivery report contract back to planning layer')
    assert.match(tianliang.volatileBlock, /分波/, 'wave-split concept present in cognitive field')
  })
})

describe('tianliang cognitive field + delivery discipline split', () => {
  it('volatileBlock carries wave-split concept as cognitive bias', () => {
    const tianliang = STAR_DOMAINS.tianliang
    assert.match(tianliang.volatileBlock, /分波/, 'wave-split concept must be present in volatileBlock as cognitive bias')
    assert.match(tianliang.volatileBlock, /验证/, 'verification rhythm must be present in volatileBlock')
  })

  it('systemPromptSuffix carries full delivery discipline with >= 4 threshold', () => {
    const tianliang = STAR_DOMAINS.tianliang
    assert.match(tianliang.systemPromptSuffix, />= 4/, 'detailed threshold lives in systemPromptSuffix for workers')
    assert.match(tianliang.systemPromptSuffix, /闭环/, 'closure discipline concept lives in systemPromptSuffix')
    assert.doesNotMatch(tianliang.systemPromptSuffix, /> 5/)
  })

  it('volatileBlock is concise (cognitive field, not procedural manual)', () => {
    const lines = STAR_DOMAINS.tianliang.volatileBlock.split('\n').filter(l => l.trim().length > 0)
    assert.ok(lines.length <= 6, `volatileBlock should be ≤6 non-empty lines, got ${lines.length}`)
  })
})
