import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyFailure, isTransient } from '../failure-classifier.js'
import { makeFaultClient } from './helpers/fault-client.js'
import { makeWorkerConfig } from './helpers/worker-fixture.js'
import type { StreamClient } from '../../api/stream-client.js'
import type { StreamCallbacks } from '../../api/stream-client.js'
import type { OaiChatRequest } from '../../api/oai-types.js'

const VALID_RESULT_JSON = JSON.stringify({
  workOrderId: 'wo1',
  status: 'passed',
  summary: 'traced auth flow',
  findings: [],
  artifacts: [],
  changedFiles: [],
  risks: [],
  nextActions: [],
  evidenceStatus: 'verified',
})

describe('worker fault injection — high availability', () => {

  // ── Layer 1: Fault classification (drives runOnceWithTransientRetry retry decisions) ──

  describe('fault classification — ECONNRESET / 429 / idle-stall', () => {
    it('ECONNRESET classifies as timeout + retryable', () => {
      const c = classifyFailure('ECONNRESET socket hang up')
      assert.equal(c.retryable, true)
      assert.ok(
        isTransient(c.class),
        `ECONNRESET must be transient, got ${c.class}`,
      )
    })

    it('429 Too Many Requests classifies as api_error + retryable', () => {
      const c = classifyFailure('HTTP 429 Too Many Requests')
      assert.equal(c.retryable, true)
      assert.equal(c.class, 'api_error')
      assert.ok(isTransient(c.class), '429 must be transient')
    })

    it('ETIMEDOUT classifies as timeout + retryable', () => {
      const c = classifyFailure('ETIMEDOUT connection timed out')
      assert.equal(c.retryable, true)
      assert.ok(isTransient(c.class), 'ETIMEDOUT must be transient')
    })

    it('non-transient error (type error) is NOT retryable', () => {
      const c = classifyFailure("Type 'string' is not assignable to type 'number'")
      assert.equal(c.retryable, false)
      assert.ok(!isTransient(c.class), 'type_error must NOT be transient')
    })

    it('context window exceeded is NOT retryable', () => {
      const c = classifyFailure('context length exceeded')
      assert.equal(c.retryable, false)
    })
  })

  // ── Layer 2: Fault client infrastructure (reusable for future A2/A4 tests) ──

  describe('fault client — scripted behavior', () => {
    it('throws ECONNRESET on the first scripted fault', async () => {
      const client = makeFaultClient([{ kind: 'econnreset' }])
      const callbacks: StreamCallbacks = {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: () => {},
      }
      await assert.rejects(
        client.stream({} as OaiChatRequest, callbacks),
        /ECONNRESET/,
      )
    })

    it('throws 429 on rate_limit fault', async () => {
      let rateLimitCalled = false
      const client = makeFaultClient([{ kind: 'rate_limit' }])
      const callbacks: StreamCallbacks = {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: () => {},
        onRateLimit: () => { rateLimitCalled = true },
      }
      await assert.rejects(
        client.stream({} as OaiChatRequest, callbacks),
        /429/,
      )
      assert.equal(rateLimitCalled, true, 'onRateLimit must fire before throw')
    })

    it('emits text + stop on ok fault', async () => {
      const deltas: string[] = []
      let stopReason: string | null = null
      const client = makeFaultClient([{ kind: 'ok', text: 'hello' }])
      const callbacks: StreamCallbacks = {
        onTextDelta: (t) => deltas.push(t),
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: (r) => { stopReason = r },
        onError: () => {},
      }
      await client.stream({} as OaiChatRequest, callbacks)
      assert.deepEqual(deltas, ['hello'])
      assert.equal(stopReason, 'stop')
    })

    it('idle_stall never resolves until signal aborts', async () => {
      const controller = new AbortController()
      const client = makeFaultClient([{ kind: 'idle_stall' }])
      const callbacks: StreamCallbacks = {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: () => {},
      }
      // Without abort, this hangs. With abort, it rejects.
      setTimeout(() => controller.abort(), 50)
      await assert.rejects(
        client.stream({} as OaiChatRequest, callbacks, controller.signal),
        /aborted/,
      )
    })

    it('consumes faults sequentially across calls (retry simulation)', async () => {
      const client = makeFaultClient([
        { kind: 'econnreset' },
        { kind: 'ok', text: VALID_RESULT_JSON },
      ])
      const makeCb = (): StreamCallbacks => ({
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: () => {},
      })
      // First call: throws
      await assert.rejects(
        client.stream({} as OaiChatRequest, makeCb()),
        /ECONNRESET/,
      )
      // Second call: succeeds
      const deltas: string[] = []
      const cb2 = makeCb()
      cb2.onTextDelta = (t) => deltas.push(t)
      await client.stream({} as OaiChatRequest, cb2)
      assert.deepEqual(deltas, [VALID_RESULT_JSON])
    })
  })

  // ── Layer 3: Worker fixture (infrastructure for future integration tests) ──

  describe('worker fixture — constructs valid config', () => {
    it('builds a WorkerSessionConfig with all required fields', () => {
      const config = makeWorkerConfig({})
      assert.ok(config.order, 'must have a work order')
      assert.ok(config.client, 'must have a client')
      assert.ok(config.promptEngine, 'must have a prompt engine')
      assert.ok(config.toolRegistry, 'must have a tool registry')
      assert.ok(config.order.budget.timeoutMs > 0, 'must have positive timeout budget')
    })

    it('accepts client override (fault injection)', () => {
      const faultClient = makeFaultClient([{ kind: 'ok', text: '{}' }])
      const config = makeWorkerConfig({ client: faultClient })
      assert.equal(config.client, faultClient)
    })
  })
})
