import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createReadOnlyWorkOrder, createWriteWorkOrder, WRITE_WORKER_TOOLS } from '../work-order.js'
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
    assert.ok(prompt.includes('read-only Rivet worker'))
    assert.ok(prompt.includes('Return exactly one JSON object'))
    assert.ok(prompt.includes('"workOrderId"'))
    assert.ok(prompt.includes('Do not call disallowed tools'))
  })

  it('builds a write-capable worker prompt for write work orders', () => {
    const order = createWriteWorkOrder({
      id: 'wo_write1',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'Fix the evidence gate bypass.',
      scope: { files: ['src/agent/coordinator.ts'] },
    })

    const prompt = buildWorkerPrompt(order)

    assert.ok(prompt.includes('write-capable Rivet worker'))
    assert.ok(!prompt.includes('read-only'))
    for (const tool of WRITE_WORKER_TOOLS) {
      assert.ok(prompt.includes(tool), `prompt should list ${tool}`)
    }
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

  it('includes evidence fields in worker prompt contract', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_evidence',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find routing seams.',
      scope: { files: ['src/main.tsx'] },
    })

    const prompt = buildWorkerPrompt(order)

    assert.ok(prompt.includes('changedFiles'))
    assert.ok(prompt.includes('evidenceStatus'))
    assert.ok(prompt.includes('unverified'))
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
