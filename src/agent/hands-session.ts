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
  /** Shared-worktree mode: when true, the worker runs directly in `cwd` (the
   *  controller's single shared worktree/branch) instead of spawning its own
   *  git worktree. Orthogonal shards write disjoint files; the file-claim
   *  registry + same-file wave serialization prevent stomping. No per-worker
   *  isolated diff is collected — the controller reads aggregate git diff on the
   *  shared workspace. Reuses the same code path as the git-absent in-place
   *  fallback. */
  sharedWorkspace?: boolean
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
  let wt: { path: string; branch?: string }
  let inPlace = false
  if (config.sharedWorkspace) {
    // Shared-worktree mode: run directly in the controller's single shared cwd.
    // No per-worker worktree, no isolated diff — orthogonal shards write disjoint
    // files and the file-claim registry prevents same-file stomping.
    wt = { path: config.cwd }
    inPlace = true
  } else {
    // Worktree isolation requires git. When git is absent (or the cwd isn't a git
    // repo), createWorktree throws — we fall back to running in-place in the
    // primary cwd. This mirrors session-manager's isolatedWorktree fallback
    // (session-manager.ts). In-place is safe because Rivet's file-claim registry
    // already prevents cross-worker write conflicts on the same branch — same
    // guarantee that lets multiple sessions share a cwd. The only loss is the
    // worktree-scoped diff (collected below only when a real worktree exists).
    try {
      wt = config.wtCoordinator.create(config.order.id)
    } catch {
      wt = { path: config.cwd }
      inPlace = true
    }
  }
  config.order.workerCwd = wt.path
  try {
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

    // Collect diff only when running in a real worktree (in-place mode has no
    // isolated worktree and no base ref, so diff is meaningless).
    const baseRef = inPlace ? undefined : (config.baseRef ?? getCurrentGitRef(config.cwd))
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
