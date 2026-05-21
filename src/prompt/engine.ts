import type { ContentBlock, Message, MessageRequest } from '../api/types.js'
import { buildSystemPrompt, type StaticPromptContext } from './static.js'
import { buildStableVolatileBlock, buildLatestTurnVolatileBlock, buildDynamicAppendix, buildConsolidatedBlock, type VolatileContext, type ToolHistoryEntry } from './volatile.js'
import { analyzeVolatilePayload, type VolatilePayloadReport } from '../context/payload-diagnostic.js'
import type { TaskState } from '../agent/task-state.js'
import type { ContextClaim } from '../context/claims.js'
import type { PlaybookBullet } from '../agent/playbook.js'
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

export interface PromptEngineConfig {
  model: string
  maxTokens: number
  staticCtx: StaticPromptContext
  volatileCtx: VolatileContext
  habituationThreshold?: number
}

function isToolUseBlock(block: ContentBlock): block is ContentBlock & { type: 'tool_use'; id: string } {
  return block.type === 'tool_use'
}

function isToolResultBlock(block: ContentBlock): block is ContentBlock & { type: 'tool_result'; tool_use_id: string } {
  return block.type === 'tool_result'
}

function toolUseIds(message: Message): string[] {
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return []
  return message.content.filter(isToolUseBlock).map(block => block.id)
}

function toolResultIds(message: Message | undefined): string[] {
  if (!message || message.role !== 'user' || !Array.isArray(message.content)) return []
  return message.content.filter(isToolResultBlock).map(block => block.tool_use_id)
}

function makeSyntheticToolResult(id: string): ContentBlock {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: 'Tool result unavailable: recovered from interrupted tool execution.',
    is_error: true,
  }
}

function normalizeToolResultPairs(messages: Message[]): Message[] {
  const normalized: Message[] = []

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role === 'user' && Array.isArray(msg.content) && msg.content.some(isToolResultBlock)) {
      const previous = normalized[normalized.length - 1]
      if (!previous || toolUseIds(previous).length === 0) continue
    }

    normalized.push(msg)

    const ids = toolUseIds(msg)
    if (ids.length === 0) continue

    const next = messages[i + 1]
    const results = toolResultIds(next)
    const missing = ids.filter(id => !results.includes(id))
    if (missing.length > 0) {
      normalized.push({ role: 'user', content: missing.map(makeSyntheticToolResult) })
    }
  }

  return normalized
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
  buildRequest(messages: Message[], toolHistory?: ToolHistoryEntry[]): MessageRequest {
    const result: Message[] = []
    const normalized = normalizeToolResultPairs(messages)

    let lastUserTextIdx = -1
    for (let i = normalized.length - 1; i >= 0; i--) {
      if (normalized[i]!.role === 'user' && typeof normalized[i]!.content === 'string') {
        lastUserTextIdx = i
        break
      }
    }

    for (let i = 0; i < normalized.length; i++) {
      const msg = normalized[i]!
      if (msg.role === 'user' && typeof msg.content === 'string' && this.volatileBlock) {
        if (i === lastUserTextIdx) {
          const userContent = msg.content

          // Only regenerate FRESH when a NEW user message arrives.
          // Tool-call turns (same user message, more tool results) reuse the cache.
          if (userContent !== this.cachedFreshForUser) {
            this.cachedFreshForUser = userContent
            const dynamicCtx: VolatileContext = { ...this.config.volatileCtx, toolHistory, taskProgress: this.taskProgress, behaviorMirror: this.behaviorMirror, strategyShift: this.strategyShift, repairHint: this.repairHint, impactHint: this.impactHint, routingReason: this.routingReason, cerebellarHint: this.cerebellarHint, decisions: this.decisions, activeDomain: this.activeDomain ?? this.config.volatileCtx.activeDomain, activeClaims: this.activeClaims ?? this.config.volatileCtx.activeClaims, playbookLessons: this.playbookLessons ?? this.config.volatileCtx.playbookLessons, sessionMemoryBlock: this.sessionMemoryOverride ?? this.config.volatileCtx.sessionMemoryBlock, crossSessionEvents: this.crossSessionEvents }

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
                this.volatileBlock = newConsolidated
                  ? this.frozenBase + '\n' + newConsolidated
                  : this.frozenBase
              }

              const activeCtx = { ...dynamicCtx }
              const habituated = this.tracker.getHabituated()
              if (habituated.has('activeDomain')) activeCtx.activeDomain = undefined
              if (habituated.has('playbookLessons')) activeCtx.playbookLessons = undefined

              const activeAppendix = shouldInjectDynamicAppendix(this.mode) ? buildDynamicAppendix(activeCtx) : ''
              const projection = shouldInjectCvm(this.mode) ? this.cognitiveProjection : null
              const fullAppendix = [projection, activeAppendix].filter(Boolean).join('\n')
              this.cachedFreshBlock = fullAppendix
                ? this.volatileBlock + '\n' + fullAppendix
                : this.volatileBlock
            } else {
              const latest = buildLatestTurnVolatileBlock(dynamicCtx)
              const projection = shouldInjectCvm(this.mode) ? this.cognitiveProjection : null
              this.cachedFreshBlock = projection
                ? latest + '\n' + projection
                : latest
            }
          }
          result.push({ role: 'user', content: this.cachedFreshBlock })
        } else {
          result.push({ role: 'user', content: this.volatileBlock })
        }
      }
      result.push(msg)
    }

    return {
      model: this.config.model,
      messages: result,
      max_tokens: this.config.maxTokens,
      system: this.systemPrompt,  // plain string, DeepSeek-compatible
      tools: this.config.staticCtx.tools.length > 0
        ? [...this.config.staticCtx.tools].sort((a, b) => a.name.localeCompare(b.name))
        : undefined,
      tool_choice: this.config.staticCtx.tools.length > 0 ? { type: 'auto' } : undefined,
      stream: true,
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

  updateSessionMemory(block: string): void {
    this.sessionMemoryOverride = block
    this.rebuildFrozenBase()
    this.invalidateFreshCache()
  }

  private rebuildFrozenBase(): void {
    const ctx = { ...this.config.volatileCtx, sessionMemoryBlock: this.sessionMemoryOverride ?? this.config.volatileCtx.sessionMemoryBlock }
    this.frozenBase = buildStableVolatileBlock(ctx)
    this.volatileBlock = this.consolidatedBlock
      ? this.frozenBase + '\n' + this.consolidatedBlock
      : this.frozenBase
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

  setPhaseHint(hint: string): void {
    this.phaseHint = hint
  }

  setCognitiveProjection(projection: string | null): void {
    const next = projection && projection.trim().length > 0 ? projection : undefined
    if (this.cognitiveProjection === next) return
    this.cognitiveProjection = next
    this.invalidateFreshCache()
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
    })
    return analyzeVolatilePayload(latest)
  }

  getContextLayerReport(): ContextLayerReport {
    return this.contextLayerReportData
  }
}
