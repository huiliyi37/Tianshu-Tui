/**
 * T9 TuiApp — 主事件循环（替代 app.tsx 的 React 组件）。
 *
 * 事件驱动架构：
 *   AgentLoop → (callbacks) → TuiApp → CommitEngine / LiveEngine / OverlayEngine
 *
 * 状态管理：普通 class properties 替代 React useState。
 * 渲染节奏：事件触发 → 更新状态 → 调用 engine 渲染。
 *
 * 阶段 5 定义架构骨架和渲染管线。
 * 阶段 6 会完成与 main.tsx 和 AgentLoop 的实际接线。
 */

import type { WriteStream, ReadStream } from 'node:tty'
import { CommitEngine } from './commit-engine.js'
import { LiveEngine, type LiveRegionLine } from './live-engine.js'
import { OverlayEngine } from './overlay-engine.js'
import { InputHandler, type KeyPress } from './input-handler.js'
import { ResizeHandler } from './resize-handler.js'
import { InputLine } from './input-line.js'
import { WriteBatcher } from './write-batcher.js'
import { BlockStreamWriter } from '../block-stream-writer.js'
import { getTheme, type RivetTheme } from '../theme.js'
import { formatUserMessage } from '../format/user-message.js'
import { formatAssistantMessage } from '../format/assistant-message.js'
import { formatToolCard } from '../format/tool-card.js'
import { formatThinking } from '../format/thinking.js'
import { formatGlanceBar } from '../format/glance-bar.js'
import { formatDiff } from '../format/diff.js'
import { formatMarkdown } from '../format/markdown.js'
import { renderPager, renderStarmap, renderCommandPalette, renderChronicle } from '../format/overlay.js'
import type { PagerData, StarmapData, PaletteData, ChronicleData } from '../format/overlay.js'

// ── State types ────────────────────────────────────────────────

export type ActivityPhase = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'analyzing'

export interface TuiState {
  /** 流式输出缓冲区（未 commit 的文本） */
  streamText: string
  /** thinking 文本缓冲区 */
  thinkingText: string
  /** 是否正在流式输出 */
  isStreaming: boolean
  /** 是否正在 thinking */
  isThinking: boolean
  /** thinking 是否已展开 */
  thinkingExpanded: boolean
  /** 当前活动阶段 */
  phase: ActivityPhase
  /** 本轮耗时起始时间戳 */
  turnStartMs: number
  /** thinking 起始时间戳 */
  thinkStartMs: number
  /** 当前 turn 序号 */
  turnNumber: number
  /** 模型名称 */
  modelName: string
  /** 当前星域 glyph */
  domainGlyph?: string
  /** 当前星域名称 */
  domainName?: string
  /** 已提交的日志行数（用于 GlanceBar） */
  committedCount: number
}

// ── Agent callbacks interface ──────────────────────────────────

// ── Agent callbacks interface (aligned to loop-types.ts AgentCallbacks) ──

import type { Usage } from '../../api/types.js'
import type { IntentPreview, IntentPreviewAction } from '../../agent/intent-preview.js'
import type { ApprovalResult } from '../../agent/approval-edit.js'

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number, isFinal?: boolean) => void
  onError: (error: Error) => void
  onAbort: () => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<ApprovalResult | boolean>
  onCheckpoint?: (hash: string) => void
  onPhaseChange?: (phase: string, detail?: { tool?: string; reason?: string }) => void
  onIntentPreview?: (intent: IntentPreview) => Promise<IntentPreviewAction>
  onSteerDrain?: () => string | null
}

// ── TuiApp ─────────────────────────────────────────────────────

export class TuiApp {
  // Engines
  private commit: CommitEngine
  private live: LiveEngine
  private overlay: OverlayEngine
  private input: InputHandler
  private resize: ResizeHandler
  private inputLine: InputLine

  // State
  private state: TuiState
  private theme: RivetTheme
  private columns: number
  private rows: number
  /** Streaming tool result accumulator: id → accumulated text */
  private toolAccumulator = new Map<string, string>()
  /** Block stream writer: chunks streaming text into display-sized blocks */
  private blockWriter: BlockStreamWriter
  /** Write batcher: coalesces render calls into a single LiveEngine.render() */
  private writeBatcher: WriteBatcher

  // Agent callbacks (aligned to loop-types.ts AgentCallbacks)
  readonly callbacks: AgentCallbacks

  // External hooks
  private onSubmitCallback?: (text: string) => void
  private onAbortCallback?: () => void
  private onExitCallback?: () => void
  /** External slash command handler. If set, handleSlashCommand delegates here. */
  private slashHandler?: (input: string) => boolean | Promise<boolean>

  constructor(options: {
    stdout: WriteStream
    stdin: ReadStream
    /** 初始终端尺寸 */
    cols: number
    rows: number
    /** 模型名称 */
    modelName?: string
    /** 历史记录 */
    history?: string[]
  }) {
    this.theme = getTheme()
    this.columns = options.cols
    this.rows = options.rows

    // Initialize engines
    this.commit = new CommitEngine({ stdout: options.stdout })
    this.live = new LiveEngine({ stdout: options.stdout, reservedRows: 3, maxRows: 20 })
    this.overlay = new OverlayEngine({
      stdout: options.stdout,
      getSize: () => ({ cols: this.columns, rows: this.rows }),
    })
    this.input = new InputHandler({ stdin: options.stdin, mode: 'input' })
    this.resize = new ResizeHandler({ stdout: options.stdout })
    this.inputLine = new InputLine({
      history: options.history,
      onSubmit: (text) => this.onSubmitCallback?.(text),
    })

    // Write batcher: coalesce render calls
    this.writeBatcher = new WriteBatcher(() => this.renderLive())

    // Block stream writer: buffers streaming text into display blocks
    this.blockWriter = new BlockStreamWriter(
      { minChars: 60, maxChars: 200, idleMs: 180 },
      (block: string) => {
        // Append block to stream buffer and schedule render
        this.state.streamText += block
        this.writeBatcher.schedule()
      },
    )

    // Initialize state
    this.state = {
      streamText: '',
      thinkingText: '',
      isStreaming: false,
      isThinking: false,
      thinkingExpanded: false,
      phase: 'idle',
      turnStartMs: Date.now(),
      thinkStartMs: 0,
      turnNumber: 0,
      modelName: options.modelName ?? 'unknown',
      committedCount: 0,
    }

    // Wire resize
    this.resize.onResize((cols, rows) => {
      this.columns = cols
      this.rows = rows
      this.rerender()
    })

    // Wire input: character input → inputLine → live region update
    this.input.onAnyKey((key) => {
      // ── Global shortcuts (before input line processing) ──────
      if (key.name === 'ctrl_c') {
        if (this.state.isStreaming || this.state.isThinking) {
          // Streaming: abort current agent run
          this.handleAbort()
        } else {
          // Idle: exit application via graceful shutdown
          this.dispose()
          if (this.onExitCallback) {
            this.onExitCallback()
          } else {
            process.exit(0)
          }
        }
        return
      }
      if (key.name === 'escape' && !this.inputLine.vimEnabled) {
        if (this.state.isStreaming || this.state.isThinking) {
          this.handleAbort()
        } else {
          // Idle: clear input line
          this.inputLine.setValue('')
          this.renderLive()
        }
        return
      }
      if (key.name === 'ctrl_l') {
        process.stdout.write('\x1B[2J\x1B[H')
        this.renderLive()
        return
      }
      // ── Slash command handling ──────────────────────────────
      const inputVal = this.inputLine.value
      if (inputVal.startsWith('/')) {
        if (key.name === 'return') {
          const handled = this.handleSlashCommand(inputVal)
          this.inputLine.setValue('')
          // If slash was not handled (pass-through like /team, /review),
          // submit to agent via onSubmitCallback
          if (!handled) {
            this.onSubmitCallback?.(inputVal)
          }
          return
        }
      }
      // ── Normal input processing ─────────────────────────────
      const event = this.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta)
      if (event?.type === 'change') {
        this.renderLive()
      }
    })

    // Build AgentCallbacks (aligned to loop-types.ts AgentCallbacks)
    this.callbacks = {
      onTextDelta: (text) => this.handleTextDelta(text),
      onThinkingDelta: (thinking) => this.handleThinkingDelta(thinking),
      onToolUse: (id, name, input) => this.handleToolUse(id, name, input),
      onToolResult: (id, name, result, isError, rawPath, uiContent) =>
        this.handleToolResult(id, name, result, isError, rawPath, uiContent),
      onTurnComplete: (usage, turnNumber, isFinal) => { void this.handleTurnComplete(usage, turnNumber, isFinal ?? true) },
      onError: (error) => this.handleError(error),
      onAbort: () => this.handleAbort(),
      onApprovalRequired: async (_id, _name, _input) => this.handleApprovalRequired(),
      onCheckpoint: (hash) => this.handleCheckpoint(hash),
      onPhaseChange: (phase, _detail) => {
        // Only map recognized phases to ActivityPhase; ignore unknown strings
        const knownPhases: Record<string, ActivityPhase> = {
          idle: 'idle',
          thinking: 'thinking',
          streaming: 'streaming',
          waiting: 'waiting',
          analyzing: 'analyzing',
          working: 'streaming',
          preparing: 'thinking',
          blocked: 'waiting',
        }
        const mapped = knownPhases[phase]
        if (mapped) {
          this.state.phase = mapped
          this.renderLive()
        }
        // Unknown phases (heartbeat, convergence-warning, etc.) are ignored
        // for the status bar display
      },
      onIntentPreview: async (_intent) => 'continue',
      onSteerDrain: () => null, // SteerBuffer integration in Phase B
    }
  }

  // ── Public API ───────────────────────────────────────────────

  /** 设置提交回调（用户按 Enter 后触发） */
  onSubmit(callback: (text: string) => void): void {
    this.onSubmitCallback = callback
  }

  /** 设置中止回调 */
  onAbort(callback: () => void): void {
    this.onAbortCallback = callback
  }

  /** 设置退出回调（/exit、/quit 时触发，由外部执行 graceful shutdown） */
  onExit(callback: () => void): void {
    this.onExitCallback = callback
  }

  /** 设置输入文本（外部更新，如 slash command） */
  setInput(text: string): void {
    this.inputLine.setValue(text, text.length)
    this.renderLive()
  }

  /** 激活 overlay */
  activateOverlay(id: string): boolean {
    switch (id) {
      case 'pager':
        return this.overlay.activate(id)
      case 'starmap':
        return this.overlay.activate(id)
      case 'command-palette':
        return this.overlay.activate(id)
      case 'chronicle':
        return this.overlay.activate(id)
      default:
        return false
    }
  }

  /** 停用 overlay */
  deactivateOverlay(): void {
    this.overlay.deactivate()
    this.renderLive()
  }

  /** 获取终端尺寸 */
  getSize(): { cols: number; rows: number } {
    return { cols: this.columns, rows: this.rows }
  }

  /** 销毁资源 */
  dispose(): void {
    this.input.dispose()
    this.resize.dispose()
  }

  /** 将静态文本提交到 scrollback（slash command 输出等） */
  commitStatic(text: string): void {
    this.commit.write({ text, trailingNewline: true })
  }

  /** 手动设置 streaming 状态 */
  setStreamingState(v: boolean): void {
    this.state.isStreaming = v
    if (!v) {
      this.state.phase = 'idle'
      this.live.clear()
    }
    this.renderLive()
  }

  /** 获取模型信息（供 slash commands 使用） */
  getModelInfo(): { modelName: string; turnNumber: number } {
    return {
      modelName: this.state.modelName,
      turnNumber: this.state.turnNumber,
    }
  }

  /** 设置外部 slash command 处理器（如 SlashRouter） */
  setSlashHandler(handler: (input: string) => boolean | Promise<boolean>): void {
    this.slashHandler = handler
  }

  // ── Agent Event Handlers ─────────────────────────────────────

  private handleTextDelta(text: string): void {
    this.state.isStreaming = true
    this.state.phase = 'streaming'
    // Push through block writer (buffers text, emits in display-sized blocks)
    this.blockWriter.push(text)
  }

  private handleThinkingDelta(thinking: string): void {
    this.state.isThinking = true
    this.state.phase = 'thinking'
    this.state.thinkingText += thinking
    if (this.state.thinkStartMs === 0) {
      this.state.thinkStartMs = Date.now()
    }
    this.renderLive()
  }

  private handleToolUse(_id: string, name: string, _input: Record<string, unknown>): void {
    this.state.phase = 'analyzing'
    // Commit thinking if any
    if (this.state.thinkingText) {
      this.commitThinking()
    }
    this.renderLive()
  }

  private handleToolResult(id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string): void {
    const displayContent = uiContent ?? result

    // Streaming chunk mode: isError === undefined means intermediate update
    if (isError === undefined) {
      // Accumulate for live tool card display — show last lines in live region
      const toolAcc = this.toolAccumulator.get(id) ?? ''
      this.toolAccumulator.set(id, toolAcc + result)
      this.renderLive()
      return
    }

    // Terminal result: commit to scrollback
    const toolAcc = this.toolAccumulator.get(id)
    this.toolAccumulator.delete(id)
    const finalContent = toolAcc ? toolAcc + displayContent : displayContent

    const formatted = formatToolCard({
      toolName: name,
      content: finalContent,
      isError,
      rawPath,
      elapsedMs: Date.now() - this.state.turnStartMs,
    }, this.theme)

    this.commit.write({ text: formatted.join('\n') })
    this.state.committedCount++
    this.renderLive()
  }

  private handleCheckpoint(hash: string): void {
    this.commit.write({
      text: `Checkpoint saved: ${hash.slice(0, 7)} — /rollback to restore`,
      trailingNewline: true,
    })
    this.state.committedCount++
  }

  private async handleTurnComplete(usage: Partial<Usage>, turnNumber: number, isFinal: boolean): Promise<void> {
    this.state.turnNumber = turnNumber

    // Flush any pending blocks from the writer
    await this.blockWriter.flush()

    if (isFinal) {
      // Commit streaming text as assistant message
      if (this.state.streamText) {
        const formatted = formatAssistantMessage({
          content: this.state.streamText,
          width: this.columns,
        }, this.theme)
        this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
        this.state.committedCount++
      }

      // Reset state
      this.state.streamText = ''
      this.state.thinkingText = ''
      this.state.isStreaming = false
      this.state.isThinking = false
      this.state.phase = 'idle'
      this.state.thinkStartMs = 0
      this.live.clear()
    } else {
      // Intermediate turn: archive current text to scrollback, keep writer alive
      if (this.state.streamText) {
        const formatted = formatAssistantMessage({
          content: this.state.streamText,
          width: this.columns,
        }, this.theme)
        this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
      }
      if (this.state.thinkingText) {
        this.commitThinkingToScrollback()
      }
      this.state.streamText = ''
      this.state.thinkingText = ''
      this.state.isThinking = false
      this.state.thinkStartMs = 0
      this.state.phase = 'waiting'
    }
    this.renderLive()
  }

  private handleError(error: Error): void {
    this.commit.write({
      text: `Error: ${error.message}`,
      trailingNewline: true,
    })
    this.state.phase = 'idle'
    this.state.isStreaming = false
    this.renderLive()
  }

  private handleAbort(): void {
    this.state.isStreaming = false
    this.state.isThinking = false
    this.state.phase = 'idle'
    this.live.clear()
    this.onAbortCallback?.()
  }

  // ── Rendering Pipeline ───────────────────────────────────────

  /**
   * 渲染 live region（底部动态区域）。
   *
   * Live region 结构：
   * ┌─ streaming/thinking 内容 ─┐
   * │ GlanceBar                  │
   * │ InputLine                  │
   * └────────────────────────────┘
   */
  private renderLive(): void {
    const lines: LiveRegionLine[] = []

    // 1. Thinking indicator
    if (this.state.isThinking && this.state.thinkingText) {
      const thinkingLines = formatThinking({
        text: this.state.thinkingText,
        elapsedMs: Date.now() - this.state.thinkStartMs,
        isStreaming: this.state.isStreaming,
        expanded: this.state.thinkingExpanded,
      }, this.theme)
      for (const line of thinkingLines) {
        lines.push({ text: line })
      }
    }

    // 2. Streaming text (last N lines from buffer)
    if (this.state.streamText) {
      const allLines = this.state.streamText.split('\n')
      const showLines = allLines.slice(-6) // last 6 lines
      for (const line of showLines) {
        lines.push({ text: line })
      }
    }

    // 3. GlanceBar
    const glanceBar = formatGlanceBar({
      width: this.columns,
      domainGlyph: this.state.domainGlyph,
      domainName: this.state.domainName,
      modelName: this.state.modelName,
      elapsedMs: Date.now() - this.state.turnStartMs,
      turnCount: this.state.turnNumber,
    }, this.theme)
    lines.push({ text: glanceBar })

    // 4. Input line
    const inputText = this.inputLine.value || 'Type your message...'
    const cursorPos = this.inputLine.cursor
    const displayInput = inputText
      ? `▸ ${inputText.slice(0, cursorPos)}█${inputText.slice(cursorPos)}`
      : `▸ ${inputText}`

    if (this.inputLine.vimEnabled && this.inputLine.vimMode === 'normal') {
      lines.push({ text: `-- NORMAL -- ${displayInput}` })
    } else {
      lines.push({ text: displayInput })
    }

    this.live.render(lines)
  }

  /** 强制重绘（resize 后） */
  private rerender(): void {
    if (this.overlay.isActive()) {
      this.overlay.rerender()
    } else {
      this.renderLive()
    }
  }

  /** 将 thinking 文本 commit 到 scrollback（保留内部状态） */
  private commitThinkingToScrollback(): void {
    const formatted = formatThinking({
      text: this.state.thinkingText,
      elapsedMs: Date.now() - this.state.thinkStartMs,
      isStreaming: false,
      expanded: true,
    }, this.theme)
    this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
  }

  /** 将 thinking 文本 commit 到 scrollback 并清空状态 */
  private commitThinking(): void {
    this.commitThinkingToScrollback()
    this.state.thinkingText = ''
    this.state.isThinking = false
    this.state.thinkStartMs = 0
  }

  /** 审批处理器（当前为 auto-approve 模式） */
  private async handleApprovalRequired(): Promise<boolean> {
    // Auto-approve for now. Interactive approval UI in future iteration.
    return true
  }

  /** 处理斜杠命令，返回 true 表示已处理，false 表示应透传 agent */
  private handleSlashCommand(input: string): boolean {
    // Delegate to external handler (SlashRouter) if configured
    if (this.slashHandler) {
      const result = this.slashHandler(input)
      if (result instanceof Promise) {
        result.catch((err) => {
          this.commit.write({ text: `Error: ${(err as Error).message}`, trailingNewline: true })
        })
        // Async handler — assume handled
        return true
      }
      return result
    }

    // Fallback: basic built-in commands
    const trimmed = input.trim()
    switch (trimmed) {
      case '/clear':
        process.stdout.write('\x1B[2J\x1B[H')
        this.live.reset()
        this.renderLive()
        return true
      case '/starmap':
        this.activateOverlay('starmap')
        return true
      case '/chronicle':
        this.activateOverlay('chronicle')
        return true
      case '/exit':
      case '/quit':
        this.dispose()
        // Delegate to graceful shutdown (session persist, agent abort, MCP teardown)
        // instead of process.exit(0) which skips all cleanup.
        if (this.onExitCallback) {
          this.onExitCallback()
        } else {
          process.exit(0)
        }
        return true
      default:
        return false
    }
  }

  // ── Overlay Registration ─────────────────────────────────────

  /**
   * 注册 overlay 渲染器。
   *
   * @param overlayData 可选：每个 overlay 的数据提供函数。
   *                    不传入则使用空占位数据。
   */
  registerOverlays(overlayData?: {
    pagerContent?: () => PagerData
    starmapEntries?: () => StarmapData
    paletteCommands?: () => PaletteData
    chronicleEntries?: () => ChronicleData
  }): void {
    // Pager
    this.overlay.register('pager', {
      render: (_w, _h) => {
        const data = overlayData?.pagerContent?.() ?? { content: '(no content)', page: 0 }
        return renderPager(data, this.columns, this.rows, this.theme)
      },
    })

    // Starmap
    this.overlay.register('starmap', {
      render: (_w, _h) => {
        const data = overlayData?.starmapEntries?.() ?? { entries: [] }
        return renderStarmap(data, this.columns, this.rows, this.theme)
      },
    })

    // Command palette
    this.overlay.register('command-palette', {
      render: (_w, _h) => {
        const data = overlayData?.paletteCommands?.() ?? { commands: [], selectedIndex: 0 }
        return renderCommandPalette(data, this.columns, this.rows, this.theme)
      },
    })

    // Chronicle
    this.overlay.register('chronicle', {
      render: (_w, _h) => {
        const data = overlayData?.chronicleEntries?.() ?? { entries: [] }
        return renderChronicle(data, this.columns, this.rows, this.theme)
      },
    })
  }
}
