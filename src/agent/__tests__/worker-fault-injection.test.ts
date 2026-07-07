/**
 * T10 A5: 断连/卡死 fault-injection —— 测真实 worker 路径。
 *
 * 修订前的版本只自测了 helper（classifyFailure / fault-client / fixture），
 * 生产 retry/abort 逻辑零覆盖。本版直接跑 `runOnceWithTransientRetry`
 * （注入 mock agent）与 `runWorkerSession`（fault client 全链路），证明：
 * - 瞬态错误（ECONNRESET/429）真的触发 retry → 恢复
 * - retry 耗尽 / 非瞬态错误确定性终止，绝不挂死
 * - idle-stall 被父 abort 收割后落 blocked，而非永久 pending
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  runWorkerSession,
  runOnceWithTransientRetry,
  type RunnableAgent,
  type WorkerTranscript,
} from '../worker-session.js'
import { makeFaultClient } from './helpers/fault-client.js'
import { makeWorkerConfig } from './helpers/worker-fixture.js'

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

function emptyTranscript(): WorkerTranscript {
  return { text: '', thinking: '', toolUses: [], toolResults: [], errors: [], repairAttempts: 0 }
}

/** Mock agent whose run() behavior is scripted per attempt — exercises the
 *  REAL runOnceWithTransientRetry without constructing an AgentLoop. */
function makeScriptedAgent(script: Array<{ error?: string; text?: string }>): { agent: RunnableAgent; attempts: () => number } {
  let i = 0
  const agent: RunnableAgent = {
    run: async (_prompt, callbacks) => {
      const step = script[Math.min(i++, script.length - 1)]
      if (!step) throw new Error('scripted agent: empty script')
      if (step.error) {
        // AgentLoop reports stream errors via onError and resolves — mirror that.
        callbacks.onError(new Error(step.error))
        return
      }
      callbacks.onTextDelta(step.text ?? '')
    },
  }
  return { agent, attempts: () => i }
}

describe('worker fault injection — high availability', () => {
  describe('runOnceWithTransientRetry (real retry layer, injected agent)', () => {
    it('retries a transient ECONNRESET and recovers', async () => {
      const { agent, attempts } = makeScriptedAgent([
        { error: 'ECONNRESET socket hang up' },
        { text: VALID_RESULT_JSON },
      ])
      const transcript = emptyTranscript()
      const text = await runOnceWithTransientRetry(agent, 'go', transcript)
      assert.equal(text, VALID_RESULT_JSON, 'second attempt must return the text')
      assert.equal(attempts(), 2, 'exactly one retry')
      assert.ok(
        transcript.errors.some(e => /Transient error.*ECONNRESET.*retrying/.test(e)),
        `retry must be logged, got: ${JSON.stringify(transcript.errors)}`,
      )
    })

    it('exhausted transient retries reject deterministically (no hang)', async () => {
      const { agent, attempts } = makeScriptedAgent([{ error: 'ECONNRESET socket hang up' }])
      await assert.rejects(
        runOnceWithTransientRetry(agent, 'go', emptyTranscript()),
        /ECONNRESET/,
      )
      assert.equal(attempts(), 3, 'initial attempt + MAX_TRANSIENT_RETRIES(2)')
    })

    it('429 rate limit is transient and retried', async () => {
      const { agent, attempts } = makeScriptedAgent([
        { error: 'HTTP 429 Too Many Requests' },
        { text: 'ok' },
      ])
      const text = await runOnceWithTransientRetry(agent, 'go', emptyTranscript())
      assert.equal(text, 'ok')
      assert.equal(attempts(), 2)
    })

    it('non-transient errors are NOT retried — fail fast', async () => {
      const { agent, attempts } = makeScriptedAgent([
        { error: "Type 'string' is not assignable to type 'number'" },
      ])
      await assert.rejects(runOnceWithTransientRetry(agent, 'go', emptyTranscript()))
      assert.equal(attempts(), 1, 'no retry for non-transient failures')
    })
  })

  describe('runWorkerSession (full path, fault client)', () => {
    it('transient ECONNRESET is retried, then a valid result resolves', async () => {
      const client = makeFaultClient([
        { kind: 'econnreset' },
        { kind: 'ok', text: VALID_RESULT_JSON },
      ])
      const run = await runWorkerSession(makeWorkerConfig({ client }))
      assert.equal(run.result.status, 'passed', 'should recover after one transient failure')
      assert.ok(
        run.transcript.errors.some(e => /Transient|ECONNRESET/.test(e)),
        'retry must be logged in the transcript',
      )
    })

    it('idle-stall stream is aborted by parent signal — resolves blocked, never hangs', async () => {
      const controller = new AbortController()
      const client = makeFaultClient([{ kind: 'idle_stall' }])
      const p = runWorkerSession(makeWorkerConfig({ client, abortSignal: controller.signal }))
      setTimeout(() => controller.abort(), 50)
      const run = await p
      assert.equal(run.result.status, 'blocked', 'aborted stall must resolve as blocked, not pend forever')
    })

    it('worker budget timer aborts a wedged stream — resolves blocked', async () => {
      const client = makeFaultClient([{ kind: 'idle_stall' }])
      const config = makeWorkerConfig({ client })
      config.order.budget.timeoutMs = 200
      const run = await runWorkerSession(config)
      assert.equal(run.result.status, 'blocked', 'budget abort must surface as blocked')
    })
  })
})
