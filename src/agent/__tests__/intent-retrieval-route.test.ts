import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskContract } from '../../context/task-contract.js'
import {
  buildHeuristicRetrievalRoute,
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
