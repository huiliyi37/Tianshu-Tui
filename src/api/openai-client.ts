import type { StreamClient, WireDivergence } from './stream-client.js'
import type { StreamCallbacks } from './stream-client.js'
import type { OaiChatRequest, OaiMessage } from './oai-types.js'
import { estimateOaiTokens } from '../compact/micro.js'
import type { ProviderProfile } from './provider-profile.js'
import { shouldInjectPrefix, buildPrefixMessage } from './prefix-completion.js'
import { fetchWithTimeout } from './fetch-timeout.js'
import { withStructuredRetry } from './retry-engine.js'
import { parseRetryAfterMs } from './error-classifier.js'
import { sanitizeMessageContent } from '../utils/sanitize.js'
import { wireAbortToReaderCancel, wrapBodyTimeoutError } from './abort-reader.js'
import { debugLog } from '../utils/debug.js'
import { repairInvalidJsonEscapes } from './json-escape-repair.js'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Parse accumulated tool_call arguments into an input object.
 *
 * Returns:
 *  - `{}` when the buffer holds no arguments (a genuine no-arg tool call).
 *  - the parsed object on success.
 *  - a salvaged object when the buffer is two concatenated JSON objects
 *    (`{...}{...}`), which happens when a provider reuses a single
 *    `tool_calls[].index` for distinct calls — we recover the first object.
 *  - `null` when the buffer is non-empty but not yet (or not) valid JSON,
 *    signalling the caller to defer until more chunks arrive.
 *
 * The `null` signal is what stops a premature `finish_reason` flush from
 * emitting an empty-input tool_use block (GLM-5.2 streams trailing argument
 * deltas AFTER finish_reason; flushing eagerly fed `{}` to the tool, which then
 * failed with a misleading "X is required").
 */
/** Full-content djb2 for the wire-level prefix probe — hashes every character
 *  so any single-byte change in the final payload is detectable. */
function wireHash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0
  }
  return `${h}:${s.length}`
}

function tryParseToolArguments(raw: string): Record<string, unknown> | null {
  if (raw.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null
  } catch {
    // Windows-path recovery: raw backslashes in string values (`"F:\src\app"`)
    // are invalid JSON escapes that fail the whole buffer. Repair and re-parse
    // before falling back to salvage, so the call executes instead of being
    // refused as argsTruncated.
    const repaired = repairInvalidJsonEscapes(raw)
    if (repaired !== null) {
      try {
        const parsed = JSON.parse(repaired)
        if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>
      } catch { /* fall through to salvage */ }
    }
    // Salvage a single leading JSON object from a concatenated buffer.
    return salvageFirstJsonObject(repaired ?? raw)
  }
}

/** Extract and parse the first balanced top-level `{...}` from a string. */
function salvageFirstJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inStr = false
  let escaped = false
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!
    if (inStr) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const obj = JSON.parse(raw.slice(start, i + 1))
          return obj && typeof obj === 'object' ? obj as Record<string, unknown> : null
        } catch {
          return null
        }
      }
    }
  }
  return null
}

export interface OpenAIClientConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxTokens: number
  reasoningEffort?: string
  thinking?: 'enabled' | 'disabled'
  /** How to format thinking in the request body. 'openai' = use reasoning_effort only, others = use thinking block */
  thinkingFormat?: 'anthropic' | 'openai' | 'none'
  /** How effort/thinking intensity is controlled. 'none' = provider doesn't support reasoning_effort */
  effortFormat?: 'reasoning_effort' | 'output_config' | 'none'
  auth?: import('../auth/types.js').AuthProvider
  /** Stable session identifier for cache routing affinity */
  sessionId?: string
  /** Provider params to strip at all levels (preserves canonical prefix) */
  unsupported?: string[]
  /** Provider profile for cache strategy application */
  providerProfile?: ProviderProfile
  /** Provider name for feature gating (e.g. 'glm' for web_search) */
  providerName?: string
  /** Enable DeepSeek Beta prefix completion (skip preamble) */
  prefixCompletion?: boolean
  /** Use max_completion_tokens instead of max_tokens (MiMo requires this per API docs) */
  useMaxCompletionTokens?: boolean
  /** Custom User-Agent header — required by providers that verify caller identity (e.g. Kimi) */
  userAgent?: string
  /**
   * Thinking-stall timeout (ms): once reasoning tokens have arrived but no text/tool
   * output yet, abort the stream if no further chunk within this window.
   * 默认 undefined = 禁用（等于 read 超时，不提前触发）—— 故意为之：Opus/GPT-5.5 等
   * 深思模型会合法地在推理段之间停顿 90s+，过短的 stall 会造成误杀。
   * 显式设置一个 < read 的值可对易卡死的 provider 开启更早的 stall 检测。
   */
  thinkingStallTimeoutMs?: number
  /**
   * First-byte (pre-first-chunk) timeout base override (ms). Optional.
   * 默认 undefined = 按 provider/thinking 推导（45/90/180s）。这一 base 之上还会按
   * 请求预估输入规模自动上浮（见 computeFirstByteTimeoutMs），故只有当某个自定义/慢
   * OpenAI 兼容模型即便小上下文也迟迟不出首 token 时才需要显式抬高 base。
   */
  firstByteTimeoutMs?: number
  /** Provider-specific capability flags (网#1). */
  capabilities?: {
    /** DeepSeek sometimes emits tool JSON as plain text content. */
    hasToolJsonInContentBug?: boolean
  }
  /** Force JSON output mode (response_format: json_object) for every request.
   *  Worker sessions use per-request response_format instead, but this flag is
   *  available for clients that always want JSON. */
  jsonMode?: boolean
  /**
   * Provider usage calibration factor for `prompt_tokens` (0–1).
   * 1.0 (default) = trust the API's prompt_tokens as-is.
   * 0 = discard prompt_tokens; use local estimate instead.
   */
  usageCalibrationFactor?: number
}

interface ToolCallChunk {
  index?: number
  id?: string
  type?: string
  function?: { name?: string; arguments?: string }
}

const FIRST_BYTE_TIMEOUT_MS = 45_000
const REASONING_FIRST_BYTE_TIMEOUT_MS = 90_000
const READ_TIMEOUT_MS = 120_000
const REASONING_READ_TIMEOUT_MS = 180_000
// GLM-5.1, Mimo, and DeepSeek (max reasoning) mandatory thinking can take 2-3
// minutes before first token. Use generous timeouts to avoid false-positive errors.
const SLOW_FIRST_BYTE_TIMEOUT_MS = 180_000
const SLOW_READ_TIMEOUT_MS = 300_000
// Size-scaled first-byte budget (B): a large cold-context prefill legitimately
// needs longer before the first token arrives. On top of the derived/configured
// base first-byte timeout, add PER_100K per 100k estimated input tokens, capped
// by MAX (kept below the 10min base hard cap and retry budget). Pre-first-chunk
// only — read timeout and thinking-stall detection are unchanged.
const FIRST_BYTE_PER_100K_MS = 60_000
const FIRST_BYTE_MAX_MS = 420_000
// GLM-5.2 reasoning_effort=max: 服务端完整推理阶段可能 5min+ 不发 token，
// 300s read timeout 会误杀。单独给到 720s（12min 硬顶兜底 runaway）。
const GLM_READ_TIMEOUT_MS = 720_000
/** Providers whose thinking mode can exceed 90s before first token. */
const SLOW_THINKING_PROVIDERS = new Set(['glm', 'mimo', 'deepseek', 'codex', 'minimax'])
/**
 * Per-process cap on the always-on tool-stream event log (logToolStreamEvent).
 * These events fire only on rare streaming pathologies (ambiguous continuation
 * chunks dropped, final-flush empty tool_use), so a long healthy session writes
 * zero lines. Hitting the cap means the provider is misbehaving — stop logging
 * rather than fill disk.
 */
const TOOL_STREAM_LOG_MAX_LINES = 2000
// Thinking-stall timeout 现由 config.thinkingStallTimeoutMs 控制（默认禁用，见
// resetIdleTimer 与 OpenAIClientConfig 注释）。旧的模块级常量已移除——它恒等于
// SLOW_READ_TIMEOUT_MS（实为禁用），且配套错误文案硬编码"90s"与实际值不符。

/** Recent-progress window for hard-cap extension: a data event within this
 *  window counts as "still producing" and earns another extension slice. */
const HARD_CAP_PROGRESS_WINDOW_MS = 60_000
const HARD_CAP_EXTENSION_SLICE_MS = 60_000
/** GLM reasoning can pause 30-60s between deltas without being stalled.
 *  Use a wider progress window so the hard cap doesn't abort healthy streams. */
const GLM_HARD_CAP_PROGRESS_WINDOW_MS = 120_000

/**
 * Size-scaled first-byte timeout (B). Pure function for testability.
 *
 * Adds a size term on top of the base first-byte budget so a genuinely large
 * cold-context prefill is not false-killed before the first token arrives, while
 * small requests keep the existing base. The result is capped so a truly dead
 * connection still fails within a bounded window.
 *
 * @param baseMs derived-or-configured base first-byte timeout (ms)
 * @param estInputTokens estimated prompt tokens for this request
 */
export function computeFirstByteTimeoutMs(input: {
  baseMs: number
  estInputTokens: number
  per100kMs?: number
  capMs?: number
}): number {
  const per100kMs = input.per100kMs ?? FIRST_BYTE_PER_100K_MS
  const capMs = input.capMs ?? FIRST_BYTE_MAX_MS
  const buckets = Math.floor(Math.max(0, input.estInputTokens) / 100_000)
  const scaled = input.baseMs + buckets * per100kMs
  return Math.min(scaled, capMs)
}

export type StreamHardCapAction =
  | { kind: 'abort' }
  | { kind: 'rearm'; rearmMs: number; extended: boolean }

/**
 * Track 4 自适应流硬顶：固定 10min 硬顶会误杀 1M+max-reasoning 的健康长输出
 * （死流早被 idle/stall 计时器拦截）。到达基础硬顶后，只要最近 progressWindowMs
 * 内仍有 data 事件就按 60s 一档续期，绝对上限 3×基础时长兜底 runaway。纯函数，
 * 由 openai-client 的硬顶计时器驱动。
 *
 * @param progressWindowMs 进度窗口（ms），默认 30s。GLM reasoning 模式传 120s
 *   以防止深度推理中 30-60s 的无 delta 停顿被误判为卡死。
 */
export function decideStreamHardCap(input: {
  now: number
  startedAt: number
  lastDataEventAt: number
  baseStreamMs: number
}, progressWindowMs = HARD_CAP_PROGRESS_WINDOW_MS): StreamHardCapAction {
  const absoluteMaxMs = input.baseStreamMs * 3
  const elapsed = input.now - input.startedAt
  if (elapsed >= absoluteMaxMs) return { kind: 'abort' }
  if (elapsed >= input.baseStreamMs) {
    if (input.now - input.lastDataEventAt > progressWindowMs) return { kind: 'abort' }
    return { kind: 'rearm', rearmMs: Math.min(HARD_CAP_EXTENSION_SLICE_MS, absoluteMaxMs - elapsed), extended: true }
  }
  return { kind: 'rearm', rearmMs: input.baseStreamMs - elapsed, extended: false }
}

export class OpenAIClient implements StreamClient {
  private toolCallBuffer = new Map<number, { id?: string; type?: string; function: { name?: string; arguments: string } }>()
  private toolCallHintFired = new Set<number>()
  /** Resolved raw-SSE dump path (undefined = unresolved, null = disabled/failed). */
  private rawSsePath: string | null | undefined = undefined
  private pendingStopReason: string | null = null
  /** Messages from the current stream request — used for usage calibration. */
  private lastRequestMessages: OaiChatRequest['messages'] = []
  /** Accumulated text for DeepSeek tool-JSON-in-content fallback (网#1). */
  private _textAccum = ''
  /** Stable suffix appended to system message for Chinese thinking (computed once, cache-safe). */
  private readonly systemSuffix: string
  /**
   * Resolved path for the lightweight tool-stream event log (always-on, best-effort).
   * undefined = unresolved, null = disabled/failed. Appends one JSON line per
   * notable streaming event (pollution-risk drops, final-flush empties) so the
   * cross-tool argument corruption class of bug leaves a trace WITHOUT requiring
   * RIVET_DEBUG. Capped at TOOL_STREAM_LOG_MAX_LINES per process to bound disk.
   */
  private toolStreamLogPath: string | null | undefined = undefined
  private toolStreamLogLines = 0
  /** Wire-level prefix probe: per-message signatures of the previous main-turn
   *  request's FINAL bytes (post reasoning-strip / sanitize / system-suffix).
   *  Only updated for requests with `prefixProbe: true` so side-path calls
   *  through this client don't poison the baseline. */
  private prevWireSignatures: Array<{ sig: string; len: number; role: string }> | null = null
  /** Latest wire divergence (consume-once via consumeWireDivergence). */
  private lastWireDivergence: WireDivergence | null = null

  constructor(private config: OpenAIClientConfig) {
    this.systemSuffix = (config.providerName === 'mimo' || config.providerName === 'deepseek') && config.thinking === 'enabled'
      ? '\n\n请在内部思考链中使用中文进行推理。不要在回复中输出你的推理过程，只输出最终答案或工具调用。'
      : ''
    this._sanitizedCount = 0
  }

  // ── Incremental sanitize ─────────────────────────────────────
  // Historical messages are already sanitized at entry points
  // (addUserMessage/addAssistantBlocks/addToolResults). Re-sanitizing
  // the full message array every turn is O(history) overhead that grows
  // linearly with conversation length — particularly wasteful at 1M
  // context windows. We track the sanitized count and only apply the
  // safety-net sanitize to newly appended messages.
  private _sanitizedCount: number

  setReasoningEffort(effort: string): void {
    // OpenAI uses reasoning_effort in request body — store for next request
    this.config = { ...this.config, reasoningEffort: effort }
  }

  setThinking(mode: 'enabled' | 'disabled'): void {
    this.config = { ...this.config, thinking: mode }
  }

  async stream(
    request: OaiChatRequest,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    this.lastRequestMessages = request.messages
    // reasoning_content stripping rules:
    // - DeepSeek (preserved thinking): keep for tool-call turns, strip for pure-text
    // - GLM (independent reasoning): always strip — no preserved thinking context
    // - Thinking disabled: always strip
    const isGlm = this.config.providerName === 'glm'
    const isPreservedThinking = this.config.thinking === 'enabled' && !isGlm
      && (this.config.providerName === 'deepseek' || this.config.providerName === 'mimo')
    const messages = request.messages.map(m => {
      if (m.role !== 'assistant') return m
      const hasToolCalls = Array.isArray((m as any).tool_calls) && (m as any).tool_calls.length > 0
      // DeepSeek preserved-thinking: tool-call turns must echo reasoning_content.
      // Some turns omit the field entirely (model skipped thinking). Absent vs
      // present changes wire bytes and breaks prefix cache at the next user
      // boundary (8396ac51: truncations aligned with first no-reasoning assistant).
      if (isPreservedThinking && hasToolCalls && !('reasoning_content' in m)) {
        return { ...m, reasoning_content: '' }
      }
      if (!('reasoning_content' in m)) return m
      if (isPreservedThinking && hasToolCalls) return m
      const { reasoning_content: _, ...rest } = m
      // DeepSeek requires assistant messages to have `content` or `tool_calls`.
      // After stripping reasoning_content, ensure `content` exists.
      if (!('content' in rest) && !hasToolCalls) {
        (rest as Record<string, unknown>).content = ''
      }
      return rest
    })

    const body: Record<string, unknown> = {
      model: request.model,
      messages,
      stream: true,
    }

    // MiMo API uses max_completion_tokens, standard OpenAI uses max_tokens
    if (this.config.useMaxCompletionTokens) {
      body.max_completion_tokens = request.max_tokens ?? this.config.maxTokens
    } else {
      body.max_tokens = request.max_tokens ?? this.config.maxTokens
    }

    // stream_options: { include_usage: true } is an OpenAI extension.
    // Some providers return 400 if unsupported.
    if (!this.config.unsupported?.includes('stream_options')) {
      body.stream_options = { include_usage: true }
    }

    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools
      if (request.tool_choice) body.tool_choice = request.tool_choice
    }

    // JSON output mode: force the model to emit valid JSON. Per-request
    // response_format (worker final turn) takes precedence; config.jsonMode is a
    // fallback for always-JSON clients. DeepSeek/GLM require the prompt to
    // mention "json" when this is set — worker prompts already satisfy this.
    if (request.response_format) {
      body.response_format = request.response_format
    } else if (this.config.jsonMode) {
      body.response_format = { type: 'json_object' }
    }

    if (request.temperature !== undefined) body.temperature = request.temperature

    // MiniMax: reasoning_split separates thinking into reasoning_content field
    // (DeepSeek-compatible), otherwise thinking is embedded in <think> tags inside content
    if (this.config.providerName === 'minimax') {
      body.reasoning_split = true
    }

    // Thinking / reasoning dispatch.
    // Providers that accept {thinking: {type: 'enabled'}} (DeepSeek, GLM, etc.):
    // send the thinking block. Pure OpenAI providers use reasoning_effort.
    const usesThinkingBlock = this.config.thinkingFormat === 'anthropic'
      || this.config.providerName === 'glm'
      || this.config.providerName === 'claude'
      || this.config.providerName === 'mimo'
      || this.config.providerName === 'minimax'

    if (this.config.thinking === 'enabled') {
      if (usesThinkingBlock) {
        body.thinking = { type: this.config.thinking }
        if (this.config.providerName === 'minimax') {
          body.thinking = { type: 'adaptive' }
        }
        // GLM: independent reasoning mode (no preserved thinking).
        // Prior reasoning is NOT echoed — each turn is a fresh reasoning start.
        // This avoids the cross-API-call context discontinuity that causes GLM
        // to restart reasoning mid-turn after a stream abort/timeout.
        if (this.config.providerName === 'claude' && this.config.reasoningEffort) {
          const budgetMap: Record<string, number> = {
            max: this.config.maxTokens,
            high: Math.floor(this.config.maxTokens * 0.6),
            medium: Math.floor(this.config.maxTokens * 0.3),
            low: 8192,
            off: 0,
          }
          const budget = budgetMap[this.config.reasoningEffort ?? 'high'] ?? Math.floor(this.config.maxTokens * 0.6)
          ;(body.thinking as Record<string, unknown>)['budget_tokens'] = budget
        }
        // DeepSeek-style: thinking 块与 reasoning_effort **并存**（官方 curl 样例
        // 同时带 {thinking:{type:enabled}} 和 {reasoning_effort:high/max}）。
        // 旧实现只发 thinking 块，配置的 reasoningEffort(v4-pro=max) 被静默丢弃，
        // DeepSeek 退回服务端默认 effort(high)。Claude/GLM/minimax 各有块内 effort
        // 编码(budget_tokens/clear_thinking/adaptive)，故仅对 reasoning_effort 格式补发。
        if (this.config.effortFormat === 'reasoning_effort'
          && this.config.reasoningEffort
          && this.config.reasoningEffort !== 'off') {
          body.reasoning_effort = this.config.reasoningEffort
        }
      } else if (this.config.effortFormat !== 'none') {
        body.reasoning_effort = this.config.reasoningEffort ?? 'medium'
      }
    }
    if (request.reasoning_effort && this.config.effortFormat !== 'none') {
      body.reasoning_effort = request.reasoning_effort
    }
    // Codex (served via cliproxy) tops out at 'xhigh', not Rivet's canonical
    // 'max'. Map at the wire so the global ReasoningEffort enum stays unchanged
    // and other providers keep receiving 'max'.
    if (this.config.providerName === 'codex' && body.reasoning_effort === 'max') {
      body.reasoning_effort = 'xhigh'
    }
    // Kimi (kimi-for-coding) does not support 'max'; cap at 'high'.
    if (this.config.providerName === 'kimi' && body.reasoning_effort === 'max') {
      body.reasoning_effort = 'high'
    }

    // Apply stable system suffix (Chinese thinking instruction) — computed once
    // at construction. Copy-on-write, NEVER `content +=`: the system message
    // object is shared by reference with the caller's request.messages, and the
    // same request object can re-enter stream() (llm-speculation reuses the main
    // request's messages; FallbackStreamClient replays the request on failover).
    // In-place mutation double-appended the suffix on re-entry → system bytes
    // changed mid-session → full prefix-cache miss for that request (2026-07-06
    // wireDiverged idx 0 incident).
    if (this.systemSuffix) {
      const wireMessages = body.messages as Record<string, unknown>[]
      const sysIdx = wireMessages.findIndex(m => m.role === 'system')
      const sysMsg = sysIdx >= 0 ? wireMessages[sysIdx]! : undefined
      if (sysMsg && typeof sysMsg.content === 'string') {
        wireMessages[sysIdx] = { ...sysMsg, content: sysMsg.content + this.systemSuffix }
      }
    }

    // Incremental sanitize: only re-sanitize messages appended since last
    // request. Historical messages were already sanitized at entry points
    // (addUserMessage/addAssistantBlocks/addToolResults). This avoids O(n)
    // overhead that grows linearly with conversation length.
    const msgArray = body.messages as Array<Record<string, unknown>>
    if (msgArray.length <= this._sanitizedCount) {
      // Compaction or message replacement: reset and full sanitize
      this._sanitizedCount = 0
    }
    const newMessages = msgArray.slice(this._sanitizedCount)
    if (newMessages.length > 0) {
      const sanitizedNew = sanitizeMessageContent(newMessages)
      for (let i = 0; i < sanitizedNew.length; i++) {
        msgArray[this._sanitizedCount + i] = sanitizedNew[i]!
      }
      this._sanitizedCount = msgArray.length
    }

    // Wire-level prefix probe (2026-07-06 cache investigation): fingerprint the
    // FINAL messages — everything above (reasoning-strip, system-suffix,
    // sanitize) has already been applied, so this hashes exactly what goes on
    // the socket. The engine-level probe proved the pre-transform arrays are
    // append-only; cacheRead regressions kept happening anyway, so the
    // remaining client-side suspects are these transforms. Joined with
    // cacheRead regressions in the cache-log this separates send-layer byte
    // churn from provider-side rendering/落盘 behavior.
    if (request.prefixProbe) this.recordWireDivergence(msgArray)

    await this.sendStream(body, callbacks, signal)
  }

  /** Compare this request's final wire bytes with the previous main-turn
   *  request's; record the first diverged message. Pure appends record nothing. */
  private recordWireDivergence(messages: Array<Record<string, unknown>>): void {
    const sigs = messages.map(m => {
      const s = JSON.stringify(m)
      return { sig: wireHash(s), len: s.length, role: String(m.role ?? '?') }
    })
    const prev = this.prevWireSignatures
    this.prevWireSignatures = sigs
    if (!prev) return

    const shared = Math.min(prev.length, sigs.length)
    let divergedIdx = -1
    for (let i = 0; i < shared; i++) {
      if (prev[i]!.sig !== sigs[i]!.sig) { divergedIdx = i; break }
    }
    if (divergedIdx === -1) {
      if (sigs.length >= prev.length) return // pure append (or identical)
      divergedIdx = sigs.length
    }
    let approxCharPos = 0
    for (let i = 0; i < divergedIdx; i++) approxCharPos += sigs[i]?.len ?? prev[i]!.len
    this.lastWireDivergence = {
      idx: divergedIdx,
      role: sigs[divergedIdx]?.role ?? 'removed',
      kind: divergedIdx >= sigs.length ? 'message_removed' : 'message_changed',
      prevCount: prev.length,
      newCount: sigs.length,
      approxCharPos,
    }
  }

  /** Consume-once accessor for the latest wire-level prefix divergence. */
  consumeWireDivergence(): WireDivergence | null {
    const d = this.lastWireDivergence
    this.lastWireDivergence = null
    return d
  }

  /** Shared inner retry+fetch+SSE loop used by both stream and streamOai. */
  private async sendStream(
    body: Record<string, unknown>,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<void> {
    // reasoningRef survives retry attempts within this sendStream call.
    // When a mid-stream failure occurs (e.g. idle timeout, connection reset),
    // the accumulated reasoning_content is saved here and echoed back to the
    // model on the next retry so it doesn't have to redo all the thinking.
    const reasoningRef = { content: '' }
    const isThinking = this.config.thinking === 'enabled'

    // Size-scaled first-byte budget (B): estimate prompt size once (stable across
    // retries; the per-retry reasoning re-injection is negligible) and derive a
    // first-byte timeout that grows with input so large cold-context prefills are
    // not false-killed before the first token. Used for both the fetch headers
    // guard and the pre-first-chunk SSE idle timer.
    const estInputTokens = estimateOaiTokens((body.messages as OaiMessage[]) ?? [])
    const derivedFirstByteBaseMs = isThinking
      ? (SLOW_THINKING_PROVIDERS.has(this.config.providerName ?? '') ? SLOW_FIRST_BYTE_TIMEOUT_MS : REASONING_FIRST_BYTE_TIMEOUT_MS)
      : FIRST_BYTE_TIMEOUT_MS
    const firstByteMs = computeFirstByteTimeoutMs({
      baseMs: this.config.firstByteTimeoutMs ?? derivedFirstByteBaseMs,
      estInputTokens,
    })

    await withStructuredRetry(async () => {
      // Reset instance state for each attempt
      this.toolCallBuffer.clear()
      this.toolCallHintFired.clear()
      this.pendingStopReason = null
      this._textAccum = ''

      // Inject previous reasoning into messages on retry so the model can
      // resume from where it left off instead of restarting from scratch.
      // DeepSeek requires assistant messages to have `content` or `tool_calls`.
      //
      // GLM exception: GLM's preserved thinking (clear_thinking: false) has its
      // own incremental protocol — it expects complete prior-turn reasoning, not
      // partial mid-stream fragments. Injecting partial reasoning_content breaks
      // the increment and causes GLM to re-reason from scratch (the exact
      // "推理到一半中断然后从头推一遍" symptom). GLM retains reasoning server-side,
      // so skipping client-side reinjection is safe.
      let effectiveBody = body
      const isGlm = this.config.providerName === 'glm'
      if (isThinking && reasoningRef.content && !isGlm) {
        const msgs = [...(body.messages as unknown[]), {
          role: 'assistant',
          content: '',
          reasoning_content: reasoningRef.content,
        }]
        effectiveBody = { ...body, messages: msgs }
      }

      // Resolve auth headers: AuthProvider takes precedence over static apiKey
      const authHeaders = this.config.auth
        ? await this.config.auth.getHeaders()
        : { 'Authorization': `Bearer ${this.config.apiKey}` }

      // Pre-first-byte timeout prevents fetch from hanging forever when the
      // server accepts the connection but never sends response headers. Uses the
      // size-scaled first-byte budget computed above.
      const fetchTimeout = firstByteMs
      // 共享 lifecycle controller：传给 fetch 的信号。它由外部 user signal 联动，
      // 也由 parseStreamFromReader 在任何退出路径（idle/硬顶超时、错误、正常结束）
      // 于 finally 中 abort —— 确保 keep-alive 下仅 reader.cancel() 可能拆不掉的 TCP
      // 连接被 fetch 侧 abort 真正拆除（mid-body abort 同时拆 fetch）。
      const lifecycle = new AbortController()
      if (signal) {
        if (signal.aborted) lifecycle.abort()
        else signal.addEventListener('abort', () => lifecycle.abort(), { once: true })
      }
      const response = await fetchWithTimeout(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Connection': 'keep-alive',
          ...(this.config.userAgent ? { 'User-Agent': this.config.userAgent } : {}),
          ...authHeaders,
          ...(this.config.sessionId ? { 'X-Request-Session': this.config.sessionId } : {}),
        },
        body: JSON.stringify(effectiveBody),
        signal: lifecycle.signal,
      }, fetchTimeout)

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '')
        const err = Object.assign(
          new Error(parseOpenAIError(response.status, errorBody)),
          { status: response.status },
        )
        // Attach parsed retry-after for the error classifier to use
        const retryAfter = response.headers.get('retry-after')
        if (retryAfter) {
          const retryAfterMs = parseRetryAfterMs(retryAfter)
          if (retryAfterMs !== undefined) {
            ;(err as Error & { retryAfterMs?: number }).retryAfterMs = retryAfterMs
          }
        }
        throw err
      }

      const reader = response.body?.getReader()
      if (!reader) throw new Error('Response body is not readable')

      await this.parseStreamFromReader(reader, callbacks, signal, reasoningRef, lifecycle, firstByteMs)
    }, signal, {
      maxTotalDurationMs: this.config.providerName === 'glm' ? 20 * 60_000 : 10 * 60_000,
      // Thinking retries are normally throttled to 1 because re-reasoning is costly.
      // 例外：slow-thinking providers 在被中止的那次尝试里已把整个 prompt 灌进服务端
      // 前缀缓存，重试命中近 100% 缓存（实测 deepseek 99.4% hit、~12s 完成），代价极低。
      // 给它们 2 次重试，让「单次服务端 thinking 卡死」甚至「连续两次卡死」都能自愈而
      // 不冒泡成错误。maxTotalDurationMs 仍是总时长兜底，防 runaway。
      maxTotalRetries: isThinking
        ? (SLOW_THINKING_PROVIDERS.has(this.config.providerName ?? '') ? 2 : 1)
        : undefined,
      onRetry: (info) => {
        if (info.classified.category === 'rate_limit') {
          callbacks.onRateLimit?.(info.classified.retryDelayMs)
        }
      },
    })
  }

  /** Parse SSE stream from a reader — exposed for testing */

  /** Parse SSE stream from a reader — exposed for testing */
  async parseStreamFromReader(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    callbacks: Partial<Pick<StreamCallbacks, 'onTextDelta' | 'onContentBlock' | 'onStopReason' | 'onStreamAttemptAborted'>>,
    signal?: AbortSignal,
    reasoningRef?: { content: string },
    /**
     * 传给 fetch 的共享 lifecycle controller。任何退出路径（正常结束 / idle 或硬顶
     * 超时 / 错误 / 用户 abort）都会在 finally 中 abort 它，确保 keep-alive 下
     * reader.cancel() 拆不掉的连接被 fetch 侧 abort 真正拆除。
     */
    lifecycle?: AbortController,
    /**
     * Size-scaled first-byte (pre-first-chunk) timeout (ms). When provided,
     * overrides the derived first-byte value in resetIdleTimer. Direct test
     * callers may omit it to keep the legacy derived behavior.
     */
    firstByteTimeoutMs?: number,
  ): Promise<void> {
    const decoder = new TextDecoder()
    let buffer = ''
    let streamTimedOut = false
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    let receivedFirstChunk = false
    /** 本次 idle timer 实际生效的超时（ms），供触发时输出准确文案。 */
    let lastIdleTimeoutMs = 0
    /** 本次 idle timer 是否以"thinking-stall"（短于 read）名义触发。 */
    let lastFiredAsThinkingStall = false
    /** Whether any reasoning_content has been received — used to detect thinking stalls. */
    let receivedThinking = false
    // GLM-5.1 mandatory thinking mode outputs everything as reasoning_content
    // with no content field. Accumulate reasoning to promote if no content arrives.
    let reasoningAccum = ''
    let textReceived = false
    let promotionFired = false

    // Create an internal timeout AbortSignal for hard timeout guarantee.
    // This ensures reader.read() is unblocked even if reader.cancel() alone
    // cannot break the TCP connection (e.g. GLM server keeps connection alive).
    //
    // Track 4 自适应硬顶：固定 10min 会误杀 1M+max-reasoning 的健康长输出
    // （死流早被 idle/stall 计时器拦截，硬顶杀掉的只能是仍在产出的流）。
    // 改为按输出进度续期：到达基础硬顶时若最近 30s 内仍有 data 事件，
    // 续 60s 一档，绝对上限 3×基础（30min）兜底 runaway。
    const timeoutController = new AbortController()
    const isGlm = this.config.providerName === 'glm'
    const baseStreamMs = isGlm ? 20 * 60_000 : 10 * 60_000
    const streamStartedAt = Date.now()
    let lastDataEventAt = streamStartedAt
    let hardCapExtended = false
    const progressWindowMs = isGlm ? GLM_HARD_CAP_PROGRESS_WINDOW_MS : HARD_CAP_PROGRESS_WINDOW_MS
    const checkHardCap = (): void => {
      const action = decideStreamHardCap({
        now: Date.now(),
        startedAt: streamStartedAt,
        lastDataEventAt,
        baseStreamMs,
      }, progressWindowMs)
      if (action.kind === 'abort') {
        timeoutController.abort()
        return
      }
      if (action.extended) hardCapExtended = true
      maxStreamTimer = setTimeout(checkHardCap, action.rearmMs)
    }
    let maxStreamTimer: ReturnType<typeof setTimeout> = setTimeout(checkHardCap, baseStreamMs)

    // Wire both external and timeout signals to reader.cancel() so that
    // either agent.abort() OR the hard timeout can interrupt blocking read().
    const signalCleanup = signal
      ? wireAbortToReaderCancel(AbortSignal.any([signal, timeoutController.signal]), reader)
      : wireAbortToReaderCancel(timeoutController.signal, reader)

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer)
      const isReasoning = this.config.thinking === 'enabled'
      const isSlowProvider = SLOW_THINKING_PROVIDERS.has(this.config.providerName ?? '')
      // Prefer the size-scaled first-byte budget computed by sendStream (B);
      // fall back to the derived value for direct callers (tests) that omit it.
      const firstByteMs = firstByteTimeoutMs ?? (isSlowProvider ? SLOW_FIRST_BYTE_TIMEOUT_MS
        : isReasoning ? REASONING_FIRST_BYTE_TIMEOUT_MS : FIRST_BYTE_TIMEOUT_MS)
      const isGlm = this.config.providerName === 'glm'
      const readMs = isGlm && isReasoning ? GLM_READ_TIMEOUT_MS
        : isSlowProvider ? SLOW_READ_TIMEOUT_MS
        : isReasoning ? REASONING_READ_TIMEOUT_MS : READ_TIMEOUT_MS
      // Thinking-stall detection: once thinking tokens have arrived but no text
      // content yet, use a (configurable) shorter timeout to catch stalled thinking
      // streams. If the provider has already sent a complete content block (for
      // example a tool_use) but no text delta, do not treat the stream as
      // thinking-only: some APIs finalize tool calls without any text content.
      // 默认 thinkingStallTimeoutMs 未配置 → 取 readMs（等于禁用，不提前触发），
      // 保留对深思模型不误杀的既有行为；显式配置可对易卡死 provider 开启更早 stall。
      const hasActionableBlock = this.toolCallBuffer.size > 0 || this._textAccum.length > 0
      const inThinkingOnly = receivedThinking && !textReceived && !hasActionableBlock
      const thinkingStallMs = inThinkingOnly
        ? Math.min(this.config.thinkingStallTimeoutMs ?? readMs, readMs)
        : null
      const timeout = receivedFirstChunk
        ? (thinkingStallMs ?? readMs)
        : firstByteMs
      // 记录本次实际生效的超时，供 idle 触发时输出准确文案（不再硬编码"90s"）。
      lastIdleTimeoutMs = timeout
      lastFiredAsThinkingStall = thinkingStallMs !== null && thinkingStallMs < readMs
      idleTimer = setTimeout(() => {
        streamTimedOut = true
        reader.cancel().catch(() => {})
      }, timeout)
    }

    try {
      resetIdleTimer()
      let streamDone = false
      while (!streamDone) {
        // Check both external signal and internal timeout signal.
        // External signal: agent.abort() / worker budget / Ctrl+C
        // Timeout signal: hard 10min ceiling on stream duration
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
        if (timeoutController.signal.aborted) {
          const mins = Math.round((Date.now() - streamStartedAt) / 60_000)
          throw new Error(hardCapExtended
            ? `OpenAI SSE stream hard timeout (~${mins}min, progress-extended) — stream exceeded maximum duration`
            : 'OpenAI SSE stream hard timeout (10min) — stream stopped progressing')
        }

        const { done, value } = await reader.read()
        // Check timeout AFTER read — reader.cancel() from idle timer causes
        // read() to return done=true, but we must throw, not silently break.
        if (streamTimedOut) {
          const secs = Math.round(lastIdleTimeoutMs / 1000)
          const msg = lastFiredAsThinkingStall
            ? `OpenAI SSE stream thinking stall timeout (${secs}s) — model stopped producing thinking tokens`
            : `OpenAI SSE stream idle timeout (${secs}s)`
          throw new Error(msg)
        }
        if (done) break

        receivedFirstChunk = true

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        // keepalive 感知：只有解析出真正的 `data:` 事件才算"进展"并重置 idle timer。
        // 服务端心跳是 `:` 注释行 / 空行（被下面 startsWith('data:') 过滤掉），
        // 若按任意字节重置（旧行为），纯心跳流会让 stall 检测失效、最坏拖到 10min 硬顶。
        let sawDataEvent = false
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed || !trimmed.startsWith('data:')) continue

          const payload = trimmed.slice(5).trimStart()
          if (payload === '[DONE]') { streamDone = true; break }
          sawDataEvent = true

          if (process.env.RIVET_DEBUG_RAW_SSE) this.dumpRawSse(payload)

          try {
            const parsed = JSON.parse(payload)
            this.processDelta(parsed, callbacks)
            // Track whether text/content was received (for reasoning promotion fallback)
            if (parsed.choices?.[0]?.delta?.content) textReceived = true
            if (parsed.choices?.[0]?.delta?.reasoning_content) {
              reasoningAccum += parsed.choices[0].delta.reasoning_content
              receivedThinking = true
              if (reasoningRef) reasoningRef.content = reasoningAccum
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
        // 仅在收到真实内容事件时重置 idle timer（心跳不重置）
        if (sawDataEvent) {
          lastDataEventAt = Date.now()
          resetIdleTimer()
        }
      }

      // Process any residual data in the SSE buffer (final chunk without trailing newline)
      if (buffer.trim()) {
        const trimmed = buffer.trim()
        if (trimmed.startsWith('data:')) {
          const payload = trimmed.slice(5).trimStart()
          if (payload !== '[DONE]') {
            try {
              const parsed = JSON.parse(payload)
              this.processDelta(parsed, callbacks)
              if (parsed.choices?.[0]?.delta?.content) textReceived = true
              if (parsed.choices?.[0]?.delta?.reasoning_content) {
                reasoningAccum += parsed.choices[0].delta.reasoning_content
                receivedThinking = true
                if (reasoningRef) reasoningRef.content = reasoningAccum
              }
            } catch { /* skip malformed */ }
          }
        }
      }

      this.flushToolCalls(callbacks, { final: true })
      // 网#1: DeepSeek tool-JSON-in-content fallback
      let textConsumedAsToolJson = false
      if (this.toolCallBuffer.size === 0 && this._textAccum && this.config.capabilities?.hasToolJsonInContentBug) {
        textConsumedAsToolJson = this.tryParseToolJsonFromContent(this._textAccum, callbacks) > 0
      }

      // Emit thinking content block so reasoning_content can be passed back
      // in subsequent requests. Mimo, MiniMax, and other OpenAI-compatible
      // providers that return reasoning_content require it to be echoed.
      if (reasoningAccum) {
        callbacks.onContentBlock?.({ type: 'thinking', thinking: reasoningAccum })
      }

      // GLM-5.1 mandatory thinking: if only reasoning_content arrived (no content),
      // promote reasoning to visible text so the TUI shows a reply.
      // ONLY promote for GLM — MiMo/DeepSeek properly separate reasoning from
      // content. When MiMo sends a tool-call turn (reasoning_content + tool_calls
      // but no content), promoting would leak thinking into visible text.
      if (!textReceived && reasoningAccum && this.config.providerName === 'glm') {
        callbacks.onTextDelta?.(reasoningAccum)
        promotionFired = true
      }

      // Emit the final text content block (normal completion only — never on
      // error/retry paths, where a second attempt would re-emit and duplicate).
      // The agent loop persists assistant turns from content blocks; without
      // this block, text-only replies never reached session history and the
      // model re-answered the previous turn. Mirrors anthropic/codex clients.
      const finalText = !textConsumedAsToolJson && this._textAccum
        ? this._textAccum
        : promotionFired ? reasoningAccum : ''
      if (finalText) {
        callbacks.onContentBlock?.({ type: 'text', text: finalText })
      }
      this._textAccum = ''

      // If no usage chunk arrived, emit stop reason now
      if (this.pendingStopReason) {
        callbacks.onStopReason?.(mapFinishReason(this.pendingStopReason), {})
        this.pendingStopReason = null
      }
    } catch (err) {
      // Observability: surface how much streamed output this attempt discards.
      callbacks.onStreamAttemptAborted?.({
        provider: this.config.providerName ?? 'openai',
        receivedChars: reasoningAccum.length + this._textAccum.length,
        elapsedMs: Date.now() - streamStartedAt,
        errorName: (err as Error)?.name ?? 'Error',
        errorMessage: (err as Error)?.message ?? String(err),
      })
      // Body-phase TimeoutError (raw undici DOMException) → descriptive,
      // classifiable Error. User AbortError and other errors pass through.
      throw wrapBodyTimeoutError(err, 'OpenAI', streamStartedAt)
    } finally {
      if (idleTimer) clearTimeout(idleTimer)
      if (maxStreamTimer) clearTimeout(maxStreamTimer)
      if (signalCleanup) signalCleanup()
      // 拆 fetch 连接：keep-alive 下 reader.cancel() 可能把连接还给连接池而非关闭，
      // abort 传给 fetch 的 lifecycle signal 强制 undici 销毁底层 socket。已结束的
      // 响应上 abort 为无操作，故正常结束路径安全。
      lifecycle?.abort()

      // Promote reasoning to text even on stream error — prevents GLM "stuck" when
      // stream breaks after receiving reasoning_content but before normal completion.
      // Only for GLM — see main promotion block above for rationale.
      if (!textReceived && reasoningAccum && !promotionFired && this.config.providerName === 'glm') {
        callbacks.onTextDelta?.(reasoningAccum)
      }
    }
  }

  /**
   * Resolve which toolCallBuffer slot a streaming chunk belongs to.
   *
   * Returns the slot index, or null to DROP the chunk. Dropping is the
   * fail-safe choice when a continuation chunk carries no `index`/`id` and more
   * than one buffer is open — misgrafting it onto another tool's arguments
   * corrupts both (the parallel tool_call pollution bug). A dropped trailing
   * fragment at worst leaves one call's JSON incomplete, which the existing
   * final-flush + salvageFirstJsonObject path already handles.
   */
  private resolveToolCallIndex(tc: ToolCallChunk): number | null {
    if (tc.index !== undefined) return tc.index
    // Continuation chunk (typically a trailing-arguments delta after
    // finish_reason). Providers omit index here; reattach by identity.
    if (tc.id !== undefined) {
      for (const [idx, buf] of this.toolCallBuffer) {
        if (buf.id === tc.id) {
          this.logToolStreamEvent({
            phase: 'reattach-by-id', openBuffers: this.toolCallBuffer.size,
            id: tc.id, name: buf.function.name,
            argsLen: tc.function?.arguments?.length, argsPreview: tc.function?.arguments?.slice(0, 80),
          })
          return idx
        }
      }
    }
    // No identity on the chunk: if exactly one buffer is open, it must be the
    // target (the common single-call trailing-args case). With multiple open we
    // cannot know — drop rather than guess and pollute.
    if (this.toolCallBuffer.size === 1) {
      const idx = this.toolCallBuffer.keys().next().value!
      this.logToolStreamEvent({
        phase: 'reattach-sole', openBuffers: 1,
        argsLen: tc.function?.arguments?.length, argsPreview: tc.function?.arguments?.slice(0, 80),
      })
      return idx
    }
    // Fallback: preserve historical behavior for the degenerate "no buffer open
    // yet" case (a first chunk with no index) by seeding slot 0; otherwise drop.
    if (this.toolCallBuffer.size === 0) return 0
    // Ambiguous: multiple open buffers, no index/id. Dropping is the fail-safe
    // choice (one call's JSON may be incomplete) vs. the old `?? 0` which grafted
    // onto a different tool and corrupted both. Log so this provider pathology
    // is visible without RIVET_DEBUG.
    this.logToolStreamEvent({
      phase: 'drop-ambiguous', openBuffers: this.toolCallBuffer.size,
      argsLen: tc.function?.arguments?.length, argsPreview: tc.function?.arguments?.slice(0, 80),
    })
    return null
  }

  /** Process a single SSE delta chunk — exposed for testing */
  processDelta(
    chunk: {
      choices?: Array<{
        delta: { content?: string | null; reasoning_content?: string | null; tool_calls?: Array<ToolCallChunk> }
        finish_reason?: string | null
      }>
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number; prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number } }
    },
    callbacks: Partial<Pick<StreamCallbacks, 'onTextDelta' | 'onThinkingDelta' | 'onContentBlock' | 'onStopReason' | 'onToolCallHint' | 'onToolCallDelta'>>,
  ): void {
    const choice = chunk.choices?.[0]

    // Usage-only chunk (final chunk with include_usage)
    if (chunk.usage && choice === undefined) {
      const usage = chunk.usage
      const stopReason = this.pendingStopReason ?? 'end_turn'
      this.pendingStopReason = null
      const cacheRead = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
      callbacks.onStopReason?.(mapFinishReason(stopReason), this.calibrateUsage({
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: usage.prompt_cache_miss_tokens ?? 0,
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
      }))
      return
    }

    if (!choice) return

    const delta = choice.delta

    // DeepSeek reasoning_content → thinking delta
    if (delta.reasoning_content) {
      callbacks.onThinkingDelta?.(delta.reasoning_content)
    }

    if (delta.content) {
      callbacks.onTextDelta?.(delta.content)
      // Always accumulate: the final text content block (emitted at stream end)
      // is built from this — it is what the agent loop persists into session
      // history. Without it, text-only replies were displayed but never stored,
      // and the model re-answered the previous turn on the next user message.
      this._textAccum += delta.content
    }

    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        callbacks.onToolCallDelta?.()
        // Resolve the buffer slot for this chunk. Naive `tc.index ?? 0` was the
        // root cause of cross-tool argument pollution (oh-my-pi/384919c7): when a
        // provider (DeepSeek/GLM) streams trailing argument deltas AFTER
        // finish_reason, those continuation chunks frequently omit `index`. `?? 0`
        // routed them onto index 0's buffer — a DIFFERENT tool (e.g. read_section),
        // grafting `{"path":...,"pattern":...}` onto its `{"file_path":...}`. grep
        // then received `{file_path}` or `{}` and failed "pattern is required" in a
        // tight loop, draining the reviewer worker's budget before it could emit
        // JSON. resolveToolCallIndex attaches index-less continuation chunks to the
        // correct slot by id / single-open-buffer, and drops them rather than
        // misgrafting when ambiguous (fail-safe beats fail-loud pollution).
        const idx = this.resolveToolCallIndex(tc)
        if (idx === null) continue
        const buf = this.toolCallBuffer.get(idx) ?? { function: { arguments: '' } }
        if (tc.id) buf.id = tc.id
        if (tc.type) buf.type = tc.type
        if (tc.function?.name) {
          buf.function.name = (buf.function.name ?? '') + tc.function.name
        }
        if (tc.function?.arguments) {
          buf.function.arguments += tc.function.arguments
        }
        this.toolCallBuffer.set(idx, buf)

        // Speculative prewarm: emit hint once when tool name + args are parseable
        if (callbacks.onToolCallHint && buf.function.name && !this.toolCallHintFired.has(idx)) {
          try {
            const partial = JSON.parse(buf.function.arguments)
            this.toolCallHintFired.add(idx)
            callbacks.onToolCallHint(buf.function.name, partial)
          } catch { /* args not yet complete JSON — wait for more chunks */ }
        }
      }
    }

    if (choice.finish_reason) {
      this.flushToolCalls(callbacks)
      // Buffer the stop reason — will be emitted when usage chunk arrives
      this.pendingStopReason = choice.finish_reason
    }

    // If usage arrived together with finish_reason in the same SSE chunk,
    // emit onStopReason immediately with usage data. This handles providers
    // (DeepSeek) that combine finish_reason + usage into one chunk, unlike
    // OpenAI which sends usage as a separate trailing chunk.
    // Must run AFTER flushToolCalls (tool_use content blocks emitted first)
    // and AFTER pendingStopReason is set (so we can read it here).
    if (chunk.usage && this.pendingStopReason !== null) {
      const usage = chunk.usage
      const stopReason = this.pendingStopReason
      this.pendingStopReason = null
      const cacheRead = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
      callbacks.onStopReason?.(mapFinishReason(stopReason), this.calibrateUsage({
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        cache_read_input_tokens: cacheRead,
        cache_creation_input_tokens: usage.prompt_cache_miss_tokens ?? 0,
        reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens,
      }))
    }
  }

  /**
   * Emit buffered tool_use blocks.
   *
   * Called twice per stream: once when `finish_reason` arrives (non-final) and
   * once at end-of-stream (`final: true`). On the non-final flush, entries whose
   * arguments are not yet valid JSON are LEFT in the buffer so trailing argument
   * deltas (GLM-5.2 sends them after finish_reason) can complete them before the
   * final flush. Only emitted entries are removed — the buffer is never cleared
   * wholesale, so a deferred entry survives to the final flush.
   */
  private flushToolCalls(
    callbacks: Partial<Pick<StreamCallbacks, 'onContentBlock' | 'onStopReason'>>,
    opts: { final?: boolean } = {},
  ): void {
    const final = opts.final ?? false
    for (const [idx, buf] of this.toolCallBuffer) {
      if (!buf.id || !buf.function.name) {
        // Header (id/name) not yet seen. Can never complete on the final flush.
        if (final) this.toolCallBuffer.delete(idx)
        continue
      }
      const parsed = tryParseToolArguments(buf.function.arguments)
      if (parsed === null) {
        // Non-empty but unparseable arguments. Defer to a later flush so
        // post-finish_reason argument deltas can complete the JSON.
        if (!final) {
          this.maybeTraceToolStream('defer', idx, buf)
          continue
        }
        // Final flush and still unparseable — surface it loudly instead of
        // silently feeding {} into the tool (the misleading "X is required").
        // argsTruncated marks the block so the tool pipeline refuses to
        // EXECUTE it (running a half-received command is worse than failing:
        // session 4df36bcd executed a truncated bash call as {}). The block
        // is still emitted — the assistant message needs the tool_use so the
        // paired error tool_result keeps the history well-formed.
        this.warnToolArgParseFailure(buf)
        this.logToolStreamEvent({
          phase: 'final-flush-empty', openBuffers: this.toolCallBuffer.size,
          id: buf.id, name: buf.function.name,
          argsLen: buf.function.arguments.length, argsPreview: buf.function.arguments.slice(0, 120),
        })
        callbacks.onContentBlock?.({ type: 'tool_use', id: buf.id, name: buf.function.name, input: {}, argsTruncated: true })
        this.toolCallBuffer.delete(idx)
        continue
      }
      this.maybeTraceToolStream(final ? 'emit-final' : 'emit', idx, buf)
      callbacks.onContentBlock?.({ type: 'tool_use', id: buf.id, name: buf.function.name, input: parsed })
      this.toolCallBuffer.delete(idx)
    }
  }

  /**
   * Append one raw SSE `data:` payload to disk for offline analysis.
   * Gated by RIVET_DEBUG_RAW_SSE: `1` → `<cwd>/.rivet/raw-sse[-<sessionId>].jsonl`,
   * any other value is treated as an explicit target file path.
   */
  private dumpRawSse(payload: string): void {
    const env = process.env.RIVET_DEBUG_RAW_SSE
    if (!env) return
    if (this.rawSsePath === undefined) {
      const target = env === '1'
        ? join(process.cwd(), '.rivet', `raw-sse${this.config.sessionId ? `-${this.config.sessionId}` : ''}.jsonl`)
        : env
      try {
        mkdirSync(dirname(target), { recursive: true })
        this.rawSsePath = target
      } catch {
        this.rawSsePath = null
      }
    }
    if (!this.rawSsePath) return
    try {
      appendFileSync(this.rawSsePath, `${JSON.stringify({ t: Date.now(), model: this.config.model, payload })}\n`)
    } catch { /* best-effort diagnostics */ }
  }

  /** Gated stream-level tool-call diagnostics (RIVET_DEBUG_TOOL_STREAM=1). */
  private maybeTraceToolStream(
    phase: string,
    idx: number,
    buf: { id?: string; function: { name?: string; arguments: string } },
  ): void {
    if (process.env.RIVET_DEBUG_TOOL_STREAM !== '1') return
    debugLog(
      `[tool-stream] phase=${phase} idx=${idx} id=${buf.id ?? '?'} name=${buf.function.name ?? '?'}` +
      ` argsLen=${buf.function.arguments.length} args=${JSON.stringify(buf.function.arguments.slice(0, 200))}`,
    )
  }

  /**
   * Append one notable tool-stream event to the always-on session log. Unlike
   * maybeTraceToolStream (gated, stderr), this writes to disk by default so the
   * cross-tool argument-pollution class of bug leaves a trace without anyone
   * having to enable RIVET_DEBUG up front. Best-effort: any IO failure disables
   * further logging for this client (sets path to null), never throws.
   *
   * Capped at TOOL_STREAM_LOG_MAX_LINES per process — once hit, logging stops to
   * bound disk on long sessions. The cap is generous: these events are rare
   * (only fire on ambiguous continuation chunks / final-flush empties), so
   * hitting the cap itself signals a provider streaming pathology worth flagging.
   */
  private logToolStreamEvent(event: {
    phase: 'drop-ambiguous' | 'reattach-by-id' | 'reattach-sole' | 'final-flush-empty'
    openBuffers?: number
    id?: string
    name?: string
    argsLen?: number
    argsPreview?: string
  }): void {
    if (this.toolStreamLogPath === null) return
    if (this.toolStreamLogLines >= TOOL_STREAM_LOG_MAX_LINES) return
    if (this.toolStreamLogPath === undefined) {
      try {
        const file = join(
          process.cwd(), '.rivet',
          `tool-stream${this.config.sessionId ? `-${this.config.sessionId}` : ''}.jsonl`,
        )
        mkdirSync(dirname(file), { recursive: true })
        this.toolStreamLogPath = file
      } catch {
        this.toolStreamLogPath = null
        return
      }
    }
    try {
      appendFileSync(this.toolStreamLogPath, `${JSON.stringify({
        t: new Date().toISOString(),
        model: this.config.model,
        provider: this.config.providerName ?? null,
        session: this.config.sessionId ?? null,
        ...event,
      })}\n`)
      this.toolStreamLogLines++
    } catch {
      this.toolStreamLogPath = null
    }
  }

  /** Diagnostic log when a tool call's arguments never became valid JSON.
   *
   * Kept debug-only to avoid writing directly to stderr and corrupting the TUI
   * render (the failure is already surfaced to the model/user through the
   * `argsTruncated` tool_use block + tool_result error). Offline diagnosis is
   * still available via the tool-stream JSONL event log and RIVET_DEBUG.
   */
  private warnToolArgParseFailure(
    buf: { id?: string; function: { name?: string; arguments: string } },
  ): void {
    const msg =
      `[tool-arg-parse-failure] id=${buf.id ?? '?'} name=${buf.function.name ?? '?'}` +
      ` argsLen=${buf.function.arguments.length} args=${JSON.stringify(buf.function.arguments.slice(0, 300))}`
    debugLog(msg)
  }

  /**
   * Calibrate API-reported usage for providers with inflated prompt_tokens.
   * When usageCalibrationFactor=0 (GLM coding API), replace input_tokens with
   * a local chars/4 estimate and scale cache fields proportionally.
   */
  private calibrateUsage(usage: {
    input_tokens: number
    output_tokens: number
    cache_read_input_tokens: number
    cache_creation_input_tokens: number
    reasoning_tokens?: number
  }): typeof usage {
    const factor = this.config.usageCalibrationFactor
    if (factor === undefined || factor >= 1) return usage
    if (factor <= 0) {
      // Complete replacement: estimate from request messages
      const estTokens = estimateRequestTokens(this.lastRequestMessages)
      const apiRatio = usage.input_tokens > 0
        ? estTokens / usage.input_tokens
        : 1
      return {
        ...usage,
        input_tokens: estTokens,
        cache_read_input_tokens: Math.round(usage.cache_read_input_tokens * apiRatio),
        cache_creation_input_tokens: Math.round(usage.cache_creation_input_tokens * apiRatio),
      }
    }
    // Partial: scale by factor
    return {
      ...usage,
      input_tokens: Math.round(usage.input_tokens * factor),
      cache_read_input_tokens: Math.round(usage.cache_read_input_tokens * factor),
      cache_creation_input_tokens: Math.round(usage.cache_creation_input_tokens * factor),
    }
  }

  /** 网#1: Parse tool JSON from accumulated text content (DeepSeek bug workaround).
   *  Returns the number of tool_use blocks emitted so the caller knows whether
   *  the text was consumed as tool calls (and must not also persist as text). */
  private tryParseToolJsonFromContent(
    text: string,
    callbacks: Partial<Pick<StreamCallbacks, 'onContentBlock'>>,
  ): number {
    const trimmed = text.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return 0
    try {
      const parsed: unknown = JSON.parse(trimmed)
      const toolCalls = Array.isArray(parsed) ? parsed : [parsed]
      let emitted = 0
      for (const tc of toolCalls) {
        if (typeof tc !== 'object' || tc === null) continue
        const obj = tc as Record<string, unknown>
        if (typeof obj.name !== 'string') continue
        const input = typeof obj.arguments === 'object' && obj.arguments !== null
          ? obj.arguments as Record<string, unknown>
          : typeof obj.arguments === 'string'
            ? (() => { try { return JSON.parse(obj.arguments as string) as Record<string, unknown> } catch { return {} } })()
            : {}
        callbacks.onContentBlock?.({ type: 'tool_use', id: `fallback_${obj.name}_${emitted}`, name: obj.name, input })
        emitted++
      }
      return emitted
    } catch { return 0 /* Not valid JSON */ }
  }
}

/**
 * Quick token estimate from request messages (chars/4 for ASCII, chars/1.5 for CJK).
 * Used for providers (GLM coding API) whose prompt_tokens is inflated.
 */
function estimateRequestTokens(messages: OaiChatRequest['messages']): number {
  let chars = 0
  for (const msg of messages) {
    if (typeof msg.content === 'string') chars += msg.content.length
    else if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          chars += String((part as { text: string }).text).length
        }
      }
    }
    if (msg.role === 'assistant') {
      const m = msg as unknown as Record<string, unknown>
      if (typeof m.reasoning_content === 'string') chars += m.reasoning_content.length
      if (Array.isArray(m.tool_calls)) chars += JSON.stringify(m.tool_calls).length
    }
  }
  // For a coding agent, content is mostly ASCII (code + English text).
  // chars/4 is a good baseline; CJK-heavy sessions will slightly underestimate
  // but this is far better than GLM's 20-100x overcounting.
  return Math.ceil(chars / 4)
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'stop': return 'end_turn'
    case 'tool_calls': return 'tool_use'
    case 'length': return 'max_tokens'
    case 'insufficient_system_resource': return 'end_turn'  // DeepSeek-specific
    default: return 'end_turn'
  }
}

export function parseOpenAIError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body)
    const code = parsed.error?.code ?? parsed.error?.type ?? `HTTP ${status}`
    const message = parsed.error?.message ?? body
    return `OpenAI API error (${code}): ${message}`
  } catch {
    return `OpenAI API error (HTTP ${status}): ${body}`
  }
}
