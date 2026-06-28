import type { CompactionConfig } from '../compact/constants.js'
import { WorktreeCoordinator } from './worktree-coordinator.js'
import { getCurrentGitRef } from './worktree.js'
import { collectDiff, formatDiffArtifact } from './diff-collector.js'
import {
  buildBlockedWorkerResult,
  parseWorkerResult,
  type WorkOrder,
  type WorkerResult,
} from './work-order.js'
import { buildWorkerPrompt, buildWorkerRepairPrompt } from './worker-prompts.js'
import { buildWorkerKnowledgeBlock } from './worker-knowledge.js'
import { buildDomainKnowledgeBlock } from './domain-knowledge-block.js'
import type { DomainKnowledgeStore } from './domain-knowledge-store.js'
import { materializeScope } from './worktree-scope.js'
import type { AgentCallbacks } from './loop-types.js'
import type { Usage } from '../api/types.js'

function worktreeScopeFiles(order: WorkOrder): string[] {
  const changed = order.scope.files ?? []
  const explicitlyReadable = changed.filter(file => !file.startsWith('src/'))
  return explicitlyReadable
}

function buildHandsPrompt(config: HandsSessionConfig): string {
  const knowledgeBlocks = [
    config.activeClaims ? buildWorkerKnowledgeBlock(config.activeClaims) : '',
    config.domainKnowledgeStore && config.order.authority
      ? buildDomainKnowledgeBlock(config.domainKnowledgeStore, config.order.authority)
      : '',
  ].filter(Boolean)
  return [...knowledgeBlocks, buildWorkerPrompt(config.order)].join('\n\n')
}

export interface HandsSessionConfig {
  order: WorkOrder
  wtCoordinator: WorktreeCoordinator
  cwd: string
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  activeClaims?: import('../context/claims.js').ContextClaim[]
  /** V3 Component B: optional per-domain lessons recalled into worker prompt. */
  domainKnowledgeStore?: DomainKnowledgeStore
  /** Base git ref to diff worker changes against. Defaults to current branch/HEAD of cwd. */
  baseRef?: string
  /** Optional artifact store to persist the worker diff for independent review.
   *  When provided, the diff is saved (into the worker's fallback session) and the
   *  resulting artifactId is attached to the WorkerResult, so the UI can fetch it.
   *  Persistence failure is non-fatal — diffArtifactId is left undefined and the
   *  diff still travels in result.artifacts as before. */
  artifactStore?: { save(input: { tool: string; target: string; rawContent: string; summary: string; sections?: unknown[] }): Promise<string> }
  /**
   * Run the worker agent in the worktree.
   * Receives the worker prompt and AgentCallbacks; returns the full text output
   * which must contain a schema-valid WorkerResult JSON.
   */
  runAgent: (prompt: string, callbacks: AgentCallbacks, workerCwd: string) => Promise<string>
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
  try {
    const wt = config.wtCoordinator.create(config.order.id)
    config.order.workerCwd = wt.path
    const scopeResult = materializeScope(config.cwd, wt.path, worktreeScopeFiles(config.order))
    if (scopeResult.missing.length > 0) {
      return {
        result: buildBlockedWorkerResult(
          config.order,
          `Worker scope file(s) are missing or outside the project: ${scopeResult.missing.join(', ')}`,
        ),
        usage: {},
     }
   }
    let text = ''
    let apiError: string | undefined
    let turnUsage: Partial<Usage> = {}

    text = await config.runAgent(buildHandsPrompt(config), {
      onTextDelta: (delta) => { text += delta },
      onThinkingDelta: () => {},
      onToolUse: () => {},
      onToolResult: () => {},
      onTurnComplete: (usage) => { turnUsage = usage },
      onError: (err) => { apiError = err.message },
      onAbort: () => { apiError = 'aborted' },
      onApprovalRequired: async () => false,
   }, wt.path)

    if (apiError) {
      return {
        result: buildBlockedWorkerResult(config.order, apiError),
        usage: turnUsage,
     }
   }

    const baseRef = config.baseRef ?? getCurrentGitRef(config.cwd)
    const diff = baseRef ? collectDiff(config.cwd, wt.path, baseRef) : ''

    let result: WorkerResult
    try {
      result = parseWorkerResult(text, config.order.id)
   } catch (parseError) {
      const message = parseError instanceof Error ? parseError.message : String(parseError)
      // Retry: send repair prompt and re-parse (mirrors worker-session.ts retry loop)
      result = buildBlockedWorkerResult(config.order, message) // default — overwritten on success
      for (let attempt = 0; attempt < config.maxTurns && attempt < 2; attempt++) {
        try {
          const repairPrompt = buildWorkerRepairPrompt(config.order, text, message)
          text = await config.runAgent(repairPrompt, {
            onTextDelta: (delta) => { text += delta },
            onThinkingDelta: () => {},
            onToolUse: () => {},
            onToolResult: () => {},
            onTurnComplete: (usage) => { turnUsage = usage },
            onError: (err) => { apiError = err.message },
            onAbort: () => { apiError = 'aborted' },
            onApprovalRequired: async () => false,
         }, wt.path)

          if (apiError) break // API error during repair — fall through to blocked

          result = parseWorkerResult(text, config.order.id)
          break
       } catch {
          // Repair attempt failed — try again
          continue
       }
     }
   }

    if (diff) {
      result.artifacts.push(formatDiffArtifact(diff, config.order.profile))
      // Persist the diff so the UI can review it independently. Saved into the
      // worker's fallback session (worker-<orderId>); fetchable by artifactId.
      // Failure is non-fatal: diffArtifactId stays undefined, diff still in artifacts.
      if (config.artifactStore) {
        try {
          result.diffArtifactId = await config.artifactStore.save({
            tool: 'hands_session',
            target: config.order.id,
            rawContent: diff,
            summary: `Patch: ${config.order.profile ?? 'worker'}`,
          })
        } catch {
          // 落盘失败（磁盘满/store 未注入正确 session 等）— 降级，前端隐藏 diff 入口
        }
      }
    }

    return { result, usage: turnUsage }
 } finally {
    config.wtCoordinator.remove(config.order.id)
 }
}
