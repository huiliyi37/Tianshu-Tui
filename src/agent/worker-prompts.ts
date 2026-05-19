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
  "examinedFiles": ["REQUIRED: list all files you read/inspected"],
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

export function buildWorkerPrompt(order: WorkOrder): string {
  const hasWriteTools = order.allowedTools.some(t => !(READ_ONLY_WORKER_TOOLS as readonly string[]).includes(t))
  const capability = hasWriteTools ? 'write-capable' : 'read-only'
  const resultShape = hasWriteTools ? buildWriteResultShape() : buildReadOnlyResultShape()

  return [
    `You are a headless ${capability} Rivet worker.`,
    `WorkOrder ID: ${order.id}`,
    `Kind: ${order.kind}`,
    `Profile: ${order.profile}`,
    `Objective: ${order.objective}`,
    `Scope: ${JSON.stringify(order.scope)}`,
    `Constraints: ${order.constraints.join(' | ')}`,
    `Allowed tools: ${order.allowedTools.join(', ')}`,
    `Disallowed tools: ${order.disallowedTools.join(', ')}`,
    'Do not call disallowed tools. Do not claim that files were changed unless you actually modified them.',
    'If you changed files and did not run relevant verification, evidenceStatus must be "unverified".',
    'Use changedFiles ONLY for files you actually modified/created. Use examinedFiles for files you read/inspected.',
    'Return exactly one JSON object and no prose outside the object.',
    'The JSON object must match this shape:',
    resultShape,
  ].join('\n')
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

export function buildPrimaryWorkerPacket(results: WorkerResult[]): string {
  const compact = results.map(result => ({
    workOrderId: result.workOrderId,
    status: result.status,
    summary: result.summary,
    findings: result.findings,
    artifacts: result.artifacts,
    verification: result.verification,
    changedFiles: result.changedFiles,
    examinedFiles: result.examinedFiles,
    risks: result.risks,
    nextActions: result.nextActions,
    evidenceStatus: result.evidenceStatus,
  }))

  return [
    '<worker_results>',
    JSON.stringify(compact, null, 2),
    '</worker_results>',
  ].join('\n')
}
