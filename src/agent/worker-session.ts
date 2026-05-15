import type { ApiClient } from '../api/client.js'
import type { Usage } from '../api/types.js'
import type { CompactionConfig } from '../compact/constants.js'
import { PromptEngine } from '../prompt/engine.js'
import { ToolRegistry } from '../tools/registry.js'
import { AgentLoop } from './loop.js'
import { SessionContext } from './context.js'
import {
  buildBlockedWorkerResult,
  parseWorkerResult,
  type WorkOrder,
  type WorkerResult,
} from './work-order.js'
import { buildWorkerPrompt, buildWorkerRepairPrompt } from './worker-prompts.js'

export interface WorkerSessionConfig {
  order: WorkOrder
  client: ApiClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
}

export interface WorkerTranscript {
  text: string
  thinking: string
  toolUses: string[]
  toolResults: string[]
  errors: string[]
  repairAttempts: number
}

export interface WorkerSessionRun {
  result: WorkerResult
  transcript: WorkerTranscript
  session: SessionContext
  usage: Usage
}

function emptyTranscript(): WorkerTranscript {
  return {
    text: '',
    thinking: '',
    toolUses: [],
    toolResults: [],
    errors: [],
    repairAttempts: 0,
  }
}

async function runOnce(agent: AgentLoop, prompt: string, transcript: WorkerTranscript): Promise<string> {
  let text = ''
  await agent.run(prompt, {
    onTextDelta: (delta) => {
      text += delta
      transcript.text += delta
    },
    onThinkingDelta: (delta) => {
      transcript.thinking += delta
    },
    onToolUse: (_id, name) => {
      transcript.toolUses.push(name)
    },
    onToolResult: (_id, name, result, isError) => {
      transcript.toolResults.push(name)
      if (isError) transcript.errors.push(result)
    },
    onTurnComplete: () => {},
    onError: (error) => {
      transcript.errors.push(error.message)
    },
    onAbort: () => {
      transcript.errors.push('Worker aborted')
    },
    onApprovalRequired: async () => false,
  })
  return text
}

export async function runWorkerSession(config: WorkerSessionConfig): Promise<WorkerSessionRun> {
  const session = new SessionContext()
  const agent = new AgentLoop({
    client: config.client,
    promptEngine: config.promptEngine,
    toolRegistry: config.toolRegistry,
    maxTurns: config.maxTurns,
    contextWindow: config.contextWindow,
    compact: config.compact,
  }, session, config.cwd)

  const timeoutMs = config.order.budget.timeoutMs
  const timer = setTimeout(() => agent.abort(), timeoutMs)

  try {
    const transcript = emptyTranscript()
    let latestText = await runOnce(agent, buildWorkerPrompt(config.order), transcript)

    for (let attempt = 0; attempt <= config.order.budget.maxRetries; attempt++) {
      try {
        const result = parseWorkerResult(latestText, config.order.id)
        return {
          result,
          transcript,
          session,
          usage: session.getTotalUsage(),
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        transcript.errors.push(message)
        if (attempt === config.order.budget.maxRetries) {
          return {
            result: buildBlockedWorkerResult(config.order, message),
            transcript,
            session,
            usage: session.getTotalUsage(),
          }
        }
        transcript.repairAttempts++
        latestText = await runOnce(agent, buildWorkerRepairPrompt(config.order, latestText, message), transcript)
      }
    }

    return {
      result: buildBlockedWorkerResult(config.order, 'Worker result parser exited unexpectedly'),
      transcript,
      session,
      usage: session.getTotalUsage(),
    }
  } finally {
    clearTimeout(timer)
  }
}
