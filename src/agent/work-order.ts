import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { CapabilityTask } from '../model/capability.js'
import type { VerificationMetadata } from '../tools/types.js'

export const READ_ONLY_WORKER_TOOLS = ['read_file', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'related_tests'] as const
export const WRITE_WORKER_TOOLS = ['read_file', 'glob', 'grep', 'diff', 'inspect_project', 'repo_map', 'related_tests', 'edit_file', 'write_file', 'bash', 'run_tests'] as const
export const PHASE1_DISALLOWED_WORKER_TOOLS = ['bash', 'write_file', 'edit_file', 'run_tests', 'delegate_task', 'delegate_batch'] as const

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

const workerFindingSchema = z.object({
  claim: z.string().min(1),
  evidence: z.string().min(1),
  confidence: z.enum(['low', 'medium', 'high']),
})

const workerArtifactSchema = z.object({
  kind: z.enum(['note', 'patch', 'test_command', 'risk', 'question', 'diff']),
  title: z.string().min(1),
  content: z.string().min(1),
})

export type WorkerArtifact = z.infer<typeof workerArtifactSchema>

export const workerResultSchema = z.object({
  workOrderId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked', 'escalated']),
  summary: z.string().min(1),
  findings: z.array(workerFindingSchema),
  artifacts: z.array(workerArtifactSchema),
  patchSummary: z.string().optional(),
  verification: verificationMetadataSchema.optional(),
  changedFiles: z.array(z.string()),
  risks: z.array(z.string()),
  nextActions: z.array(z.string()),
  evidenceStatus: z.enum(['verified', 'failed', 'blocked', 'unverified']).default('unverified'),
})

const workerResultIngestSchema = z.object({
  workOrderId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked', 'escalated']),
  summary: z.string().min(1),
  findings: z.array(z.union([workerFindingSchema, z.string().min(1)])).default([]),
  artifacts: z.array(z.union([workerArtifactSchema, z.string().min(1)])).default([]),
  patchSummary: z.string().optional(),
  verification: verificationMetadataSchema.optional(),
  changedFiles: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  nextActions: z.array(z.string()).default([]),
  evidenceStatus: z.enum(['verified', 'failed', 'blocked', 'unverified']).default('unverified'),
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
      maxTokens: input.budget?.maxTokens ?? 8192,
      timeoutMs: input.budget?.timeoutMs ?? 120_000,
      maxRetries: input.budget?.maxRetries ?? 2,
    },
  })
}

export interface CreateWriteWorkOrderInput extends Omit<CreateReadOnlyWorkOrderInput, 'profile'> {
  profile?: WorkerProfile
}

export function createWriteWorkOrder(input: CreateWriteWorkOrderInput): WorkOrder {
  const id = input.id ?? `wo_${randomUUID()}`
  return workOrderSchema.parse({
    id,
    parentTurnId: input.parentTurnId,
    kind: input.kind,
    profile: input.profile ?? 'patcher',
    objective: input.objective,
    scope: input.scope,
    constraints: input.constraints ?? [
      'Return a patchSummary describing all changes made.',
      'List every changed file in changedFiles.',
      'Include verification results if tests were run.',
    ],
    allowedTools: [...WRITE_WORKER_TOOLS],
    disallowedTools: ['delegate_task', 'delegate_batch'],
    dedupeKey: `write:${input.scope.files?.join(',') || input.objective}`,
    dependencies: input.dependencies ?? [],
    aggregationPolicy: input.aggregationPolicy ?? 'primary_decides',
    budget: {
      maxTurns: input.budget?.maxTurns ?? 8,
      maxTokens: input.budget?.maxTokens ?? 8192,
      timeoutMs: input.budget?.timeoutMs ?? 180_000,
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

function extractFencedJsonCandidates(text: string): string[] {
  return [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)]
    .map(match => match[1]?.trim())
    .filter((candidate): candidate is string => Boolean(candidate?.startsWith('{') && candidate.endsWith('}')))
}

function extractBalancedJsonCandidates(text: string): string[] {
  const candidates: string[] = []
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    let escaped = false
    for (let i = start; i < text.length; i++) {
      const ch = text[i]!
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') { inString = !inString; continue }
      if (inString) continue
      if (ch === '{') depth++
      if (ch === '}') {
        depth--
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1))
          break
        }
      }
    }
  }
  return candidates
}

function extractJsonCandidates(text: string): string[] {
  const candidates = [...extractFencedJsonCandidates(text), ...extractBalancedJsonCandidates(text)]
  if (candidates.length > 0) return candidates

  const firstBrace = text.indexOf('{')
  const lastBrace = text.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return [text.slice(firstBrace, lastBrace + 1)]
  }

  throw new Error('Worker result did not contain a JSON object')
}

function extractJsonParseError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

function parseJsonCandidate(candidate: string): unknown {
  return JSON.parse(candidate) as unknown
}

function normalizeWorkerResult(raw: z.infer<typeof workerResultIngestSchema>): WorkerResult {
  return workerResultSchema.parse({
    ...raw,
    findings: raw.findings.map((finding, index) => typeof finding === 'string'
      ? { claim: finding, evidence: `worker finding ${index + 1}`, confidence: 'medium' as const }
      : finding),
    artifacts: raw.artifacts.map((artifact, index) => typeof artifact === 'string'
      ? { kind: 'note' as const, title: `Artifact ${index + 1}`, content: artifact }
      : artifact),
  })
}

function parseWorkerResultObject(parsed: unknown, expectedWorkOrderId: string): WorkerResult {
  const ingested = workerResultIngestSchema.parse(parsed)
  if (ingested.workOrderId !== expectedWorkOrderId) {
    throw new Error(`WorkerResult workOrderId ${ingested.workOrderId} does not match ${expectedWorkOrderId}`)
  }
  return normalizeWorkerResult(ingested)
}

export function parseWorkerResult(text: string, expectedWorkOrderId: string): WorkerResult {
  const candidates = extractJsonCandidates(text)
  const errors: string[] = []

  for (const candidate of candidates) {
    let parsed: unknown
    try {
      parsed = parseJsonCandidate(candidate)
    } catch (error) {
      errors.push(extractJsonParseError(error))
      continue
    }

    try {
      return parseWorkerResultObject(parsed, expectedWorkOrderId)
    } catch (error) {
      errors.push(extractJsonParseError(error))
      continue
    }
  }

  throw new Error(errors.at(-1) ?? 'Worker result did not contain a valid JSON object')
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
    evidenceStatus: 'blocked',
  }
}
