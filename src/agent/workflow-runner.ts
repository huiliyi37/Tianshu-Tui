/**
 * Workflow Runner — declarative YAML workflow execution.
 *
 * Workflows are defined in `.rivet/workflows/*.yaml`:
 *
 * ```yaml
 * name: safe-deliver
 * inputs:
 *   objective: string
 * steps:
 *   - id: plan
 *     tool: council_convene
 *     input:
 *       objective: "${objective}"
 *       autoExecute: false
 *   - id: execute
 *     tool: team_orchestrate
 *     input:
 *       planJson: "${plan.planJson}"
 *     depends_on: [plan]
 *   - id: verify
 *     tool: delegate_task
 *     input:
 *       objective: "Review changes from ${execute}"
 *     depends_on: [execute]
 *     on_failure: plan  # loop back to plan if verify fails
 * ```
 *
 * The runner resolves `${var}` / `${step.field}` references, executes steps
 * in dependency order, and records a WorkflowTrace for replay/debugging.
 */

import { readFileSync, existsSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { workflowsDir } from '../config/paths.js'

const WORKFLOWS_DIR = '.rivet/workflows'
const TRACES_DIR = '.rivet/traces'

// ── Types ──────────────────────────────────────────────────────

export interface WorkflowStep {
  id: string
  tool: string
  input?: Record<string, unknown>
  depends_on?: string[]
  /** Step id to retry from on failure (loop-back). */
  on_failure?: string
  /** Skip this step if condition is false. */
  condition?: string
}

export interface WorkflowDef {
  name: string
  description?: string
  inputs?: Record<string, string>
  steps: WorkflowStep[]
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface StepTrace {
  stepId: string
  tool: string
  status: StepStatus
  startedAt: number
  endedAt?: number
  durationMs?: number
  input?: Record<string, unknown>
  output?: string
  error?: string
  modelUsed?: string
  costUsd?: number
}

export interface WorkflowTrace {
  workflowName: string
  traceId: string
  startedAt: number
  endedAt?: number
  totalDurationMs?: number
  inputs: Record<string, unknown>
  steps: StepTrace[]
  finalStatus: StepStatus
}

/** Tool executor — delegates to the actual tool system. */
export type ToolExecutor = (
  toolName: string,
  input: Record<string, unknown>,
  context: WorkflowContext,
) => Promise<{ output: string; error?: string }>

export interface WorkflowContext {
  inputs: Record<string, unknown>
  stepResults: Record<string, Record<string, unknown>>
  cwd: string
  onProgress?: (stepId: string, status: StepStatus) => void
}

// ── YAML parsing (lightweight — no external dep) ───────────────

/**
 * Parse a simple YAML workflow definition.
 * Supports: name, description, inputs (key: type), steps (list of objects).
 * This is a minimal parser — not a general YAML parser. It handles the
 * subset needed for workflow definitions.
 */
export function parseWorkflow(yaml: string): WorkflowDef {
  const lines = yaml.split('\n')
  const def: WorkflowDef = { name: '', steps: [] }
  let currentStep: WorkflowStep | null = null
  let inInputs = false

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue

    // name: value
    const nameMatch = line.match(/^name:\s*(.+)$/)
    if (nameMatch) { def.name = nameMatch[1]!.trim(); continue }

    const descMatch = line.match(/^description:\s*(.+)$/)
    if (descMatch) { def.description = descMatch[1]!.trim(); continue }

    // inputs: section
    if (/^inputs:\s*$/.test(line)) { inInputs = true; def.inputs = {}; continue }
    if (inInputs && /^[a-z]/.test(line.trim()) && !line.startsWith(' ')) {
      inInputs = false // exited inputs section
    }
    if (inInputs) {
      const m = line.trim().match(/^(\w+):\s*(.+)$/)
      if (m) def.inputs![m[1]!] = m[2]!.trim()
      continue
    }

    // steps: section
    if (/^steps:\s*$/.test(line)) { continue }

    // New step: - id: xxx
    const stepMatch = line.match(/^\s*- (?:id:\s*)?(\w+)/)
    if (stepMatch) {
      if (currentStep) def.steps.push(currentStep)
      currentStep = { id: stepMatch[1]!, tool: '', input: {} }
      // Check if same line has tool: value
      const toolOnSameLine = line.match(/tool:\s*(\S+)/)
      if (toolOnSameLine) currentStep.tool = toolOnSameLine[1]!.replace(/['"]/g, '')
      continue
    }

    // Step properties (indented)
    if (currentStep && line.startsWith('    ')) {
      const trimmed = line.trim()
      const toolMatch = trimmed.match(/^tool:\s*(.+)$/)
      if (toolMatch) { currentStep.tool = toolMatch[1]!.trim().replace(/['"]/g, ''); continue }

      const dependsMatch = trimmed.match(/^depends_on:\s*\[(.*)\]$/)
      if (dependsMatch) {
        currentStep.depends_on = dependsMatch[1]!.split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean)
        continue
      }

      const onFailureMatch = trimmed.match(/^on_failure:\s*(.+)$/)
      if (onFailureMatch) { currentStep.on_failure = onFailureMatch[1]!.trim().replace(/['"]/g, ''); continue }

      const conditionMatch = trimmed.match(/^condition:\s*(.+)$/)
      if (conditionMatch) { currentStep.condition = conditionMatch[1]!.trim(); continue }

      // input: key-value pairs (one level deep)
      const inputMatch = trimmed.match(/^(\w+):\s*(.*)$/)
      if (inputMatch) {
        const key = inputMatch[1]!
        let val: unknown = inputMatch[2]!.trim().replace(/^["']|["']$/g, '')
        // Try parse as number/boolean
        if (val === 'true') val = true
        else if (val === 'false') val = false
        else if (/^\d+$/.test(val as string)) val = parseInt(val as string, 10)
        if (!currentStep.input) currentStep.input = {}
        currentStep.input[key] = val
      }
    }
  }
  if (currentStep) def.steps.push(currentStep)

  if (!def.name) throw new Error('Workflow must have a name')
  if (def.steps.length === 0) throw new Error('Workflow must have at least one step')
  for (const s of def.steps) {
    if (!s.tool) throw new Error(`Step "${s.id}" must have a tool`)
  }

  return def
}

// ── Variable resolution ────────────────────────────────────────

/**
 * Resolve `${var}` and `${step.field}` references in a value.
 * Supports nested objects/arrays. Unknown refs are left as-is (string).
 */
export function resolveVars(value: unknown, ctx: WorkflowContext): unknown {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (match, ref: string) => {
      const parts = ref.split('.')
      if (parts.length === 1) {
        // Top-level input variable
        const val = ctx.inputs[parts[0]!]
        return val !== undefined ? String(val) : match
      }
      // step.field reference
      const [stepId, ...fieldParts] = parts
      const stepResult = ctx.stepResults[stepId!]
      if (!stepResult) return match
      const fieldVal = fieldParts.reduce((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), stepResult as unknown)
      return fieldVal !== undefined ? String(fieldVal) : match
    })
  }
  if (Array.isArray(value)) return value.map(v => resolveVars(v, ctx))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) result[k] = resolveVars(v, ctx)
    return result
  }
  return value
}

// ── Topological sort (dependency-ordered execution) ────────────

export function topoSort(steps: WorkflowStep[]): WorkflowStep[] {
  const sorted: WorkflowStep[] = []
  const visited = new Set<string>()
  const visiting = new Set<string>()

  function visit(step: WorkflowStep) {
    if (visited.has(step.id)) return
    if (visiting.has(step.id)) throw new Error(`Circular dependency at step "${step.id}"`)
    visiting.add(step.id)
    for (const depId of step.depends_on ?? []) {
      const dep = steps.find(s => s.id === depId)
      if (!dep) throw new Error(`Step "${step.id}" depends on unknown step "${depId}"`)
      visit(dep)
    }
    visiting.delete(step.id)
    visited.add(step.id)
    sorted.push(step)
  }

  for (const s of steps) visit(s)
  return sorted
}

// ── Execution ──────────────────────────────────────────────────

/** Execute a workflow definition, returning a trace.
 *
 *  Steps run in topological order. When a step fails and has `on_failure`,
 *  execution loops back to the target step and replays from there. A
 *  per-workflow retry cap (default 3) prevents infinite loops. */
export async function runWorkflow(
  def: WorkflowDef,
  inputs: Record<string, unknown>,
  cwd: string,
  executor: ToolExecutor,
  onProgress?: (stepId: string, status: StepStatus) => void,
): Promise<WorkflowTrace> {
  const MAX_RETRIES = 3
  const traceId = `wf-${def.name}-${Date.now().toString(36)}`
  const trace: WorkflowTrace = {
    workflowName: def.name,
    traceId,
    startedAt: Date.now(),
    inputs,
    steps: [],
    finalStatus: 'pending',
  }
  const ctx: WorkflowContext = { inputs, stepResults: {}, cwd, onProgress }
  const ordered = topoSort(def.steps)

  let i = 0
  let retries = 0
  while (i < ordered.length) {
    const step = ordered[i]!
    const stepTrace: StepTrace = {
      stepId: step.id,
      tool: step.tool,
      status: 'running',
      startedAt: Date.now(),
    }

    // Check condition — skip without executing
    if (step.condition) {
      const resolvedCondition = resolveVars(step.condition, ctx)
      if (resolvedCondition === 'false' || resolvedCondition === false) {
        stepTrace.status = 'skipped'
        stepTrace.endedAt = Date.now()
        trace.steps.push(stepTrace)
        onProgress?.(step.id, 'skipped')
        i++
        continue
      }
    }

    onProgress?.(step.id, 'running')
    const resolvedInput = resolveVars(step.input ?? {}, ctx) as Record<string, unknown>

    try {
      stepTrace.input = resolvedInput
      const result = await executor(step.tool, resolvedInput, ctx)
      stepTrace.output = result.output?.slice(0, 2000) // cap trace size
      stepTrace.error = result.error
      stepTrace.status = result.error ? 'failed' : 'done'
      stepTrace.endedAt = Date.now()
      stepTrace.durationMs = stepTrace.endedAt - stepTrace.startedAt
      ctx.stepResults[step.id] = { output: result.output, ...(result.error ? { error: result.error } : {}) }
      trace.steps.push(stepTrace)
      onProgress?.(step.id, stepTrace.status)

      // on_failure: loop back to the target step with a retry cap.
      if (result.error && step.on_failure && retries < MAX_RETRIES) {
        const targetIdx = ordered.findIndex(s => s.id === step.on_failure)
        if (targetIdx >= 0) {
          retries++
          i = targetIdx
          continue
        }
      }

      // Failed without (or after exhausting) on_failure — stop the workflow
      if (result.error) {
        trace.finalStatus = 'failed'
        trace.endedAt = Date.now()
        trace.totalDurationMs = trace.endedAt - trace.startedAt
        return trace
      }
    } catch (err) {
      stepTrace.status = 'failed'
      stepTrace.error = err instanceof Error ? err.message : String(err)
      stepTrace.endedAt = Date.now()
      stepTrace.durationMs = stepTrace.endedAt - stepTrace.startedAt
      trace.steps.push(stepTrace)
      onProgress?.(step.id, 'failed')
      trace.finalStatus = 'failed'
      trace.endedAt = Date.now()
      trace.totalDurationMs = trace.endedAt - trace.startedAt
      return trace
    }
    i++
  }

  // Determine final status from the LAST trace of each step (a retried step
  // may have earlier 'failed' traces that were superseded by a later 'done').
  const lastByStep = new Map<string, StepTrace>()
  for (const s of trace.steps) lastByStep.set(s.stepId, s)
  trace.finalStatus = [...lastByStep.values()].every(s => s.status === 'done' || s.status === 'skipped') ? 'done' : 'failed'
  trace.endedAt = Date.now()
  trace.totalDurationMs = trace.endedAt - trace.startedAt
  return trace
}

// ── File I/O ───────────────────────────────────────────────────

/** Load a workflow from .rivet/workflows/<name>.yaml */
export function loadWorkflow(cwd: string, name: string): WorkflowDef | null {
  const paths = [
    join(cwd, WORKFLOWS_DIR, `${name}.yaml`),
    join(cwd, WORKFLOWS_DIR, `${name}.yml`),
    join(workflowsDir(), `${name}.yaml`),
  ]
  for (const p of paths) {
    if (existsSync(p)) return parseWorkflow(readFileSync(p, 'utf-8'))
  }
  return null
}

/** List all available workflows. */
export function listWorkflows(cwd: string): string[] {
  const names = new Set<string>()
  for (const dir of [join(cwd, WORKFLOWS_DIR), workflowsDir()]) {
    if (existsSync(dir)) {
      for (const f of readdirSync(dir)) {
        if (f.endsWith('.yaml') || f.endsWith('.yml')) names.add(f.replace(/\.ya?ml$/, ''))
      }
    }
  }
  return [...names].sort()
}

/** Save a trace to .rivet/traces/<traceId>.json */
export function saveTrace(cwd: string, trace: WorkflowTrace): void {
  const dir = join(cwd, TRACES_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${trace.traceId}.json`), JSON.stringify(trace, null, 2), 'utf-8')
}

/** Load a trace by ID. */
export function loadTrace(cwd: string, traceId: string): WorkflowTrace | null {
  const p = join(cwd, TRACES_DIR, `${traceId}.json`)
  if (!existsSync(p)) return null
  return JSON.parse(readFileSync(p, 'utf-8')) as WorkflowTrace
}

/** List recent traces. */
export function listTraces(cwd: string, limit = 10): WorkflowTrace[] {
  const dir = join(cwd, TRACES_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')) as WorkflowTrace } catch { return null } })
    .filter((t): t is WorkflowTrace => t !== null)
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit)
}

/** Format a trace for display (CLI replay). */
export function formatTrace(trace: WorkflowTrace): string {
  const lines = [
    `Workflow: ${trace.workflowName}  (${trace.traceId})`,
    `Status: ${trace.finalStatus}  Duration: ${trace.totalDurationMs ? `${(trace.totalDurationMs / 1000).toFixed(1)}s` : '—'}`,
    `Started: ${new Date(trace.startedAt).toLocaleString()}`,
    '',
    'Steps:',
  ]
  for (const s of trace.steps) {
    const glyph = s.status === 'done' ? '✓' : s.status === 'failed' ? '✗' : s.status === 'skipped' ? '⊘' : s.status === 'running' ? '◐' : '◌'
    const dur = s.durationMs ? `${(s.durationMs / 1000).toFixed(1)}s` : '—'
    lines.push(`  ${glyph} ${s.stepId} (${s.tool})  ${dur}`)
    if (s.error) lines.push(`    error: ${s.error}`)
  }
  return lines.join('\n')
}
