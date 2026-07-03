import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskContract } from '../../context/task-contract.js'
import {
  buildHeuristicRetrievalRoute,
  extractAskLine,
  normalizeRetrievalRoute,
  renderIntentRetrievalRoute,
  type RetrievalPriority,
  type RetrievalSource,
} from '../intent-retrieval-route.js'

function routeFor(message: string) {
  return buildHeuristicRetrievalRoute({
    userMessage: message,
    taskContract: extractTaskContract(message, 1),
  })
}

function sources(route: { directions: Array<{ source: RetrievalSource }> }): RetrievalSource[] {
  return route.directions.map(direction => direction.source)
}

function priorityFor(route: { directions: Array<{ source: RetrievalSource, priority: RetrievalPriority }> }, source: RetrievalSource): RetrievalPriority | undefined {
  return route.directions.find(direction => direction.source === source)?.priority
}

describe('intent retrieval route heuristic', () => {
  it('classifies failure retry wording as bug_fix and keeps diagnostic sources', () => {
    const route = routeFor('重试一下这个失败')

    assert.ok(route.taskKinds.includes('bug_fix'))
    assert.ok(sources(route).includes('codebase'))
    assert.ok(sources(route).includes('tests'))
    assert.ok(sources(route).includes('memory'))
    assert.ok(!route.directions.every(direction => /重试|retry/i.test(direction.query)))
  })

  it('classifies performance requests with git/codebase/memory directions', () => {
    const route = routeFor('这个接口响应很慢，最近还有卡顿')

    assert.ok(route.taskKinds.includes('performance_diagnosis'))
    assert.ok(sources(route).includes('codebase'))
    assert.ok(sources(route).includes('git'))
    assert.ok(sources(route).includes('memory'))
  })

  it('routes usage questions toward docs/external and away from git by default', () => {
    const route = routeFor('怎么用 prefix cache 配置')

    assert.ok(route.taskKinds.includes('usage_question'))
    assert.match(priorityFor(route, 'docs') ?? '', /must|should/)
    assert.match(priorityFor(route, 'external') ?? '', /must|should|optional/)
    assert.match(priorityFor(route, 'git') ?? '', /avoid|optional/)
  })

  it('classifies architecture and review requests with their expected sources', () => {
    const arch = routeFor('设计一下这个路由架构方案')
    assert.ok(arch.taskKinds.includes('architecture_design'))
    assert.ok(sources(arch).includes('codebase'))
    assert.ok(sources(arch).includes('memory'))

    const review = routeFor('审查 P0 风险和 blast radius')
    assert.ok(review.taskKinds.includes('review_audit'))
    assert.ok(sources(review).includes('codebase'))
    assert.ok(sources(review).includes('tests'))
    assert.ok(sources(review).includes('git'))
    assert.ok(sources(review).includes('memory'))
  })

  it('does not treat polite slow-explanation wording as performance diagnosis', () => {
    const route = routeFor('慢慢解释这个函数')

    assert.ok(!route.taskKinds.includes('performance_diagnosis'))
    assert.ok(route.taskKinds.includes('code_explanation'))
  })

  it('does not treat token refresh API usage as a security task', () => {
    const route = routeFor('token refresh API 怎么用')

    assert.ok(!route.taskKinds.includes('security_safety'))
    assert.ok(route.taskKinds.includes('usage_question'))
  })

  it('supports multi-label usage plus bug when wording crosses task kinds', () => {
    const route = routeFor('最近升级后 X 怎么用失败')

    assert.ok(route.taskKinds.includes('bug_fix'))
    assert.ok(route.taskKinds.includes('usage_question'))
    assert.ok(sources(route).includes('codebase'))
    assert.ok(sources(route).includes('tests'))
    assert.ok(sources(route).includes('git'))
  })

  it('classifies short social greetings as social_idle with zero directions', () => {
    const cn = routeFor('你好')
    assert.ok(cn.taskKinds.includes('social_idle'))
    assert.equal(cn.directions.length, 0)
    assert.ok(cn.confidence <= 0.4)

    const en = routeFor('hi')
    assert.ok(en.taskKinds.includes('social_idle'))
    assert.equal(en.directions.length, 0)

    const hey = routeFor('hey there')
    assert.ok(hey.taskKinds.includes('social_idle'))
  })

  it('does NOT classify technical short inputs as social_idle', () => {
    const route = routeFor('修 bug')
    assert.ok(!route.taskKinds.includes('social_idle'))
    assert.ok(route.taskKinds.includes('bug_fix'))
  })

  it('classifies gap-analysis inspection wording (检查…有没有缺陷) as review_audit', () => {
    const route = routeFor('检查分析一下 用户意图识别这部分 有没有缺陷和场景不覆盖 遗漏的')

    assert.ok(route.taskKinds.includes('review_audit'), `expected review_audit, got ${route.taskKinds}`)
    // review_audit 基线必须带上测试覆盖与历史风险两个源
    assert.equal(priorityFor(route, 'tests'), 'must')
    assert.ok(sources(route).includes('memory'))
  })

  it('classifies bare 检查/排查 wording as review_audit instead of default new_feature', () => {
    const check = routeFor('检查一下这个模块有没有遗漏的场景')
    assert.ok(check.taskKinds.includes('review_audit'), `expected review_audit, got ${check.taskKinds}`)
    assert.ok(!check.taskKinds.includes('new_feature'))
    assert.ok(check.confidence >= 0.6, 'specific classification should clear the injection gate')

    const investigate = routeFor('排查一下权限校验这块的覆盖情况')
    assert.ok(investigate.taskKinds.includes('review_audit'), `expected review_audit, got ${investigate.taskKinds}`)
  })

  it('classifies project overview questions as codebase_overview with repo-wide sweep', () => {
    const route = routeFor('给我讲讲这个项目的整体架构和模块职责')

    assert.ok(route.taskKinds.includes('codebase_overview'), `expected codebase_overview, got ${route.taskKinds}`)
    const codebase = route.directions.find(direction => direction.source === 'codebase')
    assert.equal(codebase?.priority, 'must')
    assert.match(codebase?.query ?? '', /repo_map|模块地图/, 'overview must ask for a module map, not a single entry file')
    assert.ok(sources(route).includes('docs'))
  })

  it('classifies "这个项目是干嘛的" as codebase_overview', () => {
    const route = routeFor('这个项目是干嘛的，主要模块有哪些')
    assert.ok(route.taskKinds.includes('codebase_overview'), `expected codebase_overview, got ${route.taskKinds}`)
  })
})

describe('extractAskLine — 意图原文提取', () => {
  it('picks the last ask-bearing line of a multi-line message', () => {
    const message = '背景：我们上周改了压缩机制\n有些用户反馈离开一会回来上下文没了\n帮我查一下现在的压缩情况'
    assert.equal(extractAskLine(message), '帮我查一下现在的压缩情况')
  })

  it('falls back to the first line when no line carries an ask marker', () => {
    assert.equal(extractAskLine('实现登录模块\n用现有的会话存储'), '实现登录模块')
  })

  it('returns the single line unchanged for single-line messages', () => {
    assert.equal(extractAskLine('修复这个失败'), '修复这个失败')
  })

  it('objectiveSummary prefers the ask line over the first (background) line', () => {
    const route = routeFor('这是一段背景说明而已，讲上周发生了什么\n真正的问题：为什么闲时压缩会提前触发？')
    assert.match(route.objectiveSummary ?? '', /为什么闲时压缩/)
  })
})

describe('followUp mode inheritance', () => {
  it('inherits previous taskKinds when current message yields only default new_feature', () => {
    const route = buildHeuristicRetrievalRoute({
      userMessage: '继续',
      inheritedTaskKinds: ['bug_fix'],
    })
    assert.ok(route.taskKinds.includes('bug_fix'), `expected bug_fix from inheritance, got ${route.taskKinds}`)
    assert.ok(!route.taskKinds.includes('new_feature'), 'should not contain default new_feature')
  })

  it('does not inherit when current message has a specific classification', () => {
    const route = buildHeuristicRetrievalRoute({
      userMessage: '审查这个模块的安全风险',
      inheritedTaskKinds: ['bug_fix'],
    })
    assert.ok(route.taskKinds.includes('review_audit'), `expected review_audit, got ${route.taskKinds}`)
  })

  it('does not inherit when no inheritedTaskKinds provided', () => {
    const route = buildHeuristicRetrievalRoute({
      userMessage: '继续',
    })
    assert.ok(route.taskKinds.includes('social_idle'), 'without inheritance, short continuation should be social_idle')
  })

  it('uses inherited refactor kind for short follow-up', () => {
    const route = buildHeuristicRetrievalRoute({
      userMessage: '好的 做吧',
      inheritedTaskKinds: ['refactor'],
    })
    assert.ok(route.taskKinds.includes('refactor'), `expected refactor from inheritance, got ${route.taskKinds}`)
  })
})

describe('intent retrieval route normalization and rendering', () => {
  it('normalizes LLM routes and fills missing baseline sources', () => {
    const route = normalizeRetrievalRoute({
      taskKinds: ['review_audit'],
      directions: [{ source: 'codebase', priority: 'must', query: 'inspect implementation', reason: 'review task' }],
      confidence: 0.9,
      fallbackUsed: false,
    })

    assert.equal(route.fallbackUsed, false)
    assert.ok(sources(route).includes('codebase'))
    assert.ok(sources(route).includes('tests'))
    assert.ok(sources(route).includes('git'))
    assert.ok(sources(route).includes('memory'))
    // 风险4：LLM 只返回 codebase 一个方向时，normalize 必须补回 review_audit 的基线 must 源（tests）
    // LLM 不能通过省略 directions 来绕过必查源。
    assert.equal(priorityFor(route, 'tests'), 'must')
    assert.equal(priorityFor(route, 'codebase'), 'must')
  })

  it('limits unknown values and falls back to heuristic when raw route is unusable', () => {
    const route = normalizeRetrievalRoute({
      taskKinds: ['unknown'],
      directions: [{ source: 'shell', priority: 'now', query: 'x', reason: 'y' }],
      confidence: 99,
    }, { userMessage: '修复这个失败', taskContract: extractTaskContract('修复这个失败', 1) })

    assert.ok(route.taskKinds.includes('bug_fix'))
    assert.ok(route.confidence <= 1)
    assert.ok(sources(route).includes('codebase'))
    assert.ok(!sources(route).includes('shell' as RetrievalSource))
  })

  it('renders cache-safe advisory XML without raw full user message', () => {
    const route = normalizeRetrievalRoute({
      taskKinds: ['bug_fix'],
      directions: [{ source: 'codebase', priority: 'must', query: 'read <src/a.ts>', reason: 'bug & scope' }],
      objectiveSummary: '修复 <bug> & 验证',
      confidence: 0.8,
    })

    const rendered = renderIntentRetrievalRoute(route)

    assert.match(rendered, /^<intent-retrieval-route advisory="true" scope="current-turn"/)
    assert.match(rendered, /&lt;src\/a\.ts&gt;/)
    assert.match(rendered, /bug &amp; scope/)
    assert.match(rendered, /项目规则、工具权限、实际证据优先于本路由/)
    assert.ok(!rendered.includes('<bug>'))
  })
})
