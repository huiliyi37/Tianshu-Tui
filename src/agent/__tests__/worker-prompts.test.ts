import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReadOnlyWorkOrder, createWriteWorkOrder, WRITE_WORKER_TOOLS } from '../work-order.js'
import { ArtifactStore } from '../../artifact/store.js'
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

  // 天枢 agent 的默认项目约定文件是 .rivet.md / AGENTS.md——worker 的发现引导
  // 不指向其他工具的记忆文件（CLAUDE.md 曾在此处被引用，误导 worker 采信外部记忆）。
  it('project discovery points workers at rivet defaults, not other tools\' memory files', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_disc',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find routing seams.',
      scope: { files: [] },
    })
    const prompt = buildWorkerPrompt(order)
    assert.ok(prompt.includes('.rivet.md or AGENTS.md'), 'discovery preamble cites rivet defaults')
    assert.ok(!prompt.includes('CLAUDE.md'), 'no reference to other agents\' memory files')
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

    assert.ok(prompt.includes('YOUR PREVIOUS ANSWER COULD NOT BE USED'))
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

  // B3（将星点亮）：worker 出战带着账本记忆——authority 有 ledger 时注入 top-3 族。
  describe('general ledger merge (B3)', () => {
    const LEDGER = [
      '# 将星 · 瑶光',
      '',
      '## ledger（战绩账本 · 持续生长）',
      '',
      '### always-true-on-missing-field | recurrenceCount: 4 | lastSeen: 2026-06-07',
      '',
      '**signature**：某字段缺失时比较退化为恒真。',
      '',
      '### false-green | recurrenceCount: 2 | lastSeen: 2026-06-07',
      '',
      '**signature**：测试全绿与真缺陷并存。',
      '',
      '### stringify-eats-structure | recurrenceCount: 1 | lastSeen: 2026-06-07',
      '',
      '### closed-enum-vs-open-set | recurrenceCount: 1 | lastSeen: 2026-06-07',
      '',
    ].join('\n')

    function seededCwd(): string {
      const cwd = mkdtempSync(join(tmpdir(), 'worker-ledger-'))
      mkdirSync(join(cwd, '.rivet/generals'), { recursive: true })
      writeFileSync(join(cwd, '.rivet/generals/yaoguang.md'), LEDGER)
      return cwd
    }

    it('injects top-3 ledger families for an authority with a ledger', () => {
      const cwd = seededCwd()
      const order = createReadOnlyWorkOrder({
        id: 'wo_ledger',
        parentTurnId: 'turn_1',
        kind: 'review',
        profile: 'reviewer',
        objective: 'Review the change.',
        scope: { files: [] },
      })
      order.authority = 'yaoguang'
      const prompt = buildWorkerPrompt(order, undefined, { ledgerCwd: cwd })
      assert.ok(prompt.includes('## 将星战绩'), 'ledger section present')
      assert.ok(prompt.includes('always-true-on-missing-field ×4'), 'top family with count')
      assert.ok(prompt.includes('某字段缺失时比较退化为恒真'), 'signature carried')
      assert.ok(prompt.includes('false-green ×2'))
      // top-3 cap: exactly one of the two ×1 families makes the cut
      const x1Count = ['stringify-eats-structure', 'closed-enum-vs-open-set']
        .filter(f => prompt.includes(f)).length
      assert.equal(x1Count, 1, 'top-3 cap keeps exactly one ×1 family')
      assert.ok(prompt.includes('record_general_finding'), 'points at the write-back tool')
      // 段落位置：权域指令之后（末尾注意力权重）
      assert.ok(prompt.indexOf('## 权域指令') < prompt.indexOf('## 将星战绩'))
    })

    it('no ledger / no authority / no cwd → no section', () => {
      const cwd = seededCwd()
      const noAuthority = createReadOnlyWorkOrder({
        id: 'wo_na', parentTurnId: 't', kind: 'review', profile: 'reviewer',
        objective: 'x', scope: { files: [] },
      })
      assert.ok(!buildWorkerPrompt(noAuthority, undefined, { ledgerCwd: cwd }).includes('## 将星战绩'))

      const noLedger = createReadOnlyWorkOrder({
        id: 'wo_nl', parentTurnId: 't', kind: 'review', profile: 'reviewer',
        objective: 'x', scope: { files: [] },
      })
      noLedger.authority = 'tianquan'
      assert.ok(!buildWorkerPrompt(noLedger, undefined, { ledgerCwd: cwd }).includes('## 将星战绩'))

      const noCwd = createReadOnlyWorkOrder({
        id: 'wo_nc', parentTurnId: 't', kind: 'review', profile: 'reviewer',
        objective: 'x', scope: { files: [] },
      })
      noCwd.authority = 'yaoguang'
      assert.ok(!buildWorkerPrompt(noCwd).includes('## 将星战绩'))
    })
  })

  it('builds a compact primary packet from worker results', async () => {
    const packet = await buildPrimaryWorkerPacket([
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

    assert.ok(packet.includes('<worker_results_hint>'), 'packet must include trust hint')
    assert.ok(packet.includes('<worker_results>'))
    assert.ok(packet.includes('Found the seam.'))
    assert.ok(packet.includes('main constructs AgentLoop'))
    assert.ok(packet.includes('</worker_results>'))
    // Compact JSON — no pretty-print indentation
    assert.ok(!packet.includes('\n  '))
  })

  it('strips empty arrays from packet to reduce size', async () => {
    const packet = await buildPrimaryWorkerPacket([
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

  it('truncates non-diff artifact content to 2000 chars', async () => {
    const longContent = 'x'.repeat(3000)
    const packet = await buildPrimaryWorkerPacket([
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

  it('does not truncate diff artifacts', async () => {
    const diffContent = `diff --git a/src/a.ts b/src/a.ts\n${'+'.repeat(3000)}`
    const packet = await buildPrimaryWorkerPacket([
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

  it('caps total packet size at 32K chars by dropping low-value fields', async () => {
    // Create a result with many fields that would exceed 8K
    const manyFindings = Array.from({ length: 50 }, (_, i) => ({
      claim: `Finding ${i}: ${'detail '.repeat(20)}`,
      evidence: `src/file-${i}.ts`,
      confidence: 'high' as const,
    }))
    const packet = await buildPrimaryWorkerPacket([
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

  it('emits a resolvable artifact reference when over-budget packet is offloaded to the store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-artifact-'))
    const store = new ArtifactStore(dir, 'sess-test')

    // Build an over-budget result so the artifact-handoff path is taken.
    const manyFindings = Array.from({ length: 400 }, (_, i) => ({
      claim: `Finding ${i}: ${'detail '.repeat(40)}`,
      evidence: `src/file-${i}.ts`,
      confidence: 'high' as const,
    }))
    const packet = await buildPrimaryWorkerPacket(
      [
        {
          workOrderId: 'wo_offload',
          status: 'passed',
          summary: 'Offloaded result.',
          findings: manyFindings,
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified',
        },
      ],
      store,
    )

    // Reference must be present...
    const match = packet.match(/\[artifact:([^\]]+)\]/)
    assert.ok(match, `packet should embed an artifact reference: ${packet.slice(0, 200)}`)
    const referencedId = match[1]
    assert.ok(referencedId, 'artifact reference must contain an id')

    // ...and it must resolve in the store (the bug: a fabricated
    // `worker-packet-…` id that save() never produced → read_section null).
    const raw = await store.readRaw(referencedId)
    assert.ok(raw, `referenced artifact id "${referencedId}" must resolve in the store`)
    assert.ok(raw.includes('wo_offload'))
  })

  // ── Truncation transparency tests ──────────────────────────────

  it('marks progressive field drop with _truncated flag so primary agent knows info was lost', async () => {
    // Tuned: full packet > 32K (triggers progressive drop), but after dropping
    // examinedFiles+risks+nextActions+verification → ~25K (under hard truncation).
    const manyFindings = Array.from({ length: 70 }, (_, i) => ({
      claim: `Finding ${i}: ${'detail '.repeat(40)}`,
      evidence: `src/file-${i}.ts`,
      confidence: 'high' as const,
    }))
    const manyExamined = Array.from({ length: 100 }, (_, i) => `src/other-${i}.ts`)
    const manyRisks = Array.from({ length: 50 }, (_, i) => `risk-${i}: ${'word '.repeat(20)}`)

    const packet = await buildPrimaryWorkerPacket([
      {
        workOrderId: 'wo_trunc',
        status: 'passed',
        summary: 'Result with many fields that will be dropped.',
        findings: manyFindings,
        artifacts: [],
        changedFiles: Array.from({ length: 20 }, (_, i) => `src/changed-${i}.ts`),
        examinedFiles: manyExamined,
        risks: manyRisks,
        nextActions: ['action1', 'action2'],
        evidenceStatus: 'verified',
      },
    ])

    // Extract JSON from <worker_results>...</worker_results>
    const jsonMatch = packet.match(/<worker_results>([\s\S]*?)<\/worker_results>/)
    assert.ok(jsonMatch, 'packet must contain <worker_results> tags')
    const parsed = JSON.parse(jsonMatch[1]!)

    // The primary agent must be able to detect that fields were dropped.
    // Without this flag, evidenceStatus:'verified' is misleading when
    // verification metadata was silently removed.
    assert.ok(parsed[0]._truncated === true, 'progressive field drop must set _truncated:true')
    assert.equal(parsed[0].evidenceStatus, 'unverified', 'truncated verified claims must be downgraded')
  })

  it('produces valid JSON when progressive field drop is insufficient and hard truncation fires', async () => {
    // Extreme case: findings so large that even after dropping all non-core
    // fields the JSON still exceeds 32K. The hard truncation must still
    // produce parseable JSON so the primary agent doesn't get a broken packet.
    const hugeFindings = Array.from({ length: 200 }, (_, i) => ({
      claim: `Finding ${i}: ${'detail '.repeat(50)}`,
      evidence: `src/file-${i}.ts:${i}`,
      confidence: 'high' as const,
    }))

    const packet = await buildPrimaryWorkerPacket([
      {
        workOrderId: 'wo_huge',
        status: 'passed',
        summary: 'Massive result that will hit hard truncation.',
        findings: hugeFindings,
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified',
      },
    ])

    const jsonMatch = packet.match(/<worker_results>([\s\S]*?)<\/worker_results>/)
    assert.ok(jsonMatch, 'packet must contain <worker_results> tags')
    // The JSON inside must be parseable — hard truncation must not break
    // the JSON structure by slicing in the middle of a value.
    assert.doesNotThrow(
      () => JSON.parse(jsonMatch[1]!),
      'hard-truncated packet JSON must be parseable',
    )
  })
})
