/**
 * In-flight worker stall detection (T10 A4 — 运行态主闸).
 *
 * Tracks last-activity time per in-flight worker so the coordinator can
 * detect a worker that stopped producing tokens BEFORE its budget/hardStall
 * fires — turning a 180s frozen session into an early, observable abort.
 *
 * Design principle: workers die for **silence**, never for duration. The
 * wall-clock budget stays a far backstop; this is the primary runtime gate.
 */

import {
  REASONING_FIRST_BYTE_TIMEOUT_MS,
  SLOW_FIRST_BYTE_TIMEOUT_MS,
  isSlowThinkingProvider,
  FIRST_BYTE_PER_100K_MS,
} from '../api/openai-client.js'

/** Default silence tolerance for read-only (explore) workers. */
export const EXPLORE_STALL_MS = 90_000
/** Default silence tolerance for write (hands) workers — edits pause longer. */
export const WRITE_STALL_MS = 120_000

/** Conservative size-scaled first-byte headroom: 3 buckets (~300k-token prompts). */
const FIRST_BYTE_SIZE_MARGIN_MS = 3 * FIRST_BYTE_PER_100K_MS
/** Window for one internal transient retry (backoff + reconnect) to start ticking. */
const RETRY_WINDOW_MS = 30_000

export interface DeriveWorkerStallOpts {
  providerName?: string
  /** Worker 端点 baseUrl——慢思考判定的第二级启发式（host 子串），见
   *  isSlowThinkingProvider（2026-08-09：自定义名如 deepseek-spark 精确名必漏判）。 */
  baseUrl?: string
  /** 显式慢思考声明（provider config slowThinking），优先级最高。 */
  slowThinking?: boolean
  isWrite?: boolean
  /** Worker uses thinking mode. Default true — provider schema 的 thinking 默认
   *  'enabled'（src/config/schema.ts），未知时按 true 取保守长绳。 */
  thinking?: boolean
}

/**
 * Per-worker silence tolerance derived from the API layer's OWN first-byte
 * budget. The fixed 90/120s defaults pre-empt healthy slow first-byte waits:
 * a thinking worker's API first-byte budget is 90s（slow set 180s）+ up to
 * 60s per 100k input tokens — e.g. a 351k-token LongCat scout legally waits
 * 270s for its first token, but the 90s sweep killed it first（2026-07-18
 * 会话 2058615c 四个 scout 同窗口齐死）。慢 ≠ 死：thinking/slow provider
 * 的静默下限必须覆盖"基础首字节 + 规模上浮余量 + 一次内部重试窗口"；
 * 非 thinking provider 保持原档，快杀真死锁。
 */
export function deriveWorkerStallMs(opts: DeriveWorkerStallOpts): number {
  const base = opts.isWrite ? WRITE_STALL_MS : EXPLORE_STALL_MS
  const thinking = opts.thinking ?? true
  if (!thinking) return base
  const firstByteBase = isSlowThinkingProvider({
    providerName: opts.providerName,
    baseUrl: opts.baseUrl,
    slowThinking: opts.slowThinking,
  })
    ? SLOW_FIRST_BYTE_TIMEOUT_MS
    : REASONING_FIRST_BYTE_TIMEOUT_MS
  return Math.max(base, firstByteBase + FIRST_BYTE_SIZE_MARGIN_MS + RETRY_WINDOW_MS)
}

export interface WorkerLivenessOptions {
  /** No activity for this long ⇒ worker is considered stalled. */
  stallMs: number
  /** Injectable clock for tests. */
  now?: () => number
}

export class WorkerLiveness {
  private readonly defaultStallMs: number
  private readonly now: () => number
  private readonly lastActivity = new Map<string, number>()
  private readonly stallMsById = new Map<string, number>()

  constructor(opts: WorkerLivenessOptions) {
    this.defaultStallMs = opts.stallMs
    this.now = opts.now ?? Date.now
  }

  /** Start tracking a worker. Optional per-worker silence tolerance. */
  register(id: string, stallMs?: number): void {
    this.lastActivity.set(id, this.now())
    if (stallMs !== undefined) this.stallMsById.set(id, stallMs)
  }

  /** Record activity — resets the worker's stall clock. */
  tick(id: string): void {
    if (this.lastActivity.has(id)) this.lastActivity.set(id, this.now())
  }

  /** Stop tracking (worker completed/failed) — no false stall afterwards. */
  unregister(id: string): void {
    this.lastActivity.delete(id)
    this.stallMsById.delete(id)
  }

  /** Ids whose silence exceeds their stall tolerance. */
  stalled(): string[] {
    const t = this.now()
    const out: string[] = []
    for (const [id, last] of this.lastActivity) {
      const tolerance = this.stallMsById.get(id) ?? this.defaultStallMs
      if (t - last > tolerance) out.push(id)
    }
    return out
  }

  /** Registered silence tolerance for an id (undefined when not tracked). */
  tolerance(id: string): number | undefined {
    if (!this.lastActivity.has(id)) return undefined
    return this.stallMsById.get(id) ?? this.defaultStallMs
  }

  /** Number of workers currently tracked. */
  size(): number {
    return this.lastActivity.size
  }
}
