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
