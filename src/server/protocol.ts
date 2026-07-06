/**
 * Desktop ↔ sidecar wire protocol — the SINGLE definition of the session
 * contract shared by both sides.
 *
 * - The sidecar (src/server/session-manager.ts and friends) re-exports these
 *   types, so all server code keeps importing from session-manager as before.
 * - The desktop re-exports them from desktop/src/runtime/types.ts via a
 *   relative TYPE-ONLY import, giving the frontend compile-time drift
 *   protection (previously the two sides were kept in sync by comment
 *   convention only).
 *
 * HARD CONSTRAINT: this module must stay a dependency-free LEAF (no imports,
 * not even type imports). The desktop's typecheck follows every import in its
 * graph — one careless `import type` from an agent/server module here would
 * drag half the runtime into the frontend's type graph.
 */

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'

/**
 * S — autonomy level. Canonical wire definition; the agent runtime re-exports
 * it from src/agent/loop-types.ts.
 */
export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'

/**
 * Plan mode — read-only planning vs normal execution. Canonical wire
 * definition; the runtime re-exports it from src/agent/plan-mode.ts.
 */
export type PlanModeState = 'off' | 'planning'

export type SessionEventType =
  | 'user'
  | 'text_delta'
  | 'thinking_delta'
  | 'tool_use'
  | 'tool_result'
  | 'turn_complete'
  | 'phase'
  | 'checkpoint'
  | 'approval_required'
  | 'approval_resolved'
  | 'intent_note'
  | 'delegation'
  | 'artifact'
  | 'status'
  | 'error'
  | 'decision_shift'
  | 'rewind'
  // T2 — structured active task list (mirrors the `todo` tool's write payload).
  | 'todo_state'
  // T3 — mid-run user guidance accepted into the steer buffer.
  | 'steer_queued'
  // Plan mode — state toggle (off|planning) + a plan was submitted to disk.
  | 'plan_mode'
  | 'plan_submitted'
  // Plan mode — the agent grew the active draft (throttled invalidation signal;
  // metadata only, the desktop re-fetches the body via GET /plans).
  | 'plan_draft'
  // Structured ask_user_question payload → desktop question card (Cursor-style).
  | 'user_question'
  // PlusMenu — per-session model / star-domain / skill selection changes.
  | 'model_switched'
  | 'domain_changed'
  | 'skills_changed'
  // I4 — user-defined .rivet/hooks.json script results.
  | 'hook_result'
  // Background jobs (bash run_in_background) — started / output / exit.
  | 'job'
  | 'done'
  // Watchdog stall auto-recovery (桌面端对齐 TUI v3) — 续跑决策可观测。
  | 'watchdog_recovery'
  // Change landing — commit / squash merge-back / PR created from the Changes tab.
  | 'landing'
  // C3 自治档检查点 — run 在 N 轮后暂停等待用户确认（continue 恢复）。
  | 'autonomy_checkpoint'

export interface SessionEvent {
  seq: number
  ts: number
  type: SessionEventType
  data: Record<string, unknown>
}

export interface SessionRecord {
  id: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
  cwd: string
  title?: string
  currentPhase?: string
  lastSeq: number
  error?: string
  pendingApprovals: number
  /**
   * S — per-session autonomy level. Overrides the global config approval mode
   * so one session can run unattended (dangerously-skip-permissions) while
   * another stays supervised. Absent → the agent uses the global config default.
   */
  approvalMode?: ApprovalMode
  /**
   * Plan mode — when 'planning', the agent is restricted to read-only tools and
   * is expected to call plan_submit to produce a reviewable plan. Absent/'off' →
   * normal execution. Mirrors AgentLoop.planModeState.
   */
  planMode?: PlanModeState
  /**
   * PlusMenu — current provider model id for this session (the resolved model
   * id, not an alias). Absent → the global default. Surfaced in the model picker
   * and persisted so a reconnecting viewer sees the live model.
   */
  model?: string
  /**
   * PlusMenu — star-domain selection KEY ('auto' | <domainId>; legacy 'off'
   * persists but resolves to auto). Stored
   * as the round-trippable key (not a display name) so rehydrate can restore the
   * live ActiveStarDomain. Absent → 'auto'.
   */
  domain?: string
  /** Visual glyph for the current star-domain selection (for UI badges). */
  domainGlyph?: string
  /** Semantic accent color key for the current star-domain selection. */
  domainAccent?: string
  /** Estimated token count for the current conversation. Absent → session is idle/rehydrated. */
  contextTokens?: number
  /** Model context window size (max tokens). Absent → session is idle/rehydrated. */
  contextWindow?: number
  /** Current reasoning effort level (off/low/medium/high/max). Absent → model default. */
  reasoningEffort?: string
  /** Archived (closed) sessions are excluded from listSessions() and hidden in the desktop sidebar. */
  archived?: boolean
  /** Git worktree branch name — set when the session was created with isolated worktree. */
  worktreeBranch?: string
  /** Worktree path on disk (for cleanup on archive/close). */
  worktreePath?: string
  /** HEAD commit at session creation — diff baseline for the Changes tab (worktree sessions). */
  baselineHead?: string
  /** Worktree branch head at the last successful merge-back. Squash merges
   *  leave the branch commits unreachable from main, so rev-list can't tell
   *  "landed" — this marker lets archive safely delete a landed branch. */
  landedHead?: string
}

/** Live plan-mode draft surfaced to the desktop — a growing working document,
 *  not a submitted plan. Title is the draft's H1 (null while still empty). */
export interface PlanDraft {
  path: string
  title: string | null
  content: string
}
