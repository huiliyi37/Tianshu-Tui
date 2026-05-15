export type Phase = 'idle' | 'searching' | 'coding' | 'testing' | 'running' | 'delegating'

export interface LastAction {
  tool: string
  target: string
  success: boolean
}

export class PhaseTracker {
  private phase: Phase = 'idle'
  private steps = 0
  private last: LastAction | null = null

  current(): Phase { return this.phase }
  stepCount(): number { return this.steps }
  lastAction(): LastAction | null { return this.last }

  onToolUse(toolName: string, target?: string): void {
    this.steps++
    this._pendingTarget = target ?? toolName
    switch (toolName) {
      case 'edit_file': case 'write_file':
        this.phase = 'coding'; break
      case 'run_tests':
        this.phase = 'testing'; break
      case 'read_file': case 'grep': case 'glob': case 'diff':
        this.phase = 'searching'; break
      case 'bash':
        this.phase = 'running'; break
      case 'delegate_task':
        this.phase = 'delegating'; break
      default: break
    }
  }

  onToolResult(toolName: string, isError: boolean): void {
    this.last = { tool: toolName, target: this._pendingTarget ?? toolName, success: !isError }
    this._pendingTarget = undefined
  }

  onTurnComplete(): void {
    this.phase = 'idle'
    this.steps = 0
  }

  private _pendingTarget?: string
}
