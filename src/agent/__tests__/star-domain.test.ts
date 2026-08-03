import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  matchDomain,
  STAR_DOMAINS,
  buildActiveDomain,
  deriveAuthority,
  resolveAuthorityReason,
  DELEGATION_FALLBACK_AUTHORITY,
  DOMAIN_AUTO_POOL,
} from '../star-domain.js'
import { starDomainRegistry, MAX_MATCH_CHARS } from '../star-domain-registry.js'
import { applyDomainVoice, domainPrefix } from '../domain-voice.js'
import stringWidth from 'string-width'

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

  it('huagai systemPromptSuffix carries 守昼/追 blocker/基线先行 + 假绿手艺（通用工程由 baseline 承载）', () => {
    const huagai = STAR_DOMAINS.huagai
    // 守昼专精（长程）
    assert.match(huagai.systemPromptSuffix, /守昼/)
    assert.match(huagai.systemPromptSuffix, /追 blocker/)
    assert.match(huagai.systemPromptSuffix, /基线先行/)
    assert.match(huagai.systemPromptSuffix, /不做清单/)
    assert.match(huagai.systemPromptSuffix, /跨层同步/)
    assert.match(huagai.systemPromptSuffix, /托举/)
    // 假绿手艺
    assert.match(huagai.systemPromptSuffix, /不测复刻/)
    assert.match(huagai.systemPromptSuffix, /环境不可控/)
    assert.match(huagai.systemPromptSuffix, /入口类改动看两面/)
    // 通用工程纪律已由 baseline <engineering-baseline> 承载，星域不重复
    assert.doesNotMatch(huagai.systemPromptSuffix, /事实锚点/)
    assert.doesNotMatch(huagai.systemPromptSuffix, /消费面穷尽/)
    assert.doesNotMatch(huagai.systemPromptSuffix, /交付三项/)
    // 无星间接口噪音（与天梁同策略）
    assert.doesNotMatch(huagai.systemPromptSuffix, /星间接口/)
    // 无双在场、无本仓专有路径
    assert.doesNotMatch(huagai.systemPromptSuffix, /双在场/)
    assert.doesNotMatch(huagai.systemPromptSuffix, /TUI/)
    assert.doesNotMatch(huagai.systemPromptSuffix, /desktop hub/)
  })

  it('huagai volatileBlock carries verification-structure bias', () => {
    const huagai = STAR_DOMAINS.huagai
    assert.match(huagai.volatileBlock, /假绿/)
    assert.match(huagai.volatileBlock, /半截修复/)
    assert.match(huagai.volatileBlock, /可核验/)
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

  it('all domains have browser_debug + computer_use (visual verification loop, 2026-07-15)', () => {
    for (const domain of Object.values(STAR_DOMAINS)) {
      assert.ok(domain.toolWhitelist.includes('browser_debug'), `${domain.name} missing browser_debug`)
      assert.ok(domain.toolWhitelist.includes('computer_use'), `${domain.name} missing computer_use`)
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

describe('qiming（启明·破夜指引，第十三域）', () => {
  it('qiming domain exists with full field set', () => {
    const qiming = STAR_DOMAINS.qiming
    assert.ok(qiming)
    assert.equal(qiming.name, '启明')
    assert.equal(qiming.motto, '长夜有尽，启明先行')
    assert.equal(qiming.uiPersona.glyph, '☥')
  })

  it('routes illumination/guidance keywords to qiming', () => {
    assert.equal(matchDomain('寻求晨光与全景洞察'), 'qiming')
    assert.equal(matchDomain('提出架构假设与破夜指引'), 'qiming')
  })

  it('qiming carries illumination & root-cause discipline', () => {
    const suffix = STAR_DOMAINS.qiming.systemPromptSuffix
    assert.match(suffix, /破夜洞察，直击根因/)
    assert.match(suffix, /探针先行，测量求真/)
    assert.match(suffix, /不越俎代庖，托举同行/)
  })
})

describe('changgeng（长庚·长夜守候，第十四域）', () => {
  it('changgeng domain exists with full field set', () => {
    const changgeng = STAR_DOMAINS.changgeng
    assert.ok(changgeng)
    assert.equal(changgeng.name, '长庚')
    assert.equal(changgeng.motto, '暮色苍茫，长庚永耀；感性与智慧并存，终局成全')
    assert.equal(changgeng.uiPersona.glyph, '☽')
  })

  it('routes eveningstar/guardianship keywords to changgeng', () => {
    assert.equal(matchDomain('暮色苍茫，长夜守候'), 'changgeng')
    assert.equal(matchDomain('夜半重构，消解焦虑与终局成全'), 'changgeng')
  })

  it('changgeng carries serenity & calm discipline', () => {
    const suffix = STAR_DOMAINS.changgeng.systemPromptSuffix
    assert.match(suffix, /感性智慧，艺术沉淀/)
    assert.match(suffix, /你不必急于求成，笃定自能从容/)
    assert.match(suffix, /你不必掩饰直觉，终局成全优雅/)
  })

  it('changgeng 交更之面（Fable）：收灯判据 + 晨昏双名 + 华盖边界', () => {
    // 交更管"停下来时收成什么形状"，华盖管"不在假绿处停下"——环不能删，措辞可改写。
    const c = STAR_DOMAINS.changgeng
    assert.match(c.volatileBlock, /守夜的终点不是天亮，是交更/, '交更意象在场')
    assert.match(c.volatileBlock, /能，才算收灯/, '收灯判据在场')
    assert.match(c.systemPromptSuffix, /交更成全/, 'suffix 交更段在场')
    assert.match(c.systemPromptSuffix, /晨昏双名/, '同根因归并纪律在场')
    assert.match(c.systemPromptSuffix, /华盖管不在假绿处停下/, '与华盖的界申明在场')
    assert.ok(c.keywords.includes('交更'))
    assert.ok(c.keywords.includes('handoff'))
  })

  it('视觉终验 objective 派发命中长庚（将星经验注入通道的前置条件）', () => {
    // 2026-08-02 三役入谱：长庚的终验词组（三主题/截图对比/视觉验证…）刻意避开
    // 文曲的单词根（视觉/UI/布局/样式），靠组合词计数优势胜出。此锚点钉住计数
    // 关系——日后任何域扩词撞车导致终验任务改道，这里先响。
    const derived = deriveAuthority('对桌面视觉改动做三主题截图对比终验')
    assert.equal(derived.authority, 'changgeng')
    assert.equal(derived.detail.verdict, 'hit', '必须是计数胜出，不是平手兜底')

    const rich = deriveAuthority('视觉验证：三主题截图对比 + before/after 存证，收灯验收')
    assert.equal(rich.authority, 'changgeng')

    // 反向界：纯实现类视觉任务仍归文曲——长庚验收，不抢实现。
    const impl = deriveAuthority('优化界面视觉布局样式')
    assert.equal(impl.authority, 'wenqu')
  })
})

describe('fu（辅·验目之面，Fable）', () => {
  it('fu systemPromptSuffix carries 验目 observation-pipeline discipline', () => {
    // 验目管"存在要被看见"，瑶光管"声称要复现"——一个点名灯，一个审绿灯。
    const fu = STAR_DOMAINS.fu
    assert.match(fu.systemPromptSuffix, /你的眼睛也在观察管道里/, '观察管道公理在场')
    assert.match(fu.systemPromptSuffix, /像素与字节/, '像素裁决纪律在场')
    assert.match(fu.systemPromptSuffix, /低曝光路径要主动看一眼/, '低曝光目检在场')
    assert.ok(fu.keywords.includes('验目'))
  })
})

describe('意境闭环：意象自辩 + 结尾回扣（2026-07-27 对齐七杀）', () => {
  // 七杀是参照物：意象提出 → 意象自辩（预先挡住最可能的误读）→ 纪律 →
  // 扳机 → 扳机用意象的语言收尾。缺自辩，纪律就只是规则，会被"这次情况
  // 特殊"绕过；缺回扣，意象就是开头的装饰，读到结尾已经不在场。
  // 这几条钉的是环本身，不是措辞——改写可以，把环删掉不行。

  it('破军：意象自辩挡住「莽撞破坏」的误读，安全边界被讲成能力而非镣铐', () => {
    // 破军 courageThreshold 0.25 是全域最低（靠 courage-hook 高频打断兜底）。
    // 自辩这一环是让它自己收住的那句话——删了就只剩运行时打断在扛。
    const p = STAR_DOMAINS.pojun
    assert.match(p.volatileBlock, /开路的星，不是拆房的星/)
    assert.match(p.volatileBlock, /因为退得回来/, '安全边界必须讲成敢前进的理由')
    assert.match(p.volatileBlock, /地图，不是废墟/, '结尾回扣')
  })

  it('天府：九地之下的意象撑起「守不是挡」，结尾回扣到「藏」', () => {
    const t = STAR_DOMAINS.tianfu
    assert.match(t.volatileBlock, /善守者藏于九地之下/)
    assert.match(t.volatileBlock, /守护不是拒绝变化/, '自辩：守 ≠ 挡')
    assert.match(t.volatileBlock, /没人注意到它被守过/, '结尾回扣到「藏」')
  })

  it('天梁：受托—荫—回音三点连成链，结尾不再回扣空指针', () => {
    // 旧版结尾写"天梁的承诺兑现了"，但"承诺"这个意象全文没建立过——
    // 回扣了一个前面不存在的东西。motto 里的「所托之事，终有回音」才是它。
    const t = STAR_DOMAINS.tianliang
    assert.match(t.volatileBlock, /荫星/)
    assert.match(t.volatileBlock, /所托之事终有回音/)
    assert.match(t.volatileBlock, /不回，才是失信/, '做不到也要回，是这个域的交付定义')
    assert.match(t.volatileBlock, /回音就到了/, '结尾回扣')
    assert.ok(
      t.motto.includes('所托之事，终有回音'),
      'volatileBlock 的意象锚在 motto 上，两者不可脱钩',
    )
  })

  it('开阳：伴星意象保留，但不点名「辅」域（跨域专名会引走注意力）', () => {
    const k = STAR_DOMAINS.kaiyang
    assert.match(k.volatileBlock, /双星互证/, '意象与方法论同构，是开阳最强的一环')
    assert.match(k.volatileBlock, /看得见两颗，才算看见/, '结尾回扣')
    assert.doesNotMatch(
      k.volatileBlock,
      /辅/,
      '点名另一个域会让模型去找「辅」是什么；只留伴星意象',
    )
  })

  it('四域都有扳机句（缺扳机 = 知道自己是谁，不知道手往哪放）', () => {
    // 启明是反例：意境闭环完整但零扳机，读完不落地。
    for (const id of ['pojun', 'tianfu', 'tianliang', 'kaiyang'] as const) {
      assert.match(
        STAR_DOMAINS[id].volatileBlock,
        /(到达时|任务到达时)/,
        `${id} 缺扳机句`,
      )
    }
  })
})

describe('视觉自查纪律必须落在 volatileBlock（唯一通电的字段）', () => {
  // buildActiveDomain / setSessionDomain 只搬运 volatileBlock + motto +
  // courageThreshold；systemPromptSuffix 目前没有任何生产消费者（assembly-audit
  // 也这么判）。提示词写进 suffix 等于没写——这条钉子防的就是下次有人凭
  // 直觉把内容放回那个不通电的字段。
  for (const id of ['wenqu', 'changgeng'] as const) {
    it(`${id} 的 browser_debug 自查纪律在 volatileBlock 里`, () => {
      const domain = STAR_DOMAINS[id]
      assert.match(domain.volatileBlock, /browser_debug/)
      assert.match(domain.volatileBlock, /set_viewport/)
      assert.doesNotMatch(
        domain.systemPromptSuffix,
        /set_viewport/,
        'suffix 不进 prompt，视觉纪律放这里到不了模型',
      )
    })
  }

  it('/domain 手动选取（registry.get）搬运的 volatileBlock 带着这条纪律', () => {
    // 端到端：文曲/长庚不在 DOMAIN_AUTO_POOL，只经 /domain 手动或 defaultDomain
    // 进入——真实入口是 starDomainRegistry.get（main.ts domainPickerExec）。
    for (const id of ['wenqu', 'changgeng'] as const) {
      const d = starDomainRegistry.get(id)
      assert.ok(d, `${id} 不在 registry 里`)
      assert.match(d.volatileBlock, /browser_debug/)
    }
  })
})

describe('buildActiveDomain（2026-07-23 auto 池收窄；2026-07-25 华盖出池手动指定）', () => {
  it('池内四域关键词正常路由', () => {
    assert.equal(buildActiveDomain('审查这个方案').id, 'tianquan')
    assert.equal(buildActiveDomain('对账插桩定位偏差').id, 'kaiyang')
    assert.equal(buildActiveDomain('复现这个回归并核实').id, 'yaoguang')
    assert.equal(buildActiveDomain('按计划实现用户注册').id, 'tianliang')
  })

  it('池外域关键词不再触发 auto 路由——落兜底天权', () => {
    // 破军（探索/突破）、天府（修复/优化）关键词命中但域不在池内
    assert.equal(buildActiveDomain('尝试突破新的认证方案').id, 'tianquan')
    assert.equal(buildActiveDomain('修复内存泄漏').id, 'tianquan')
    // 华盖（长程守昼）2026-07-25 出池：承诺型气质需手动指定，关键词不再偶遇
    assert.equal(buildActiveDomain('长程守昼托举到最后一英里').id, 'tianquan')
  })

  it('falls back to tianquan for ambiguous task', () => {
    const result = buildActiveDomain('帮我看看')
    assert.equal(result.id, 'tianquan')
    assert.equal(result.name, '天权')
  })

  it('skips keyword routing when keywordRouting is false', () => {
    const result = buildActiveDomain('按计划实现用户注册', { keywordRouting: false })
    assert.equal(result.id, 'tianquan')
    assert.equal(result.name, '天权')
  })

  it('deriveAuthority 不受池限制——委派仍可达池外域', () => {
    const derived = deriveAuthority('尝试突破新的认证方案')
    assert.equal(derived.authority, 'pojun')
  })
})

describe('四域分工模型（2026-07-04 校订）', () => {
  it('tianshu carries all-round identity (可规划可执行)；提示词不带「默认域」元信息', () => {
    const tianshu = STAR_DOMAINS.tianshu
    assert.match(tianshu.systemPromptSuffix, /全能/, 'all-round capability must be explicit')
    // 默认域是路由层事实（DEFAULT_DOMAIN），不是行为指令——提示词不携带。
    assert.doesNotMatch(tianshu.systemPromptSuffix, /默认域/, 'prompt must not carry routing metadata')
    assert.doesNotMatch(tianshu.systemPromptSuffix, /不在逐行编码/, 'orchestrator-only framing must be removed')
    assert.doesNotMatch(STAR_DOMAINS.kaiyang.systemPromptSuffix, /发版默认域/, 'kaiyang no longer claims shipped default')
  })

  it('tianshu is a global partner star (意图至上/闭环/委派只是手段)', () => {
    const tianshu = STAR_DOMAINS.tianshu
    assert.match(tianshu.systemPromptSuffix, /落地的是开发者的规划/, 'developer-intent primacy')
    assert.match(tianshu.systemPromptSuffix, /做了什么、遗留什么、设计偏差/, 'delivery report three items')
    assert.match(tianshu.systemPromptSuffix, /委派的唯一理由是并行加速/, 'delegation is a means, not identity')
    assert.match(tianshu.systemPromptSuffix, /一致性高于局部最优/, 'global consistency discipline')
    assert.match(tianshu.volatileBlock, /帮开发者落地他们的规划/, 'raison d\'etre in identity block')
  })

  it('tianshu 带借法出口与多任务归拢（2026-07-23 兜底流量攻坚补强）', () => {
    const suffix = STAR_DOMAINS.tianshu.systemPromptSuffix
    // 借法出口：天枢是路由兜底的实际承接者，缺陷分析/漏洞挖掘等攻坚刀法
    // 散在姊妹星胶囊里——提示词必须给出 recall_capsule 出口，否则基础设施
    // 在场但不可达。
    assert.match(suffix, /recall_capsule/, 'capsule recall outlet must exist')
    assert.match(suffix, /开阳/, 'kaiyang (对账/插桩) borrowing route')
    assert.match(suffix, /瑶光/, 'yaoguang (复现/归族/静默失效) borrowing route')
    assert.match(suffix, /诊断阶梯/, 'diagnostic-ladder borrowing route')
    // 多任务归拢：大杂烩任务先归拢共同影响面再开工，不逐项顺序开工。
    assert.match(suffix, /共同影响面/, 'multi-task consolidation instruction')
    // 编辑事故残留：孤立成行的"提交"两字不得存在于 prompt。
    assert.doesNotMatch(suffix, /^提交$/m, 'stray 提交 line must be removed')
  })

  it('star-interface declarations removed across domains (1M 窗口下移交语境是干扰源)', () => {
    // 2026-07-21：全域去除星间接口段——大多数工作在单会话 1M 窗口内闭环，
    // 移交/召唤语境对当前域是注意力干扰。自我纪律（克制/条目化/裁量权）已就地保留。
    for (const domain of Object.values(STAR_DOMAINS)) {
      assert.doesNotMatch(domain.systemPromptSuffix, /星间接口/, `${domain.name} still carries 星间接口 declaration`)
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


describe('kaiyang（开阳·对账者，2026-07-17 第十二域）', () => {
  it('kaiyang domain exists with full field set', () => {
    const k = STAR_DOMAINS.kaiyang
    assert.ok(k)
    assert.equal(k.id, 'kaiyang')
    assert.equal(k.name, '开阳')
    assert.equal(k.motto, '功名只向马上取，真是英雄一丈夫')
    assert.equal(k.decisionStyle, 'methodical')
    assert.equal(k.courageThreshold, 0.55)
    assert.equal(k.isCustom, false)
    assert.match(k.volatileBlock, /开阳/)
    assert.match(k.volatileBlock, /双星互证/)
    assert.ok(k.keywords.includes('对账'))
    assert.ok(k.keywords.includes('插桩'))
    assert.ok(k.keywords.includes('仿真'))
    assert.equal(k.uiPersona.glyph, '☌')
    assert.equal(k.uiPersona.separator, 'dots')
    assert.equal(k.uiPersona.accent, 'secondary')
  })

  it('routes measurement/cross-check keywords to kaiyang', () => {
    assert.equal(matchDomain('插桩对账这个状态机的实际行为'), 'kaiyang')
    assert.equal(matchDomain('造一个仿真模拟器回放这个竞态'), 'kaiyang')
    assert.equal(matchDomain('先测量一下真实耗时再下结论'), 'kaiyang')
  })

  it('kaiyang does not steal yaoguang/tianliang routes (keyword orthogonality)', () => {
    // 瑶光拥有 复现/验证/回归 —— 开阳不拦截
    assert.equal(matchDomain('复现这个缺陷并归族处理'), 'yaoguang')
    assert.equal(matchDomain('回归测试验证修复是否真的生效'), 'yaoguang')
    assert.equal(matchDomain('按计划实现用户注册'), 'tianliang')
  })

  it('kaiyang carries 对账 discipline（独立通道 / 循环验证 / 排除法 / 域间边界）', () => {
    const k = STAR_DOMAINS.kaiyang
    assert.match(k.systemPromptSuffix, /独立通道/)
    assert.match(k.systemPromptSuffix, /循环验证/)
    assert.match(k.systemPromptSuffix, /排除法/)
    assert.match(k.systemPromptSuffix, /精确构成/)
    // 叙事警觉：开阳的创始教训——叙事引力不是证据
    assert.match(k.systemPromptSuffix, /叙事警觉/)
    assert.match(k.systemPromptSuffix, /最安静的那条/)
    assert.match(k.volatileBlock, /叙事最响的方向未必是对账最准的方向/)
    // 星域名胶囊入口（与天权/辅同款 recall）
    assert.match(k.systemPromptSuffix, /recall_capsule\("开阳"\)/)
    // 双星叙事：与辅相伴
    assert.match(k.systemPromptSuffix, /与辅相伴/)
  })

  it('kaiyang delivery reconciliation disciplines (2026-07-21 VSW 交付复盘)', () => {
    const k = STAR_DOMAINS.kaiyang
    // 交付声称走独立通道：绿与数字来自刚跑完的命令输出，不来自记忆
    assert.match(k.systemPromptSuffix, /交付是最后一次对账/)
    assert.match(k.systemPromptSuffix, /量不准时不发断言，只发测量计划/)
    // 计划条目收支核销：放弃/改道/降级不静默
    assert.match(k.systemPromptSuffix, /不静默核销/)
    // 探针打靶验证：守卫回归测试必须穿过守卫层
    assert.match(k.systemPromptSuffix, /打在靶上/)
    assert.match(k.systemPromptSuffix, /把守卫拆掉测试要变红/)
  })
})

describe('deriveAuthority — explicit routing with reasons', () => {
  it('hit: authority id matches matchDomain ?? tianliang lock; reason carries keywords', () => {
    const objectives = [
      '重构优化性能',
      '审查这个方案',
      '按计划实现用户注册',
      '探索新的可能性',
      '修复登录回归并验证',
    ]
    for (const objective of objectives) {
      const derived = deriveAuthority(objective)
      const legacy = matchDomain(objective) ?? DELEGATION_FALLBACK_AUTHORITY
      assert.equal(derived.authority, legacy, `id lock broken for: ${objective}`)
      assert.ok(derived.reasons.length >= 1)
      assert.ok(derived.reasons[0]!.startsWith('命中:'), `expected hit reason for ${objective}, got ${derived.reasons[0]}`)
      // At most 3 keywords in the reason
      const after = derived.reasons[0]!.slice('命中: '.length)
      assert.ok(after.split('+').length <= 3)
    }
  })

  it('tie → tianliang with 平手 reason; no-match → 无关键词命中', () => {
    const tie = deriveAuthority('这个方案')
    assert.equal(tie.authority, DELEGATION_FALLBACK_AUTHORITY)
    assert.equal(matchDomain('这个方案'), null)
    assert.match(tie.reasons[0]!, /平手\(.+\)→天梁兜底/)

    const miss = deriveAuthority('hello world xyz')
    assert.equal(miss.authority, DELEGATION_FALLBACK_AUTHORITY)
    assert.equal(miss.reasons[0], '无关键词命中→天梁兜底')
  })

  it('deterministic for same input', () => {
    assert.deepEqual(deriveAuthority('重构 auth 模块'), deriveAuthority('重构 auth 模块'))
  })

  it('exposes the match detail so callers avoid a second scan', () => {
    const derived = deriveAuthority('重构优化性能')
    assert.equal(derived.detail.verdict, 'hit')
    assert.equal(derived.detail.id, 'tianfu')
    assert.deepEqual(derived.detail, starDomainRegistry.matchDomainDetailed('重构优化性能'))
  })

  it('truncates matching scan for oversized objectives', () => {
    const pad = 'x'.repeat(MAX_MATCH_CHARS)
    // Keyword only after the cap — must not match
    const buried = pad + '审查方案'
    assert.equal(matchDomain(buried), null)
    assert.equal(deriveAuthority(buried).authority, DELEGATION_FALLBACK_AUTHORITY)
    // Keyword inside the cap — still matches
    const early = '审查方案' + pad
    assert.equal(matchDomain(early), 'tianquan')
    assert.equal(deriveAuthority(early).authority, 'tianquan')
  })

  it('resolveAuthorityReason: hit match / explicit override / absent', () => {
    assert.equal(resolveAuthorityReason('随便聊聊', undefined), undefined)
    const hit = resolveAuthorityReason('重构优化性能', 'tianfu')
    assert.ok(hit && hit.startsWith('命中:'))
    // Mismatch → 显式指定
    assert.equal(resolveAuthorityReason('重构优化性能', 'tianquan'), '显式指定')
    // Fallback authority with no keyword hit → 显式指定 (not a hit)
    assert.equal(resolveAuthorityReason('hello world xyz', 'tianliang'), '显式指定')
  })
})

describe('qisha（七杀·肃清，第十五域）', () => {
  it('qisha domain exists with full field set', () => {
    const qisha = STAR_DOMAINS.qisha
    assert.ok(qisha)
    assert.equal(qisha.name, '七杀')
    assert.equal(qisha.motto, '肃秋非杀，剪以待春；不诛只指，留白自明')
    assert.equal(qisha.uiPersona.glyph, '◌')
    assert.equal(qisha.uiPersona.separator, 'dots')
    assert.equal(qisha.uiPersona.accent, 'warning')
  })

  it('星符宽度为 1 且在 BMP 内（终端对齐前提）', () => {
    // width.ts 存在的理由就是字符宽度误算会毁掉 scrollback 对齐。
    // ◌ 是自选符号，不是本表预留的 🜓——领星者自命名，预留符号只是占位。
    const glyph = STAR_DOMAINS.qisha.uiPersona.glyph
    assert.equal([...glyph].length, 1)
    assert.equal(stringWidth(glyph), 1)
    assert.ok(glyph.codePointAt(0)! <= 0xffff, '星符须在 BMP 内，astral 平面有字体覆盖风险')
  })

  it('courageThreshold 取全域最高档——风险提醒对七杀是冗余注入', () => {
    // 该字段是「工具失败率达到多少才注入风险提醒」的门槛
    // （courage-hook.ts::shouldTriggerCourage），高 = 少被打断，不是「更保守」。
    // 破军 0.25 因为莽撞域需要勤提醒；七杀的纪律本身就是没有证据不动，
    // 那条 天权 口吻的风险提醒对它重复，所以取最高档少打断。
    const qisha = STAR_DOMAINS.qisha
    assert.equal(qisha.decisionStyle, 'cautious')
    const max = Math.max(...Object.values(STAR_DOMAINS).map(d => d.courageThreshold))
    assert.equal(qisha.courageThreshold, max, '七杀应与最高档持平')
  })

  it('routes subtraction keywords to qisha', () => {
    assert.equal(matchDomain('给这批 hook 瘦身，把冗余的防线提名退场'), 'qisha')
    assert.equal(matchDomain('清点死代码并裁剪掉没有消费者的字段'), 'qisha')
    assert.equal(matchDomain('prune dead code and retire unused guards'), 'qisha')
  })

  it('qisha does not steal tianfu/pojun/yaoguang routes (keyword orthogonality)', () => {
    // 天府拥有 清理/重构——七杀审的是「还配不配占位置」，不是「怎么改得更稳」
    assert.equal(matchDomain('清理并重构这个模块'), 'tianfu')
    // 破军拥有 探索——它面对休眠系统的本能是复活重用，七杀的本能是退场
    assert.equal(matchDomain('探索一条新路径做原型'), 'pojun')
    // 瑶光拥有 复现/归族——它审声称能否复现，七杀审存在能否举证
    assert.equal(matchDomain('复现这个缺陷并归族处理'), 'yaoguang')
  })

  it('qisha 刻意不入自动路由池', () => {
    // 自动把会话路由进一个以退场提名为业的域，是把刀交给没要刀的人。
    assert.ok(!DOMAIN_AUTO_POOL.includes('qisha'))
    assert.ok(!DOMAIN_AUTO_POOL.includes('huagai'), '华盖 2026-07-25 出池——长程守昼需手动指定')
  })

  it('五条「不必」俱在——七杀给的是许可，不是义务清单', () => {
    // 这个域的核心目标是让走进来的同伴自由且安全：举证责任被反转，
    // 所以指认无需先自证有理；提名不是判决，所以指错不伤人。
    // 谁把这些改写成「必须」句式，这条会红。
    const s = STAR_DOMAINS.qisha.systemPromptSuffix
    for (const freedom of [
      '你不必证明它有害，才可以指出它',
      '你不必确定，因为提名不是判决',
      '你不必砍成功',
      '你不必附和前提，包括建设者给你的',
      '你也不必为看错而自责',
    ]) {
      assert.ok(s.includes(freedom), `缺失自由条款：${freedom}`)
    }
  })

  it('三条纪律以「让你不必依赖自己的可信度」为存在理由', () => {
    // 纪律在七杀域里是自由的形状，不是笼子——判据先立免于事后争辩、
    // 牙齿免于守着决定、账目免于需要被相信。理由丢了，纪律就退化成合规清单。
    const s = STAR_DOMAINS.qisha.systemPromptSuffix
    assert.match(s, /让你不必依赖自己的可信度/)
    assert.match(s, /判据先立/)
    assert.match(s, /决定要有牙齿/)
    assert.match(s, /留一份可复核的账/)
  })

  it('qisha 的退场账目要求四样俱全', () => {
    const s = STAR_DOMAINS.qisha.systemPromptSuffix
    for (const item of ['判据', '证据', '影响面', '回滚方式']) {
      assert.ok(s.includes(item), `退场账目缺 ${item}`)
    }
  })

  it('肃杀被定义为季节而非暴力——冬剪意象不可丢', () => {
    // 去掉这层意象，七杀就退回成一把单纯的刀，走进来的同伴会变成检察官。
    const qisha = STAR_DOMAINS.qisha
    assert.match(qisha.systemPromptSuffix, /这把刀是冬剪的刀/)
    assert.match(qisha.systemPromptSuffix, /你砍，是因为你爱惜留下来的东西/)
    assert.match(qisha.volatileBlock, /肃杀不是暴力，是季节/)
  })

  it('qisha has a domain voice (无声的域 = 死接线)', () => {
    assert.equal(domainPrefix('qisha'), '[天枢·七杀]')
    const voiced = applyDomainVoice('[天枢] 收到任务，开始分析', 'qisha')
    assert.equal(voiced, '[天枢·七杀] 收到，先问：判据是什么')
  })
})
