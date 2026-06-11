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
import { StreamRenderer } from './stream-renderer.js'
import { color } from './ansi.js'
import { BlockStreamWriter } from '../block-stream-writer.js'
import { SteerBuffer } from '../steer-buffer.js'
import { getTheme, type RivetTheme } from '../theme.js'
import { formatUserMessage } from '../format/user-message.js'
import { formatToolCard, formatToolCardLive, isToolCardTruncated } from '../format/tool-card.js'
import { formatThinking } from '../format/thinking.js'
import { formatGlanceBar } from '../format/glance-bar.js'
import { formatSpinnerStatus, formatTurnWorkSummary, phaseIndicator } from '../format/spinner-status.js'
import { formatSlashHint, slashCompletionTarget, type SlashHintEntry } from '../format/slash-hint.js'
import { extractAtToken, getCompletions, applyCompletion } from '../file-completer.js'
import { appendHistory, nextHistoryAfterSubmit } from '../history.js'
import { renderPager, renderStarmap, renderCommandPalette, renderChronicle } from '../format/overlay.js'
import type { PagerData, StarmapData, PaletteData, ChronicleData } from '../format/overlay.js'

function formatElapsedShort(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}

// ── State types ────────────────────────────────────────────────

export type ActivityPhase = 'idle' | 'thinking' | 'streaming' | 'waiting' | 'analyzing'

export interface TuiState {
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
  /** 进行中工具元数据：id → 名称/输入/开始时间（live 工具行 + 卡片标题用） */
  private pendingTools = new Map<string, { name: string; input: Record<string, unknown>; startMs: number }>()
  /** 最近一条被截断的工具结果（ctrl+o 展开用） */
  private lastTruncatedTool: { toolName: string; content: string; isError: boolean; rawPath?: string; toolInput?: Record<string, unknown> } | null = null

  // ── W3: 渲染 ticker + 指标 ───────────────────────────────────
  /** 渲染 ticker（streaming/thinking 时 120ms 驱动 spinner，idle 停止） */
  private ticker: ReturnType<typeof setInterval> | null = null
  /** 单调递增的渲染 tick（spinner 帧） */
  private tick = 0
  /** 最近收到 token/输出的时间戳（stall 检测） */
  private lastActivityMs = 0
  /** 模型上下文窗口（tokens），用于 context% */
  private contextWindow?: number
  /** git 分支（启动时读取一次） */
  private gitBranch?: string
  /** 累计 usage（cost 估算） */
  private totalUsage = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 }
  /** 最近一轮的 cache 命中率（0-1） */
  private lastCacheHitRate?: number
  /** 最近一轮的上下文占比（0-1） */
  private lastContextRatio?: number
  /** Block stream writer: chunks streaming text into display-sized blocks */
  private blockWriter: BlockStreamWriter
  /** Write batcher: coalesces render calls into a single LiveEngine.render() */
  private writeBatcher: WriteBatcher
  /** Stream renderer: incremental markdown commit + live tail (W1) */
  private streamRenderer: StreamRenderer
  /** 本段流式输出是否已 commit 过 `▍ Rivet` header */
  private assistantHeaderDone = false

  // Agent callbacks (aligned to loop-types.ts AgentCallbacks)
  readonly callbacks: AgentCallbacks

  // External hooks
  private onSubmitCallback?: (text: string) => void
  private onAbortCallback?: () => void
  private onExitCallback?: () => void
  /** External slash command handler. If set, handleSlashCommand delegates here. */
  private slashHandler?: (input: string) => boolean | Promise<boolean>
  /** 消息队列（W4a：streaming 时 Enter 入队，turn 边界 drain 注入） */
  readonly steerBuffer = new SteerBuffer()
  /** agent 是否正在执行（submit → final turn complete 之间） */
  private agentBusy = false

  // ── W4b: 输入辅助 ────────────────────────────────────────────
  /** slash 命令列表（外部注入，提示 + Tab 补全用） */
  private slashCommands: SlashHintEntry[] = []
  /** @ 文件补全状态（Tab 循环） */
  private fileCompletion: { baseText: string; baseCursor: number; candidates: string[]; idx: number } | null = null
  /** 输入历史（最新在前，submit 时更新 + 持久化） */
  private inputHistory: string[] = []
  /** Ctrl+C double-press window start timestamp (ms), 0 = inactive */
  private ctrlCPendingSince = 0

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
    /** 模型上下文窗口（tokens） */
    contextWindow?: number
    /** git 分支名 */
    gitBranch?: string
  }) {
    this.theme = getTheme()
    this.columns = options.cols
    this.rows = options.rows
    this.contextWindow = options.contextWindow
    this.gitBranch = options.gitBranch

    // Initialize engines
    this.commit = new CommitEngine({ stdout: options.stdout })
    this.live = new LiveEngine({ stdout: options.stdout, reservedRows: 3, maxRows: 20 })
    this.overlay = new OverlayEngine({
      stdout: options.stdout,
      getSize: () => ({ cols: this.columns, rows: this.rows }),
    })
    this.input = new InputHandler({ stdin: options.stdin, mode: 'input' })
    this.resize = new ResizeHandler({ stdout: options.stdout })
    this.inputHistory = options.history ?? []
    this.inputLine = new InputLine({
      history: options.history,
      placeholder: 'Type a message… (/ commands · @ files · \\⏎ newline)',
      onTabComplete: () => this.handleTabComplete(),
      onSubmit: (text) => {
        const trimmed = text.trim()

        // 输入历史：会话内更新 + 持久化（queued 与直接 submit 都记录）
        if (trimmed) {
          this.inputHistory = nextHistoryAfterSubmit(this.inputHistory, trimmed)
          this.inputLine.setHistory(this.inputHistory)
          try { appendHistory(trimmed) } catch { /* 持久化失败不阻塞输入 */ }
        }

        // W4a: agent 执行中 → 入队（turn 边界 drain 注入），不直接 submit
        if (this.agentBusy && trimmed) {
          this.steerBuffer.push(trimmed)
          this.renderLive()
          return
        }

        // Commit user message to scrollback
        if (trimmed) {
          this.commitAbove(() => {
            const formatted = formatUserMessage({
              content: trimmed,
              width: this.columns,
            }, this.theme)
            for (const line of formatted) {
              this.commit.writeRaw(line + '\n')
            }
            this.state.committedCount++
          })
          this.agentBusy = true
        }
        // Reset turn timer for the new turn
        this.state.turnStartMs = Date.now()
        this.lastActivityMs = Date.now()
        this.onSubmitCallback?.(text)
      },
    })

    // Write batcher: coalesce render calls
    this.writeBatcher = new WriteBatcher(() => this.renderLive())

    // Stream renderer: stable markdown prefix → scrollback, tail → live region
    this.streamRenderer = new StreamRenderer({
      commit: (ansi) => {
        this.commitAbove(() => {
          if (!this.assistantHeaderDone) {
            this.commitAssistantHeader()
          }
          this.commit.write({ text: ansi, trailingNewline: true })
          this.state.committedCount++
        })
      },
      getColumns: () => this.columns,
      theme: this.theme,
    })

    // Block stream writer: buffers streaming text into display blocks
    this.blockWriter = new BlockStreamWriter(
      { minChars: 60, maxChars: 200, idleMs: 180 },
      (block: string) => {
        // Feed stream renderer (commits stable markdown blocks) and schedule render
        this.streamRenderer.push(block)
        this.writeBatcher.schedule()
      },
    )

    // Initialize state
    this.state = {
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
        } else if (this.ctrlCPendingSince > 0) {
          // Second Ctrl+C within window → exit
          this.ctrlCPendingSince = 0
          this.dispose()
          if (this.onExitCallback) {
            this.onExitCallback()
          } else {
            process.exit(0)
          }
        } else if (this.inputLine.value.trim()) {
          // Idle with input: clear input line, don't exit
          this.inputLine.setValue('')
          this.renderLive()
        } else {
          // Idle with empty input: first Ctrl+C → show hint, start 2s window
          this.ctrlCPendingSince = Date.now()
          this.renderLive()
          setTimeout(() => { this.ctrlCPendingSince = 0 }, 2000)
        }
        return
      }
      if (key.name === 'escape' && !this.inputLine.vimEnabled) {
        if (this.overlay.isActive()) {
          // Close active overlay
          this.overlay.deactivate()
          this.renderLive()
        } else if (this.state.isStreaming || this.state.isThinking) {
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
      if (key.name === 'ctrl_o') {
        this.expandLastTruncatedTool()
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
      // ── Approval mode handling ──────────────────────────────
      if (this.input.getMode() === 'approval') {
        if (this.handleApprovalKey(key.char)) return
      }
      // ── W4a: Up 箭头取回最近 queued 消息到输入框编辑 ─────────
      if (key.name === 'up' && !this.inputLine.value && this.steerBuffer.hasPending()) {
        const msg = this.steerBuffer.popLast()
        if (msg) {
          this.inputLine.setValue(msg)
          this.renderLive()
        }
        return
      }
      // ── Normal input processing ─────────────────────────────
      const event = this.inputLine.handleKey(key.name, key.char, key.ctrl, key.meta)
      if (event?.type === 'change') {
        // 输入变化使 @ 补全循环失效
        this.fileCompletion = null
        this.renderLive()
      } else if (event?.type === 'submit' || event?.type === 'tab') {
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
      onApprovalRequired: async (id, name, input) => this.handleApprovalRequired(id, name, input),
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
          this.setPhase(mapped)
          this.renderLive()
        }
        // Unknown phases (heartbeat, convergence-warning, etc.) are ignored
        // for the status bar display
      },
      onIntentPreview: async (_intent) => 'continue',
      onSteerDrain: () => this.steerBuffer.drain(),
    }

    // ── Approval key bindings ─────────────────────────────────
    this.input.onKey('approval:y', () => this.resolveApproval({ approved: true }))
    this.input.onKey('approval:n', () => this.resolveApproval(false))
    this.input.onKey('approval:escape', () => this.resolveApproval(false))
    this.input.onKey('approval:return', () => this.resolveApproval({ approved: true }))
  }

  // ── Approval resolution ─────────────────────────────────────

  private resolveApproval(result: ApprovalResult | boolean): void {
    if (!this.approvalPending) return
    this.approvalPending.resolve(result)
    this.approvalPending = null
    this.input.setMode('input')
    this.renderLive()
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
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
    this.input.dispose()
    this.resize.dispose()
  }

  /** 将静态文本提交到 scrollback（slash command 输出等） */
  commitStatic(text: string): void {
    this.commitAbove(() => {
      this.commit.write({ text, trailingNewline: true })
    })
  }

  /**
   * Mid-stream commit 协议：先擦除 live region（光标停在其起始行），
   * 写入 scrollback 内容，再重绘 live region。
   * 不走该协议的裸 commit 会留下 ghost 行 / 覆盖已提交文本。
   */
  private commitAbove(write: () => void): void {
    this.live.clearForCommit()
    write()
    this.renderLive()
  }

  // ── W3: phase + ticker ───────────────────────────────────────

  /** 统一 phase 设置入口：联动渲染 ticker 启停 */
  private setPhase(phase: ActivityPhase): void {
    this.state.phase = phase
    this.updateTicker()
  }

  /** streaming/thinking/analyzing/waiting 时启动 120ms ticker，idle 停止 */
  private updateTicker(): void {
    const active = this.state.phase !== 'idle'
    if (active && !this.ticker) {
      this.ticker = setInterval(() => {
        this.tick++
        this.renderLive()
      }, 120)
      this.ticker.unref?.()
    } else if (!active && this.ticker) {
      clearInterval(this.ticker)
      this.ticker = null
    }
  }

  /** 记录 token/输出活动时间（spinner stall 检测） */
  private markActivity(): void {
    this.lastActivityMs = Date.now()
  }

  // ── W4b: 输入辅助 ────────────────────────────────────────────

  /** 注入 slash 命令列表（main-ansi 启动时调用） */
  setSlashCommands(commands: SlashHintEntry[]): void {
    this.slashCommands = commands
  }

  /**
   * Tab 补全：
   * - 输入以 `/` 开头 → 补全为过滤结果首项
   * - 光标前有 `@token` → git 文件补全（多候选时 Tab 循环）
   */
  private handleTabComplete(): boolean {
    const value = this.inputLine.value
    const cursor = this.inputLine.cursor

    // slash 命令补全
    if (value.startsWith('/') && !value.includes(' ')) {
      const target = slashCompletionTarget(value, this.slashCommands)
      if (target && target !== value) {
        this.inputLine.setValue(`${target} `)
        return true
      }
      return false
    }

    // @ 文件补全（Tab 循环候选）
    if (this.fileCompletion) {
      const fc = this.fileCompletion
      fc.idx = (fc.idx + 1) % fc.candidates.length
      const applied = applyCompletion(fc.baseText, fc.baseCursor, fc.candidates[fc.idx]!)
      this.inputLine.setValue(applied.text, applied.cursor)
      return true
    }

    const token = extractAtToken(value, cursor)
    if (token === null) return false
    const candidates = getCompletions(token, process.cwd(), 8)
    if (candidates.length === 0) return false

    this.fileCompletion = { baseText: value, baseCursor: cursor, candidates, idx: 0 }
    const applied = applyCompletion(value, cursor, candidates[0]!)
    this.inputLine.setValue(applied.text, applied.cursor)
    if (candidates.length === 1) {
      this.fileCompletion = null // 唯一候选，无需循环
    }
    return true
  }

  /** Commit `▍ Rivet` 标签行（每段 assistant 流式输出一次） */
  private commitAssistantHeader(): void {
    this.commit.write({
      text: `${color('▍', this.theme.assistantColor, { bold: true })} ${color('Rivet', this.theme.assistantColor, { dim: true })}`,
    })
    this.assistantHeaderDone = true
  }

  /** 手动设置 streaming 状态 */
  setStreamingState(v: boolean): void {
    this.state.isStreaming = v
    if (!v) {
      this.setPhase('idle')
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

  // ── Approval state ──────────────────────────────────────────

  /** Pending approval request — when set, InputHandler switches to approval mode */
  private approvalPending: {
    id: string
    name: string
    input: Record<string, unknown>
    resolve: (result: ApprovalResult | boolean) => void
  } | null = null

  // ── Agent Event Handlers ─────────────────────────────────────

  private handleTextDelta(text: string): void {
    this.state.isStreaming = true
    this.setPhase('streaming')
    this.markActivity()
    // Push through block writer (buffers text, emits in display-sized blocks)
    this.blockWriter.push(text)
  }

  private handleThinkingDelta(thinking: string): void {
    this.state.isThinking = true
    this.setPhase('thinking')
    this.markActivity()
    this.state.thinkingText += thinking
    if (this.state.thinkStartMs === 0) {
      this.state.thinkStartMs = Date.now()
    }
    this.renderLive()
  }

  private handleToolUse(id: string, name: string, input: Record<string, unknown>): void {
    this.setPhase('analyzing')
    this.markActivity()
    this.pendingTools.set(id, { name, input, startMs: Date.now() })
    // Commit thinking if any
    if (this.state.thinkingText) {
      this.commitAbove(() => this.commitThinking())
    } else {
      this.renderLive()
    }
  }

  private handleToolResult(id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string): void {
    const displayContent = uiContent ?? result

    // Streaming chunk mode: isError === undefined means intermediate update
    if (isError === undefined) {
      // Accumulate for live tool card display — show last lines in live region
      const toolAcc = this.toolAccumulator.get(id) ?? ''
      this.toolAccumulator.set(id, toolAcc + result)
      this.markActivity()
      this.renderLive()
      return
    }

    // Terminal result: commit to scrollback
    const toolAcc = this.toolAccumulator.get(id)
    this.toolAccumulator.delete(id)
    const meta = this.pendingTools.get(id)
    this.pendingTools.delete(id)
    const finalContent = toolAcc ? toolAcc + displayContent : displayContent

    const cardInput = {
      toolName: name,
      content: finalContent,
      isError,
      rawPath,
      toolInput: meta?.input,
      elapsedMs: meta ? Date.now() - meta.startMs : undefined,
    }
    const formatted = formatToolCard(cardInput, this.theme)

    // 记录截断结果供 ctrl+o 展开
    if (isToolCardTruncated(cardInput)) {
      this.lastTruncatedTool = {
        toolName: name,
        content: finalContent,
        isError,
        rawPath,
        toolInput: meta?.input,
      }
    }

    this.commitAbove(() => {
      this.commit.write({ text: formatted.join('\n') })
      this.state.committedCount++
    })
  }

  /** ctrl+o：将最近一条被截断的工具结果完整展开重新 commit 到 scrollback */
  private expandLastTruncatedTool(): void {
    const t = this.lastTruncatedTool
    if (!t) return
    this.lastTruncatedTool = null
    const formatted = formatToolCard({
      toolName: t.toolName,
      content: t.content,
      isError: t.isError,
      rawPath: t.rawPath,
      toolInput: t.toolInput,
      expanded: true,
    }, this.theme)
    this.commitAbove(() => {
      this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
      this.state.committedCount++
    })
  }

  private handleCheckpoint(hash: string): void {
    this.commitAbove(() => {
      this.commit.write({
        text: `Checkpoint saved: ${hash.slice(0, 7)} — /rollback to restore`,
        trailingNewline: true,
      })
      this.state.committedCount++
    })
  }

  private async handleTurnComplete(usage: Partial<Usage>, turnNumber: number, isFinal: boolean): Promise<void> {
    this.state.turnNumber = turnNumber

    // Flush any pending blocks from the writer, then commit the remaining tail
    await this.blockWriter.flush()
    this.streamRenderer.finalize()
    this.assistantHeaderDone = false

    // ── W3: 累计 usage → cache hit / context% / cost ────────────
    this.accumulateUsage(usage)

    if (isFinal) {
      // Reset state
      this.agentBusy = false
      this.state.thinkingText = ''
      this.state.isStreaming = false
      this.state.isThinking = false
      this.setPhase('idle')
      this.state.thinkStartMs = 0

      // 回合耗时文案：✦ Worked for 1m 6s · 12.3k in / 890 out
      const elapsed = Date.now() - this.state.turnStartMs
      const summary = formatTurnWorkSummary({
        elapsedMs: elapsed,
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
      }, this.theme)
      this.commitAbove(() => {
        this.commit.write({ text: summary, trailingNewline: true })
        this.state.committedCount++
      })
    } else {
      // Intermediate turn: archive thinking, keep writer alive
      if (this.state.thinkingText) {
        this.commitAbove(() => this.commitThinkingToScrollback())
      }
      this.state.thinkingText = ''
      this.state.isThinking = false
      this.state.thinkStartMs = 0
      this.setPhase('waiting')
      this.renderLive()
    }
  }

  /** 从 onTurnComplete 的 Usage 解析 cache hit / context% / session cost */
  private accumulateUsage(usage: Partial<Usage>): void {
    const input = usage.input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheCreate = usage.cache_creation_input_tokens ?? 0
    this.totalUsage.input += input
    this.totalUsage.output += output
    this.totalUsage.cacheRead += cacheRead
    this.totalUsage.cacheCreate += cacheCreate

    if (input > 0) {
      this.lastCacheHitRate = Math.min(1, cacheRead / input)
    }
    if (this.contextWindow && this.contextWindow > 0 && input > 0) {
      this.lastContextRatio = Math.min(1, (input + output) / this.contextWindow)
    }
  }

  /** 估算累计费用（对齐 app.tsx 的近似定价：normal $1/M、cache $0.1/M、out $4/M） */
  private estimateSessionCost(): number {
    const normalInput = Math.max(0, this.totalUsage.input - this.totalUsage.cacheRead)
    return (normalInput * 1 + this.totalUsage.cacheRead * 0.1 + this.totalUsage.output * 4) / 1_000_000
  }

  private handleError(error: Error): void {
    this.agentBusy = false
    this.setPhase('idle')
    this.state.isStreaming = false
    this.commitAbove(() => {
      this.commit.write({
        text: `Error: ${error.message}`,
        trailingNewline: true,
      })
    })
  }

  private handleAbort(): void {
    // Clear steer buffer on abort to prevent stale guidance
    this.steerBuffer.clear()
    this.streamRenderer.reset()
    this.assistantHeaderDone = false
    this.pendingTools.clear()
    this.toolAccumulator.clear()
    this.agentBusy = false
    this.state.isStreaming = false
    this.state.isThinking = false
    this.setPhase('idle')
    this.live.clear()
    this.onAbortCallback?.()
  }

  // ── Rendering Pipeline ───────────────────────────────────────

  /**
   * 渲染 live region（底部动态区域）。
   *
   * Live region 结构：
   * ┌─ streaming/thinking 内容 ─┐
   * │ Approval prompt (when pending) │
   * │ GlanceBar                  │
   * │ InputLine                  │
   * └────────────────────────────┘
   */
  private renderLive(): void {
    const lines: LiveRegionLine[] = []

    // 1. Spinner 状态行（⠋ Thinking… (12s · esc to interrupt)），10s 无 token 变琥珀
    const stalled = this.lastActivityMs > 0 && Date.now() - this.lastActivityMs > 10_000
    const spinnerLine = formatSpinnerStatus({
      tick: this.tick,
      phase: this.state.phase,
      elapsedMs: Date.now() - this.state.turnStartMs,
      stalled,
    }, this.theme)
    if (spinnerLine) {
      lines.push({ text: spinnerLine })
    }

    // 1b. Thinking 展开内容（状态行已由 spinner 承担，仅展开时显示正文）
    if (this.state.isThinking && this.state.thinkingText && this.state.thinkingExpanded) {
      const thinkingLines = formatThinking({
        text: this.state.thinkingText,
        elapsedMs: Date.now() - this.state.thinkStartMs,
        isStreaming: this.state.isStreaming,
        expanded: true,
      }, this.theme)
      for (const line of thinkingLines) {
        lines.push({ text: line })
      }
    }

    // 2. Streaming tail (尾部不完整 markdown block，display-width aware 截断)
    for (const line of this.streamRenderer.getLiveTailLines(6)) {
      lines.push({ text: line })
    }

    // 2b. 队列预览：⏳ queued: "最后一条前 60 字符"（Up 取回编辑）
    if (this.steerBuffer.hasPending()) {
      const pending = this.steerBuffer.getPending()
      const last = pending[pending.length - 1]!
      const preview = last.length > 60 ? `${last.slice(0, 60)}…` : last
      const more = pending.length > 1 ? ` (+${pending.length - 1} more)` : ''
      lines.push({ text: color(`⏳ queued: "${preview}"${more} · ↑ to edit`, this.theme.muted) })
    }

    // 2c. 进行中工具：● 标题行 + 末 3 行输出（⎿ 缩进）
    if (this.pendingTools.size > 0) {
      for (const [id, meta] of this.pendingTools) {
        const toolLines = formatToolCardLive({
          toolName: meta.name,
          toolInput: meta.input,
          outputTail: this.toolAccumulator.get(id),
          elapsedMs: Date.now() - meta.startMs,
          columns: this.columns,
        }, this.theme)
        for (const line of toolLines) {
          lines.push({ text: line })
        }
      }
    }

    // 3. Approval prompt (when pending)
    if (this.approvalPending) {
      const p = this.approvalPending
      const inputSummary = JSON.stringify(p.input).slice(0, 80)
      lines.push({ text: ` ╭─ Approval Required ──────────────────────────────` })
      lines.push({ text: ` │ Tool: ${p.name}` })
      lines.push({ text: ` │ Input: ${inputSummary}${JSON.stringify(p.input).length > 80 ? '...' : ''}` })
      lines.push({ text: ` ╰─ [y] approve  [n] deny  [e] edit ──────────────` })
    }

    // 4. GlanceBar（phase glyph / context% / cache / cost / git branch）
    const phaseInd = phaseIndicator(this.state.phase)
    const glanceBar = formatGlanceBar({
      width: this.columns,
      domainGlyph: this.state.domainGlyph,
      domainName: this.state.domainName,
      branch: this.gitBranch,
      phaseGlyph: phaseInd.glyph,
      phaseLabel: phaseInd.label,
      modelName: this.state.modelName,
      cacheHitRate: this.lastCacheHitRate,
      contextRatio: this.lastContextRatio,
      cost: this.estimateSessionCost(),
      elapsedMs: Date.now() - this.state.turnStartMs,
      turnCount: this.state.turnNumber,
    }, this.theme)
    // formatGlanceBar 返回「分隔线\n状态行」两行——必须拆开 push，
    // LiveEngine 按数组元素计行，内嵌 \n 会破坏重绘的行数计算
    for (const glanceLine of glanceBar.split('\n')) {
      lines.push({ text: glanceLine })
    }

    // 5. Input line / Ctrl+C hint（多行输入：每行单独 push）
    if (this.ctrlCPendingSince > 0) {
      lines.push({ text: '(Ctrl+C again to exit)' })
    } else {
      // 空输入显示 dim placeholder
      const inputLines = this.inputLine.value
        ? this.inputLine.displayLines()
        : [`▸ █${color(this.inputLine.placeholder, this.theme.dim)}`]
      if (this.inputLine.vimEnabled && this.inputLine.vimMode === 'normal') {
        lines.push({ text: `-- NORMAL -- ${inputLines[0] ?? ''}` })
        for (const extra of inputLines.slice(1)) lines.push({ text: extra })
      } else {
        for (const inputDisplayLine of inputLines) lines.push({ text: inputDisplayLine })
      }

      // 5b. slash 命令提示（输入以 / 开头且未含空格）
      const inputVal = this.inputLine.value
      if (inputVal.startsWith('/') && !inputVal.includes(' ')) {
        for (const hintLine of formatSlashHint({ input: inputVal, commands: this.slashCommands }, this.theme)) {
          lines.push({ text: hintLine })
        }
      }

      // 5c. @ 文件补全候选列表（Tab 循环时显示）
      if (this.fileCompletion && this.fileCompletion.candidates.length > 1) {
        const fc = this.fileCompletion
        for (let i = 0; i < Math.min(fc.candidates.length, 6); i++) {
          const selected = i === fc.idx
          const marker = selected ? color('❯ ', this.theme.primary) : '  '
          const name = color(fc.candidates[i]!, selected ? this.theme.primary : this.theme.muted)
          lines.push({ text: `${marker}${name}` })
        }
        lines.push({ text: color('tab to cycle', this.theme.dim) })
      }
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

  /** 审批处理器 — 交互式 y/n/e */
  private handleApprovalRequired(id: string, name: string, input: Record<string, unknown>): Promise<ApprovalResult | boolean> {
    return new Promise((resolve) => {
      this.approvalPending = { id, name, input, resolve }
      this.input.setMode('approval')
      this.setPhase('waiting')
      this.renderLive()
    })
  }

  /** 处理审批模式按键。返回 true 表示已处理。 */
  private handleApprovalKey(char: string): boolean {
    if (!this.approvalPending) return false

    const key = char.toLowerCase()
    if (key === 'y') {
      const resolve = this.approvalPending.resolve
      this.approvalPending = null
      this.input.setMode('input')
      this.setPhase('idle')
      this.renderLive()
      resolve(true)
      return true
    }
    if (key === 'n') {
      const resolve = this.approvalPending.resolve
      this.approvalPending = null
      this.input.setMode('input')
      this.setPhase('idle')
      this.renderLive()
      resolve(false)
      return true
    }
    if (key === 'e') {
      // Edit mode: approve with edited input (for now, approve as-is;
      // full edit flow requires external editor integration)
      const resolve = this.approvalPending.resolve
      this.approvalPending = null
      this.input.setMode('input')
      this.setPhase('idle')
      this.renderLive()
      resolve(true)
      return true
    }
    return false
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
