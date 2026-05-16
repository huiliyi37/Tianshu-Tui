import type { Usage } from './api/types.js'
import type { AgentCallbacks, AgentLoop } from './agent/loop.js'

export interface HeadlessCliArgs {
  headless: boolean
  prompt?: string
  json: boolean
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
  createAgent: () => Pick<AgentLoop, 'run'> | HeadlessAgent
}

export function parseCliArgs(args: string[]): HeadlessCliArgs {
  const printIndex = args.findIndex(arg => arg === '-p' || arg === '--print')
  const json = args.includes('--json')

  if (printIndex === -1) return { headless: false, json }

  const prompt = args[printIndex + 1]
  return { headless: true, prompt, json }
}

function stringifyOutput(result: HeadlessJsonOutput, json: boolean): string {
  return json ? JSON.stringify(result) : result.text
}

export async function runHeadless(config: HeadlessRunConfig): Promise<HeadlessRunResult> {
  const agent = config.createAgent()
  let text = ''
  let usage: Partial<Usage> | undefined
  let error: string | undefined

  await agent.run(config.prompt, {
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
  })

  const success = !error
  const payload: HeadlessJsonOutput = success
    ? { success: true, text, ...(usage ? { usage } : {}) }
    : { success: false, text, error: error ?? 'Unknown error' }

  return {
    exitCode: success ? 0 : 1,
    stdout: stringifyOutput(payload, config.json),
    json: config.json ? payload : undefined,
  }
}
