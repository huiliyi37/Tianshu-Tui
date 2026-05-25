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
import { DEFAULT_MODE, shouldInjectCvm, shouldInjectDynamicAppendix, type PromptMode } from './mode.js'

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
  /** Cached FRESH volatile block — only regenerated when a NEW user message arrives */
  private cachedFreshBlock: string = ''
  private cachedFreshForUser: string = ''
  /** Frozen merged content for historical user messages (preserves prefix stability) */
  private frozenUserMerged: Map<string, string> = new Map()
  private taskProgress?: TaskState
  private behaviorMirror?: string | null
  private strategyShift?: string | null
  private repairHint?: string | null
  private impactHint?: string | null
  private routingReason?: string | null
  private cerebellarHint?: string | null
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
  private heuristicRulesText?: string
  private worktreeReality?: WorktreeReality
  private mode: PromptMode = DEFAULT_MODE

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
  buildOaiRequest(oaiMessages: OaiMessage[], toolHistory?: ToolHistoryEntry[], contextWindow?: number): OaiChatRequest {
    const result: OaiMessage[] = []

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

          if (userContent !== this.cachedFreshForUser) {
            this.cachedFreshForUser = userContent
            const dynamicCtx: VolatileContext = { ...this.config.volatileCtx, toolHistory, taskProgress: this.taskProgress, behaviorMirror: this.behaviorMirror, strategyShift: this.strategyShift, repairHint: this.repairHint, impactHint: this.impactHint, routingReason: this.routingReason, cerebellarHint: this.cerebellarHint, decisions: this.decisions, activeDomain: this.activeDomain, activeClaims: this.activeClaims, playbookLessons: this.playbookLessons, sessionMemoryBlock: this.sessionMemoryOverride ?? this.config.volatileCtx.sessionMemoryBlock, crossSessionEvents: this.crossSessionEvents, heuristicRules: this.heuristicRulesText, sessionState: this.sessionStateText, worktreeReality: this.worktreeReality }

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

              const activeAppendix = shouldInjectDynamicAppendix(this.mode) ? buildDynamicAppendix(activeCtx) : ''
              const projection = shouldInjectCvm(this.mode) ? this.cognitiveProjection : null
              const fullAppendix = [projection, this.consolidatedBlock, activeAppendix].filter(Boolean).join('\n')
              this.cachedFreshBlock = fullAppendix
                ? this.volatileBlock + '\n' + fullAppendix
                : this.volatileBlock
            } else {
              const base = shouldInjectDynamicAppendix(this.mode)
                ? buildLatestTurnVolatileBlock(dynamicCtx)
                : this.frozenBase
              const projection = shouldInjectCvm(this.mode) ? this.cognitiveProjection : null
              this.cachedFreshBlock = projection ? base + '\n' + projection : base
            }
          }
          // Trailer mode: merge cachedFreshBlock into last user message content
          // instead of pushing as separate message. Keeps message array append-only,
          // preserving DeepSeek exact-prefix cache across user-message boundaries.
          const merged = this.cachedFreshBlock + '\n---\n' + (typeof msg.content === 'string' ? msg.content : '')
          const key = typeof msg.content === 'string' ? msg.content : ''
          this.frozenUserMerged.set(key, merged)
          result.push({ role: 'user', content: merged })
        } else if (i === firstUserIdx) {
          result.push({ role: 'user', content: this.volatileBlock })
          result.push(msg)
        } else {
          // Historical user message: use frozen merged content if available
          // to preserve prefix stability (avoids content change when msg loses "last" status)
          const key = typeof msg.content === 'string' ? msg.content : ''
          const frozen = this.frozenUserMerged.get(key)
          if (frozen) {
            result.push({ role: 'user', content: frozen })
          } else {
            result.push(msg)
          }
        }
      } else {
        result.push(msg)
      }
    }

    const tools: OaiToolDefinition[] | undefined = this.config.staticCtx.tools.length > 0
      ? this.config.staticCtx.tools.map(tool => ({
        type: 'function' as const,
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.input_schema ?? { type: 'object', properties: {} },
        },
      }))
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

    // File content dedup: if same large tool result appears multiple times, keep only the latest
    const seenContent = new Map<string, number>() // content hash → latest index
    for (let i = result.length - 1; i >= 0; i--) {
      const msg = result[i]!
      if (msg.role === 'tool' && msg.content.length > 500 && !msg.content.startsWith('[observation masked')) {
        const hash = simpleHash(msg.content)
        if (!seenContent.has(hash)) {
          seenContent.set(hash, i)
        } else {
          // This is an older duplicate — replace with placeholder
          result[i] = { ...msg, content: `[duplicate content, see later tool result]` }
        }
      }
    }

    // Disk budget: truncate any remaining tool result >50K chars to a 2KB preview
    const DISK_BUDGET_CHARS = 50_000
    const PREVIEW_CHARS = 2000
    for (let i = 0; i < result.length; i++) {
      const msg = result[i]!
      if (msg.role === 'tool' && msg.content.length > DISK_BUDGET_CHARS) {
        const preview = msg.content.slice(0, PREVIEW_CHARS)
        result[i] = { ...msg, content: `${preview}\n\n[output truncated: ${msg.content.length} chars total, showing first ${PREVIEW_CHARS}]` }
      }
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

  updateSessionMemory(block: string): void {
    this.sessionMemoryOverride = block
    this.rebuildFrozenBase()
    this.invalidateFreshCache()
  }

  private rebuildFrozenBase(): void {
    const ctx = { ...this.config.volatileCtx, sessionMemoryBlock: this.sessionMemoryOverride ?? this.config.volatileCtx.sessionMemoryBlock }
    this.frozenBase = buildStableVolatileBlock(ctx)
    this.volatileBlock = this.frozenBase
  }

  setMode(mode: PromptMode): void {
    if (this.mode === mode) return
    this.mode = mode
    this.invalidateFreshCache()
  }

  getMode(): PromptMode {
    return this.mode
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

  setCerebellarHint(hint: string | null): void {
    this.cerebellarHint = hint ?? undefined
  }

  setDecisions(decisions: string[]): void {
    this.decisions = decisions
  }

  setCrossSessionEvents(events: string | null): void {
    this.crossSessionEvents = events ?? undefined
  }

  /** Inject cross-session heuristic rules into dynamic appendix. Cache-safe. */
  setHeuristicRules(rules: string | null): void {
    this.heuristicRulesText = rules ?? undefined
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

  setPhaseHint(hint: string): void {
    this.phaseHint = hint
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
    this.cachedFreshBlock = ''
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
