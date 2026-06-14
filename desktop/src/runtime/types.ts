// Shared shapes mirroring the rivet runtime session API (src/server/session-manager.ts).
// Keep in sync with the backend; this is the desktop's view of the contract.

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'

/** S — autonomy level. Mirrors the backend ApprovalMode (loop-types.ts). */
export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'

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
  /** S — per-session autonomy override; absent → global config default. */
  approvalMode?: ApprovalMode
}

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
  | 'intent_required'
  | 'intent_resolved'
  | 'delegation'
  | 'artifact'
  | 'status'
  | 'error'
  | 'decision_shift'
  | 'rewind'
  | 'todo_state'
  | 'steer_queued'
  | 'done'

export interface SessionEvent {
  seq: number
  ts: number
  type: SessionEventType
  data: Record<string, unknown>
}

export interface ApprovalRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
}

export interface IntentRequest {
  requestId: string
  summary: string
  confidence: number
  alternatives: string[]
  warnings: string[]
}

export type ApprovalDecision = 'approve' | 'reject'

export interface HealthInfo {
  ok: boolean
  version: string
  uptimeMs: number
  sessionCount: number
  runningCount: number
}

export interface ScheduledTask {
  id: string
  prompt: string
  allowedTools: string[]
  trigger: { type: 'interval' | 'cron' | 'oneshot'; spec: string }
  createdAt: string
  lastTriggeredAt?: string
  triggerCount: number
  enabled?: boolean
}

export interface DelegationNode {
  workerId: string
  parentId?: string
  objective: string
  status: string
  phase?: string
  updatedAt: number
  /** T4 — latest worker activity line (e.g. "edit_file src/x.ts"). */
  progressLine?: string
  /** T4 — elapsed wall-clock since the worker started, ms. */
  elapsedMs?: number
}

/** T2 — structured active task list item (mirrors backend `todo` write). */
export interface TodoStateItem {
  id: string
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export interface ArtifactSummary {
  id: string
  tool: string
  target: string
  kind: string
  summary: string
  charCount: number
  lineCount: number
  createdAt: number
}
