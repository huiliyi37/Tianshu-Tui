import type { ContentBlock, Message, MessageRequest } from '../api/types.js'
import { buildSystemPrompt, type StaticPromptContext } from './static.js'
import { buildStableVolatileBlock, buildLatestTurnVolatileBlock, type VolatileContext, type ToolHistoryEntry } from './volatile.js'
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
import { createContextLayer, createContextLayerReport, type ContextLayerReport } from './context-layer.js'

export type { PrefixFingerprint, DriftEvent, ContextLayerReport }

export interface PromptEngineConfig {
  model: string
  maxTokens: number
  staticCtx: StaticPromptContext
  volatileCtx: VolatileContext
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
  private fingerprint: PrefixFingerprint
  private config: PromptEngineConfig
  private taskProgress?: TaskState
  private behaviorMirror?: string | null
  private strategyShift?: string | null
  private repairHint?: string | null
  private impactHint?: string | null
  private routingReason?: string | null
  private cerebellarHint?: string | null
  private decisions?: string[]
  private contextLayerReportData: ContextLayerReport

  constructor(config: PromptEngineConfig) {
    this.config = config
    this.systemPrompt = buildSystemPrompt(config.staticCtx)
    this.volatileBlock = buildStableVolatileBlock(config.volatileCtx)
    this.fingerprint = computeFingerprint(this.systemPrompt, config.staticCtx.tools, this.volatileBlock)
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
   * prepended before each user message with string content. This produces a
   * consistent prefix structure every turn, which is crucial for DeepSeek since
   * it ignores cache_control: ephemeral on system blocks.
   *
   * Only the LAST user text message gets a fresh volatile context block.
   * Historical messages pass through unchanged — this preserves the literal
   * prefix that DeepSeek cached on previous turns.
   *
   * Turn 1: [system, user(<context>), user("hello")]
   * Turn 2: [system, user(<context>), user("hello"), assistant, user(<context>), user("read")]
   *
   * The <context> blocks for turn 1 are identical across both requests because
   * they come from the stored message history, not re-generated.
   *
   * User messages with ContentBlock[] (tool results) pass through unchanged.
   */
  buildRequest(messages: Message[], toolHistory?: ToolHistoryEntry[]): MessageRequest {
    const result: Message[] = []
    const normalized = normalizeToolResultPairs(messages)

    // Find the last user text message index so we can inject fresh tool history there
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
          // Always refresh the latest turn so active claims and session memory updates project even when no tools ran.
          const freshBlock = buildLatestTurnVolatileBlock({ ...this.config.volatileCtx, toolHistory, taskProgress: this.taskProgress, behaviorMirror: this.behaviorMirror, strategyShift: this.strategyShift, repairHint: this.repairHint, impactHint: this.impactHint, routingReason: this.routingReason, cerebellarHint: this.cerebellarHint, decisions: this.decisions })
          result.push({ role: 'user', content: freshBlock })
        } else {
          // Frozen volatile block for historical turns — preserves prefix cache
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
    this.config.volatileCtx.sessionMemoryBlock = block
  }

  updateActiveClaims(claims: ContextClaim[]): void {
    this.config.volatileCtx.activeClaims = claims
  }

  updatePlaybookLessons(lessons: PlaybookBullet[]): void {
    this.config.volatileCtx.playbookLessons = lessons
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

  setActiveDomain(domain: VolatileContext['activeDomain']): void {
    this.config.volatileCtx.activeDomain = domain
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
    })
    return analyzeVolatilePayload(latest)
  }

  getContextLayerReport(): ContextLayerReport {
    return this.contextLayerReportData
  }
}
