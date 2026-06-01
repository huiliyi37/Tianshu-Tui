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
    for (const tool of ['read_file', 'glob', 'grep', 'diff']) {
      assert.ok(prompt.includes(tool), `prompt should list ${tool}`)
    }
    assert.ok(prompt.includes('Allowed tools:'))
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

  it('includes workerCwd guidance for write work orders in isolated worktrees', () => {
    const order = createWriteWorkOrder({
      id: 'wo_cwd',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'Patch a worker file.',
      scope: { files: ['src/agent/foo.ts'] },
    })
    order.workerCwd = '/tmp/rivet-wt-test'

    const prompt = buildWorkerPrompt(order)

    assert.ok(prompt.includes('## Working Directory'))
    assert.ok(prompt.includes('CWD: /tmp/rivet-wt-test'))
    assert.ok(prompt.includes('Use RELATIVE paths'))
    assert.ok(prompt.includes('Do NOT use absolute paths'))
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

  it('injects a memory knowledge packet for memory, prompt, and recall work orders', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_memory',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Review project memory recall behavior.',
      scope: { files: ['src/tools/recall.ts'] },
    })

    const prompt = buildWorkerPrompt(order)

    assert.ok(prompt.includes('## Required Knowledge Packet: memory / prompt / recall'))
    assert.ok(prompt.includes('.rivet/knowledge/manifest.md'))
    assert.ok(prompt.includes('docs/analysis/2026-06-01-project-memory-architecture-conflict.md'))
    assert.ok(prompt.includes('docs/superpowers/plans/2026-06-01-guided-memory-retrieval.md'))
    assert.ok(prompt.includes('memory.jsonl is local structured cache'))
  })

  it('does not inject the memory knowledge packet for unrelated work orders', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_tui',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find TUI rendering seams.',
      scope: { files: ['src/tui/app.tsx'] },
    })

    const prompt = buildWorkerPrompt(order)

    assert.ok(!prompt.includes('## Required Knowledge Packet: memory / prompt / recall'))
    assert.ok(!prompt.includes('2026-06-01-project-memory-architecture-conflict.md'))
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
    // Compact JSON — no pretty-print indentation
    assert.ok(!packet.includes('\n  '))
  })

  it('strips empty arrays from packet to reduce size', () => {
    const packet = buildPrimaryWorkerPacket([
      {
        workOrderId: 'wo_2',
        status: 'passed',
        summary: 'Done.',
        findings: [],
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified',
      },
    ])

    // Empty arrays should be stripped
    assert.ok(!packet.includes('"findings"'))
    assert.ok(!packet.includes('"risks"'))
    assert.ok(!packet.includes('"artifacts"'))
    assert.ok(packet.includes('"workOrderId"'))
    assert.ok(packet.includes('"summary"'))
  })

  it('truncates non-diff artifact content to 2000 chars', () => {
    const longContent = 'x'.repeat(3000)
    const packet = buildPrimaryWorkerPacket([
      {
        workOrderId: 'wo_3',
        status: 'passed',
        summary: 'Has artifact.',
        findings: [],
        artifacts: [{ kind: 'note', title: 'test', content: longContent }],
        changedFiles: [],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified',
      },
    ])

    // Artifact content should be truncated
    assert.ok(packet.length < 4000)
    assert.ok(packet.includes('…'))
    assert.ok(!packet.includes('x'.repeat(3000)))
  })

  it('does not truncate diff artifacts', () => {
    const diffContent = `diff --git a/src/a.ts b/src/a.ts\n${'+'.repeat(3000)}`
    const packet = buildPrimaryWorkerPacket([
      {
        workOrderId: 'wo_diff',
        status: 'passed',
        summary: 'Has diff.',
        findings: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: diffContent }],
        changedFiles: ['src/a.ts'],
        risks: [],
        nextActions: [],
        evidenceStatus: 'unverified',
      },
    ])

    assert.ok(packet.includes('+'.repeat(3000)), 'diff content should not be truncated')
    assert.ok(!packet.includes('…'))
  })

  it('caps total packet size at 32K chars by dropping low-value fields', () => {
    // Create a result with many fields that would exceed 8K
    const manyFindings = Array.from({ length: 50 }, (_, i) => ({
      claim: `Finding ${i}: ${'detail '.repeat(20)}`,
      evidence: `src/file-${i}.ts`,
      confidence: 'high' as const,
    }))
    const packet = buildPrimaryWorkerPacket([
      {
        workOrderId: 'wo_big',
        status: 'passed',
        summary: 'Big result.',
        findings: manyFindings,
        artifacts: [],
        changedFiles: Array.from({ length: 30 }, (_, i) => `src/file-${i}.ts`),
        examinedFiles: Array.from({ length: 30 }, (_, i) => `src/other-${i}.ts`),
        risks: ['risk1', 'risk2'],
        nextActions: Array.from({ length: 20 }, (_, i) => `action ${i}`),
        evidenceStatus: 'verified',
      },
    ])

    // Packet should be capped at ~32K
    assert.ok(packet.length <= 32200, `packet too large: ${packet.length}`)
    // Core fields should survive
    assert.ok(packet.includes('wo_big'))
    assert.ok(packet.includes('Big result.'))
  })
})
