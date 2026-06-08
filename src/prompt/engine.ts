import type { OaiChatRequest, OaiMessage, OaiToolDefinition } from '../api/oai-types.js'
import { semanticPruneLayer1 } from '../compact/semantic-prune.js'
import { detectStaleness } from '../compact/staleness-detect.js'
import { CACHE_ANCHOR_MESSAGES } from '../compact/constants.js'
import { buildSystemPrompt, type StaticPromptContext } from './static.js'
import type { ToolDefinition } from '../api/types.js'
import { buildStableVolatileBlock, buildLatestTurnVolatileBlock, buildDynamicAppendix, buildConsolidatedBlock, type VolatileContext, type ToolHistoryEntry } from './volatile.js'
import { analyzeVolatilePayload, type VolatilePayloadReport } from '../context/payload-diagnostic.js'
import type { TaskState } from '../agent/task-state.js'
import type { ContextClaim } from '../context/claims.js'
import type { PlaybookBullet } from '../agent/playbook.js'
import type { WorktreeReality } from '../agent/worktree-reality.js'
import {
  computeFingerprint,
  detectDrift,
  type PrefixFingerprint,
  type DriftEvent,
} from './fingerprint.js'
import { FieldHabituationTracker } from './field-habituation.js'
import { createContextLayer, createContextLayerReport, type ContextLayerReport } from './context-layer.js'

export type { PrefixFingerprint, DriftEvent, ContextLayerReport }

/** Fast non-crypto hash for content dedup (djb2 on first 2000 chars + length). */
function simpleHash(s: string): string {
  let h = 5381
  const len = Math.min(s.length, 2000)
  for (let i = 0; i < len; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return `${h}:${s.length}`
}

export interface PromptEngineConfig {
  model: string
  maxTokens: number
  staticCtx: StaticPromptContext
  volatileCtx: VolatileContext
  habituationThreshold?: number
}

export class PromptEngine {
  private systemPrompt: string
  private volatileBlock: string
  private frozenBase: string
  private fingerprint: PrefixFingerprint
  private config: PromptEngineConfig
  private tracker: FieldHabituationTracker | null
  private consolidatedBlock: string = ''
  /** Cache key: last user message content — triggers rebuild when it changes. */
  private cachedFreshForUser: string = ''
  /** P1: cached dynamic appendix, appended as standalone message at end of result.
   *  Computed once when a new user message arrives, reused across tool-call turns. */
  private cachedAppendix: string = ''
  /**
   * Frozen merged content for historical user messages (preserves prefix stability).
   * Maps user-message content → array of frozen snapshots. Array handles duplicate
   * messages: first "继续" → index 0, second "继续" → index 1, etc.
   */
  private frozenUserMerged: Map<string, string[]> = new Map()
  /** Per-content fetch index — tracks which entry to retrieve next per content key. */
  private frozenFetchIndex: Map<string, number> = new Map()
  /** Maximum total entries across all content keys before eviction kicks in. */
  private static readonly MAX_FROZEN_USER_MERGED = 64
  private taskProgress?: TaskState
  private behaviorMirror?: string | null
  private strategyShift?: string | null
  private repairHint?: string | null
  private impactHint?: string | null
  private routingReason?: string | null
  private cerebellarHint?: string | null
  private affordanceHint?: string | null
  private policyGuidance?: string | null
  private planCacheAdvisory?: string | null
  private intentRetrievalRoute?: string | null
  private decisions?: string[]
  private activeDomain?: VolatileContext['activeDomain']
  private activeClaims?: VolatileContext['activeClaims']
  private playbookLessons?: VolatileContext['playbookLessons']
  private sessionMemoryOverride?: string
  private contextLayerReportData: ContextLayerReport
  private phaseHint?: string
  private cognitiveProjection?: string
  private crossSessionEvents?: string
  private sessionStateText?: string
  private worktreeReality?: WorktreeReality
  /** Plan Mode state — when 'planning', rendered into volatile block */
  private planModeState?: 'off' | 'planning' | 'approved'
  /** Whether current turn message warrants task-mode scaffolding (task contract, CVM, etc.).
   *  Replaces the old binary chat/task PromptMode — auto-detected from message content. */
  private actionableTurn: boolean = true
  private gitDirty = false
  /** Tracks message array length to detect true duplicate messages vs tool-call turns. */
  private lastMessageCount: number = 0
  /** Hash of last message array to distinguish exact same call from true duplicate. */
  private lastMessageHash: string = ''
  private userMessagesSinceGitRefresh = 0

  constructor(config: PromptEngineConfig) {
    this.config = config
    this.systemPrompt = buildSystemPrompt(config.staticCtx)
    this.frozenBase = buildStableVolatileBlock(config.volatileCtx)
    this.volatileBlock = this.frozenBase
    this.fingerprint = computeFingerprint(this.systemPrompt, config.staticCtx.tools, this.volatileBlock)
    this.tracker = (config.habituationThreshold ?? 5) > 0
      ? new FieldHabituationTracker({ promotionThreshold: 0.8, decayRate: 0.3 })
      : null
    this.contextLayerReportData = createContextLayerReport([
      createContextLayer({ id: 'system', label: 'Stable System Prompt', stability: 'stable', channel: 'system', fingerprint: 'included', content: this.systemPrompt }),
      createContextLayer({ id: 'tools', label: 'Tool Definitions', stability: 'stable', channel: 'tools', fingerprint: 'included', content: JSON.stringify(config.staticCtx.tools) }),
      ...(config.volatileCtx.rivetMd ? [createContextLayer({ id: 'project-instructions', label: 'Project Instructions', stability: 'stable-volatile', channel: 'volatile-user-message', fingerprint: 'included', content: config.volatileCtx.rivetMd })] : []),
      ...(config.volatileCtx.gitStatus ? [createContextLayer({ id: 'git-status', label: 'Git Status', stability: 'stable-volatile', channel: 'volatile-user-message', fingerprint: 'included', content: config.volatileCtx.gitStatus })] : []),
      ...(config.volatileCtx.sessionMemoryBlock ? [createContextLayer({ id: 'session-memory', label: 'Session Memory', stability: 'stable-volatile', channel: 'volatile-user-message', fingerprint: 'included', content: config.volatileCtx.sessionMemoryBlock })] : []),
      ...(config.volatileCtx.playbookLessons && config.volatileCtx.playbookLessons.length > 0 ? [createContextLayer({ id: 'historical-lessons', label: 'Historical Lessons', stability: 'dynamic', channel: 'volatile-user-message', fingerprint: 'excluded', content: config.volatileCtx.playbookLessons.map(b => b.lesson).join('\n') })] : []),
      ...(config.volatileCtx.workingSet && config.volatileCtx.workingSet.length > 0 ? [createContextLayer({ id: 'working-set', label: 'Working Set', stability: 'stable-volatile', channel: 'volatile-user-message', fingerprint: 'partial', content: config.volatileCtx.workingSet.join('\n') })] : []),
    ])
  }

  /**
   * Build a request. Volatile context is injected as an independent user message
   * prepended before each user message with string content.
   *
   * Cache-critical design for agent loop mode (1 user message → 50 tool calls):
   * - The FRESH volatile block is generated ONCE per user message, then cached.
   * - Subsequent tool-call turns reuse the cached FRESH → prefix stays stable.
   * - Only when a NEW user text message arrives does FRESH get regenerated.
   * - Historical user text messages always use FROZEN (this.volatileBlock).
   *
   * This ensures DeepSeek's exact-prefix cache hits on API calls 2-50 within
   * a single user message's execution, not just across user messages.
   */
  /**
   * Retrieve the next frozen snapshot for a given user-message content.
   * Maintains a per-content fetch index so that duplicate messages ("继续", "ok")
   * each get their own frozen snapshot in order.
   */
  private getNextFrozen(content: string): string | undefined {
    const arr = this.frozenUserMerged.get(content)
    if (!arr || arr.length === 0) return undefined
    const idx = this.frozenFetchIndex.get(content) ?? 0
    if (idx >= arr.length) return undefined
    this.frozenFetchIndex.set(content, idx + 1)
    return arr[idx]
  }

  buildOaiRequest(oaiMessages: OaiMessage[], toolHistory?: ToolHistoryEntry[], contextWindow?: number): OaiChatRequest {
    const result: OaiMessage[] = []
    // Reset per-call fetch index — each call re-fetches frozen entries in order.
    this.frozenFetchIndex.clear()

    // Compute GWT budget for dynamic appendix (context-update sub-blocks).
    // Scales with context window; caps at 200K chars to prevent bloat.
    // On 1M+ windows: 5% × 4 chars/token = 200K chars (hits cap).
    // On 200K windows: 5% × 4 chars/token = 40K chars. Minimum 2K.
    const appendixMaxChars = contextWindow && contextWindow > 0
      ? Math.min(Math.max(Math.floor(contextWindow * 0.05 * 4), 2_000), 200_000)
      : undefined

    let firstUserIdx = -1
    let lastUserIdx = -1
    for (let i = 0; i < oaiMessages.length; i++) {
      if (oaiMessages[i]!.role === 'user') {
        if (firstUserIdx === -1) firstUserIdx = i
        lastUserIdx = i
      }
    }

    for (let i = 0; i < oaiMessages.length; i++) {
      const msg = oaiMessages[i]!
      if (msg.role === 'user' && this.volatileBlock) {
        if (i === lastUserIdx) {
          const userContent = msg.content

          // Force rebuild for true duplicate messages — they need their own frozen entry.
          // A true duplicate: same content, same message count, but different message array
          // (the user actually sent "继续" again, not just re-calling with the same messages).
          const msgHash = oaiMessages.length > 0
            ? `${oaiMessages.length}:${typeof oaiMessages[oaiMessages.length - 1]!.content === 'string' ? oaiMessages[oaiMessages.length - 1]!.content as string : ''}`
            : ''
          const isDuplicate = userContent === this.cachedFreshForUser
            && oaiMessages.length === this.lastMessageCount
            && msgHash !== this.lastMessageHash
            && (this.frozenUserMerged.get(typeof userContent === 'string' ? userContent : '')?.length ?? 0) > 0
          this.lastMessageCount = oaiMessages.length
          this.lastMessageHash = msgHash
          if (userContent !== this.cachedFreshForUser || isDuplicate) {
            this.cachedFreshForUser = userContent
            this.userMessagesSinceGitRefresh++
            const refreshGit = this.gitDirty || this.userMessagesSinceGitRefresh >= 3
            if (refreshGit) {
              this.gitDirty = false
              this.userMessagesSinceGitRefresh = 0
            }
            const dynamicCtx: VolatileContext = { ...this.config.volatileCtx, toolHistory, taskProgress: this.taskProgress, behaviorMirror: this.behaviorMirror, strategyShift: this.strategyShift, repairHint: this.repairHint, impactHint: this.impactHint, routingReason: this.routingReason, cerebellarHint: this.cerebellarHint, affordanceHint: this.affordanceHint, policyGuidance: this.policyGuidance, planCacheAdvisory: this.planCacheAdvisory, intentRetrievalRoute: this.intentRetrievalRoute, decisions: this.decisions, activeDomain: this.activeDomain, activeClaims: this.activeClaims, playbookLessons: this.playbookLessons, sessionMemoryBlock: this.sessionMemoryOverride ?? this.config.volatileCtx.sessionMemoryBlock, crossSessionEvents: this.crossSessionEvents, sessionState: this.sessionStateText, worktreeReality: this.worktreeReality, planModeState: this.planModeState, ...(refreshGit ? { gitStatus: undefined } : {}) }

            if (this.tracker) {
              const fieldValues: Record<string, string> = {}
              if (dynamicCtx.activeDomain) fieldValues['activeDomain'] = JSON.stringify(dynamicCtx.activeDomain)
              if (dynamicCtx.playbookLessons && dynamicCtx.playbookLessons.length > 0) {
                fieldValues['playbookLessons'] = dynamicCtx.playbookLessons.map(b => b.lesson).join('|')
              }
              this.tracker.recordTurn(fieldValues, this.phaseHint)

              const habituatedContent = this.tracker.getHabituatedContent()
              const renderedHabituated = new Map<string, string>()
              for (const [name, content] of habituatedContent) {
                if (name === 'activeDomain') {
                  const d = JSON.parse(content) as { name: string; volatileBlock: string; motto: string }
                  renderedHabituated.set(name, `<star-domain name="${d.name}" motto="${d.motto}">${d.volatileBlock}</star-domain>`)
                } else if (name === 'playbookLessons') {
                  renderedHabituated.set(name, `<historical-lessons>\n${content.split('|').map((l: string) => `- ${l}`).join('\n')}\n</historical-lessons>`)
                }
              }

              const newConsolidated = buildConsolidatedBlock(renderedHabituated)
              if (newConsolidated !== this.consolidatedBlock) {
                this.consolidatedBlock = newConsolidated
                // volatileBlock stays at frozenBase — consolidatedBlock goes
                // into dynamic appendix (injected after message history).
                // Mutating volatileBlock here would break exact-prefix cache
                // for all subsequent turns (5-20% hit rate drop per event).
              }

              const activeCtx = { ...dynamicCtx }
              const habituated = this.tracker.getHabituated()
              if (habituated.has('activeDomain')) activeCtx.activeDomain = undefined
              if (habituated.has('playbookLessons')) activeCtx.playbookLessons = undefined

              const activeAppendix = this.actionableTurn ? buildDynamicAppendix(activeCtx, appendixMaxChars) : ''
              const projection = this.actionableTurn ? this.cognitiveProjection : null
              const fullAppendix = [projection, this.consolidatedBlock, activeAppendix].filter(Boolean).join('\n')
              this.cachedAppendix = fullAppendix
            } else {
              if (this.actionableTurn) {
                const appendix = buildDynamicAppendix(dynamicCtx, appendixMaxChars)
                const projection = this.actionableTurn ? this.cognitiveProjection : null
                this.cachedAppendix = projection ? [projection, appendix].filter(Boolean).join('\n') : appendix
              } else {
                this.cachedAppendix = ''
              }
            }
          }
          // Trailer mode: merge volatileBlock (FROZEN) into last user message.
          // Dynamic appendix is appended AFTER user content so the prefix
          // (volatileBlock + userContent) stays stable across turns.
          // Frozen snapshot captures the full content (including appendix),
          // so historical retrieval returns byte-identical content → cache hit.
          let merged = this.volatileBlock + '\n---\n' + (typeof msg.content === 'string' ? msg.content : '')
          if (this.cachedAppendix) {
            merged += '\n\n' + this.cachedAppendix
          }
          const key = typeof msg.content === 'string' ? msg.content : ''
          const arr = this.frozenUserMerged.get(key)
          if (arr) {
            arr.push(merged)
          } else {
            this.frozenUserMerged.set(key, [merged])
          }
          result.push({ role: 'user', content: merged })
        } else if (i === firstUserIdx) {
          // Use frozen merged content if available (preserves prefix from when this was lastUserIdx)
          const frozen = this.getNextFrozen(typeof msg.content === 'string' ? msg.content : '')
          if (frozen) {
            result.push({ role: 'user', content: frozen })
          } else {
            // Fallback: trailer-merge volatileBlock to keep message count stable.
            // A 2-message fallback here would shift all subsequent indices and
            // break exact-prefix cache for the entire suffix.
            const fc = typeof msg.content === 'string' ? msg.content : ''
            result.push({ role: 'user', content: this.volatileBlock + '\n---\n' + fc })
          }
        } else {
          // Historical user message: use frozen merged content if available
          // to preserve prefix stability (avoids content change when msg loses "last" status)
          const frozen = this.getNextFrozen(typeof msg.content === 'string' ? msg.content : '')
          if (frozen) {
            result.push({ role: 'user', content: frozen })
          } else {
            // Fallback: inject volatileBlock so the message still carries context.
            // Loses dynamic appendix vs frozen snapshot, causing one cache miss but
            // doesn't cascade (message count unchanged).
            const fc = typeof msg.content === 'string' ? msg.content : ''
            result.push({ role: 'user', content: this.volatileBlock + '\n---\n' + fc })
          }
        }
      } else {
        result.push(msg)
      }
    }

    const tools: OaiToolDefinition[] | undefined = this.config.staticCtx.tools.length > 0
      ? this.config.staticCtx.tools.map(tool => {
        const func: OaiToolDefinition['function'] = {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema ?? { type: 'object', properties: {} },
        }
        if (tool.providerFormat) {
          func.providerFormat = tool.providerFormat
        }
        return { type: 'function' as const, function: func }
      })
      : undefined

    // On 1M+ windows, skip pruning entirely — same rationale as observation masking:
    // mutating message content breaks DeepSeek exact-prefix cache. trySessionSplit (86%)
    // handles context overflow instead.
    if (!contextWindow || contextWindow < 1_000_000) {
      const { messages: semanticPruned } = semanticPruneLayer1(result, CACHE_ANCHOR_MESSAGES)
      if (semanticPruned !== result) {
        for (let i = 0; i < result.length; i++) result[i] = semanticPruned[i]!
      }

      const { messages: stalenessPruned } = detectStaleness(result, CACHE_ANCHOR_MESSAGES)
      if (stalenessPruned !== result) {
        for (let i = 0; i < result.length; i++) result[i] = stalenessPruned[i]!
      }
    }

    // Observation masking: replace tool result content older than 10 user turns
    // with compact placeholder. On 1M+ context windows, skip masking entirely —
    // the 1M window has enough headroom, and masking mutates message content
    // which breaks exact prefix cache. trySessionSplit (86%) is the primary
    // defense against context overflow on 1M windows.
    const MASK_WINDOW = 10
    if (!contextWindow || contextWindow < 1_000_000) {
      let userCount = 0
      const userTurnIndices: number[] = []
      for (let i = result.length - 1; i >= 0; i--) {
        if (result[i]!.role === 'user') {
          userCount++
          userTurnIndices.push(i)
        }
      }
      if (userCount > MASK_WINDOW) {
        const cutoff = userTurnIndices[MASK_WINDOW - 1]!
        for (let i = 0; i < cutoff; i++) {
          const msg = result[i]!
          if (msg.role === 'tool' && msg.content.length > 200) {
            const preview = msg.content.slice(0, 100)
            result[i] = { ...msg, content: `[observation masked, ${msg.content.length} chars]\n${preview}…` }
          }
        }
      }
    }

    // File content dedup + disk budget: skip on 1M+ windows — mutating historical
    // tool results breaks DeepSeek exact-prefix cache (same rationale as pruning/masking).
    if (!contextWindow || contextWindow < 1_000_000) {
      const seenContent = new Map<string, number>()
      for (let i = result.length - 1; i >= 0; i--) {
        const msg = result[i]!
        if (msg.role === 'tool' && msg.content.length > 500 && !msg.content.startsWith('[observation masked')) {
          const hash = simpleHash(msg.content)
          if (!seenContent.has(hash)) {
            seenContent.set(hash, i)
          } else {
            result[i] = { ...msg, content: `[duplicate content, see later tool result]` }
          }
        }
      }

      const DISK_BUDGET_CHARS = 50_000
      const PREVIEW_CHARS = 2000
      for (let i = 0; i < result.length; i++) {
        const msg = result[i]!
        if (msg.role === 'tool' && msg.content.length > DISK_BUDGET_CHARS) {
          const preview = msg.content.slice(0, PREVIEW_CHARS)
          result[i] = { ...msg, content: `${preview}\n\n[output truncated: ${msg.content.length} chars total, showing first ${PREVIEW_CHARS}]` }
        }
      }
    }

    // Evict oldest frozen entries when total count exceeds limit.
    // Each content key stores an array of snapshots (for duplicate messages).
    // Total count = sum of all array lengths. Evict by removing oldest entries
    // from the longest arrays first.
    let totalFrozen = 0
    for (const arr of this.frozenUserMerged.values()) totalFrozen += arr.length
    while (totalFrozen > PromptEngine.MAX_FROZEN_USER_MERGED && this.frozenUserMerged.size > 0) {
      let maxKey = '', maxLen = 0
      for (const [k, arr] of this.frozenUserMerged) {
        if (arr.length > maxLen) { maxKey = k; maxLen = arr.length }
      }
      if (maxLen <= 1) {
        this.frozenUserMerged.delete(maxKey)
      } else {
        this.frozenUserMerged.get(maxKey)!.shift()
      }
      totalFrozen--
    }

    return {
      model: this.config.model,
      messages: [{ role: 'system', content: this.systemPrompt }, ...result],
      max_tokens: this.config.maxTokens,
      stream: true,
      stream_options: { include_usage: true },
      tools,
      tool_choice: tools ? 'auto' : undefined,
    }
  }

  getModel(): string {
    return this.config.model
  }

  getFingerprint(): PrefixFingerprint {
    return this.fingerprint
  }

  checkDrift(): DriftEvent | null {
    const current = computeFingerprint(this.systemPrompt, this.config.staticCtx.tools, this.volatileBlock)
    return detectDrift(this.fingerprint, current)
  }

  getSystemPrompt(): string {
    return this.systemPrompt
  }

  updateTools(tools: ToolDefinition[]): void {
    this.config.staticCtx.tools = tools
    this.fingerprint = computeFingerprint(this.systemPrompt, tools, this.volatileBlock)
  }

  /** Number of tool definitions (for prefix overhead estimation). */
  getToolCount(): number {
    return this.config.staticCtx.tools.length
  }
  updateSessionMemory(block: string): void {
    this.sessionMemoryOverride = block
    this.rebuildFrozenBase()
    this.invalidateFreshCache()
  }

  private rebuildFrozenBase(): void {
    const ctx = { ...this.config.volatileCtx, sessionMemoryBlock: this.sessionMemoryOverride ?? this.config.volatileCtx.sessionMemoryBlock }
    this.frozenBase = buildStableVolatileBlock(ctx)
    this.volatileBlock = this.frozenBase
    // P1: frozen snapshots store volatileBlock format — clear stale entries
    // when frozen base is rebuilt so historical messages use consistent format.
    this.frozenUserMerged.clear()
  }

  setActionableTurn(actionable: boolean): void {
    if (this.actionableTurn === actionable) return
    this.actionableTurn = actionable
    this.invalidateFreshCache()
  }

  /** @deprecated Use isActionableTurn from task-contract for auto-detection. */
  getMode(): 'task' {
    return 'task'
  }

  updateActiveClaims(claims: ContextClaim[]): void {
    this.activeClaims = claims
  }

  updatePlaybookLessons(lessons: PlaybookBullet[]): void {
    this.playbookLessons = lessons
  }

  setTaskProgress(state: TaskState): void {
    this.taskProgress = state
  }

  setBehaviorMirror(mirror: string | null): void {
    this.behaviorMirror = mirror
  }

  setStrategyShift(hint: string | null): void {
    this.strategyShift = hint
  }

  setRepairHint(hint: string | null): void {
    this.repairHint = hint
  }

  setImpactHint(hint: string | null): void {
    this.impactHint = hint
  }

  setRoutingReason(reason: string | null): void {
    this.routingReason = reason
  }

  getRoutingReason(): string | null {
    return this.routingReason ?? null
  }

  setCerebellarHint(hint: string | null): void {
    this.cerebellarHint = hint ?? undefined
  }

  setAffordanceHint(hint: string | null): void {
    this.affordanceHint = hint ?? undefined
  }

  setPolicyGuidance(guidance: string | null): void {
    this.policyGuidance = guidance ?? undefined
  }

  setPlanCacheAdvisory(advisory: string | null): void {
    this.planCacheAdvisory = advisory ?? undefined
  }

  setIntentRetrievalRoute(route: string | null): void {
    this.intentRetrievalRoute = route ?? undefined
    this.invalidateFreshCache()
  }

  setDecisions(decisions: string[]): void {
    this.decisions = decisions
  }

  setCrossSessionEvents(events: string | null): void {
    this.crossSessionEvents = events ?? undefined
  }

  /**
   * Update session-state snapshot. Does NOT invalidate the fresh cache:
   * within the same user message, all tool-call turns reuse the cached fresh
   * volatile block — sessionState refreshes only at user-message boundaries.
   * This is required to preserve DeepSeek prefix cache across tool turns.
   * See: prompt/volatile.ts VolatileContext.sessionState comment.
   */
  setSessionState(text: string | null): void {
    this.sessionStateText = text ?? undefined
  }

  /**
   * Update worktree reality check result. Does NOT invalidate the fresh cache:
   * rendered ONLY into the dynamic appendix when severity !== 'green'.
   * This is required to preserve DeepSeek prefix cache across tool turns.
   */
  setWorktreeReality(reality: WorktreeReality | null): void {
    this.worktreeReality = reality ?? undefined
  }

  /** Update plan-mode state — rendered into volatile block to instruct agent */
  setPlanModeState(state: 'off' | 'planning' | 'approved' | undefined): void {
    this.planModeState = state
  }

  setPhaseHint(hint: string): void {
    this.phaseHint = hint
  }

  getPhaseHint(): string | undefined {
    return this.phaseHint
  }

  /**
   * Update cognitive projection. Does NOT invalidate the fresh cache:
   * within the same user message, all tool-call turns reuse the cached fresh
   * volatile block — projection refreshes only at user-message boundaries.
   * This preserves DeepSeek prefix cache across tool turns (~10% hit rate gain).
   */
  setCognitiveProjection(projection: string | null): void {
    this.cognitiveProjection = projection && projection.trim().length > 0 ? projection : undefined
  }

  private invalidateFreshCache(): void {
    this.cachedFreshForUser = ''
    this.cachedAppendix = ''
  }

  /**
   * Mark git status as dirty — next user-message boundary will use live gitStatusCache
   * instead of the frozen session-start snapshot. Call after file-modifying tools
   * (Write, Edit, Bash with git commands) to keep multi-session git state fresh.
   */
  markGitDirty(): void {
    this.gitDirty = true
  }

  /**
   * Pre-refresh git status cache when stale. Call in async context before
   * buildOaiRequest() to ensure the model sees fresh git state instead of the
   * up-to-30s-old cached value returned by the synchronous get() path.
   */
  async refreshGitContextIfNeeded(cwd: string): Promise<void> {
    const { gitStatusCache } = await import('./volatile-git.js')
    await gitStatusCache.refreshIfStale(cwd)
  }

  setActiveDomain(domain: VolatileContext['activeDomain']): void {
    this.activeDomain = domain
  }

  getVolatilePayloadReport(toolHistory?: ToolHistoryEntry[]): VolatilePayloadReport {
    const latest = buildLatestTurnVolatileBlock({
      ...this.config.volatileCtx,
      toolHistory,
      taskProgress: this.taskProgress,
      behaviorMirror: this.behaviorMirror,
      strategyShift: this.strategyShift,
      repairHint: this.repairHint,
      impactHint: this.impactHint,
      routingReason: this.routingReason,
      cerebellarHint: this.cerebellarHint,
      affordanceHint: this.affordanceHint,
      policyGuidance: this.policyGuidance,
      planCacheAdvisory: this.planCacheAdvisory,
      intentRetrievalRoute: this.intentRetrievalRoute,
      decisions: this.decisions,
      activeDomain: this.activeDomain ?? this.config.volatileCtx.activeDomain,
      activeClaims: this.activeClaims ?? this.config.volatileCtx.activeClaims,
      playbookLessons: this.playbookLessons ?? this.config.volatileCtx.playbookLessons,
      sessionMemoryBlock: this.sessionMemoryOverride ?? this.config.volatileCtx.sessionMemoryBlock,
      sessionState: this.sessionStateText,
      worktreeReality: this.worktreeReality,
    })
    return analyzeVolatilePayload(latest)
  }

  getContextLayerReport(): ContextLayerReport {
    return this.contextLayerReportData
  }
}
