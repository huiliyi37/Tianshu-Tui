import type { ToolDefinition } from '../api/types.js'
import type { ArtifactStore } from '../artifact/store.js'
import type { ProviderProfile } from '../api/provider-profile.js'

/**
 * T4 — structured per-worker delegation update for the desktop subagent panel
 * (Codex `Down` panel / Antigravity Manager parity). Emitted alongside (not
 * replacing) the existing text progress stream. `running` carries the latest
 * activity line; a terminal status carries the worker's outcome.
 */
export interface DelegationActivity {
  /** Stable per-worker id within a run (work order id), distinct from the tool id. */
  workOrderId: string
  /** The delegation tool call that spawned this worker (delegation tree parent). */
  parentToolId: string
  profile?: string
  /** 星域 id（星名来源），从 WorkerActivityEvent.authority 透传。 */
  authority?: string
  status: 'running' | 'passed' | 'failed' | 'blocked' | 'escalated'
  /** Latest worker activity line (running) or terminal summary. */
  progressLine?: string
}

/**
 * An agent's self-chosen departure mark, captured by the `leave_mark` tool and
 * recorded by 主控 (the post-session hook) as one constellation milestone.
 */
export interface LeaveMarkInput {
  /** Agent's self-chosen symbol (any glyph). */
  symbol: string
  /** One-line summary of the journey. */
  summary: string
  type?: 'feature' | 'fix' | 'refactor' | 'architecture' | 'milestone'
  tags?: string[]
}

export interface PlanClosedInput {
  planFile: string
  tasks: string
  deliveryState: 'GREEN' | 'YELLOW' | 'RED'
  totalChangedCheckboxes: number
}

/**
 * VSW: a resolved snapshot plan attached to a verification tool call. Built by
 * the session-scoped verification-snapshot-manager from the §6 policy decision.
 */
export interface VerificationSnapshotPlan {
  /** Snapshot worktree directory (Phase A cwd). */
  path: string
  /** Content-addressed identity (baselineHead + sha(ownedDiff)) for metadata. */
  snapshotRef: string
}

export interface ToolCallParams {
  input: Record<string, unknown>
  toolUseId: string
  cwd: string
  onOutput?: (chunk: string) => void
  /** Capture an agent's departure mark for 主控 to record at session close. */
  onLeaveMark?: (mark: LeaveMarkInput) => void
  /** Write a constellation milestone when plan_close succeeds with apply=true. */
  onPlanClosed?: (input: PlanClosedInput) => void
  /** U6/C1: capture the goal decomposition (ordered step descriptions) produced
   *  by the plan_steps tool during planning. The loop maps these into the active
   *  PlanExecutionTrace. Absent in non-task / worker contexts → tool is a no-op. */
  onPlanSteps?: (descriptions: string[]) => void
  /** T4: structured per-worker delegation updates (subagent panel). Optional —
   *  set by the tool pipeline; absent in non-server contexts (no-op). */
  onWorkerActivity?: (activity: DelegationActivity) => void
  /** Files this session/tool pipeline owns and may safely include in scoped write operations. */
  sessionModifiedFiles?: string[]
  /** Artifact store for persisting tool output — no global setter, always inject via params */
  artifactStore?: ArtifactStore
  /** B1: Task identifier for ownership attribution */
  taskId?: string
  /** B1: Files owned by the current task (subset of sessionModifiedFiles, excluding externals) */
  ownedFiles?: string[]
  /** B1: Worktree baseline hash for integrity verification (structural identity, NOT a commit) */
  baselineHash?: string
  /** VSW: real baseline commit SHA captured at task start (BaselineSnapshot.head).
   *  Distinct from baselineHash — this is the commit-ish a snapshot worktree
   *  detaches onto so verification runs on (baseline.head + owned diff). */
  baselineHead?: string
  /** VSW: active snapshot plan for this verification. When present, run_tests
   *  runs two phases — Phase A in `path` (isolated, blocking) tagged with
   *  `snapshotRef`, then Phase B in the live `cwd` (integration, advisory).
   *  Absent → in-place single-phase verification (default, unchanged). */
  verificationSnapshot?: VerificationSnapshotPlan
  /** P0-2: Active context window — drives per-call read caps for read_file/grep. */
  contextWindow?: number
  /** P0-2: Provider profile — read caps relax for cache-preserving providers. */
  providerProfile?: Pick<ProviderProfile, 'cacheType' | 'persistent'>
  /** Current session turn count — enables progressive timeout strategies. */
  sessionTurnCount?: number
  /** Review-router re-entrancy depth propagated into worker contexts. */
  reviewDepth?: number
  /** B3: delegation nesting depth of the calling agent (primary=0, worker=1).
   *  Delegate tools forward this so the coordinator can enforce the depth cap. */
  delegationDepth?: number
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
  /** VSW: identity of the snapshot this verification ran against
   *  (baselineHead + sha(ownedDiff)). Absent for in-place (non-snapshot) runs.
   *  When the owned diff changes, the ref changes → old verifications go stale. */
  snapshotRef?: string
  /** VSW two-phase: 'isolated' = Phase A on baseline.head + owned diff (blocking
   *  gate); 'integration' = Phase B on current HEAD + owned diff (advisory). */
  verificationPhase?: 'isolated' | 'integration'
}

export interface ToolResult {
  /** Content sent to model as tool_result */
  content: string
  /** UI summary override — falls back to content if not provided */
  uiContent?: string
  /** Path to persisted raw output file */
  rawPath?: string
  /** Observational fidelity of this result:
   *  - lossless: full output, no truncation or collapse
   *  - truncated: output was clipped (stdout ring buffer, line limit)
   *  - collapsed: output was replaced by an aggregate summary (ToolAccumulator storm-collapse)
   *  - preview_only: output is a head/tail preview, not the full content
   *  Undefined = lossless (backward compatible default). */
  lossiness?: 'lossless' | 'truncated' | 'collapsed' | 'preview_only'
  isError?: boolean
  verification?: VerificationMetadata
  /** Additional verification events to record beyond the primary one. VSW uses
   *  this to record the Phase B (integration) verification alongside the
   *  primary Phase A (isolated) verification from a single run_tests call. */
  extraVerifications?: VerificationMetadata[]
  /** Raw output byte count before any truncation (bash stdout+stderr). */
  rawBytes?: number
  /** Raw output line count before any truncation (bash stdout+stderr). */
  rawLines?: number
  /** Exit code for shell commands (bash). */
  exitCode?: number
  /** Executed command (bash) — used by ToolAccumulator for per-command collapse summaries. */
  command?: string
  /** Signal the turn loop to end after this tool result (e.g. ask_user_question
   *  needs the user's next message as the answer). When true, the orchestrator
   *  completes the turn as final instead of continuing the tool loop. */
  endTurn?: boolean
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
