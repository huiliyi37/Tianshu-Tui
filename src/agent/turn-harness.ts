import { TrajectoryRecorder, type TrajectoryEntry } from './trajectory.js'
import { isTransient, type FailureClass } from './failure-classifier.js'

export interface ToolExecution {
  id: string
  name: string
  input: Record<string, unknown>
  execute: () => Promise<{ content: string; isError?: boolean }>
  classify: (content: string) => FailureClass | undefined
}

export interface ToolExecutionResult {
  content: string
  isError: boolean
  retried: boolean
  errorClass?: string
}

export interface TurnHarnessConfig {
  maxRetries: number
  retryableClasses: string[]
  onBeforeTool?: (name: string, input: Record<string, unknown>) => void
  onAfterTool?: (name: string, result: string, isError: boolean) => void
}

export class TurnHarness {
  constructor(
    private config: TurnHarnessConfig,
    private trajectory: TrajectoryRecorder,
  ) {}

  async executeTool(exec: ToolExecution): Promise<ToolExecutionResult> {
    this.config.onBeforeTool?.(exec.name, exec.input)
    const start = Date.now()

    let result = await exec.execute()
    let retried = false
    let errorClass: string | undefined

    if (result.isError) {
      errorClass = exec.classify(result.content) ?? undefined
      if (
        errorClass
        && isTransient(errorClass as FailureClass)
        && this.config.retryableClasses.includes(errorClass)
        && this.config.maxRetries > 0
      ) {
        retried = true
        result = await exec.execute()
        if (result.isError) {
          result = {
            content: `${result.content}\n\n[Retry failed. Error class: ${errorClass}. This is a transient error — consider alternative approach.]`,
            isError: true,
          }
        }
      }
    }

    const durationMs = Date.now() - start
    const status: TrajectoryEntry['status'] = retried
      ? (result.isError ? 'retried-failed' : 'retried-success')
      : (result.isError ? 'failed' : 'success')

    const target = typeof exec.input.file_path === 'string'
      ? exec.input.file_path
      : typeof exec.input.path === 'string'
        ? exec.input.path
        : typeof exec.input.command === 'string'
          ? exec.input.command.slice(0, 50)
          : exec.name

    this.trajectory.record({
      turn: 0,
      tool: exec.name,
      target,
      durationMs,
      status,
      errorClass: result.isError ? errorClass : undefined,
      inputSummary: JSON.stringify(exec.input).slice(0, 100),
      resultSummary: result.content.slice(0, 200),
    })

    this.config.onAfterTool?.(exec.name, result.content, result.isError ?? false)
    return { content: result.content, isError: result.isError ?? false, retried, errorClass }
  }
}
