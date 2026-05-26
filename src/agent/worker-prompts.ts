import { READ_ONLY_WORKER_TOOLS, type WorkOrder, type WorkerResult } from './work-order.js'

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
  "risks": [],
  "nextActions": [],
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
  "risks": [],
  "nextActions": [],
  "evidenceStatus": "verified | failed | blocked | unverified"
}`
}

export function buildWorkerPrompt(order: WorkOrder, authoritySuffix?: string): string {
  const hasWriteTools = order.allowedTools.some(t => !(READ_ONLY_WORKER_TOOLS as readonly string[]).includes(t))
  const capability = hasWriteTools ? 'write-capable' : 'read-only'
  const resultShape = hasWriteTools ? buildWriteResultShape() : buildReadOnlyResultShape()

  const parts = [
    `You are a headless ${capability} Rivet worker.`,
    `WorkOrder ID: ${order.id}`,
    `Kind: ${order.kind}`,
    `Profile: ${order.profile}`,
    `Objective: ${order.objective}`,
    `Scope: ${JSON.stringify(order.scope)}`,
    `Constraints: ${order.constraints.join(' | ')}`,
    `Allowed tools: ${order.allowedTools.join(', ')}`,
    `Disallowed tools: ${order.disallowedTools.join(', ')}`,
  ]

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
    'Use changedFiles ONLY for files you actually modified/created. Use examinedFiles for files you read/inspected.',
    'Return exactly one JSON object and no prose outside the object.',
    'The JSON object must match this shape:',
    resultShape,
  )

  if (authoritySuffix) {
    parts.push('', '## 权域指令', '', authoritySuffix)
  }

  return parts.join('\n')
}

export function buildWorkerRepairPrompt(order: WorkOrder, previousText: string, parseError: string): string {
  // Use tail of previous text — JSON output is more likely at the end.
  // If the text is short, use the whole thing; otherwise prefer the last 4000 chars.
  const tail = previousText.length <= 4000
    ? previousText
    : previousText.slice(-4000)

  const hasWriteTools = order.allowedTools.some(t => !(READ_ONLY_WORKER_TOOLS as readonly string[]).includes(t))
  const resultShape = hasWriteTools ? buildWriteResultShape() : buildReadOnlyResultShape()

  return [
    'Repair the previous answer so it is exactly one valid WorkerResult JSON object.',
    `WorkOrder ID that must be used: ${order.id}`,
    `Parse error: ${parseError}`,
    'Do not add markdown fences or explanation.',
    'Use this shape:',
    resultShape,
    'Previous answer (last 4000 chars):',
    tail,
  ].join('\n')
}

/** Maximum characters for the entire worker packet returned to primary session.
 *  ~8K chars ≈ 2K tokens. Enough for 2-3 workers with concise findings,
 *  but prevents a single delegate_task from consuming 50K+ tokens. */
const MAX_WORKER_PACKET_CHARS = 32_000

/** Maximum characters for a single non-diff artifact content field. */
const MAX_ARTIFACT_CONTENT_CHARS = 2_000

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

export function buildPrimaryWorkerPacket(results: WorkerResult[]): string {
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
    }
    return stripEmpty(raw)
  })

  let json = JSON.stringify(compact)

  // Hard cap: if packet exceeds budget, progressively drop low-value fields
  if (json.length > MAX_WORKER_PACKET_CHARS) {
    for (const result of compact) {
      delete result.examinedFiles
      delete result.risks
      delete result.nextActions
      delete result.verification
    }
    json = JSON.stringify(compact)
  }

  // Final safety: truncate raw JSON if still over budget (shouldn't happen normally)
  if (json.length > MAX_WORKER_PACKET_CHARS) {
    json = json.slice(0, MAX_WORKER_PACKET_CHARS) + '…"'
  }

  return `<worker_results>${json}</worker_results>`
}
