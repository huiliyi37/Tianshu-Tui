import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskContract } from '../../context/task-contract.js'
import {
  buildHeuristicRetrievalRoute,
  normalizeRetrievalRoute,
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

describe('intent retrieval anti-anchor boundaries', () => {
  it('routes retry-failure wording to diagnostics, not only retry advice', () => {
    const route = routeFor('重试一下这个失败')

    assert.ok(route.taskKinds.includes('bug_fix'))
    assert.ok(sources(route).includes('codebase'))
    assert.ok(sources(route).includes('tests'))
    assert.ok(sources(route).includes('memory'))
    assert.ok(route.directions.some(direction => !/重试|retry/i.test(direction.query)))
  })

  it('adds git/codebase/memory for performance wording', () => {
    const route = routeFor('这个接口很慢，延迟和吞吐都变差了')

    assert.ok(route.taskKinds.includes('performance_diagnosis'))
    assert.ok(sources(route).includes('git'))
    assert.ok(sources(route).includes('codebase'))
    assert.ok(sources(route).includes('memory'))
  })

  it('routes usage questions toward docs/external and not git by default', () => {
    const route = routeFor('怎么用 X')

    assert.ok(route.taskKinds.includes('usage_question'))
    assert.match(priorityFor(route, 'docs') ?? '', /must|should/)
    assert.match(priorityFor(route, 'external') ?? '', /must|should/)
    assert.match(priorityFor(route, 'git') ?? '', /avoid|optional/)
  })

  it('routes P0 review/audit requests to codebase/tests/git/memory', () => {
    const route = routeFor('审查 P0 风险')

    assert.ok(route.taskKinds.includes('review_audit'))
    assert.ok(sources(route).includes('codebase'))
    assert.ok(sources(route).includes('tests'))
    assert.ok(sources(route).includes('git'))
    assert.ok(sources(route).includes('memory'))
  })

  it('restores baseline must/should sources when LLM JSON omits them', () => {
    const route = normalizeRetrievalRoute({
      taskKinds: ['security_safety'],
      directions: [{ source: 'codebase', priority: 'must', query: 'inspect auth', reason: 'security' }],
      confidence: 0.9,
      fallbackUsed: false,
    })

    assert.equal(route.fallbackUsed, false)
    assert.ok(sources(route).includes('codebase'))
    assert.ok(sources(route).includes('tests'))
    assert.ok(sources(route).includes('git'))
    assert.ok(sources(route).includes('memory'))
  })

  it('does not mistake slow explanatory phrasing for performance diagnosis', () => {
    const route = routeFor('慢慢解释这个函数')

    assert.ok(!route.taskKinds.includes('performance_diagnosis'))
    assert.ok(route.taskKinds.includes('code_explanation'))
  })

  it('does not mistake token refresh API usage for a security task', () => {
    const route = routeFor('token refresh API 怎么用')

    assert.ok(!route.taskKinds.includes('security_safety'))
    assert.ok(route.taskKinds.includes('usage_question'))
  })

  it('allows usage plus bug-fix when upgrade usage wording also says failure', () => {
    const route = routeFor('最近升级后 X 怎么用失败')

    assert.ok(route.taskKinds.includes('usage_question'))
    assert.ok(route.taskKinds.includes('bug_fix'))
    assert.ok(sources(route).includes('codebase'))
    assert.ok(sources(route).includes('tests'))
    assert.ok(sources(route).includes('git'))
  })

  it('does not treat standalone P0 label without review/risk context as audit', () => {
    const route = routeFor('P0 这个配置怎么用')

    assert.ok(!route.taskKinds.includes('review_audit'))
    assert.ok(route.taskKinds.includes('usage_question'))
  })
})
