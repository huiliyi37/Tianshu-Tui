import { TrajectoryRecorder, type TrajectoryEntry } from './trajectory.js'
import { isTransient, type FailureClass } from './failure-classifier.js'

export interface ToolExecution {
  id: string
  name: string
  input: Record<string, unknown>
  turn: number
  execute: () => Promise<{ content: string; isError?: boolean }>
  classify: (content: string) => FailureClass | undefined
}

export interface ToolExecutionResult {
  content: string
  isError: boolean
  retried: boolean
  errorClass?: FailureClass
}

export interface TurnHarnessConfig {
  maxRetries: number
  retryableClasses: string[]
}

export class TurnHarness {
  constructor(
    private config: TurnHarnessConfig,
    private trajectory: TrajectoryRecorder,
  ) {}

  async executeTool(exec: ToolExecution): Promise<ToolExecutionResult> {
    const start = Date.now()

    let result = await exec.execute()
    let retried = false
    let errorClass: FailureClass | undefined

    if (result.isError) {
      errorClass = exec.classify(result.content) ?? undefined
      if (
        errorClass
        && isTransient(errorClass)
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
      turn: exec.turn,
      tool: exec.name,
      target,
      durationMs,
      status,
      errorClass: result.isError ? errorClass : undefined,
      inputSummary: JSON.stringify(exec.input).slice(0, 100),
      resultSummary: result.content.slice(0, 200),
    })

    return { content: result.content, isError: result.isError ?? false, retried, errorClass }
  }
}
