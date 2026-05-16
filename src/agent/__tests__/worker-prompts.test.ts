import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createReadOnlyWorkOrder } from '../work-order.js'
import {
  buildPrimaryWorkerPacket,
  buildWorkerPrompt,
  buildWorkerRepairPrompt,
} from '../worker-prompts.js'

describe('worker prompts', () => {
  it('builds a worker prompt that requires WorkerResult JSON', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find routing seams.',
      scope: { files: ['src/main.tsx'] },
    })

    const prompt = buildWorkerPrompt(order)

    assert.ok(prompt.includes('WorkOrder ID: wo_1'))
    assert.ok(prompt.includes('Allowed tools: read_file, glob, grep, diff'))
    assert.ok(prompt.includes('Return exactly one JSON object'))
    assert.ok(prompt.includes('"workOrderId"'))
    assert.ok(prompt.includes('Do not call disallowed tools'))
  })

  it('builds a repair prompt with the parse error but not a new objective', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_1',
      parentTurnId: 'turn_1',
      kind: 'review',
      profile: 'reviewer',
      objective: 'Review risk.',
      scope: {},
    })

    const prompt = buildWorkerRepairPrompt(order, 'not json', 'Unexpected token')

    assert.ok(prompt.includes('Repair the previous answer'))
    assert.ok(prompt.includes('Unexpected token'))
    assert.ok(prompt.includes('workOrderId'))
    assert.ok(prompt.includes('wo_1'))
  })

  it('builds a compact primary packet from worker results', () => {
    const packet = buildPrimaryWorkerPacket([
      {
        workOrderId: 'wo_1',
        status: 'passed',
        summary: 'Found the seam.',
        findings: [{ claim: 'main constructs AgentLoop', evidence: 'src/main.tsx', confidence: 'high' }],
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: ['Wire coordinator near main'],
        evidenceStatus: 'verified',
      },
    ])

    assert.ok(packet.includes('<worker_results>'))
    assert.ok(packet.includes('Found the seam.'))
    assert.ok(packet.includes('main constructs AgentLoop'))
    assert.ok(packet.includes('</worker_results>'))
  })
})
