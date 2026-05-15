import type { ApiClient, StreamCallbacks } from '../api/client.js'
import type { ContentBlock, Message, Usage } from '../api/types.js'
import { PromptEngine } from '../prompt/engine.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ToolCallParams } from '../tools/types.js'
import { SessionContext } from './context.js'
import { shouldAutoCompact, smartCompact } from '../compact/index.js'
import { microCompact } from '../compact/micro.js'
import type { CompactionConfig } from '../compact/constants.js'
import { recordCompactFailure, recordCompactSuccess } from '../context/compact-policy.js'
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

  constructor(
    private config: AgentConfig,
    private session: SessionContext,
    cwd?: string,
  ) {
    this.cwd = cwd ?? process.cwd()
    this.evidence = new EvidenceTracker()
  }

  abort(): void {
    this.abortController?.abort()
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.config.approvalMode = mode
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
        const decision = shouldAutoCompact(messages, this.config.compact, estTokens)
        if (decision.shouldCompact) {
          const beforeTokens = estTokens
          try {
            const { messages: compacted } = await this.compactMessages(messages, decision.tokenCount)
            this.session.replaceMessages(compacted)
            this.session.markCompacted(turn)
            const afterTokens = this.session.getEstimatedTokens()
            this.session.recordCompactEvent({
              turn: this.session.getTurnCount(),
              tier: this.config.compactClient ? 2 : 1,
              reason: `auto compact: ${decision.reason}`,
              beforeTokens,
              afterTokens,
              createdAt: Date.now(),
            })
            this.compactFailures = recordCompactSuccess(this.compactFailures)
          } catch (err) {
            this.compactFailures = recordCompactFailure(this.compactFailures, this.session.getTurnCount())
            throw err
          }
        }

        const request = this.config.promptEngine.buildRequest(this.session.getMessages())
        const collectedBlocks: ContentBlock[] = []
        let toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
        const streamCallbacks: StreamCallbacks = {
          onTextDelta: (text) => {
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

              const result = await this.config.toolRegistry.execute(tu.name, params)
              callbacks.onToolResult(tu.id, tu.name, result.content, result.isError ?? false, result.rawPath, result.uiContent)

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
          callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
          continue
        }

        const badge = this.evidence.buildBadge()
        if (badge) callbacks.onTextDelta('\n' + badge)
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
