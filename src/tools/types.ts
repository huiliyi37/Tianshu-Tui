import type { ToolDefinition } from '../api/types.js'
import type { ArtifactStore } from '../artifact/store.js'
import type { PrewarmCache } from '../agent/prewarm.js'
import type { ReadRefStats } from './read-file.js'
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
  /** Actual model dispatched for this worker (insights / cost visualization). */
  model?: string
  /** Provider name for this worker (insights / cost visualization). */
  provider?: string
  /** Token usage for this worker (insights / cost visualization). */
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
    reasoning_tokens?: number
    total_tokens?: number
  }
  /** Persisted diff artifact id (in the worker's fallback session). Lets the UI
   *  fetch this worker's diff for independent review. Absent when the worker
   *  produced no diff or persistence failed (降级：UI 隐藏 diff 入口). */
  artifactId?: string
  /** Files this worker changed (for diff review entry hints). */
  changedFiles?: string[]
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

/** U6/C1: a step input passed through onPlanSteps to seed/sync PlanExecutionTrace. */
export interface PlanStepInput {
  /** Optional stable identifier (e.g. todo id). */
  id?: string
  /** Step description shown in trace / UI. */
  content: string
  /** Current status from the todo list, if known. */
  status?: 'pending' | 'in_progress' | 'completed'
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
  /** Register a file written internally by a tool (e.g. ast-edit via writeFileAtomicAsync).
   *  Ensures evidence/filesModified and cerebellar gate are aware of the write. */
  onFileWrite?: (filePath: string) => void
  /** Capture an agent's departure mark for 主控 to record at session close. */
  onLeaveMark?: (mark: LeaveMarkInput) => void
  /** Write a constellation milestone when plan_close succeeds with apply=true. */
  onPlanClosed?: (input: PlanClosedInput) => void
  /** U6/C1: capture the goal decomposition (ordered step descriptions) produced
   *  by the plan_steps tool during planning. The loop maps these into the active
   *  PlanExecutionTrace. Absent in non-task / worker contexts → tool is a no-op. */
  onPlanSteps?: (steps: PlanStepInput[]) => void
  /** T4: structured per-worker delegation updates (subagent panel). Optional —
   *  set by the tool pipeline; absent in non-server contexts (no-op). */
  onWorkerActivity?: (activity: DelegationActivity) => void
  /** Files this session/tool pipeline owns and may safely include in scoped write operations. */
  sessionModifiedFiles?: string[]
  /** Artifact store for persisting tool output — no global setter, always inject via params */
  artifactStore?: ArtifactStore
  /** Session-scoped background job registry — enables bash run_in_background and
   *  the `job` tool (list/logs/await/kill). Absent in TUI/non-server contexts →
   *  bash degrades to foreground execution. */
  jobs?: import('./job-store.js').JobRegistry
  /** Prewarm cache for speculative file reads — injected so read_file can hit
   *  warmed entries (mtime-verified) instead of a cold fs read. Per-session. */
  prewarmCache?: PrewarmCache
  /** Per-session read-ref telemetry accumulator. When injected, read-ref
   *  savings scope to this session instead of accumulating process-wide. */
  readRefStats?: ReadRefStats
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
  /** Session identifier — used to isolate per-session state (read history,
   *  dedup tracking) so concurrent sessions in the same cwd don't cross-
   *  contaminate (e.g. a forked session seeing "already read" for a file
   *  only the parent read). */
  sessionId?: string
  /** Review-router re-entrancy depth propagated into worker contexts. */
  reviewDepth?: number
  /** B3: delegation nesting depth of the calling agent (primary=0, worker=1).
   *  Delegate tools forward this so the coordinator can enforce the depth cap. */
  delegationDepth?: number
  /** Active plan draft file (relative to cwd) while in plan mode. */
  activePlanFilePath?: string | null
  /** AbortSignal from the tool pipeline — fires when the tool-level timeout
   *  rejects. Delegate tools propagate this to the coordinator so zombie
   *  workers are cleaned up immediately. */
  abortSignal?: AbortSignal
  /** Called when the model explicitly loads a skill via the skill tool. */
  onSkillInvoked?: (name: string) => void
  /** Called when the model explicitly marks a skill as complete via the skill tool. */
  onSkillCompleted?: (name: string) => void
}

export type VerificationFailureKind = 'test_failure' | 'tool_invocation_failure'

/** Root cause when status is 'blocked'. Absent for passed/failed.
 *  Enables downstream (attribution, gate, deliver_task) to give
 *  scenario-specific guidance instead of a uniform "tests blocked" message. */
export type VerificationBlockedReason =
  | 'no_test_framework'    // no package.json / no detectable runner at all
  | 'no_tests_found'        // project has a runner but no test files detected
  | 'filter_unresolved'     // run_tests(filter=...) could not resolve to a test file
  | 'unknown_runner'        // npm test script uses an unrecognized runner (not vitest/jest/node-test)
  | 'timeout'               // tests timed out
  | 'invocation_failure'    // runner crashed / EPERM / could not start

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
  /** Why verification was blocked — enables scenario-specific guidance downstream. */
  blockedReason?: VerificationBlockedReason
  /** User-facing next step when blocked (e.g. "项目缺少测试框架，运行 npm init 后配置 test 脚本"). */
  userGuidance?: string
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
  /** Unix ms timestamp when this verification was recorded. */
  timestamp?: number
}

/** Classification of a failing shell result — shared by ToolResult + pipeline signatures. */
export type ToolErrorClass = 'environment' | 'exec-failure' | 'timeout'

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
  /** Classification of a failing shell result. 'environment' = the command could not
   *  run because the host lacks it (command-not-found / shell-not-found), NOT a model
   *  competence failure — downstream (momentum/doom/approval) must not penalise these,
   *  otherwise benign Windows command-name differences make the agent timid.
   *  'timeout' = the command exceeded its budget — slow ≠ dead-end, so dead-end
   *  pheromone deposition must exclude these too. */
  errorClass?: ToolErrorClass
  /** Executed command (bash) — used by ToolAccumulator for per-command collapse summaries. */
  command?: string
  /** Signal the turn loop to end after this tool result (e.g. ask_user_question
   *  needs the user's next message as the answer). When true, the orchestrator
   *  completes the turn as final instead of continuing the tool loop. */
  endTurn?: boolean
  /** Write-family tools (edit_file/write_file) report the AFTER-file line ranges
   *  they touched (1-based, inclusive). The tool-pipeline uses this to narrow the
   *  whole-file LSP diagnostics it appends to the model: in-region diagnostics are
   *  surfaced fully, out-of-region errors collapse to a one-line nudge, and
   *  out-of-region warnings are dropped. Absent → append site keeps whole-file
   *  behavior. See computeChangedLineRanges / filterDiagnosticsForEdit. */
  changedRanges?: Array<{ start: number; end: number }>
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
