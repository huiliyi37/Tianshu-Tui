import type { Usage } from './api/types.js'
import type { AgentCallbacks, AgentLoop } from './agent/loop.js'

export interface HeadlessCliArgs {
  headless: boolean
  prompt?: string
  json: boolean
  streamJson: boolean
  goal?: string
  budget?: number
}

export interface HeadlessJsonOutput {
  success: boolean
  text: string
  usage?: Partial<Usage>
  error?: string
}

export interface HeadlessRunResult {
  exitCode: number
  stdout: string
  stderr?: string
  json?: HeadlessJsonOutput
}

export interface HeadlessAgent {
  run(prompt: string, callbacks: AgentCallbacks): Promise<void>
}

export interface HeadlessRunConfig {
  prompt: string
  json: boolean
  streamJson: boolean
  createAgent: () => Pick<AgentLoop, 'run'> | HeadlessAgent
}

export function parseCliArgs(args: string[]): HeadlessCliArgs {
  const printIndex = args.findIndex(arg => arg === '-p' || arg === '--print')
  const goalIndex = args.findIndex(arg => arg === '--goal')
  const json = args.includes('--json')
  const streamJson = args.includes('--stream-json')

  if (goalIndex >= 0) {
    const goal = args[goalIndex + 1]
    const budgetIndex = args.indexOf('--budget')
    const budget = budgetIndex >= 0 ? parseInt(args[budgetIndex + 1]!, 10) : 100
    return { headless: true, prompt: undefined, json, streamJson, goal, budget }
  }

  if (printIndex === -1) return { headless: false, json, streamJson }

  const prompt = args[printIndex + 1]
  return { headless: true, prompt, json, streamJson }
}

export async function runHeadless(config: HeadlessRunConfig): Promise<HeadlessRunResult> {
  const agent = config.createAgent()
  let text = ''
  let usage: Partial<Usage> | undefined
  let error: string | undefined

  const callbacks: AgentCallbacks = config.streamJson
    ? {
        onTextDelta: delta => {
          text += delta
          process.stdout.write(JSON.stringify({ type: 'text_delta', text: delta }) + '\n')
        },
        onThinkingDelta: () => {},
        onToolUse: (id, name, input) => {
          process.stdout.write(JSON.stringify({ type: 'tool_use', id, name, input }) + '\n')
        },
        onToolResult: (id, name, result, isError) => {
          if (isError) error = result
          process.stdout.write(JSON.stringify({ type: 'tool_result', id, name, isError, result: result.slice(0, 500) }) + '\n')
        },
        onTurnComplete: turnUsage => {
          usage = turnUsage
          process.stdout.write(JSON.stringify({ type: 'turn_complete', usage: turnUsage }) + '\n')
        },
        onError: err => {
          error = err.message
          process.stdout.write(JSON.stringify({ type: 'error', error: err.message }) + '\n')
        },
        onAbort: () => { error = 'Aborted' },
        onApprovalRequired: async () => false,
      }
    : {
        onTextDelta: delta => { text += delta },
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onToolResult: (_id, _name, result, isError) => {
          if (isError) error = result
        },
        onTurnComplete: turnUsage => { usage = turnUsage },
        onError: err => { error = err.message },
        onAbort: () => { error = 'Aborted' },
        onApprovalRequired: async () => false,
      }

  await agent.run(config.prompt, callbacks)

  const success = !error
  const payload: HeadlessJsonOutput = success
    ? { success: true, text, ...(usage ? { usage } : {}) }
    : { success: false, text, error: error ?? 'Unknown error' }

  const stdout = config.json ? JSON.stringify(payload) : config.streamJson ? '' : payload.text

  return {
    exitCode: success ? 0 : 1,
    stdout,
    json: (config.json || config.streamJson) ? payload : undefined,
  }
}
