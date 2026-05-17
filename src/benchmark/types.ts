import { z } from 'zod'

export const taskCategorySchema = z.enum([
  'repo_inspection',
  'code_edit',
  'test_repair',
  'multi_file_refactor',
  'session_recovery',
  'provider_conformance',
])

export const benchmarkStatusSchema = z.enum(['passed', 'failed', 'blocked'])

export const taskDefinitionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  category: taskCategorySchema,
  prompt: z.string().min(1),
  setupCommands: z.array(z.string().min(1)).default([]),
  successCommands: z.array(z.string().min(1)).default([]),
  timeoutMs: z.number().int().positive(),
  tags: z.array(z.string().min(1)).default([]),
})

export const benchmarkFailureSchema = z.object({
  class: z.string().min(1),
  message: z.string().min(1),
  toolName: z.string().min(1).optional(),
})

export const benchmarkMetricsSchema = z.object({
  turns: z.number().int().nonnegative(),
  toolCalls: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative(),
  cacheHitRate: z.number().min(0).max(1).optional(),
  costUsd: z.number().nonnegative().optional(),
})

export const benchmarkRunSchema = z.object({
  runId: z.string().min(1),
  suiteId: z.string().min(1),
  taskId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: benchmarkStatusSchema,
  startedAt: z.string().datetime(),
  endedAt: z.string().datetime(),
  metrics: benchmarkMetricsSchema,
  failures: z.array(benchmarkFailureSchema).default([]),
})

export const capabilityMatrixRowSchema = z.object({
  provider: z.string().min(1),
  model: z.string().min(1),
  suiteId: z.string().min(1),
  runs: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  blocked: z.number().int().nonnegative(),
  passRate: z.number().min(0).max(1),
  medianTurns: z.number().nonnegative(),
  medianToolCalls: z.number().nonnegative(),
  averageCostUsd: z.number().nonnegative(),
})

export type TaskCategory = z.infer<typeof taskCategorySchema>
export type BenchmarkStatus = z.infer<typeof benchmarkStatusSchema>
export type TaskDefinition = z.infer<typeof taskDefinitionSchema>
export type BenchmarkFailure = z.infer<typeof benchmarkFailureSchema>
export type BenchmarkMetrics = z.infer<typeof benchmarkMetricsSchema>
export type BenchmarkRun = z.infer<typeof benchmarkRunSchema>
export type CapabilityMatrixRow = z.infer<typeof capabilityMatrixRowSchema>
