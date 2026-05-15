import { readFileSync, existsSync, statSync } from 'fs'
import { join } from 'path'
import type { ApiClient, StreamCallbacks } from '../api/client.js'
import type { ContentBlock, Message, Usage } from '../api/types.js'
import { PromptEngine } from '../prompt/engine.js'
import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ToolCallParams } from '../tools/types.js'
import { SessionContext } from './context.js'
import { extractIntents } from './intent-extractor.js'
import { PrewarmCache } from './prewarm.js'
import { shouldAutoCompact, smartCompact } from '../compact/index.js'
import { microCompact } from '../compact/micro.js'
import type { CompactionConfig } from '../compact/constants.js'
import { decideCompactTier, recordCompactFailure, recordCompactSuccess } from '../context/compact-policy.js'
import { createContextLedger } from '../context/ledger.js'
import type { CompactCircuitBreakerState } from '../context/types.js'
import { EvidenceTracker } from './evidence.js'
import { createCheckpoint, recordAgentTouchedFile } from './checkpoint.js'
import { classifyTestRun } from './failure-classifier.js'

export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual'

export interface AgentConfig {
  client: ApiClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  compactClient?: ApiClient
  compactModel?: string
  approvalMode?: ApprovalMode
  sessionId?: string
  transcriptPath?: string
  getSessionMemoryState?: () => import('../context/types.js').LedgerSessionMemoryState | undefined
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number) => void
  onError: (error: Error) => void
  onAbort: () => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<boolean>
  onCheckpoint?: (hash: string) => void
}

function isToolUse(b: ContentBlock): b is ContentBlock & { type: 'tool_use'; id: string; name: string } {
  return b.type === 'tool_use'
}

export class AgentLoop {
  private abortController: AbortController | null = null
  private cwd: string
  private evidence: EvidenceTracker
  private compactFailures: CompactCircuitBreakerState = { consecutiveFailures: 0 }
  private recentToolHistory: ToolHistoryEntry[] = []
  private prewarm = new PrewarmCache()
  private streamedText = ''
  private lastPrewarmAt = 0

  constructor(
    private config: AgentConfig,
    private session: SessionContext,
    cwd?: string,
  ) {
    this.cwd = cwd ?? process.cwd()
    this.evidence = new EvidenceTracker()
  }

  private recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, result: string): void {
    const target = typeof input?.path === 'string'
      ? input.path
      : typeof input?.file_path === 'string'
        ? input.file_path
        : typeof input?.command === 'string'
          ? input.command.slice(0, 50)
          : name
    this.recentToolHistory.push({
      tool: name,
      target,
      status: isError ? 'failed' : 'success',
      error: isError ? result.slice(0, 50) : undefined,
    })
    if (this.recentToolHistory.length > 5) this.recentToolHistory.shift()
  }

  private maybePrewarm(text: string): void {
    const intents = extractIntents(text)
    for (const intent of intents) {
      if (intent.type === 'file' && !this.prewarm.get(intent.value)) {
        const fullPath = join(this.cwd, intent.value)
        if (existsSync(fullPath)) {
          try {
            const stat = statSync(fullPath)
            if (stat.size > 100_000) continue // skip files > 100KB
            const content = readFileSync(fullPath, 'utf-8')
            this.prewarm.set(intent.value, content)
          } catch { /* ignore unreadable files */ }
        }
      }
    }
  }

  abort(): void {
    this.abortController?.abort()
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.config.approvalMode = mode
  }

  updateSessionMemory(block: string): void {
    this.config.promptEngine.updateSessionMemory(block)
  }

  private isHighRisk(toolName: string, input: Record<string, unknown>): boolean {
    const destructive = /\b(rm\s+-|git\s+reset\s+--hard|git\s+clean\s+-|push\s+--force|killall|pkill|drop\s+table)\b/i
    if (toolName === 'bash') {
      const cmd = typeof input.command === 'string' ? input.command : ''
      return destructive.test(cmd)
    }
    if (toolName === 'rollback') return true
    const targets = [input.file_path, input.path, input.target].filter((v): v is string => typeof v === 'string')
    if (targets.some(t => t.startsWith('/') || t.split('/').includes('..'))) return true
    return false
  }

  getDebugInfo() {
    const fp = this.config.promptEngine.getFingerprint()
    const drift = this.config.promptEngine.checkDrift()
    const sysPrompt = this.config.promptEngine.getSystemPrompt()
    return {
      fingerprint: fp,
      drift,
      systemPromptLength: sysPrompt.length,
      systemPromptPreview: sysPrompt.slice(0, 200) + (sysPrompt.length > 200 ? '...' : ''),
      toolCount: this.config.toolRegistry.getDefinitions().length,
      toolNames: this.config.toolRegistry.getDefinitions().map(t => t.name),
    }
  }

  private async compactMessages(
    messages: Message[],
    tokenCount: number,
  ): Promise<{ messages: Message[] }> {
    if (this.config.compactClient && this.config.compactModel) {
      const result = await smartCompact(
        this.config.compactClient,
        messages,
        tokenCount,
        this.config.contextWindow,
        this.config.compactModel,
      )
      return { messages: result.messages }
    }
    return microCompact(messages, this.config.contextWindow, tokenCount)
  }

  private refreshLedger(): void {
    const ledger = createContextLedger(
      this.config.sessionId ?? 'session',
      this.config.transcriptPath ?? '',
      this.session.getMessages(),
      this.config.contextWindow,
      this.config.getSessionMemoryState?.(),
    )
    this.session.setContextLedger(ledger)
  }

  async run(userInput: string, callbacks: AgentCallbacks): Promise<void> {
    this.abortController = new AbortController()
    this.session.addUserMessage(userInput)
    let checkpointCreatedThisTurn = false

    try {
      for (let turn = 0; turn < this.config.maxTurns; turn++) {
        if (this.abortController.signal.aborted) {
          callbacks.onAbort()
          return
        }

        const messages = this.session.getMessages()
        const estTokens = this.session.getEstimatedTokens()
        const compactDecision = decideCompactTier({
          estimatedTokens: estTokens,
          maxTokens: this.config.contextWindow,
          turn: this.session.getTurnCount(),
          failures: this.compactFailures,
        })
        const legacyDecision = shouldAutoCompact(messages, this.config.compact, estTokens)
        if (compactDecision.shouldCompact && legacyDecision.shouldCompact) {
          const beforeTokens = estTokens
          try {
            const { messages: compacted } = await this.compactMessages(messages, estTokens)
            this.session.replaceMessages(compacted)
            this.session.markCompacted(turn)
            const afterTokens = this.session.getEstimatedTokens()
            this.session.recordCompactEvent({
              turn: this.session.getTurnCount(),
              tier: this.config.compactClient ? 2 : 1,
              reason: `auto compact: ${compactDecision.reason}`,
              beforeTokens,
              afterTokens,
              createdAt: Date.now(),
            })
            this.compactFailures = recordCompactSuccess(this.compactFailures)
            this.refreshLedger()
          } catch (err) {
            this.compactFailures = recordCompactFailure(this.compactFailures, this.session.getTurnCount())
            throw err
          }
        }

        this.streamedText = ''
        this.lastPrewarmAt = 0
        const request = this.config.promptEngine.buildRequest(this.session.getMessages(), this.recentToolHistory)
        const collectedBlocks: ContentBlock[] = []
        let toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
        const streamCallbacks: StreamCallbacks = {
          onTextDelta: (text) => {
            this.streamedText += text
            if (this.streamedText.length - this.lastPrewarmAt >= 500) {
              this.lastPrewarmAt = this.streamedText.length
              this.maybePrewarm(this.streamedText)
            }
            callbacks.onTextDelta(text)
          },
          onThinkingDelta: (thinking) => {
            callbacks.onThinkingDelta(thinking)
          },
          onContentBlock: (block) => {
            collectedBlocks.push(block)
            if (isToolUse(block)) {
              toolUses.push({ id: block.id, name: block.name, input: block.input })
              callbacks.onToolUse(block.id, block.name, block.input)
            }
          },
          onStopReason: (_reason, usage) => {
            this.session.addUsage(usage)
          },
          onError: (error) => {
            callbacks.onError(error)
          },
        }

        await this.config.client.stream(request, streamCallbacks, this.abortController.signal)

        if (this.abortController.signal.aborted) {
          callbacks.onAbort()
          return
        }

        if (collectedBlocks.length > 0) {
          this.session.addAssistantBlocks(collectedBlocks)
        }

        if (toolUses.length > 0) {
          const toolResults: ContentBlock[] = []

          for (const tu of toolUses) {
            const params: ToolCallParams = {
              input: tu.input,
              toolUseId: tu.id,
              cwd: this.cwd,
              onOutput: (chunk) => {
                callbacks.onToolResult(tu.id, tu.name, chunk)
              },
            }
            try {
              const needsApproval = this.config.toolRegistry.needsApproval(tu.name, params)
              const isHighRisk = needsApproval && this.isHighRisk(tu.name, tu.input)
              const approvalMode = this.config.approvalMode ?? 'manual'

              const shouldAsk = approvalMode === 'manual'
                ? needsApproval
                : approvalMode === 'auto-safe'
                  ? isHighRisk
                  : false // auto-accept: never ask

              if (shouldAsk) {
                const approved = await callbacks.onApprovalRequired(tu.id, tu.name, tu.input)
                if (!approved) {
                  const denyMsg = 'Tool execution denied: requires user approval'
                  callbacks.onToolResult(tu.id, tu.name, denyMsg, true)
                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: denyMsg,
                    is_error: true,
                  })
                  continue
                }
              }

              if ((tu.name === 'write_file' || tu.name === 'edit_file') && !checkpointCreatedThisTurn) {
                const cp = await createCheckpoint(this.cwd, 'auto')
                checkpointCreatedThisTurn = true
                if (cp) callbacks.onCheckpoint?.(cp.hash)
              }

              if ((tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string') {
                recordAgentTouchedFile(this.cwd, tu.input.file_path)
              }

              // Prewarm cache fast-path for read_file
              let result: import('../tools/types.js').ToolResult
              if (tu.name === 'read_file' && typeof tu.input.file_path === 'string') {
                const cached = this.prewarm.get(tu.input.file_path)
                if (cached) {
                  result = { content: cached }
                } else {
                  result = await this.config.toolRegistry.execute(tu.name, params)
                }
              } else {
                result = await this.config.toolRegistry.execute(tu.name, params)
              }
              callbacks.onToolResult(tu.id, tu.name, result.content, result.isError ?? false, result.rawPath, result.uiContent)

              // Record tool history for volatile context injection
              this.recordToolHistory(tu.name, tu.input, result.isError ?? false, result.content)

              // Invalidate prewarm cache after writes
              if ((tu.name === 'write_file' || tu.name === 'edit_file') && !result.isError && typeof tu.input.file_path === 'string') {
                this.prewarm.invalidate(tu.input.file_path)
              }

              if (tu.name === 'read_file' && !result.isError) {
                this.evidence.trackFileRead(tu.input.file_path as string)
              } else if ((tu.name === 'write_file' || tu.name === 'edit_file') && !result.isError) {
                this.evidence.trackFileModified(tu.input.file_path as string)
              } else if (tu.name === 'run_tests') {
                if (result.verification) {
                  this.evidence.trackVerification(result.verification)
                }
                if (result.verification && result.verification.status !== 'passed') {
                  const failures = classifyTestRun(result.content)
                  if (failures.length > 0 && failures[0]!.confidence >= 0.7) {
                    result.content += `\n\nDiagnosis: ${failures[0]!.suggestion}`
                  }
                }
              }

              toolResults.push({
                type: 'tool_result',
                tool_use_id: tu.id,
                content: result.content,
                is_error: result.isError,
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              callbacks.onToolResult(tu.id, tu.name, msg, true)
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tu.id,
                content: msg,
                is_error: true,
              })
            }
          }

          this.session.addToolResults(toolResults)
          this.refreshLedger()
          callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
          continue
        }

        const badge = this.evidence.buildBadge()
        if (badge) callbacks.onTextDelta('\n' + badge)
        this.refreshLedger()
        callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
        this.evidence.reset()
        break
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        callbacks.onAbort()
      } else {
        callbacks.onError(err as Error)
      }
    }
  }
}
