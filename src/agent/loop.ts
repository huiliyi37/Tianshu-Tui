import type { ApiClient, StreamCallbacks } from '../api/client.js'
import type { ContentBlock, Message, Usage } from '../api/types.js'
import { PromptEngine } from '../prompt/engine.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ToolCallParams } from '../tools/types.js'
import { SessionContext } from './context.js'
import { shouldAutoCompact, smartCompact } from '../compact/index.js'
import { microCompact } from '../compact/micro.js'
import type { CompactionConfig } from '../compact/constants.js'

export interface AgentConfig {
  client: ApiClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  compactClient?: ApiClient
  compactModel?: string
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number) => void
  onError: (error: Error) => void
  onAbort: () => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<boolean>
}

function isToolUse(b: ContentBlock): b is ContentBlock & { type: 'tool_use'; id: string; name: string } {
  return b.type === 'tool_use'
}

export class AgentLoop {
  private abortController: AbortController | null = null
  private cwd: string

  constructor(
    private config: AgentConfig,
    private session: SessionContext,
    cwd?: string,
  ) {
    this.cwd = cwd ?? process.cwd()
  }

  abort(): void {
    this.abortController?.abort()
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

    try {
      for (let turn = 0; turn < this.config.maxTurns; turn++) {
        if (this.abortController.signal.aborted) {
          callbacks.onAbort()
          return
        }

        // Check compaction before building request to prevent context overflow
        const messages = this.session.getMessages()
        const decision = shouldAutoCompact(messages, this.config.compact, this.session.getEstimatedTokens())
        if (decision.shouldCompact) {
          const { messages: compacted } = await this.compactMessages(messages, decision.tokenCount)
          this.session.replaceMessages(compacted)
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

        // Add assistant message with all collected blocks
        if (collectedBlocks.length > 0) {
          this.session.addAssistantBlocks(collectedBlocks)
        }

        // If there are tool_use blocks, execute them and continue the loop
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
              // Check if this tool requires user approval
              if (this.config.toolRegistry.needsApproval(tu.name, params)) {
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

              const result = await this.config.toolRegistry.execute(tu.name, params)
              callbacks.onToolResult(tu.id, tu.name, result.content, result.isError ?? false)
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

          // Inject tool results as user message for next LLM turn
          this.session.addToolResults(toolResults)
          callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
          // Continue loop — next iteration sends messages with tool_results
          continue
        }

        // No tool_use blocks — conversation complete
        callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
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
