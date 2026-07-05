import type { Message } from '../api/types.js'
import type { OaiMessage } from '../api/oai-types.js'
import type { OaiRound } from './rounds.js'

// ─── Health & Budget ──────────────────────────────────────────

export type ContextHealthLevel = 'healthy' | 'watch' | 'compact' | 'critical'

export type CompactionState = 'healthy' | 'warning' | 'compacting' | 'critical'

export interface ContextBudget {
  estimatedTokens: number
  maxTokens: number
  warningThreshold: number
  compactionState: CompactionState
}

// ─── API Round ────────────────────────────────────────────────

export type ApiInvariant = 'ok' | 'repaired' | 'broken'

export interface ApiRound {
  id: string
  startMessageIndex: number
  endMessageIndex: number
  turnNumber: number
  hasToolUse: boolean
  hasToolResult: boolean
  tokenEstimate: number
  compactableTokenEstimate: number
  apiInvariant: ApiInvariant
}

export interface ApiInvariantStatus {
  totalRounds: number
  okRounds: number
  repairedRounds: number
  brokenRounds: number
  orphanToolUse: string[]
  orphanToolResult: string[]
}

// ─── Context Ledger ───────────────────────────────────────────

export interface CompactedSpan {
  id: string
  strategy: 'micro' | 'session_memory' | 'reactive' | 'emergency'
  startRoundIndex: number
  endRoundIndex: number
  tokenBefore: number
  tokenAfter: number
  summaryPath?: string
  rawTranscriptPath: string
  createdAt: number
}

export interface ContextAnchor {
  kind: 'decision' | 'error' | 'user_preference' | 'user_constraint' | 'pending_task' | 'file' | 'verification'
  text: string
  sourceRoundIndex: number
  salience: number
}

export interface WorkingSetEntry {
  path: string
  status: 'read' | 'modified' | 'error' | 'pending'
  lastRoundIndex: number
}

export interface LedgerSessionMemoryState {
  path: string
  lastSummarizedRoundIndex: number
  lastUpdatedAt: number
  digest: string
  stale: boolean
  tokenEstimate: number
}

export interface ContextLedger {
  sessionId: string
  transcriptPath: string
  rounds: OaiRound[]
  anchors: ContextAnchor[]
  workingSet: WorkingSetEntry[]
  compactedSpans: CompactedSpan[]
  sessionMemory: LedgerSessionMemoryState | null
  tokenBudget: ContextBudget
  apiInvariantStatus: ApiInvariantStatus
}

// ─── Compact Tier & Policy ────────────────────────────────────

export type CompactTier = 0 | 1 | 2 | 3 | 4

export interface CompactDecision {
  tier: CompactTier
  reason: string
  shouldCompact: boolean
}

export interface CompactCircuitBreakerState {
  consecutiveFailures: number
  disabledUntilTurn?: number
}

// ─── Compact Event ────────────────────────────────────────────

export interface CompactEvent {
  turn: number
  tier: CompactTier
  reason: string
  beforeTokens: number
  afterTokens: number
  createdAt: number
}

// ─── Resume Preflight ─────────────────────────────────────────

export interface ResumePreflightReport {
  messageCount: number
  roundCount: number
  invariant: ApiInvariantStatus
  repaired: boolean
  syntheticResultsInserted: number
  orphanToolResultIds: string[]
  safe: boolean
  messages: Message[]
}

// ─── Microcompact ─────────────────────────────────────────────

export interface MicrocompactOptions {
  keepRecentRounds?: number
  minContentLength?: number
}

export interface MicrocompactResult {
  messages: Message[]
  compactedCount: number
  tokensSaved: number
  compactedRoundIds: string[]
}

// ─── Session Memory Sidecar ──────────────────────────────────────

export interface SessionMemoryEntry {
  id: string
  createdAt: number
  text: string
  source: 'manual' | 'compact' | 'resume'
}

export interface SessionMemoryState {
  sessionId: string
  entries: SessionMemoryEntry[]
}

export interface SessionMetadata {
  sessionId: string
  /** ISO timestamp when the session was first created */
  createdAt: number
  /** ISO timestamp of the last mutation (append/compact) */
  updatedAt: number
  compactEvents: CompactEvent[]
  lastLedger?: ContextLedger
  /** Primary model used for this session */
  model?: string
  /** Provider profile name (e.g. 'deepseek', 'openai') */
  provider?: string
  /** Running token usage aggregate */
  tokenUsage?: {
    prompt: number
    completion: number
    total: number
  }
  /** First user message — used as session title / summary */
  title?: string
  /** Session lifecycle status */
  status?: 'active' | 'completed' | 'archived'
  /** Number of turns (user messages) processed */
  turnCount?: number
  /** Total tool calls executed */
  toolCallCount?: number
  /** Star-domain id for cross-session handoff routing (e.g. 'tianji', 'tanlang') */
  domain?: string
  /** Working directory this session was started in. Gates cross-cwd resume (R1). */
  cwd?: string
  /**
   * True when the previous run exited cleanly (vs crashed mid-flight). Set on
   * shutdown, reset to false on every live start. A clean-exit session is NOT
   * silently auto-resumed — only crash-interrupted sessions are (R1).
   */
  cleanExit?: boolean
  /** TUI side panel open state persisted across session resume. */
  sidePanelOpen?: boolean
  /**
   * Guardian（星域守护链路）活动摘要 — CCR 触发数、改道发射数（按 source 分）、
   * advisory 渲染/丢弃计数。排查"守护链路被静音"时一眼可见（Phase 0 观测）。
   */
  guardianActivity?: {
    ccr: number
    shifts: Record<string, number>
    advisoriesRendered: number
    advisoriesDropped: number
    /** P1a 核销闭环：expect 谓词判定的采纳/忽略累计（缺省 = 会话早于该功能） */
    advisoriesAdopted?: number
    advisoriesIgnored?: number
  }
  /**
   * 投机预读四源（tool-pattern/physarum-file/combined/llm）enqueued/hits 计数。
   * postSession 写入（有活动才写）——绕过 RIVET_DEBUG_TELEMETRY 门，
   * 为「llmSpeculation 是否默认开」提供跨会话命中率证据。
   */
  speculationStats?: Record<string, { enqueued: number; hits: number }>
}
