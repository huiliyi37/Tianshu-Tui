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

  onToolUse(toolName: string): void {
    this.steps++
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
    }
  }

  onToolResult(toolName: string, target: string, isError: boolean): void {
    this.last = { tool: toolName, target, success: !isError }
  }

  onTurnComplete(): void {
    this.phase = 'idle'
    this.steps = 0
  }
}
