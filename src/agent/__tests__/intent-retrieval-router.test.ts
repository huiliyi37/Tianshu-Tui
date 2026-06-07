import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { StreamClient, StreamCallbacks } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import { extractTaskContract } from '../../context/task-contract.js'
import {
  buildIntentRouterPrompt,
  classifyIntentRetrievalRoute,
  DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG,
  normalizeIntentRetrievalRouterConfig,
} from '../intent-retrieval-router.js'

function input(message: string) {
  return { userMessage: message, taskContract: extractTaskContract(message, 1) }
}

function mockClient(handler: (request: OaiChatRequest, callbacks: StreamCallbacks, signal?: AbortSignal) => Promise<void> | void): StreamClient & { calls: number } {
  return {
    calls: 0,
    async stream(request, callbacks, signal) {
      this.calls++
      await handler(request, callbacks, signal)
    },
  }
}

describe('intent retrieval router config', () => {
  it('normalizes boolean and partial config inputs', () => {
    assert.equal(normalizeIntentRetrievalRouterConfig(undefined).enabled, false)
    assert.equal(normalizeIntentRetrievalRouterConfig(false).enabled, false)
    assert.equal(normalizeIntentRetrievalRouterConfig(true).enabled, true)

    const cfg = normalizeIntentRetrievalRouterConfig({ enabled: true, classifier: 'heuristic', timeoutMs: 10 })
    assert.equal(cfg.enabled, true)
    assert.equal(cfg.classifier, 'heuristic')
    assert.equal(cfg.timeoutMs, 10)
    assert.equal(cfg.maxTokens, DEFAULT_INTENT_RETRIEVAL_ROUTER_CONFIG.maxTokens)
  })
})

describe('intent retrieval router prompt', () => {
  it('forbids answering the task and asks for JSON route only', () => {
    const prompt = buildIntentRouterPrompt(input('修复这个失败'))

    assert.match(prompt, /只输出 JSON/)
    assert.match(prompt, /不要回答用户任务/)
    assert.match(prompt, /用户关键词是线索不是边界/)
    assert.doesNotMatch(prompt, /undefined/)
  })
})

describe('classifyIntentRetrievalRoute', () => {
  it('returns null when disabled and does not call the model', async () => {
    const client = mockClient(() => { throw new Error('should not call') })

    const route = await classifyIntentRetrievalRoute({
      ...input('修复这个失败'),
      config: { enabled: false },
      client,
      model: 'test-model',
    })

    assert.equal(route, null)
    assert.equal(client.calls, 0)
  })

  it('uses heuristic mode without calling the model', async () => {
    const client = mockClient(() => { throw new Error('should not call') })

    const route = await classifyIntentRetrievalRoute({
      ...input('这个接口很慢'),
      config: { enabled: true, classifier: 'heuristic' },
      client,
      model: 'test-model',
    })

    assert.ok(route)
    assert.ok(route.taskKinds.includes('performance_diagnosis'))
    assert.equal(route.fallbackUsed, true)
    assert.equal(client.calls, 0)
  })

  it('parses valid LLM JSON, normalizes it, and avoids text block duplication', async () => {
    const client = mockClient((request, callbacks) => {
      assert.equal(request.tool_choice, 'none')
      assert.equal(request.stream, true)
      assert.equal(request.max_tokens, 123)
      assert.equal(request.temperature, 0)
      callbacks.onTextDelta('```json\n{"taskKinds":["review_audit"],"directions":[{"source":"codebase","priority":"must","query":"inspect","reason":"review"}],"confidence":0.9}\n```')
      callbacks.onContentBlock({ type: 'text', text: '{"duplicated":true}' })
    })

    const route = await classifyIntentRetrievalRoute({
      ...input('审查 P0 风险'),
      config: { enabled: true, classifier: 'llm', maxTokens: 123 },
      client,
      model: 'test-model',
    })

    assert.ok(route)
    assert.equal(route.fallbackUsed, false)
    assert.ok(route.taskKinds.includes('review_audit'))
    assert.ok(route.directions.some(direction => direction.source === 'tests'))
    assert.ok(route.directions.some(direction => direction.source === 'git'))
    assert.equal(client.calls, 1)
    // 风险2：确认 onContentBlock 的 text 没有参与最终 route（防止 Anthropic 适配层重复拼接）
    assert.ok(!route.directions.some(direction => direction.query.includes('duplicated')))
    assert.ok(!route.directions.some(direction => direction.reason.includes('duplicated')))
  })

  it('falls back to heuristic on invalid JSON', async () => {
    const client = mockClient((_, callbacks) => {
      callbacks.onTextDelta('not json')
    })

    const route = await classifyIntentRetrievalRoute({
      ...input('重试一下这个失败'),
      config: { enabled: true, classifier: 'llm' },
      client,
      model: 'test-model',
    })

    assert.ok(route)
    assert.equal(route.fallbackUsed, true)
    assert.ok(route.taskKinds.includes('bug_fix'))
  })

  it('falls back to heuristic when model throws', async () => {
    const client = mockClient(() => { throw new Error('model down') })

    const route = await classifyIntentRetrievalRoute({
      ...input('token 泄露风险'),
      config: { enabled: true, classifier: 'llm' },
      client,
      model: 'test-model',
    })

    assert.ok(route)
    assert.equal(route.fallbackUsed, true)
    assert.ok(route.taskKinds.includes('security_safety'))
  })

  it('falls back to heuristic on timeout/abort', async () => {
    const client = mockClient((_, __, signal) => new Promise<void>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))

    const route = await classifyIntentRetrievalRoute({
      ...input('这个接口延迟很高'),
      config: { enabled: true, classifier: 'llm', timeoutMs: 1 },
      client,
      model: 'test-model',
    })

    assert.ok(route)
    assert.equal(route.fallbackUsed, true)
    assert.ok(route.taskKinds.includes('performance_diagnosis'))
  })
})
