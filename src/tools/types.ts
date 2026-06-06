import type { ToolDefinition } from '../api/types.js'
import type { ArtifactStore } from '../artifact/store.js'
import type { ProviderProfile } from '../api/provider-profile.js'

export interface ToolCallParams {
  input: Record<string, unknown>
  toolUseId: string
  cwd: string
  onOutput?: (chunk: string) => void
  /** Files this session/tool pipeline owns and may safely include in scoped write operations. */
  sessionModifiedFiles?: string[]
  /** Artifact store for persisting tool output — no global setter, always inject via params */
  artifactStore?: ArtifactStore
  /** B1: Task identifier for ownership attribution */
  taskId?: string
  /** B1: Files owned by the current task (subset of sessionModifiedFiles, excluding externals) */
  ownedFiles?: string[]
  /** B1: Worktree baseline hash for integrity verification */
  baselineHash?: string
  /** P0-2: Active context window — drives per-call read caps for read_file/grep. */
  contextWindow?: number
  /** P0-2: Provider profile — read caps relax for cache-preserving providers. */
  providerProfile?: Pick<ProviderProfile, 'cacheType' | 'persistent'>
  /** Current session turn count — enables progressive timeout strategies. */
  sessionTurnCount?: number
  /** Review-router re-entrancy depth propagated into worker contexts. */
  reviewDepth?: number
  /** AbortSignal from the tool pipeline — fires when the tool-level timeout
   *  rejects. Delegate tools propagate this to the coordinator so zombie
   *  workers are cleaned up immediately. */
  abortSignal?: AbortSignal
}

export type VerificationFailureKind = 'test_failure' | 'tool_invocation_failure'

export interface VerificationMetadata {
  command: string
  status: 'passed' | 'failed' | 'blocked'
  scope: 'full' | 'targeted'
  exitCode: number
  passed: number
  failed: number
  skipped: number
  durationMs: number
  failureKind?: VerificationFailureKind
  targetFiles?: string[]
  resolvedCommand?: string
  recommendedCommand?: string
}

export interface ToolResult {
  /** Content sent to model as tool_result */
  content: string
  /** UI summary override — falls back to content if not provided */
  uiContent?: string
  /** Path to persisted raw output file */
  rawPath?: string
  isError?: boolean
  verification?: VerificationMetadata
}

export interface Tool {
  definition: ToolDefinition
  execute(params: ToolCallParams): Promise<ToolResult>
  requiresApproval(params: ToolCallParams): boolean
  isConcurrencySafe(): boolean
  isEnabled(): boolean
  /** Maximum execution time in ms before the tool-pipeline aborts.
   *  Override for long-running orchestrator tools (delegate, batch).
   *  Default: 120 000 (2 minutes). */
  timeoutMs?(params?: ToolCallParams): number
}
