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

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, content: string, isError?: boolean, rawPath?: string) => void
  onCheckpoint: (hash: string) => void
  onTurnComplete: (usage: unknown, turnNumber: number, isFinal?: boolean) => void
  onError: (error: Error) => void
  onAbort: () => void
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

  // Agent callbacks (wired in Phase 6)
  readonly callbacks: AgentCallbacks

  // External hooks
  private onSubmitCallback?: (text: string) => void
  private onAbortCallback?: () => void

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
      const event = this.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta)
      if (event?.type === 'change') {
        this.renderLive() // update input bar in live region
      }
    })

    // Build AgentCallbacks (these will be passed to AgentLoop in Phase 6)
    this.callbacks = {
      onTextDelta: (text) => this.handleTextDelta(text),
      onThinkingDelta: (thinking) => this.handleThinkingDelta(thinking),
      onToolUse: (id, name, input) => this.handleToolUse(id, name, input),
      onToolResult: (id, name, content, isError, rawPath) => this.handleToolResult(id, name, content, isError, rawPath),
      onCheckpoint: (hash) => this.handleCheckpoint(hash),
      onTurnComplete: (usage, turnNumber, isFinal) => this.handleTurnComplete(turnNumber, isFinal ?? true),
      onError: (error) => this.handleError(error),
      onAbort: () => this.handleAbort(),
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

  // ── Agent Event Handlers ─────────────────────────────────────

  private handleTextDelta(text: string): void {
    this.state.isStreaming = true
    this.state.phase = 'streaming'
    this.state.streamText += text

    // Show last few lines of streaming text in live region
    this.renderLive()
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

  private handleToolResult(id: string, name: string, content: string, isError?: boolean, rawPath?: string): void {
    // Commit tool card to scrollback
    const formatted = formatToolCard({
      toolName: name,
      content,
      isError,
      rawPath,
      elapsedMs: Date.now() - this.state.turnStartMs,
    }, this.theme)

    // Write each line to commit engine (scrollback)
    const lines = formatted.join('\n')
    this.commit.write({ text: lines })
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

  private handleTurnComplete(turnNumber: number, isFinal: boolean): void {
    this.state.turnNumber = turnNumber

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

  /** 将 thinking 文本 commit 到 scrollback */
  private commitThinking(): void {
    const formatted = formatThinking({
      text: this.state.thinkingText,
      elapsedMs: Date.now() - this.state.thinkStartMs,
      isStreaming: false,
      expanded: true,
    }, this.theme)
    this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
    this.state.thinkingText = ''
    this.state.isThinking = false
    this.state.thinkStartMs = 0
  }

  // ── Overlay Registration ─────────────────────────────────────

  /** 注册 overlay 渲染器（初始化时调用一次） */
  registerOverlays(): void {
    // Pager
    this.overlay.register('pager', {
      render: (_w, _h) => renderPager(
        { content: 'Pager placeholder', page: 0 },
        this.columns, this.rows, this.theme,
      ),
    })

    // Starmap
    this.overlay.register('starmap', {
      render: (_w, _h) => renderStarmap(
        { entries: [] },
        this.columns, this.rows, this.theme,
      ),
    })

    // Command palette
    this.overlay.register('command-palette', {
      render: (_w, _h) => renderCommandPalette(
        { commands: [], selectedIndex: 0 },
        this.columns, this.rows, this.theme,
      ),
    })

    // Chronicle
    this.overlay.register('chronicle', {
      render: (_w, _h) => renderChronicle(
        { entries: [] },
        this.columns, this.rows, this.theme,
      ),
    })
  }
}
