/**
 * T10 A2: worker liveness signal (onActivity).
 *
 * Worker 内部心跳曾 fire 进虚空——父 coordinator 无法区分「深读中」与
 * 「卡死」。onActivity 把每个 delta/tool 事件上行，喂 A4 的 stall clock。
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runWorkerSession } from '../worker-session.js'
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

describe('worker activity signal', () => {
  it('fires onActivity for each text delta', async () => {
    const kinds: string[] = []
    const client = makeFaultClient([{ kind: 'ok', text: VALID_RESULT_JSON }])
    const run = await runWorkerSession(makeWorkerConfig({
      client,
      onActivity: (kind) => kinds.push(kind),
    }))
    assert.equal(run.result.status, 'passed')
    assert.ok(kinds.includes('text'), `text delta must signal activity, got [${kinds.join(',')}]`)
    assert.ok(kinds.length > 0, 'at least one activity signal emitted')
  })

  it('omitting onActivity is safe (backwards compatible)', async () => {
    const client = makeFaultClient([{ kind: 'ok', text: VALID_RESULT_JSON }])
    const run = await runWorkerSession(makeWorkerConfig({ client }))
    assert.equal(run.result.status, 'passed')
  })
})
