import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  resolveContextualIdentifier,
  enrichUserMessageWithContext,
  sanitizeForIntentClassification,
  extractSemanticVerb,
  disambiguateByVerb,
} from '../intent-sanitizer.js'
import { buildHeuristicRetrievalRoute } from '../intent-retrieval-route.js'

describe('intent-sanitizer context resolution', () => {
  it('extracts P1/P2/T1 from markdown task lists', () => {
    const lastAssistant = `
请问我们接下来做哪一个？
- P1: 修复 src/agent/loop.ts 中的内存泄露
- P2: 重写 buildIntentRouterPrompt 单元测试
- T1: 整理 docs/ 目录下的过时文档
`
    const r1 = resolveContextualIdentifier('执行 P1', lastAssistant)
    assert.deepEqual(r1, [{ identifier: 'P1', resolvedContent: '修复 src/agent/loop.ts 中的内存泄露' }])

    const r2 = resolveContextualIdentifier('P2 和 T1 都做一下', lastAssistant)
    assert.deepEqual(r2, [
      { identifier: 'P2', resolvedContent: '重写 buildIntentRouterPrompt 单元测试' },
      { identifier: 'T1', resolvedContent: '整理 docs/ 目录下的过时文档' }
    ])
  })

  it('handles bold identifiers and title patterns', () => {
    const lastAssistant = `
1. **P1**: 修复登录报错问题
2. **P2**: 新增用户注册 API
### T3 - 重构 API 客户端
`
    const r1 = resolveContextualIdentifier('就做 P1', lastAssistant)
    assert.deepEqual(r1, [{ identifier: 'P1', resolvedContent: '修复登录报错问题' }])

    const r2 = resolveContextualIdentifier('重构 T3', lastAssistant)
    assert.deepEqual(r2, [{ identifier: 'T3', resolvedContent: '重构 API 客户端' }])
  })
})

describe('intent-sanitizer message enrichment', () => {
  it('enriches user message with resolved context', () => {
    const contexts = [
      { identifier: 'P1', resolvedContent: '修复内存泄露' }
    ]
    const enriched = enrichUserMessageWithContext('执行 P1 吧', contexts)
    assert.equal(enriched, '执行 P1 (上下文关联任务: 修复内存泄露) 吧')
  })
})

describe('intent-sanitizer desensitization', () => {
  it('strips P1, TASK-123 and PROJ-456 and replaces with [REF]', () => {
    const { sanitized, strippedTokens } = sanitizeForIntentClassification('执行 P1 修复 TASK-1002 问题')
    assert.equal(sanitized, '执行 [REF] 修复 [REF] 问题')
    assert.deepEqual(strippedTokens.sort(), ['P1', 'TASK-1002'].sort())
  })
})

describe('intent-sanitizer semantic verb extraction', () => {
  it('extracts verbs and maps to task kinds', () => {
    assert.equal(extractSemanticVerb('修复登录报错'), '修复')
    assert.equal(extractSemanticVerb('优化系统性能'), '优化')
    assert.equal(extractSemanticVerb('怎么用这个 API'), '怎么用')
  })

  it('disambiguates candidates using verbs', () => {
    const candidates = ['review_audit', 'bug_fix']
    const result = disambiguateByVerb(candidates as any, '修复')
    assert.deepEqual(result, ['bug_fix', 'review_audit'])
  })
})

describe('end-to-end integration with buildHeuristicRetrievalRoute', () => {
  it('correctly classifies "P1" when P1 maps to bug_fix in context', () => {
    const lastAssistant = `
我们有以下待办：
- P1: 修复 loop.ts 内存泄露
- P2: 解释 docs/api.md 里的用法
`
    const route = buildHeuristicRetrievalRoute({
      userMessage: '做 P1 吧',
      lastAssistantMessage: lastAssistant
    })
    assert.ok(route.taskKinds.includes('bug_fix'))
    assert.ok(!route.taskKinds.includes('review_audit')) // Avoid reviews
  })

  it('correctly classifies "P2" when P2 maps to usage_question in context', () => {
    const lastAssistant = `
我们有以下待办：
- P1: 修复 loop.ts 内存泄露
- P2: 解释 docs/api.md 里的用法
`
    const route = buildHeuristicRetrievalRoute({
      userMessage: '执行 P2',
      lastAssistantMessage: lastAssistant
    })
    assert.ok(route.taskKinds.includes('usage_question'))
  })
})

describe('multi-turn taskList fallback', () => {
  it('falls back to persisted taskList when lastAssistantMessage has no match', () => {
    // 模拟当前 assistant 回复（不同的P1）
    const currentAssistant = '好的，正在处理...'
    // 持久化的旧 taskList
    const taskList = [
      { id: 'P1', content: '修复内存泄露', status: 'pending' as const, turnCreated: 1, turnUpdated: 1 },
      { id: 'P2', content: '重构 API 客户端', status: 'pending' as const, turnCreated: 1, turnUpdated: 1 },
    ]

    const result = resolveContextualIdentifier('做 P2', currentAssistant, taskList)
    assert.deepEqual(result, [{ identifier: 'P2', resolvedContent: '重构 API 客户端' }])
  })

  it('prefers lastAssistantMessage over taskList when both have matches', () => {
    const currentAssistant = '- P1: 新增用户注册功能'
    const taskList = [
      { id: 'P1', content: '修复旧的内存泄露', status: 'pending' as const, turnCreated: 1, turnUpdated: 1 },
    ]

    const result = resolveContextualIdentifier('做 P1', currentAssistant, taskList)
    // lastAssistantMessage 优先
    assert.deepEqual(result, [{ identifier: 'P1', resolvedContent: '新增用户注册功能' }])
  })

  it('resolves some from message and some from taskList', () => {
    const currentAssistant = '- P1: 新增功能'
    const taskList = [
      { id: 'P1', content: '旧内容', status: 'pending' as const, turnCreated: 1, turnUpdated: 1 },
      { id: 'P2', content: '重构模块', status: 'pending' as const, turnCreated: 1, turnUpdated: 1 },
    ]

    const result = resolveContextualIdentifier('P1 和 P2 都做', currentAssistant, taskList)
    assert.equal(result.length, 2)
    const p1 = result.find(r => r.identifier === 'P1')
    const p2 = result.find(r => r.identifier === 'P2')
    assert.equal(p1!.resolvedContent, '新增功能')  // from message
    assert.equal(p2!.resolvedContent, '重构模块')   // from taskList
  })

  it('returns empty when no match in any source', () => {
    const currentAssistant = '好的，明白了'
    const taskList = [
      { id: 'P3', content: '写文档', status: 'pending' as const, turnCreated: 1, turnUpdated: 1 },
    ]

    const result = resolveContextualIdentifier('做 P1', currentAssistant, taskList)
    assert.deepEqual(result, [])
  })
})
