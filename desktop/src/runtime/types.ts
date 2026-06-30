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
  /** Visual glyph for the current star-domain selection (for badges). */
  domainGlyph?: string
  /** Semantic accent color key for the current star-domain selection. */
  domainAccent?: string
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
  /** Full UI persona (separator + accent + glyph). */
  uiPersona?: {
    separator: 'thin' | 'thick' | 'dots'
    accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim'
    glyph: string
  }
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

/** Gap 1 — directory entry for the read-only file browser. */
export interface DirEntry {
  name: string
  isDirectory: boolean
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
  | 'intent_note'
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
  // I4 — user-defined .rivet/hooks.json script results.
  | 'hook_result'
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

/** Non-blocking 方向提示 — a passive direction note (no requestId, no reply). */
export interface IntentNote {
  summary: string
  confidence: number
  warnings: string[]
  title: string
  reasons: string[]
  action: string
  steerHint: string
}

export type ApprovalDecision = 'approve' | 'reject'

export interface HealthInfo {
  ok: boolean
  version: string
  uptimeMs: number
  sessionCount: number
  runningCount: number
  /** false when the default provider has no usable API key (first launch / setup mode). */
  configured: boolean
}

export interface ToolVersionInfo {
  available: boolean
  version?: string
  command: string
  path?: string
}

export interface EnvironmentInfo {
  python: ToolVersionInfo
  uv: ToolVersionInfo
  git: ToolVersionInfo
  node: ToolVersionInfo
  platform: string
}

export interface ProjectTemplatesStatus {
  needsInit: boolean
  cwd: string
  agentsTemplate: string
  rivetTemplate: string
}

export interface ProjectTemplatesApplyResult {
  created: string[]
  appended: string[]
  skipped: string[]
  decision: 'created' | 'declined' | 'skipped'
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
  /** Persisted diff artifact id (worker fallback session). Lets the UI fetch this
   *  worker's diff for independent review. Absent when no diff or persistence failed. */
  artifactId?: string
  /** Files this worker changed (for diff review entry hints). */
  changedFiles?: string[]
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
  /** Main control session turn-level usage (turn_complete events). null when session has no turns. */
  mainSession: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    reasoningTokens: number
    totalTokens: number
    model?: string
    provider?: string
    cost: number
  } | null
  workers: InsightsWorker[]
  modelBreakdown: InsightsModelBreakdown[]
  providerBreakdown: InsightsProviderBreakdown[]
}

/** Git branch graph response from `GET /git/graph`. */
export interface GitGraphResponse {
  graph: string[]
}

/** A single file's working-tree change relative to HEAD (mirrors backend WorkingTreeFile). */
export interface WorkingTreeFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
}

/** Working-tree change list for the desktop "changes" tab. */
export interface WorkingTreeResponse {
  files: WorkingTreeFile[]
  isRepo: boolean
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

/**
 * 行级评论：锚定 diff 的一行（文件 + old/new 行号 + 文本）。
 * 锚点用 (file, oldLine, newLine) 组合，newLine 优先作为定位行；file 来自
 * parseDiff 解析的当前文件上下文，保证多文件 diff 唯一定位。
 */
export interface LineComment {
  file: string
  oldLine?: number
  newLine?: number
  comment: string
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

/** I4 — user-defined hook event kinds. Mirrors backend HookEvent. */
export type HookEvent = 'preTurn' | 'postTurn' | 'postTool' | 'postSession' | 'onError'

/** I4 — a single entry in .rivet/hooks.json. */
export interface HookEntry {
  event: HookEvent
  script: string
  timeoutMs?: number
}

/** I4 — result of running one user hook script. */
export interface HookResult {
  script: string
  ok: boolean
  output: string
}

/** I4 — full .rivet/hooks.json payload. */
export interface HooksConfig {
  hooks: HookEntry[]
}

/** Desktop shell — available data-root locations. */
export interface StorageOptions {
  current: string
  defaultPath: string
  portablePath?: string
}

/** Desktop shell — result of applying a new RIVET_HOME. */
export interface StorageApplyResult {
  success: boolean
  migrated: boolean
  requiresRestart: boolean
  error?: string
}
