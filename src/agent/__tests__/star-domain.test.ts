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
