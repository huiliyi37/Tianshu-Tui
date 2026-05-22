import type { ToolDefinition } from '../api/types.js'

export interface RepairContext {
  toolName: string
  schema: ToolDefinition['input_schema']
}

export interface RepairResult {
  output: Record<string, unknown>
  applied: boolean
  fixType?: string
}

export interface RepairPass {
  name: string
  run(input: Record<string, unknown>, ctx: RepairContext): RepairResult
}

export interface RepairTelemetryEntry {
  pass: string
  fixType: string
  toolName: string
  timestamp: number
}

export interface PipelineResult {
  output: Record<string, unknown>
  telemetry: RepairTelemetryEntry[]
}

export function summarizeRepairTelemetry(entries: RepairTelemetryEntry[]): string | null {
  if (entries.length === 0) return null
  const compact = entries.map(e => `${e.fixType}(${e.toolName})`).join(', ')
  return `repair: ${compact}`
}

export class RepairPipeline {
  constructor(private passes: RepairPass[]) {}

  run(input: Record<string, unknown>, ctx: RepairContext): PipelineResult {
    const telemetry: RepairTelemetryEntry[] = []
    let current = input

    for (const pass of this.passes) {
      const result = pass.run(current, ctx)
      if (result.applied) {
        current = result.output
        telemetry.push({
          pass: pass.name,
          fixType: result.fixType ?? pass.name,
          toolName: ctx.toolName,
          timestamp: Date.now(),
        })
      }
    }

    return { output: current, telemetry }
  }
}

/** Validate required fields are present in tool input */
export function validateRequiredFields(
  input: Record<string, unknown>,
  required: string[],
): string[] {
  if (required.length === 0) return []
  return required.filter(f => input[f] === undefined || input[f] === null)
}
