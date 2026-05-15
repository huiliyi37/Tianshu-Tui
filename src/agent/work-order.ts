import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CapabilityTask } from '../model/capability.js'
import type { VerificationMetadata } from '../tools/types.js'

export const READ_ONLY_WORKER_TOOLS = ['read_file', 'glob', 'grep', 'diff'] as const
export const PHASE1_DISALLOWED_WORKER_TOOLS = ['bash', 'write_file', 'edit_file', 'run_tests', 'delegate_task'] as const

export const workOrderKindSchema = z.enum([
  'code_search',
  'doc_research',
  'plan',
  'review',
  'verify',
  'patch_proposal',
])

export type WorkOrderKind = z.infer<typeof workOrderKindSchema>

export const workerProfileSchema = z.enum([
  'code_scout',
  'doc_scout',
  'planner',
  'reviewer',
  'verifier',
  'patcher',
])

export type WorkerProfile = z.infer<typeof workerProfileSchema>

export const aggregationPolicySchema = z.enum([
  'all_required',
  'first_success',
  'majority',
  'primary_decides',
])

export type AggregationPolicy = z.infer<typeof aggregationPolicySchema>

const workOrderScopeSchema = z.object({
  files: z.array(z.string()).optional(),
  symbols: z.array(z.string()).optional(),
  commands: z.array(z.string()).optional(),
  externalUrls: z.array(z.string()).optional(),
})

export type WorkOrderScope = z.infer<typeof workOrderScopeSchema>

const workerBudgetSchema = z.object({
  maxTurns: z.number().int().positive(),
  maxTokens: z.number().int().positive(),
  timeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0),
})

export type WorkerBudget = z.infer<typeof workerBudgetSchema>

export const workOrderSchema = z.object({
  id: z.string().min(1),
  parentTurnId: z.string().min(1),
  kind: workOrderKindSchema,
  profile: workerProfileSchema,
  objective: z.string().min(1),
  scope: workOrderScopeSchema,
  constraints: z.array(z.string()),
  allowedTools: z.array(z.string()),
  disallowedTools: z.array(z.string()),
  dedupeKey: z.string().min(1),
  dependencies: z.array(z.string()),
  aggregationPolicy: aggregationPolicySchema,
  budget: workerBudgetSchema,
})

export type WorkOrder = z.infer<typeof workOrderSchema>

const verificationMetadataSchema = z.object({
  command: z.string(),
  status: z.enum(['passed', 'failed', 'blocked']),
  scope: z.enum(['full', 'targeted']),
  exitCode: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  durationMs: z.number(),
}) satisfies z.ZodType<VerificationMetadata>

export const workerResultSchema = z.object({
  workOrderId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked', 'escalated']),
  summary: z.string().min(1),
  findings: z.array(z.object({
    claim: z.string().min(1),
    evidence: z.string().min(1),
    confidence: z.enum(['low', 'medium', 'high']),
  })),
  artifacts: z.array(z.object({
    kind: z.enum(['note', 'patch', 'test_command', 'risk', 'question']),
    title: z.string().min(1),
    content: z.string().min(1),
  })),
  verification: verificationMetadataSchema.optional(),
  changedFiles: z.array(z.string()),
  risks: z.array(z.string()),
  nextActions: z.array(z.string()),
})

export type WorkerResult = z.infer<typeof workerResultSchema>

export interface CreateReadOnlyWorkOrderInput {
  id?: string
  parentTurnId: string
  kind: WorkOrderKind
  profile: WorkerProfile
  objective: string
  scope: WorkOrderScope
  constraints?: string[]
  dependencies?: string[]
  aggregationPolicy?: AggregationPolicy
  budget?: Partial<WorkerBudget>
}

export function createReadOnlyWorkOrder(input: CreateReadOnlyWorkOrderInput): WorkOrder {
  const id = input.id ?? `wo_${randomUUID()}`
  return workOrderSchema.parse({
    id,
    parentTurnId: input.parentTurnId,
    kind: input.kind,
    profile: input.profile,
    objective: input.objective,
    scope: input.scope,
    constraints: input.constraints ?? [
      'Return only evidence-backed claims.',
      'Do not suggest edits as completed changes.',
      'Do not request write, edit, bash, or test execution tools.',
    ],
    allowedTools: [...READ_ONLY_WORKER_TOOLS],
    disallowedTools: [...PHASE1_DISALLOWED_WORKER_TOOLS],
    dedupeKey: `${input.kind}:${input.scope.files?.join(',') || input.objective}`,
    dependencies: input.dependencies ?? [],
    aggregationPolicy: input.aggregationPolicy ?? 'primary_decides',
    budget: {
      maxTurns: input.budget?.maxTurns ?? 4,
      maxTokens: input.budget?.maxTokens ?? 4096,
      timeoutMs: input.budget?.timeoutMs ?? 120_000,
      maxRetries: input.budget?.maxRetries ?? 1,
    },
  })
}

export function mapWorkOrderKindToCapabilityTask(kind: WorkOrderKind): CapabilityTask {
  switch (kind) {
    case 'code_search':
    case 'doc_research':
    case 'plan':
      return 'repo_summarization'
    case 'verify':
      return 'test_failure_diagnosis'
    case 'review':
    case 'patch_proposal':
      return 'risky_refactor'
  }
}

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const source = (fenced?.[1] ?? text).trim()
  const firstBrace = source.indexOf('{')
  const lastBrace = source.lastIndexOf('}')
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    throw new Error('Worker result did not contain a JSON object')
  }
  return source.slice(firstBrace, lastBrace + 1)
}

export function parseWorkerResult(text: string, expectedWorkOrderId: string): WorkerResult {
  const parsed = JSON.parse(extractJsonObject(text)) as unknown
  const result = workerResultSchema.parse(parsed)
  if (result.workOrderId !== expectedWorkOrderId) {
    throw new Error(`WorkerResult workOrderId ${result.workOrderId} does not match ${expectedWorkOrderId}`)
  }
  return result
}

export function buildBlockedWorkerResult(order: WorkOrder, reason: string): WorkerResult {
  return {
    workOrderId: order.id,
    status: 'blocked',
    summary: `Worker blocked: ${reason}`,
    findings: [],
    artifacts: [{
      kind: 'risk',
      title: 'Worker result contract failed',
      content: reason,
    }],
    changedFiles: [],
    risks: ['Worker did not return schema-valid JSON'],
    nextActions: ['Primary should continue without trusting this worker result'],
  }
}
