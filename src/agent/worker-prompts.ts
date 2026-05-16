import type { WorkOrder, WorkerResult } from './work-order.js'

const RESULT_SHAPE = `{
  "workOrderId": "<copy WorkOrder ID>",
  "status": "passed | failed | blocked | escalated",
  "summary": "one sentence summary",
  "findings": [
    { "claim": "evidence-backed claim", "evidence": "file path, command, or observed fact", "confidence": "low | medium | high" }
  ],
  "artifacts": [
    { "kind": "note | patch | test_command | risk | question", "title": "short title", "content": "artifact content" }
  ],
  "patchSummary": "optional: describe all changes made",
  "changedFiles": [],
  "risks": [],
  "nextActions": [],
  "evidenceStatus": "verified | failed | blocked | unverified"
}`

export function buildWorkerPrompt(order: WorkOrder): string {
  return [
    'You are a headless read-only Rivet worker.',
    `WorkOrder ID: ${order.id}`,
    `Kind: ${order.kind}`,
    `Profile: ${order.profile}`,
    `Objective: ${order.objective}`,
    `Scope: ${JSON.stringify(order.scope)}`,
    `Constraints: ${order.constraints.join(' | ')}`,
    `Allowed tools: ${order.allowedTools.join(', ')}`,
    `Disallowed tools: ${order.disallowedTools.join(', ')}`,
    'Do not call disallowed tools. Do not claim that files were changed.',
    'If you changed files and did not run relevant verification, evidenceStatus must be "unverified".',
    'Return exactly one JSON object and no prose outside the object.',
    'The JSON object must match this shape:',
    RESULT_SHAPE,
  ].join('\n')
}

export function buildWorkerRepairPrompt(order: WorkOrder, previousText: string, parseError: string): string {
  return [
    'Repair the previous answer so it is exactly one valid WorkerResult JSON object.',
    `WorkOrder ID that must be used: ${order.id}`,
    `Parse error: ${parseError}`,
    'Do not add markdown fences or explanation.',
    'Use this shape:',
    RESULT_SHAPE,
    'Previous answer:',
    previousText.slice(0, 4000),
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
