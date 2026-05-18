import type { CompactionConfig } from '../compact/constants.js'
import { WorktreeCoordinator } from './worktree-coordinator.js'
import { collectDiff, formatDiffArtifact } from './diff-collector.js'
import {
  buildBlockedWorkerResult,
  parseWorkerResult,
  type WorkOrder,
  type WorkerResult,
} from './work-order.js'
import { buildWorkerPrompt } from './worker-prompts.js'
import type { AgentCallbacks } from './loop.js'
import type { Usage } from '../api/types.js'

export interface HandsSessionConfig {
  order: WorkOrder
  wtCoordinator: WorktreeCoordinator
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  activeClaims?: import('../context/claims.js').ContextClaim[]
  /**
   * Run the worker agent in the worktree.
   * Receives the worker prompt and AgentCallbacks; returns the full text output
   * which must contain a schema-valid WorkerResult JSON.
   */
  runAgent: (prompt: string, callbacks: AgentCallbacks) => Promise<string>
}

export interface HandsSessionRun {
  result: WorkerResult
  usage: Partial<Usage>
}

/**
 * Execute a write-capable worker in an isolated git worktree.
 *
 * Lifecycle:
 * 1. Create a worktree for the worker
 * 2. Run the agent with the worker prompt
 * 3. Parse the WorkerResult from the agent's output
 * 4. Collect git diff from the worktree and attach as artifact
 * 5. Clean up the worktree (always, even on failure)
 */
export async function runHandsSession(config: HandsSessionConfig): Promise<HandsSessionRun> {
  const wt = config.wtCoordinator.create(config.order.id)
  try {
    let text = ''
    let apiError: string | undefined
    let turnUsage: Partial<Usage> = {}

    text = await config.runAgent(buildWorkerPrompt(config.order), {
      onTextDelta: (delta) => { text += delta },
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (usage) => { turnUsage = usage },
      onError: (err) => { apiError = err.message },
      onAbort: () => { apiError = 'aborted' },
      onApprovalRequired: async () => false,
    })

    if (apiError) {
      return {
        result: buildBlockedWorkerResult(config.order, apiError),
        usage: turnUsage,
      }
    }

    const mainBranch = 'main'
    const diff = collectDiff(config.cwd, wt.path, mainBranch)

    let result: WorkerResult
    try {
      result = parseWorkerResult(text, config.order.id)
    } catch {
      result = buildBlockedWorkerResult(config.order, 'Worker result unparseable')
    }

    if (diff) {
      result.artifacts.push(formatDiffArtifact(diff, config.order.profile))
    }

    return { result, usage: turnUsage }
  } finally {
    config.wtCoordinator.remove(config.order.id)
  }
}
