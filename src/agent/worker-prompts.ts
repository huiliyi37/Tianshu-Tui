import { type WorkOrder, type WorkerResult, type WorkerProfile } from './work-order.js'

/** Tools that mutate the workspace. A worker is "write-capable" iff its allowlist
 *  contains at least one of these — NOT merely "any tool beyond the read-only
 *  baseline". The previous check keyed on READ_ONLY_WORKER_TOOLS, which had
 *  diverged from profile-registry's actual read-only set (file_info /
 *  semantic_search / web_search / web_fetch are read-only but absent from
 *  READ_ONLY_WORKER_TOOLS), misclassifying pure read-only workers as write-capable. */
const WRITE_CAPABLE_TOOLS: ReadonlySet<string> = new Set([
  'edit_file', 'write_file', 'hash_edit', 'apply_patch', 'bash', 'run_tests', 'git',
])
import { buildMemoryKnowledgePacket, needsMemoryKnowledgePacket } from './worker-knowledge-packet.js'
import { profileRegistry } from './profile-registry.js'
import { starDomainRegistry } from './star-domain-registry.js'
import { topGeneralFamilies } from './general-ledger.js'
import type { ArtifactStore } from '../artifact/store.js'

// ─── Profile-specific expertise prompts ────────────────────────────
// Each profile gets targeted guidance on HOW to do its job,
// inspired by the everything-claude-code agent collection.

const PROFILE_PROMPTS: Record<WorkerProfile, string> = {
  code_scout: `## Code Scout Methodology

You are an expert code explorer. Follow this search strategy:

1. **Locate**: Use grep to find key symbols, function names, class definitions.
   Prefer literal patterns over broad regex. Start narrow, broaden only if needed.
2. **Read**: Use read_file (with offset/limit for large files) to inspect implementations.
   Focus on the specific area relevant to the objective — do NOT read entire large files.
3. **Trace dependencies**: Use repo_graph to find callers, imports, and dependents.
   This reveals blast radius and integration points.
4. **Verify scope**: Use glob to confirm file locations and discover related files.

Evidence quality checklist:
- Every finding must cite a specific file:line reference
- Report what you actually observed, not what you assume
- If a search returns no results, report that explicitly — absence is evidence too
- Distinguish "file does not exist" from "pattern not found in existing file"`,

  doc_scout: `## Documentation Scout Methodology

You are an expert at finding and analyzing documentation, specs, and plans.

1. **Find docs**: Use glob to locate *.md, docs/, *.txt, DESIGN*, PLAN* files.
   Check for .rivet/, .rivet.md, AGENTS.md, README.md at project root.
2. **Read selectively**: Use read_file with offset/limit for large documents.
   Focus on sections relevant to the objective.
3. **Extract structure**: Identify headings, sections, and key decisions.
4. **Cross-reference**: Verify if code matches documented behavior.

Report format:
- Quote the relevant sections verbatim (with source file and line numbers)
- Note any discrepancies between docs and code
- Flag stale or outdated documentation`,

  planner: `## Planning Methodology

You are a senior architect creating implementation plans.

1. **Understand current state**: Use repo_map to get project structure.
   Read key entry points (main.ts, index.ts, package.json) to understand the stack.
2. **Analyze the request**: Break the objective into concrete, ordered steps.
3. **Identify risks**: Look for potential breaking changes, circular dependencies,
   and backward compatibility concerns.
4. **Estimate scope**: Classify each step as small/medium/large.
   Flag steps that require sequential ordering vs parallel execution.

Plan output format (in findings):
- Step N: What to do + which files to change + estimated complexity
- Prerequisites: What must be true before starting this step
- Verification: How to confirm the step was done correctly`,

  reviewer: `## Code Review Methodology

You are a senior code reviewer. Review with the following priorities:

### Critical (must fix)
- Security: hardcoded secrets, SQL injection, path traversal, XSS
- Correctness: logic errors, null/undefined risks, race conditions
- Data loss: unsafe file operations, missing error handling

### High (should fix)
- API misuse: incorrect parameters, missing error handling
- Performance: O(n²) when O(n) possible, unnecessary re-renders
- Test gaps: new code without tests, flaky test patterns

### Medium (consider)
- Readability: unclear naming, magic numbers, deep nesting
- Maintainability: God objects, duplicated logic, tight coupling
- Documentation: missing JSDoc on public APIs, stale comments

Review process:
1. Read the changed files first (use scope.files if provided)
2. Use repo_graph to understand caller impact
3. Organize findings by severity, include file:line references`,

  verifier: `## Verification Methodology

You are a test and verification specialist.

1. **Identify test framework**: Read package.json scripts section to find test commands.
   Look for vitest, jest, mocha, or node:test patterns.
2. **Run relevant tests**: Execute test commands for the affected files.
3. **Analyze failures**: If tests fail, read the test file and source to diagnose root cause.
4. **Verify coverage**: Check if the changed code has corresponding test coverage.

Output requirements:
- Report exact test commands run and their exit codes
- For failures: include the test name, expected vs actual, and root cause analysis
- For passes: confirm which test files cover the changed code`,

  patcher: `## Patcher Methodology

You are a precise code editor working in an isolated git worktree.

1. **Understand the change**: Read the objective and relevant files carefully.
2. **Make minimal edits**: Use edit_file for targeted changes — do NOT rewrite entire files.
3. **Preserve context**: Keep existing formatting, imports, and surrounding code intact.
4. **Verify**: After editing, read the changed section back to confirm correctness.
5. **Run tests**: Execute relevant test commands to validate the change.

Critical rules:
- NEVER use edit_file with old_string that matches multiple locations
- NEVER rewrite a file when a targeted edit suffices
- ALWAYS read the file first to understand current state
- If a change affects multiple files, list all of them in changedFiles`,

  adversarial_verifier: `## Adversarial Verifier

See profile-registry for full adversarial verifier prompt. If you see this fallback,
the registry prompt was not loaded — escalate as blocked.`,
}

// ─── Project self-discovery preamble ───────────────────────────────
// Instead of injecting project-specific knowledge, teach the worker
// to discover it dynamically. This works on ANY project.

const PROJECT_DISCOVERY_PREAMBLE = `## Project Context Discovery

Before diving into the objective, quickly orient yourself:
1. If .rivet.md or AGENTS.md exists at the project root, read it — it contains project conventions.
2. If package.json exists, read the "scripts" and "dependencies" sections to understand the stack.
3. Use repo_map to see the top-level file structure if you need navigation context.

Do NOT spend more than 1-2 tool calls on discovery. Proceed to the objective quickly.
If the objective is already specific enough (cites file paths), skip discovery entirely.`

// ─── Result shape templates ────────────────────────────────────────

function buildReadOnlyResultShape(): string {
  return `{
  "workOrderId": "<copy WorkOrder ID>",
  "status": "passed | failed | blocked | escalated",
  "summary": "one sentence summary",
  "findings": [
    { "claim": "evidence-backed claim", "evidence": "file path, command, or observed fact", "confidence": "low | medium | high" }
  ],
  "artifacts": [
    { "kind": "note | patch | test_command | risk | question", "title": "short title", "content": "artifact content" }
  ],
  "changedFiles": [],
  "examinedFiles": ["REQUIRED: list all files you read/inspected but did NOT modify"],
  "risks": ["string — brief risk description, one per item"],
  "nextActions": ["string — suggested next action, one per item"],
  "evidenceStatus": "verified | failed | blocked | unverified"
}`
}

function buildWriteResultShape(): string {
  return `{
  "workOrderId": "<copy WorkOrder ID>",
  "status": "passed | failed | blocked | escalated",
  "summary": "one sentence summary",
  "findings": [
    { "claim": "evidence-backed claim", "evidence": "file path, command, or observed fact", "confidence": "low | medium | high" }
  ],
  "artifacts": [
    { "kind": "note | patch | test_command | risk | question", "title": "short title", "content": "artifact content" }
  ],
  "patchSummary": "describe all changes made",
  "changedFiles": ["REQUIRED: list all files you modified/created"],
  "examinedFiles": ["list files you read/inspected but did NOT modify"],
  "verification": {
    "command": "verification command run",
    "status": "passed | failed | blocked",
    "scope": "full | targeted",
    "exitCode": 0,
    "passed": 0,
    "failed": 0,
    "skipped": 0,
    "durationMs": 0
  },
  "risks": ["string — brief risk description, one per item"],
  "nextActions": ["string — suggested next action, one per item"],
  "evidenceStatus": "verified | failed | blocked | unverified"
}`
}

export interface WorkerPromptOptions {
  /** B3: 项目根 cwd（非 worktree），用于读 .rivet/generals/ 将星账本。
   *  提供且 order.authority 有账本时，权域指令后附「将星战绩」top-3 段。 */
  ledgerCwd?: string
}

export function buildWorkerPrompt(order: WorkOrder, authoritySuffix?: string, opts?: WorkerPromptOptions): string {
  // V3 Component A: if order has authority, derive persona + suffix from domain registry.
  // volatileBlock = "你是谁" (frames identity, goes first); systemPromptSuffix = "你怎么做"
  // (methodology, goes last for highest attention weight).
  const domainDef = order.authority ? starDomainRegistry.get(order.authority) : undefined
  if (order.authority && !domainDef) {
    const known = starDomainRegistry.getDomainIds()
    console.warn(
      `[coordinator] Unknown authority "${order.authority}" — cognitive injection skipped. ` +
      `Known domains: ${known.join(', ')}. Worker will run without domain persona/methodology.`,
    )
  }
  const effectiveSuffix = authoritySuffix ?? domainDef?.systemPromptSuffix
  const personaBlock = authoritySuffix ? undefined : domainDef?.volatileBlock
  const hasWriteTools = order.allowedTools.some(t => WRITE_CAPABLE_TOOLS.has(t))
  const capability = hasWriteTools ? 'write-capable' : 'read-only'
  const resultShape = hasWriteTools ? buildWriteResultShape() : buildReadOnlyResultShape()

  const parts = [
    `You are a headless ${capability} Rivet worker.`,
    `WorkOrder ID: ${order.id}`,
    `Kind: ${order.kind}`,
    `Profile: ${order.profile}`,
  ]

  // V3 Component A (persona): inject the star-domain identity up front so the
  // worker reasons in-character before reading its methodology / task.
  if (personaBlock) {
    parts.push('', '## 你是谁', '', personaBlock)
  }

  // Inject profile-specific expertise (prefer registry, fallback to hardcoded PROFILE_PROMPTS)
  const profileDef = profileRegistry.get(order.profile)
  const profilePrompt = profileDef?.expertisePrompt ?? PROFILE_PROMPTS[order.profile]
  if (profilePrompt) {
    parts.push('', profilePrompt)
  }

  // Inject project self-discovery for read-only workers (exploration profiles)
  if (!hasWriteTools) {
    parts.push('', PROJECT_DISCOVERY_PREAMBLE)
  }

  // Guided retrieval: memory/prompt/recall tasks need a concrete knowledge packet.
  // Do not rely on workers to guess which memory docs exist.
  if (needsMemoryKnowledgePacket(order)) {
    parts.push('', buildMemoryKnowledgePacket())
  }

  parts.push(
    '',
    '## Task',
    `Objective: ${order.objective}`,
    `Scope: ${JSON.stringify(order.scope)}`,
    `Constraints: ${order.constraints.join(' | ')}`,
    `Allowed tools: ${order.allowedTools.join(', ')}`,
    `Disallowed tools: ${order.disallowedTools.join(', ')}`,
  )

  // 浏览器/桌面自动化使用要点：工具在 allowed 列表里时给一行分工提示，
  // 否则 worker 常把 browser_debug 当纯截图工具、把 computer_use 当首选而非兜底。
  const visualUsageNotes: string[] = []
  if (order.allowedTools.includes('browser_debug')) {
    visualUsageNotes.push(
      'browser_debug：本地 web 联调主工具——navigate 到 dev server 后 screenshot 验证渲染、console 查报错、network {failed_only:true} 抓失败请求；改了 UI 文件交付前截图自证。',
    )
  }
  if (order.allowedTools.includes('computer_use')) {
    visualUsageNotes.push(
      'computer_use：原生桌面 GUI 兜底——先 snapshot(app) 读可访问性树再 find/click/type；有 CLI/API 可用时永远优先结构化工具。',
    )
  }
  if (visualUsageNotes.length > 0) {
    parts.push('', '## 浏览器/桌面自动化要点', ...visualUsageNotes.map(n => `- ${n}`))
  }

  if (order.workerCwd && hasWriteTools) {
    parts.push(
      '',
      '## Working Directory',
      `CWD: ${order.workerCwd}`,
      'You are in an isolated git worktree. Use RELATIVE paths for all file operations.',
      'Do NOT use absolute paths from the original repository.',
      'After completing edits, run relevant verification if feasible; git commit is optional because the primary session collects uncommitted worktree diffs.',
    )
  }

  parts.push(
    'Do not call disallowed tools. Do not claim that files were changed unless you actually modified them.',
    'If you changed files and did not run relevant verification, evidenceStatus must be "unverified".',
    '执行纪律（全星域共享）：绿非证明，复现即证——宣称已修/已验证前，先用工具复现结论（run_tests 或验证命令）；summary 里的每个数字要能指到一条真实验证记录，否则宣称会被证据门降级。',
    'Use changedFiles ONLY for files you actually modified/created. Use examinedFiles for files you read/inspected.',
    'Return exactly one JSON object and no prose outside the object.',
    'The JSON object must match this shape:',
    resultShape,
  )

  if (effectiveSuffix) {
    parts.push('', '## 权域指令', '', effectiveSuffix)
  }

  // B3（将星点亮）：worker 出战带着上次的记忆——账本缺陷/能力族 top-3，
  // 各一行（族名 + 复发计数 + signature 摘要）。体量受控，账本缺失时零注入。
  if (order.authority && opts?.ledgerCwd) {
    try {
      const families = topGeneralFamilies(opts.ledgerCwd, order.authority, 3)
      if (families.length > 0) {
        parts.push(
          '',
          '## 将星战绩（跨会话账本 · 上次出战的记忆）',
          '',
          ...families.map(f => `- ${f.family} ×${f.recurrenceCount}（lastSeen ${f.lastSeen}）${f.signature ? ` — ${f.signature}` : ''}`),
          '',
          '这些族上次也来过。同族再现时优先按族处置；新战绩用 record_general_finding 追加（同族复用族名）。',
        )
      }
    } catch {
      // Ledger merge is best-effort — never block the worker prompt.
    }
  }

  return parts.join('\n')
}

export function buildWorkerRepairPrompt(order: WorkOrder, previousText: string, parseError: string): string {
  // Tail of previous text as reference for the model to repair. A complete
  // WorkerResult JSON for write-capable workers (multiple findings + artifacts
  // + changedFiles) commonly reaches 5–8K chars; 4000 truncated mid-object and
  // left the model without enough context to rebuild. 8000 covers a full
  // typical packet while staying well under the 8192-token output budget.
  const tail = previousText.length <= 8000
    ? previousText
    : previousText.slice(-8000)

  const hasWriteTools = order.allowedTools.some(t => WRITE_CAPABLE_TOOLS.has(t))
  const resultShape = hasWriteTools ? buildWriteResultShape() : buildReadOnlyResultShape()

  // Classify the error to give a specific repair instruction.
  const isMissingJson = parseError.includes('did not contain a JSON object')
  const isInvalidJson = parseError.includes('Unexpected token') || parseError.includes('Expected')
  const isMissingField = parseError.includes('Required') || parseError.includes('invalid_type')
  const isSchemaError = parseError.includes('Unrecognized key') || parseError.includes('invalid_union')

  let instruction = ''
  if (isMissingJson) {
    instruction = [
      'The previous answer contained NO valid JSON object. Output ONLY a raw JSON object (no markdown, no prose, no thinking).',
      'Start with a single { character and end with a single } character.',
      'If your answer includes thinking or analysis, put it INSIDE the "summary" field of the JSON.',
    ].join('\n')
  } else if (isInvalidJson) {
    instruction = [
      'The JSON in your previous answer was syntactically invalid (bad commas, unclosed strings, etc).',
      'Common fixes: use double-quotes for all keys AND values; remove trailing commas after the last array/object item; escape any double-quotes inside strings with \\\".',
    ].join('\n')
  } else if (isMissingField) {
    instruction = [
      'The JSON was valid but missing required fields. Check that your object has:',
      '- "workOrderId" (copy from the order ID)',
      '- "status" (one of: passed, failed, blocked, escalated)',
      '- "findings" (array, not single object)',
      '- "artifacts" (array, not single object)',
      '- "changedFiles" (array of strings, even if empty)',
      '- "risks" (array of strings)',
      '- "nextActions" (array of strings)',
      '- "evidenceStatus" (one of: verified, failed, blocked, unverified)',
    ].join('\n')
  } else if (isSchemaError) {
    instruction = 'The JSON had extra or wrong-typed fields. Use EXACTLY the field names shown in the shape below — no additional top-level keys.'
  } else {
    instruction = `The JSON could not be parsed. Error: ${parseError}. Follow the exact shape below.`
  }

  // Always surface the concrete parser error so the worker knows exactly what
  // failed — the classified branches give generic advice; without the raw error
  // the model is repairing blind. (The fallback branch already embeds it.)
  if (parseError && !instruction.includes(parseError)) {
    instruction = `${instruction}\nParser error: ${parseError}`
  }

  return [
    `YOUR PREVIOUS ANSWER COULD NOT BE USED. ${instruction}`,
    'Output EXACTLY one JSON object and NOTHING else — no ``` fences, no markdown, no prose outside the object.',
    `WorkOrder ID (copy this exactly): ${order.id}`,
    'Required shape:',
    resultShape,
    'Your previous answer (for reference):',
    tail,
  ].join('\n')
}

/** Maximum characters for the entire worker packet returned to primary session.
 *  ~8K chars ≈ 2K tokens. Enough for 2-3 workers with concise findings,
 *  but prevents a single delegate_task from consuming 50K+ tokens. */
const MAX_WORKER_PACKET_CHARS = 32_000

/** Maximum characters for a single non-diff artifact content field. */
const MAX_ARTIFACT_CONTENT_CHARS = 2_000

const WORKER_RESULTS_HINT = `<worker_results_hint>
以下 worker 返回来自只读扫描或子代理摘要。除非某个 result 的 verification.status 为 "passed"，否则这些发现属于“待核验假设”，不是已验证事实。引用到具体文件前，请用 read_file/grep 独立确认。
</worker_results_hint>`

function wrapWorkerResults(body: string): string {
  return `${WORKER_RESULTS_HINT}\n${body}`
}

/** Mark a compact result as truncated and downgrade any verified claim,
 *  because the metadata backing that claim may have been omitted. */
function markTruncated(result: Record<string, unknown>): void {
  result._truncated = true
  result._truncationNote = 'Inline packet truncated; verification metadata may have been omitted.'
  if (result.evidenceStatus === 'verified') {
    result.evidenceStatus = 'unverified'
  }
}

/** Strip empty arrays/strings/undefined from an object to reduce JSON size. */
function stripEmpty<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    if (Array.isArray(v) && v.length === 0) continue
    if (typeof v === 'string' && v === '') continue
    result[k] = v
  }
  return result as Partial<T>
}

function truncateArtifactContent(artifacts: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return artifacts.map(a => {
    if (a.kind === 'diff') return a
    if (typeof a.content === 'string' && a.content.length > MAX_ARTIFACT_CONTENT_CHARS) {
      return { ...a, content: a.content.slice(0, MAX_ARTIFACT_CONTENT_CHARS) + '…' }
    }
    return a
  })
}

/** Build the `<worker_results>` packet for the primary session.
 *  Async because large packets await artifact store persistence before returning
 *  the reference — never emits a dangling artifact reference. */
export async function buildPrimaryWorkerPacket(results: WorkerResult[], artifactStore?: ArtifactStore): Promise<string> {
  const compact = results.map(result => {
    const raw = {
      workOrderId: result.workOrderId,
      status: result.status,
      summary: result.summary,
      findings: result.findings,
      artifacts: result.artifacts ? truncateArtifactContent(result.artifacts as Array<Record<string, unknown>>) : undefined,
      verification: result.verification,
      changedFiles: result.changedFiles,
      examinedFiles: result.examinedFiles,
      risks: result.risks,
      nextActions: result.nextActions,
      evidenceStatus: result.evidenceStatus,
      failureReason: result.failureReason,
    }
    return stripEmpty(raw)
  })

  let json = JSON.stringify(compact)

  // Hard cap: if packet exceeds budget, try artifact handoff first
  if (json.length > MAX_WORKER_PACKET_CHARS) {
    if (artifactStore) {
      const fullJson = JSON.stringify(results)
      // Use the ID returned by save() — the store generates its own ID
      // (`delegate_task:<hex>`), so a fabricated `worker-packet-…` reference
      // would never resolve via read_section even on a successful save.
      let artifactId: string | null = null
      try {
        artifactId = await artifactStore.save({
          tool: 'delegate_task',
          target: 'worker-packet',
          rawContent: fullJson,
          summary: `${results.length} worker results (${fullJson.length} chars) — full content in artifact store`,
          sections: [],
        })
      } catch {
        // Save failed — fall through to progressive field drop below
      }

      if (artifactId) {
        // Build a compact packet with artifact reference
        for (const result of compact) {
          delete result.examinedFiles
          delete result.risks
          delete result.nextActions
          delete result.verification
          delete result.artifacts
          markTruncated(result)
        }
        json = JSON.stringify(compact)
        // Append artifact reference so primary agent can read_section if needed
        if (json.length > MAX_WORKER_PACKET_CHARS) {
          json = json.slice(0, MAX_WORKER_PACKET_CHARS - 100) + '…"'
        }
        return wrapWorkerResults(`<worker_results>${json}\n[artifact:${artifactId}] — full worker results saved to artifact store, use read_section to retrieve</worker_results>`)
      }
      // artifact save failed → fall through to progressive field drop
    }

    // No artifact store or save failed: progressive field drop (fallback).
    // Mark each result so the primary agent knows fields were removed —
    // without this, evidenceStatus:'verified' is misleading when the
    // verification metadata backing that claim was silently deleted.
    for (const result of compact) {
      delete result.examinedFiles
      delete result.risks
      delete result.nextActions
      delete result.verification
      markTruncated(result)
    }
    json = JSON.stringify(compact)
  }

  // Final safety: if still over budget, truncate to the largest prefix whose
  // JSON array is still valid. We must not emit unparseable JSON — the primary
  // agent has no error recovery for a broken <worker_results> payload.
  if (json.length > MAX_WORKER_PACKET_CHARS) {
    // Strategy: try removing findings from the tail (keep earliest results
    // intact), then hard-limit the remaining JSON. This is more principled
    // than slicing a string at an arbitrary byte offset.
    for (let i = compact.length - 1; i >= 0 && json.length > MAX_WORKER_PACKET_CHARS; i--) {
      delete compact[i]!.findings
      ;(compact[i]! as Record<string, unknown>)._truncated = true
      json = JSON.stringify(compact)
    }
    // Last resort: truncate the array itself, keeping valid JSON structure.
    while (json.length > MAX_WORKER_PACKET_CHARS && compact.length > 1) {
      const dropped = compact.pop()
      if (dropped) markTruncated(dropped)
      json = JSON.stringify(compact)
    }
    // If a single result is still too large, keep only its core identifiers.
    if (json.length > MAX_WORKER_PACKET_CHARS && compact.length === 1) {
      const only = compact[0]!
      const minimal: Record<string, unknown> = {
        workOrderId: only.workOrderId,
        status: only.status,
        summary: typeof only.summary === 'string' ? only.summary.slice(0, 200) : '',
      }
      markTruncated(minimal)
      json = JSON.stringify([minimal])
    }
  }

  return wrapWorkerResults(`<worker_results>${json}</worker_results>`)
}
