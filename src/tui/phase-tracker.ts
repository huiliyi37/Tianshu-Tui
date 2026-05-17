export type Phase = 'idle' | 'searching' | 'coding' | 'testing' | 'running' | 'delegating' | 'interview'

export interface LastAction {
  tool: string
  target: string
  success: boolean
}

function toolPhase(toolName: string): Phase {
  switch (toolName) {
    case 'edit_file': case 'write_file':
      return 'coding'
    case 'run_tests':
      return 'testing'
    case 'read_file': case 'grep': case 'glob': case 'diff':
      return 'searching'
    case 'bash':
      return 'running'
    case 'delegate_task': case 'delegate_batch':
      return 'delegating'
    default: return 'idle'
  }
}

export class PhaseTracker {
  private phase: Phase = 'idle'
  private steps = 0
  private last: LastAction | null = null
  private pendingPhase: Phase = 'idle'
  private pendingCount = 0

  current(): Phase { return this.phase }
  stepCount(): number { return this.steps }
  lastAction(): LastAction | null { return this.last }

  onToolUse(toolName: string, target?: string): void {
    this.steps++
    this._pendingTarget = target ?? toolName
    const candidate = toolPhase(toolName)
    if (candidate === 'idle') return

    if (candidate === this.pendingPhase) {
      this.pendingCount++
      if (this.pendingCount >= 2) {
        this.phase = candidate
      }
    } else {
      this.pendingPhase = candidate
      this.pendingCount = 1
    }
  }

  onToolResult(toolName: string, isError: boolean): void {
    this.last = { tool: toolName, target: this._pendingTarget ?? toolName, success: !isError }
    this._pendingTarget = undefined
  }

  onTurnComplete(): void {
    this.phase = 'idle'
    this.pendingPhase = 'idle'
    this.pendingCount = 0
    this.steps = 0
  }

  private _pendingTarget?: string
}
