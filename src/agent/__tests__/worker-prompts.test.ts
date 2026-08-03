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
  buildFinalizationInstruction,
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

    assert.ok(prompt.includes('工单 ID（WorkOrder ID）：wo_1'))
    for (const tool of ['read_file', 'glob', 'grep', 'diff']) {
      assert.ok(prompt.includes(tool), `prompt should list ${tool}`)
    }
    assert.ok(prompt.includes('允许的工具：'))
    assert.ok(prompt.includes('只读 Rivet worker'))
    assert.ok(prompt.includes('只返回一个 JSON 对象'))
    assert.ok(prompt.includes('"workOrderId"'))
    assert.ok(prompt.includes('不要调用禁止的工具'))
  })

  // 廉价模型（LongCat/MiMo 一类）常在 JSON 字符串值里写未转义的裸双引号，
  // 导致整份报告 JSON.parse 失败、只能 salvage 部分字段（见 docs/analysis/
  // 2026-07-17-worker-batch-0-salvage-incident.md）。首次输出路径必须有明文
  // 转义纪律，不能只在 repair 路径补。
  it('includes JSON string-escape discipline in the first-output prompt', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_esc',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find routing seams.',
      scope: { files: ['src/main.tsx'] },
    })
    const prompt = buildWorkerPrompt(order)
    assert.ok(prompt.includes('JSON 字符串纪律'), 'escape discipline heading present')
    assert.ok(prompt.includes('字符串内的双引号转义为'), 'specific escape rule')
    assert.ok(prompt.includes('summary、findings[].claim/evidence 与 artifacts[].content'),
      'discipline names the fields most prone to bare quotes')
  })

  // 发现引导不再叫 worker 去读项目约定文件：文件存在时其内容已经在冻结块的
  // <project-instructions> 里，不存在时条件本身不成立——两种情况下都是死条文。
  // 原有的硬约束（不指向其他工具的记忆文件）在整行删除后自然成立，继续钉住。
  it('project discovery no longer tells workers to read convention files', () => {
    const order = createReadOnlyWorkOrder({
      id: 'wo_disc',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find routing seams.',
      scope: { files: [] },
    })
    const prompt = buildWorkerPrompt(order)
    assert.ok(prompt.includes('## 项目上下文探测'), 'discovery preamble still orients read-only workers')
    assert.ok(!prompt.includes('.rivet.md'), 'convention files travel in <project-instructions>, not as a tool-call instruction')
    assert.ok(!prompt.includes('AGENTS.md'), 'convention files travel in <project-instructions>, not as a tool-call instruction')
    assert.ok(!prompt.includes('CLAUDE.md'), 'no reference to other agents\' memory files')
  })

  // 只读 worker 一个写工具都没有，changedFiles 相关的三条前件不可能成立，
  // 结果卡模板里 changedFiles 也写死成 []。给它们只会占前缀、不产生约束。
  it('gates changedFiles instructions to write-capable workers', () => {
    const readOnly = buildWorkerPrompt(createReadOnlyWorkOrder({
      id: 'wo_ro_gate',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Trace the routing seam.',
      scope: { files: [] },
    }))
    const write = buildWorkerPrompt(createWriteWorkOrder({
      id: 'wo_w_gate',
      parentTurnId: 'turn_1',
      kind: 'patch_proposal',
      objective: 'Fix the evidence gate bypass.',
      scope: { files: ['src/agent/coordinator.ts'] },
    }))

    assert.ok(!readOnly.includes('不要声称改过文件'))
    assert.ok(!readOnly.includes('If you changed files and did not run relevant verification'))
    assert.ok(!readOnly.includes('Use changedFiles ONLY'))
    assert.ok(!readOnly.includes('验证执行与改动文件以系统捕获的工具调用为准'))
    assert.ok(readOnly.includes('不要调用禁止的工具。'), 'the disallowed-tools gate still applies')
    assert.ok(readOnly.includes('用 examinedFiles 列你读/查过的文件。'),
      'examinedFiles guidance is the half that still applies to read-only workers')

    assert.ok(write.includes('不要声称改过文件'))
    assert.ok(write.includes('验证执行与改动文件以系统捕获的工具调用为准'),
      '写工口径：changedFiles/verification 以系统捕获为准，自报仅作交叉校验')
    assert.ok(!write.includes('Use changedFiles ONLY'))
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

    assert.ok(prompt.includes('可写 Rivet worker'))
    assert.ok(!prompt.includes('只读'))
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

    assert.ok(prompt.includes('## 工作目录'))
    assert.ok(prompt.includes('CWD：/tmp/rivet-wt-test'))
    assert.ok(prompt.includes('所有文件操作使用相对路径'))
    assert.ok(prompt.includes('不要使用原仓库的绝对路径'))
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

    assert.ok(prompt.includes('你上一条回答无法使用'))
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

  // B（终轮定型）：报告契约从主提示词移到系统收尾轮。finalized 变体不得
  // 携带 shape/转义段/inline JSON 要求（探索轮只需把活干完）；inline-json
  // 默认不变（hands-session 等旧路径的兼容锚）。
  describe('report contract variants (B：终轮定型)', () => {
    const scoutOrder = () => createReadOnlyWorkOrder({
      id: 'wo_contract',
      parentTurnId: 'turn_1',
      kind: 'code_search',
      profile: 'code_scout',
      objective: 'Find routing seams.',
      scope: { files: ['src/main.tsx'] },
    })

    it('inline-json（默认）保留完整契约：shape + 转义纪律 + JSON 要求', () => {
      for (const prompt of [buildWorkerPrompt(scoutOrder()), buildWorkerPrompt(scoutOrder(), undefined, { reportContract: 'inline-json' })]) {
        assert.ok(prompt.includes('只返回一个 JSON 对象'), 'inline 契约要求自产 JSON')
        assert.ok(prompt.includes('"workOrderId"'), 'inline 契约带结果卡 shape')
        assert.ok(prompt.includes('JSON 字符串纪律'), 'inline 契约带转义纪律')
        assert.ok(!prompt.includes('无需自己输出报告 JSON'), 'inline 不出现收尾说明')
      }
    })

    it('finalized 变体删掉契约段，换成收尾说明', () => {
      const prompt = buildWorkerPrompt(scoutOrder(), undefined, { reportContract: 'finalized' })
      assert.ok(!prompt.includes('只返回一个 JSON 对象'), 'finalized 不要求自产 JSON')
      assert.ok(!prompt.includes('JSON 字符串纪律'), 'finalized 不带转义纪律')
      assert.ok(!prompt.includes('"workOrderId"'), 'finalized 不带结果卡 shape')
      assert.ok(prompt.includes('无需自己输出报告 JSON'), '说明系统会单独索取报告')
      assert.ok(prompt.includes('系统会在收尾时基于完整会话记录单独索取结构化报告'), '说明收尾轮带历史')
      // 执行纪律（绿非证明）不属于报告契约，两种变体都保留
      assert.ok(prompt.includes('绿非证明，复现即证'), '执行纪律保留')
    })

    it('buildFinalizationInstruction 携带完整契约与诚实纪律', () => {
      const instruction = buildFinalizationInstruction(scoutOrder(), false)
      assert.ok(instruction.includes('工单 ID（原样复制）：wo_contract'), '带 order id')
      assert.ok(instruction.includes('"workOrderId"'), '带结果卡 shape')
      assert.ok(instruction.includes('JSON 字符串纪律'), '带转义纪律')
      assert.ok(instruction.includes('只基于上方对话中实际发生的工具调用及其结果'), '只准基于实际工具调用与结果')
      assert.ok(instruction.includes('不得宣称跑过未执行的验证、读过未读的文件'), '不得编造未执行的验证/未读的文件')
      assert.ok(instruction.includes('只输出一个 JSON 对象'), '带输出纪律（含 json 字样，满足 response_format 门）')
    })

    it('buildFinalizationInstruction 按写能力选 shape', () => {
      const writeOrder = createWriteWorkOrder({
        id: 'wo_contract_w',
        parentTurnId: 'turn_1',
        kind: 'patch_proposal',
        objective: 'Patch a file.',
        scope: { files: ['src/a.ts'] },
      })
      const writeInstruction = buildFinalizationInstruction(writeOrder, true)
      assert.ok(writeInstruction.includes('patchSummary'), '写工 shape 带 patchSummary')
      assert.ok(writeInstruction.includes('examinedFiles'), '写工 shape 带 examinedFiles')
      const readInstruction = buildFinalizationInstruction(scoutOrder(), false)
      assert.ok(!readInstruction.includes('patchSummary'), '只读 shape 无 patchSummary')
      assert.ok(readInstruction.includes('必填：列出你读/查过但未修改的全部文件'), '只读 shape 的 examinedFiles 口径')
    })
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

    assert.ok(prompt.includes('## 必需知识包（memory / prompt / recall 类任务）'))
    assert.ok(prompt.includes('.rivet/knowledge/manifest.md'))
    assert.ok(prompt.includes('docs/analysis/2026-06-01-project-memory-architecture-conflict.md'))
    assert.ok(prompt.includes('docs/superpowers/plans/2026-06-01-guided-memory-retrieval.md'))
    assert.ok(prompt.includes('memory.jsonl 是本地结构化缓存'))
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

    assert.ok(!prompt.includes('## 必需知识包（memory / prompt / recall 类任务）'))
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
      // 段落位置：任务卡之后（末尾注意力权重）
      assert.ok(prompt.indexOf('## 任务') < prompt.indexOf('## 将星战绩'))
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

  describe('packet 带上派发目标', () => {
    const withObjective = (over: Record<string, unknown> = {}) => ({
      workOrderId: 'batch:3',
      status: 'passed' as const,
      summary: '改完了',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'unverified' as const,
      ...over,
    })

    it('objective 出现在 packet 里', async () => {
      // 缺了它，主控看到的只是「batch:3 说：改完了」——批量派五个再隔几轮，
      // 模型无从判断交回物是否对得上当初派它去做的事。
      const packet = await buildPrimaryWorkerPacket([
        withObjective({ objective: '把 fleet-registry 的 id 复用改成另起一条记录' }),
      ])
      assert.ok(packet.includes('把 fleet-registry 的 id 复用改成另起一条记录'), 'packet 必须带上派发目标')
    })

    it('objective 排在 summary 之前', async () => {
      const packet = await buildPrimaryWorkerPacket([
        withObjective({ objective: 'OBJECTIVE_MARKER' }),
      ])
      const at = packet.indexOf('OBJECTIVE_MARKER')
      assert.ok(at >= 0, 'objective 必须在 packet 里')
      assert.ok(at < packet.indexOf('改完了'), '先看见目标再看见交付')
    })

    it('过长的 objective 被截断，不挤占 packet 预算', async () => {
      const long = 'x'.repeat(600)
      const packet = await buildPrimaryWorkerPacket([withObjective({ objective: long })])
      assert.ok(!packet.includes(long), '不能原样带进 packet')
      assert.ok(packet.includes(`${'x'.repeat(300)}…`), '截断到 300 字并留省略号')
    })

    it('没有 objective 的结果不留空字段', async () => {
      const packet = await buildPrimaryWorkerPacket([withObjective()])
      assert.ok(!packet.includes('"objective"'), '缺省时应被 stripEmpty 剥掉')
    })
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

  it('字段裁剪时保住续跑指引——它是主控知道「这活能接着干」的唯一线索', async () => {
    // packet 超预算恰恰发生在派了一批 worker 的时候，也正是最需要续跑的场景。
    // 整字段删 nextActions 会把 captureAbortCheckpoint 写入的那条 Resumable
    // 一起删掉，被截断的 salvage 摘要就此被当成交付（7-24 假摘要事故的形状）。
    const resumeHint = "Resumable: re-dispatch with delegate_task/delegate_batch resume:'wo_cut' — the worker's partial progress (12 tool calls, 4096 chars) is checkpointed and will be injected as context."
    const manyFindings = Array.from({ length: 70 }, (_, i) => ({
      claim: `Finding ${i}: ${'detail '.repeat(40)}`,
      evidence: `src/file-${i}.ts`,
      confidence: 'high' as const,
    }))

    const packet = await buildPrimaryWorkerPacket([
      {
        workOrderId: 'wo_cut',
        status: 'blocked',
        summary: 'Cut off by the turn budget mid-scan.',
        findings: manyFindings,
        artifacts: [],
        changedFiles: [],
        examinedFiles: Array.from({ length: 100 }, (_, i) => `src/other-${i}.ts`),
        risks: Array.from({ length: 50 }, (_, i) => `risk-${i}: ${'word '.repeat(20)}`),
        nextActions: ['narrow the scope next time', resumeHint, 'or split into two orders'],
        evidenceStatus: 'unverified',
        failureReason: 'max_turns',
      },
    ])

    const jsonMatch = packet.match(/<worker_results>([\s\S]*?)<\/worker_results>/)
    assert.ok(jsonMatch, 'packet must contain <worker_results> tags')
    const parsed = JSON.parse(jsonMatch[1]!)

    assert.equal(parsed[0]._truncated, true, '前提：这个用例确实触发了字段裁剪')
    assert.deepEqual(parsed[0].nextActions, [resumeHint], '只保留续跑指引，其余 nextActions 照删')
    assert.equal(parsed[0].failureReason, 'max_turns', 'failureReason 不参与裁剪')
  })

  it('没有续跑指引时 nextActions 仍整字段删掉', async () => {
    const manyFindings = Array.from({ length: 70 }, (_, i) => ({
      claim: `Finding ${i}: ${'detail '.repeat(40)}`,
      evidence: `src/file-${i}.ts`,
      confidence: 'high' as const,
    }))

    const packet = await buildPrimaryWorkerPacket([
      {
        workOrderId: 'wo_plain',
        status: 'passed',
        summary: 'Finished, no checkpoint involved.',
        findings: manyFindings,
        artifacts: [],
        changedFiles: [],
        examinedFiles: Array.from({ length: 100 }, (_, i) => `src/other-${i}.ts`),
        risks: Array.from({ length: 50 }, (_, i) => `risk-${i}: ${'word '.repeat(20)}`),
        nextActions: ['ship it', 'tell the user'],
        evidenceStatus: 'verified',
      },
    ])

    const jsonMatch = packet.match(/<worker_results>([\s\S]*?)<\/worker_results>/)
    const parsed = JSON.parse(jsonMatch![1]!)
    assert.equal(parsed[0]._truncated, true, '前提：这个用例确实触发了字段裁剪')
    assert.equal('nextActions' in parsed[0], false, '普通 nextActions 不该被保留，避免白占预算')
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

  describe('派发未完成的告知（Wave 9）', () => {
    function result(over: Partial<import('../work-order.js').WorkerResult>): import('../work-order.js').WorkerResult {
      return {
        workOrderId: 'wo',
        status: 'passed',
        summary: 'done',
        findings: [],
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: [],
        evidenceStatus: 'unverified',
        ...over,
      }
    }

    it('有 worker 没完成时，hint 顶部单列一段，并把 failureReason 翻成可操作的下一步', async () => {
      const packet = await buildPrimaryWorkerPacket([
        result({ workOrderId: 'wo_ok', status: 'passed', summary: '查到了' }),
        result({ workOrderId: 'wo_cut', status: 'blocked', summary: '干到一半', failureReason: 'max_turns' }),
      ])
      assert.ok(packet.includes('<worker_dispatch_incomplete>'), '未完成时必须显式告知')
      assert.ok(packet.includes('1/2'), '说清有几个没完成')
      assert.ok(packet.includes('wo_cut'), '点名是哪个 worker')
      assert.ok(packet.includes('maxTurns'), 'max_turns 要给出可操作的下一步')
      assert.ok(
        packet.indexOf('<worker_dispatch_incomplete>') < packet.indexOf('<worker_results>'),
        '告知在结果之前——主控最先读到的应当是「这次没干完」',
      )
    })

    it('全部通过时不加噪音', async () => {
      const packet = await buildPrimaryWorkerPacket([result({ workOrderId: 'wo_ok' })])
      assert.ok(!packet.includes('worker_dispatch_incomplete'))
    })

    it('可续跑的失败额外给出 resume 指引', async () => {
      const packet = await buildPrimaryWorkerPacket([
        result({ workOrderId: 'wo_cut', status: 'blocked', failureReason: 'timeout', nextActions: ['Resumable: 断点已存'] }),
      ])
      assert.ok(packet.includes('resume:'), '带断点的失败要告诉主控怎么接着干')
    })

    it('失败结果在 packet 里置顶——裁剪从尾部丢，置顶让它活到最后', async () => {
      const packet = await buildPrimaryWorkerPacket([
        result({ workOrderId: 'wo_ok_1', status: 'passed' }),
        result({ workOrderId: 'wo_cut', status: 'blocked', failureReason: 'worker_crash' }),
        result({ workOrderId: 'wo_ok_2', status: 'passed' }),
      ])
      const body = packet.match(/<worker_results>([\s\S]*?)<\/worker_results>/)![1]!
      const parsed = JSON.parse(body) as Array<{ workOrderId: string }>
      assert.equal(parsed[0]!.workOrderId, 'wo_cut')
      assert.deepEqual(parsed.map(r => r.workOrderId), ['wo_cut', 'wo_ok_1', 'wo_ok_2'], '通过的结果之间保持原有顺序')
    })
  })
})
