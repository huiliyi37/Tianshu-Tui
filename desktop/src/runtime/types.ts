// Shared shapes for the rivet runtime session API.
//
// The session core (statuses, 30+ event types, SessionRecord) is now imported
// TYPE-ONLY from the backend's single source of truth — src/server/protocol.ts.
// That file is a dependency-free leaf, so this pulls zero runtime code and no
// server-side type graph into the frontend; drift now fails `tsc` instead of
// silently shipping. The remaining interfaces below are desktop-shaped views
// of individual REST responses and still live here.

export type {
  SessionStatus,
  ApprovalMode,
  PlanModeState,
  SessionEventType,
  SessionEvent,
  SessionRecord,
  PlanDraft,
} from '../../../src/server/protocol'

// Re-exports don't create local bindings; import the names this file also uses.
import type { PlanDraft } from '../../../src/server/protocol'

/** Lifecycle of a submitted plan document on disk. */
export type PlanStatus = 'submitted' | 'approved' | 'executed' | 'rejected'

export interface PlanOption {
  label: string
  description: string
}

/** PlusMenu — a selectable model annotated with the session's current flag. */
export interface ModelEntry {
  id: string
  alias: string
  provider: string
  contextWindow?: number
  current: boolean
}

/** PlusMenu — a star-domain picker entry (Auto / built-in & custom). */
export interface DomainEntry {
  /** Selection key: 'auto' | <domainId>. */
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

/** GET /skills response: loaded skills + skills that failed to parse on load. */
export interface SkillsResponse {
  skills: SkillStatus[]
  /** `<name>: <reason>` for skills under .rivet/skills that failed to load. */
  loadErrors: string[]
}

/** A skill discoverable under .claude/skills that can be copied into .rivet/skills. */
export interface InstallableSkill {
  name: string
  description: string
  source: 'project-claude' | 'global-claude'
  installed: boolean
}

/** GET /skills/installable response: candidates + soft install-cap context. */
export interface InstallableSkillsResponse {
  skills: InstallableSkill[]
  /** Skills already present under .rivet/skills. */
  installedCount: number
  /** Recommended soft cap on installed skills (advisory, not enforced). */
  recommendedMax: number
}

/** Result of copying skills into .rivet/skills. */
export interface SkillInstallResult {
  copied: string[]
  skipped: string[]
  errors: string[]
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
  options?: PlanOption[]
  /** 产出模型留痕（submit 时写入的模型名）。缺失 = 旧计划或未知模型。 */
  model?: string
  /** 产出模型 tier（名字推断）。cheap 时展示低阶模型复核警告。 */
  modelTier?: 'cheap' | 'balanced' | 'strong' | null
}

/** `GET /sessions/:id/plans` — submitted plans plus the active draft (if planning). */
export interface PlanListResponse {
  plans: PlanSummary[]
  draft: PlanDraft | null
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
  options?: PlanOption[]
}

export interface ApprovalRequest {
  requestId: string
  toolName: string
  input: Record<string, unknown>
}

/** 结构化提问卡片 — user_question SSE 载荷（ask_user_question 工具输入的镜像）。 */
export interface PendingQuestionItem {
  id: string
  prompt: string
  options: string[]
  allowMultiple: boolean
}

export interface PendingQuestion {
  toolUseId: string
  questions: PendingQuestionItem[]
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
  /** p99 sidecar event-loop delay (ms) over the last poll window — high values
   *  mean "sidecar busy", which the UI shows instead of a phantom "offline". */
  loopLagP99Ms?: number
  /** Worst single event-loop delay (ms) over the same window. */
  loopLagMaxMs?: number
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
  /** Windows only: effective `git config core.autocrlf` ('true'|'input'|'false'), undefined when unset. */
  gitAutocrlf?: string
  /** Shell info — Windows 上 Git Bash 可用性 + 当前降级状态。 */
  shell?: {
    kind: 'bash' | 'powershell' | 'cmd' | 'sh'
    gitBashAvailable: boolean
    fallbackReason?: string
  }
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

export interface ScheduledTaskRetry {
  maxAttempts: number
  backoffMs: number
}

/** 付费版 v1 · T2 — 自动化任务审查策略。 */
export type ReviewPolicy = 'always-review' | 'first-runs' | 'auto-proceed'

export interface ScheduledTask {
  id: string
  prompt: string
  allowedTools: string[]
  trigger: { type: 'interval' | 'cron' | 'oneshot'; spec: string }
  createdAt: string
  lastTriggeredAt?: string
  triggerCount: number
  enabled?: boolean
  retry?: ScheduledTaskRetry
  reviewPolicy?: ReviewPolicy
}

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'

/** A single execution record (run) of a task; mirrors the backend TaskRecord. */
export interface TaskRecord {
  id: string
  prompt: string
  source: 'api' | 'cron' | 'manual' | 'internal'
  status: TaskStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  error?: string
  result?: { summary: string; changedFiles: string[]; exitCode?: number }
  allowedTools?: string[]
  scheduledTaskId?: string
  sessionId?: string
  attempt?: number
  retryOf?: string
  retry?: ScheduledTaskRetry
  /** 无人值守运行（审批 fail-closed 中止）。 */
  unattended?: boolean
  /** 无人值守中止时缺授权的 app 名（修复闭环「去授权/重跑」）。 */
  haltedApp?: string
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
  /** Terminal digest text — populated when a user-dispatched worker finishes.
   *  Drives the "汇入主会话" adopt-to-composer button. */
  summary?: string
  /** Who launched this worker: 'user' = user-dispatched background subagent,
   *  'agent' (or undefined) = the model's own auto-delegation. */
  origin?: 'user' | 'agent'
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

/** A background job (bash run_in_background). Mirrors backend JobSnapshot. */
export type JobStatus = 'running' | 'exited' | 'killed'

export interface JobState {
  id: string
  command: string
  status: JobStatus
  exitCode?: number
  startedAt: number
  endedAt?: number
  /** Last non-empty output line (dashboard preview). */
  lastLine: string
  pid?: number
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

export interface McpPresetEnvField {
  key: string
  label: string
  help?: string
}

export interface McpPreset {
  id: string
  name: string
  description: string
  category: 'dev' | 'productivity' | 'communication' | 'knowledge'
  transport: 'stdio' | 'sse'
  command?: string
  args?: string[]
  url?: string
  requiredEnv?: McpPresetEnvField[]
  expectedTools?: string[]
  docsUrl?: string
}

export interface McpPresetsResponse {
  presets: McpPreset[]
  configuredIds: string[]
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

export interface BalanceInfo {
  currency: string
  totalBalance: string
}

export interface BalanceResult {
  isAvailable: boolean
  balances: BalanceInfo[]
}
