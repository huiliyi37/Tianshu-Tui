import type { AgentCallbacks } from './agent/loop.js'
import type { Usage } from './api/types.js'

export interface GoalLoopAgent {
  run(prompt: string, callbacks: AgentCallbacks): Promise<void>
}

export interface GoalLoopConfig {
  goal: string
  budget: number
  createAgent: () => GoalLoopAgent
  checkGoalAchieved: (lastOutput: string) => boolean
  onIteration?: (iteration: number, text: string, usage: Partial<Usage>) => void
  streamJson?: boolean
}

export interface GoalLoopResult {
  achieved: boolean
  iterations: number
  exitReason: 'goal_achieved' | 'budget_exhausted' | 'consecutive_failures' | 'aborted'
  totalUsage: { input_tokens: number; output_tokens: number }
  lastOutput: string
}

export async function runGoalLoop(config: GoalLoopConfig): Promise<GoalLoopResult> {
  const agent = config.createAgent()
  let iterations = 0
  let consecutiveFailures = 0
  let lastOutput = ''
  const totalUsage = { input_tokens: 0, output_tokens: 0 }

  while (iterations < config.budget) {
    iterations++
    let text = ''
    let error: string | undefined
    let turnUsage: Partial<Usage> = {}
    const toolResults: string[] = []

    const prompt = iterations === 1
      ? `Goal: ${config.goal}\n\nWork toward this goal. When complete, clearly state the goal is achieved.`
      : `Goal: ${config.goal}\n\nPrevious attempt output:\n${lastOutput.slice(-2000)}\n\nContinue working toward the goal.`

    await agent.run(prompt, {
      onTextDelta: (delta) => { text += delta },
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: (_id, _name, result, isError) => {
        if (!isError) toolResults.push(result.slice(0, 500))
        if (isError) error = result
      },
      onTurnComplete: (usage) => { turnUsage = usage },
      onError: (err) => { error = err.message },
      onAbort: () => { error = 'aborted' },
      onApprovalRequired: async () => false,
    })

    totalUsage.input_tokens += turnUsage.input_tokens ?? 0
    totalUsage.output_tokens += turnUsage.output_tokens ?? 0
    lastOutput = text

    if (config.streamJson) {
      process.stdout.write(JSON.stringify({
        type: 'goal_iteration',
        iteration: iterations,
        achieved: false,
        usage: turnUsage,
        text: text.slice(0, 500),
      }) + '\n')
    }

    config.onIteration?.(iterations, text, turnUsage)

    if (error === 'aborted') {
      return { achieved: false, iterations, exitReason: 'aborted', totalUsage, lastOutput }
    }

    if (error) {
      consecutiveFailures++
      if (consecutiveFailures >= 3) {
        return { achieved: false, iterations, exitReason: 'consecutive_failures', totalUsage, lastOutput }
      }
      continue
    }

    consecutiveFailures = 0

    const fullContext = text + '\n' + toolResults.join('\n')
    if (config.checkGoalAchieved(fullContext)) {
      return { achieved: true, iterations, exitReason: 'goal_achieved', totalUsage, lastOutput }
    }
  }

  return { achieved: false, iterations, exitReason: 'budget_exhausted', totalUsage, lastOutput }
}
