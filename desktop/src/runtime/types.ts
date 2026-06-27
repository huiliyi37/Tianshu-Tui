// Shared shapes mirroring the rivet runtime session API (src/server/session-manager.ts).
// Keep in sync with the backend; this is the desktop's view of the contract.

export type SessionStatus = 'idle' | 'running' | 'completed' | 'failed' | 'aborted'

/** S — autonomy level. Mirrors the backend ApprovalMode (loop-types.ts). */
export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual' | 'dangerously-skip-permissions'

/** Plan mode — read-only planning vs normal execution. Mirrors PlanModeState. */
export type PlanModeState = 'off' | 'planning'

/** Lifecycle of a submitted plan document on disk. */
export type PlanStatus = 'submitted' | 'approved' | 'executed' | 'rejected'

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
  /** Plan mode — 'planning' restricts the agent to read-only exploration. */
  planMode?: PlanModeState
  /** PlusMenu — current provider model id (resolved id). Absent → global default. */
  model?: string
  /** PlusMenu — star-domain selection key ('auto' | 'off' | <domainId>). */
  domain?: string
  /** Estimated token count for the current conversation (from live agent). */
  contextTokens?: number
  /** Model context window size in tokens. */
  contextWindow?: number
  /** Archived (closed) sessions are hidden from the sidebar. */
  archived?: boolean
  /** Git worktree branch name — set when created with isolated worktree. */
  worktreeBranch?: string
}

/** PlusMenu — a selectable model annotated with the session's current flag. */
export interface ModelEntry {
  id: string
  alias: string
  provider: string
  contextWindow?: number
  current: boolean
}

/** PlusMenu — a star-domain picker entry (Auto / Off / built-in & custom). */
export interface DomainEntry {
  /** Selection key: 'auto' | 'off' | <domainId>. */
  key: string
  name: string
  motto: string
  /** Secondary dim meta: decisionStyle · keywords. */
  meta: string
  /** One-shot essence preview (never the full volatileBlock). */
  essence: string
  /** Whether this is the session's current selection. */
  current: boolean
}

/** PlusMenu — a skill with its per-session enablement status. */
export interface SkillStatus {
  name: string
  description: string
  source: string
  enabled: boolean
}

/** P2-2 — file content viewer response. */
export interface FileContent {
  path: string
  content: string
  language: string
  totalLines: number
  startLine: number
  endLine: number
}

/** Plan list entry (no markdown body). createdAt/approvedAt are epoch ms. */
export interface PlanSummary {
  slug: string
  title: string
  status: PlanStatus
  path: string
  createdAt: number
  approvedAt?: number
}

/** Full plan document including markdown content. */
export interface PlanDoc {
  slug: string
  title: string
  content: string
  path: string
  status: PlanStatus
  createdAt: number | string
  approvedAt?: number | string
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
  | 'plan_mode'
  | 'plan_submitted'
  | 'model_switched'
  | 'domain_changed'
  | 'skills_changed'
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
  /** Worker role profile (e.g. "code_scout", "patcher", "reviewer"). */
  profile?: string
  /** T4 — latest worker activity line (e.g. "edit_file src/x.ts"). */
  progressLine?: string
  /** T4 — elapsed wall-clock since the worker started, ms. */
  elapsedMs?: number
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
}

export interface InsightsWorker {
  workerId: string
  parentId?: string
  profile?: string
  status?: string
  model?: string
  provider?: string
  objective?: string
  elapsedMs?: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  cost: number
}

export interface InsightsModelBreakdown {
  model: string
  provider?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost: number
  count: number
}

export interface InsightsProviderBreakdown {
  provider: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  cost: number
  count: number
}

export interface InsightsResponse {
  totals: {
    workers: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    totalTokens: number
    cost: number
  }
  cacheHitRate: number | null
  workers: InsightsWorker[]
  modelBreakdown: InsightsModelBreakdown[]
  providerBreakdown: InsightsProviderBreakdown[]
}

/** Git branch graph response from `GET /git/graph`. */
export interface GitGraphResponse {
  graph: string[]
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

// ── MCP (Model Context Protocol) ────────────────────────────────────

export type McpTransport = 'stdio' | 'sse'
export type McpServerStatus = 'disconnected' | 'connecting' | 'connected' | 'degraded' | 'error'

export interface McpConnectionState {
  serverId: string
  status: McpServerStatus
  transport?: McpTransport
  toolCount: number
  error?: string
  lastErrorClass?: string
  lastConnectedAt?: number
}

export interface McpStatusResponse {
  servers: McpConnectionState[]
  totalTools: number
  enabled: boolean
}

export interface McpServerConfig {
  serverId: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  url?: string
  headers?: Record<string, string>
  disabled?: boolean
}

export interface McpServerToolsResponse {
  tools: Array<{
    name: string
    description: string
    inputSchema: Record<string, unknown>
  }>
}
