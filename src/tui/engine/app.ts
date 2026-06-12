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
 * 阶段 6 会完成与 main.ts 和 AgentLoop 的实际接线。
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
import { formatToolGroup, shouldFlushGroup, canCollapse, groupFamily, toolEntryDisplay, type ToolGroup } from '../format/tool-group.js'
import { formatPermissionDiff } from '../format/permission-diff.js'
import { formatThinking } from '../format/thinking.js'
import { formatGlanceBar } from '../format/glance-bar.js'
import { formatTaskList } from '../format/task-list.js'
import type { TodoItem } from '../../tools/todo-store.js'
import { formatTeamPanel } from '../format/team-panel.js'
import { decodeTeamPanelModel } from '../team-panel-model.js'
import { domainBadge, isDelegationTool } from '../format/tool-domain.js'
import { formatSpinnerStatus, formatTurnWorkSummary, phaseIndicator } from '../format/spinner-status.js'
import { formatSlashHint, slashCompletionTarget, filterSlashCommands, type SlashHintEntry } from '../format/slash-hint.js'
import { extractAtToken, getCompletions, applyCompletion } from '../file-completer.js'
import { appendHistory, nextHistoryAfterSubmit } from '../history.js'
import { renderPager, renderStarmap, renderCommandPalette, renderChronicle } from '../format/overlay.js'
import type { PagerData, StarmapData, PaletteData, ChronicleData } from '../format/overlay.js'
import { renderCockpit } from '../format/cockpit.js'
import type { CockpitSnapshot } from '../cockpit/types.js'
import { renderRewind, type RewindData } from '../format/rewind.js'

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
  /** 常驻任务面板（todo 列表，canonical 源为 TodoStore） */
  todos: TodoItem[]
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

/**
 * GlanceBar 真实指标快照（由 main-ansi 闭包从 ctx.session 读取）。
 * 全部为「当前会话累计 / 估算」的真实值，避免 TUI 端自行 += 累加导致膨胀。
 */
export interface TuiMetrics {
  /** 当前估算 prompt token（含 prefix overhead） */
  estimatedTokens: number
  /** 模型上下文窗口 token 上限 */
  maxTokens: number
  /** 缓存命中率 0-1（近 N 回合优先，回退会话累计）；无数据为 null */
  cacheHitRate: number | null
  /** 会话累计费用（美元，单次从 getTotalUsage 计算，不累加） */
  cost: number
  /** 会话累计 input / output token（仅用于展示，不参与 += 累加） */
  inputTokens: number
  outputTokens: number
}

/** 指标提供者：返回 null 表示暂无（回退 TUI 内部估算）。 */
export type TuiMetricsProvider = () => TuiMetrics | null

// ── TuiApp ─────────────────────────────────────────────────────

export class TuiApp {
  // Engines
  private commit: CommitEngine
  private live: LiveEngine
  private overlay: OverlayEngine
  private input: InputHandler
  private resize: ResizeHandler
  private inputLine: InputLine

  // Overlay 交互导航状态（pager 翻页 / palette 选中）。
  // 渲染器是纯函数，page/selectedIndex 由此状态注入并在激活时复位。
  private overlayNav = { pagerPage: 0, paletteIndex: 0, rewindIndex: 0 }
  /** 注册时保存的 overlay 数据提供函数（供导航处理器查边界 / 执行命令） */
  private overlayData?: {
    pagerContent?: () => PagerData
    starmapEntries?: () => StarmapData
    paletteCommands?: () => PaletteData
    chronicleEntries?: () => ChronicleData
    cockpitSnapshot?: () => CockpitSnapshot
    rewindEntries?: () => RewindData
  }
  /** palette Enter 执行回调：参数为选中命令的 0-based 索引 */
  private paletteExec?: (index: number) => void

  // State
  private state: TuiState
  private get theme(): RivetTheme { return getTheme() }
  private columns: number
  private rows: number
  /** Streaming tool result accumulator: id → accumulated text */
  private toolAccumulator = new Map<string, string>()
  /** 进行中工具元数据：id → 名称/输入/开始时间（live 工具行 + 卡片标题用） */
  private pendingTools = new Map<string, { name: string; input: Record<string, unknown>; startMs: number }>()
  /** 最近一条被截断的工具结果（ctrl+o 展开用） */
  private lastTruncatedTool: { toolName: string; content: string; isError: boolean; rawPath?: string; toolInput?: Record<string, unknown> } | null = null
  /** 工具折叠组缓冲区：连续同族 read/grep/glob 调用在此累积，异族到达或 turn 结束时 flush */
  private toolGroupBuffer: ToolGroup | null = null

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
  /** 真实指标提供者（main-ansi 闭包读 ctx.session）；无则回退内部估算 */
  private metricsProvider?: TuiMetricsProvider
  /** todo 列表访问器（main-ansi 读 TodoStore 单例） */
  private todosProvider?: () => TodoItem[]
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
  /**
   * Run 世代计数 —— 唯一权威的「当前 run」标识。
   * 每次 abort 自增；被中断的旧 run 的迟到回调（经 bridge 包裹时捕获的旧 gen）
   * 与当前 gen 不符即被丢弃，杜绝旧 run 的 onAbort/onTextDelta 污染新 run 状态。
   */
  private _runGen = 0

  // ── W4b: 输入辅助 ────────────────────────────────────────────
  /** slash 命令列表（外部注入，提示 + Tab 补全用） */
  private slashCommands: SlashHintEntry[] = []
  /** slash hint 当前选中项索引（输入以 / 开头时，Tab 补全目标） */
  private slashSelectedIdx = 0
  /** @ 文件补全状态（Tab 循环） */
  private fileCompletion: { baseText: string; baseCursor: number; candidates: string[]; idx: number } | null = null
  /** 输入历史（最新在前，submit 时更新 + 持久化） */
  private inputHistory: string[] = []
  /** Ctrl+C double-press window start timestamp (ms), 0 = inactive */
  private ctrlCPendingSince = 0
  /** 原始 stdout（用于直接写 DEC 私有模式如 bracketed paste 开关） */
  private stdout: WriteStream

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
    // theme is now a dynamic getter — always reads current activeTheme
    this.stdout = options.stdout
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

        // 跨 run steer 收口：上一 run 结束（text-only 收尾从不 drain）或
        // busy 闩残留时排队的 guidance 会滞留到这里。若放任不管，它会在
        // 下一次工具回合作为 [User guidance] 注入 —— 旧指令混进新任务上下文。
        // 归并进本次 prompt（排队内容本就是用户意图，按时间序拼在新消息前）。
        let submitText = text
        if (trimmed && this.steerBuffer.hasPending()) {
          const pending = [...this.steerBuffer.getPending()]
          this.steerBuffer.clear()
          submitText = [...pending, trimmed].join('\n\n')
          this.commitAbove(() => {
            this.commit.write({
              text: color(`↳ ${pending.length} queued message${pending.length > 1 ? 's' : ''} merged into this prompt`, this.theme.muted),
              trailingNewline: true,
            })
            this.state.committedCount++
          })
        }

        // Commit user message to scrollback
        if (trimmed) {
          this.commitAbove(() => {
            const formatted = formatUserMessage({
              content: submitText.trim(),
              width: this.columns,
            }, this.theme)
            // 单次提交 + 块尾空行：与 assistant/tool/summary 统一间距契约
            this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
            this.state.committedCount++
          })
          // 新 run 启动前丢弃上一 run 未 finalize 的流式残留：blockWriter 缓冲
          // 与 streamRenderer pending 若不清，会把上一轮文字追加进新轮输出。
          this.blockWriter.discard()
          this.streamRenderer.reset()
          this.assistantHeaderDone = false
          this.agentBusy = true
        }
        // Reset turn timer for the new turn
        this.state.turnStartMs = Date.now()
        this.lastActivityMs = Date.now()
        this.onSubmitCallback?.(submitText)
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
      getTheme: () => this.theme,
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
      todos: [],
    }

    // Wire resize
    this.resize.onResize((cols, rows) => {
      this.columns = cols
      this.rows = rows
      this.rerender()
    })

    // Wire bracketed paste: 整段插入光标处，批渲染（避免逐 chunk 全量重写）
    this.input.onPaste((text) => {
      this.inputLine.insertText(text)
      this.fileCompletion = null
      this.writeBatcher.schedule()
    })

    // Wire input: character input → inputLine → live region update
    this.input.onAnyKey((key) => {
      // ── Approval mode short-circuit (顶部，先于一切普通输入) ──
      // 审批态只解析审批动作，绝不落入 slash / inputLine —— 杜绝 Enter 双触发
      // （旧实现：onAnyKey 落入 inputLine 触发 submit + mode-bound approval:return 再 approve）。
      if (this.input.getMode() === 'approval' && this.approvalPending) {
        const c = key.char.toLowerCase()
        if (key.name === 'ctrl_c') {
          this.resolveApproval(false)
          // 继续走下方全局 ctrl_c（abort / exit）
        } else {
          if (key.name === 'return' || c === 'y') this.resolveApproval({ approved: true })
          else if (key.name === 'escape' || c === 'n') this.resolveApproval(false)
          // 其余按键在审批态一律吞掉，不污染输入框。
          // 注意：不提供 [e] edit —— 编辑工具入参的完整流程尚未实装，
          // 旧实现 e===approve 是误导性假动作（UI 明示可编辑，实际等同 y）。
          return
        }
      }

      // ── Intent preview mode short-circuit ──
      // 意图闸是「先确认再动手」的安全机制，旧实现 onIntentPreview 永远 'continue'
      // 等于旁路了这道闸。这里把按键解析成 IntentPreviewAction，绝不落入普通输入。
      if (this.input.getMode() === 'intent' && this.intentPending) {
        const c = key.char.toLowerCase()
        const hasAlt = (this.intentPending.intent.alternatives?.length ?? 0) > 0
        if (key.name === 'ctrl_c') {
          this.resolveIntent('veto')
          // 继续走下方全局 ctrl_c（abort / exit）
        } else {
          if (key.name === 'return' || c === 'y') this.resolveIntent('continue')
          else if (key.name === 'escape' || c === 'n') this.resolveIntent('veto')
          else if (c === 'a' && hasAlt) this.resolveIntent('alternative')
          // 其余按键在意图态一律吞掉，不污染输入框
          return
        }
      }

      // ── Overlay 交互导航（pager 翻页 / palette 选择执行）──
      // overlay 激活时按键先路由进 overlay：原实现仅 Esc 关闭，pager 不能翻页、
      // palette 不能选 → overlay 形同只读弹窗。这里补全导航与执行。
      if (this.overlay.isActive()) {
        if (this.handleOverlayKey(key)) return
        // 未被 overlay 消费的键落到下方（Esc/Ctrl+C 等全局兜底）
      }

      // ── Global shortcuts (before input line processing) ──────
      if (key.name === 'ctrl_c') {
        if (this.isAgentActive()) {
          // Agent active (含首 token 前/纯工具窗口): abort current agent run
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
      if (key.name === 'escape' && key.ctrl) {
        // Ctrl+Esc → 激活命令面板
        this.overlayNav = { pagerPage: 0, paletteIndex: 0, rewindIndex: 0 }
        this.overlay.activate('command-palette')
        return
      }
      if (key.name === 'escape' && !this.inputLine.vimEnabled) {
        if (this.overlay.isActive()) {
          // Close active overlay
          this.overlay.deactivate()
          this.renderLive()
        } else if (this.isAgentActive()) {
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
      if (key.name === 'ctrl_t') {
        if (this.state.isThinking) {
          this.state.thinkingExpanded = !this.state.thinkingExpanded
          this.renderLive()
        }
        return
      }
      // ── Slash command handling ──────────────────────────────
      const inputVal = this.inputLine.value
      if (inputVal.startsWith('/')) {
        // ↑↓ 选择仅对无参数命令生效（Tab 补全同理）
        if (!inputVal.includes(' ')) {
          const filtered = filterSlashCommands(this.slashCommands, inputVal.slice(1))
          if (key.name === 'up' && filtered.length > 0) {
            this.slashSelectedIdx = (this.slashSelectedIdx - 1 + filtered.length) % filtered.length
            this.renderLive()
            return
          }
          if (key.name === 'down' && filtered.length > 0) {
            this.slashSelectedIdx = (this.slashSelectedIdx + 1) % filtered.length
            this.renderLive()
            return
          }
          // Tab 在 inputLine.handleKey 里走 'tab' 事件 → handleTabComplete，无需在此处理
        }
        if (key.name === 'return') {
          // 先清空输入框，再异步处理（await handler 结果决定是否透传 agent）
          this.inputLine.setValue('')
          this.slashSelectedIdx = 0
          void this.submitSlashCommand(inputVal)
          return
        }
      } else {
        this.slashSelectedIdx = 0
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
        // 普通文本输入重置 slash 选中项（避免选了第 3 项又打字导致选中越界）
        this.slashSelectedIdx = 0
        // 批渲染：快速输入/分 chunk 到达时合并为单次 LiveEngine.render，
        // 避免逐 chunk 全量重写造成的闪烁/残影。
        this.writeBatcher.schedule()
      } else if (event?.type === 'submit' || event?.type === 'tab') {
        // 提交/补全需即时反馈，不进批
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
      onIntentPreview: async (intent) => this.handleIntentPreview(intent),
      onSteerDrain: () => this.steerBuffer.drain(),
    }

    // 审批按键统一在 onAnyKey 顶部短路处理（见上），不再注册 mode-bound 处理器，
    // 避免与 onAnyKey 双触发。
  }

  // ── Approval resolution ─────────────────────────────────────

  private resolveApproval(result: ApprovalResult | boolean): void {
    if (!this.approvalPending) return
    this.approvalPending.resolve(result)
    this.approvalPending = null
    this.input.setMode('input')
    this.renderLive()
  }

  // ── Intent preview resolution ───────────────────────────────

  private resolveIntent(action: IntentPreviewAction): void {
    if (!this.intentPending) return
    this.intentPending.resolve(action)
    this.intentPending = null
    this.input.setMode('input')
    this.renderLive()
  }

  // ── Public API ───────────────────────────────────────────────

  /**
   * 首屏渲染：启动后立即绘制底部 chrome（GlanceBar + 输入框），
   * 无需等待第一次按键。main-ansi 在欢迎块写完后调用。
   */
  start(): void {
    // 启用 bracketed paste（DEC 2004）：粘贴被 200~/201~ 包裹，
    // 避免含 \r 的多行粘贴被逐行当作 Enter 提交、控制字符污染显示。
    this.stdout.write('\x1B[?2004h')
    this.renderLive()
  }

  /** 设置提交回调（用户按 Enter 后触发） */
  onSubmit(callback: (text: string) => void): void {
    this.onSubmitCallback = callback
  }

  /** 设置中止回调 */
  onAbort(callback: () => void): void {
    this.onAbortCallback = callback
  }

  /** 当前 run 世代（唯一权威；bridge 用它丢弃被中断旧 run 的迟到回调） */
  get runGen(): number {
    return this._runGen
  }

  /** agent 是否正在执行（streaming 状态的唯一权威，供外层入口判定是否可发起新 run） */
  get busy(): boolean {
    return this.agentBusy
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

  /** 读取当前输入框文本（测试/外部检视用） */
  getInputValue(): string {
    return this.inputLine.value
  }

  /** 激活 overlay */
  activateOverlay(id: string): boolean {
    switch (id) {
      case 'pager':
      case 'starmap':
      case 'command-palette':
      case 'cockpit':
      case 'rewind':
      case 'chronicle': {
        // 复位导航状态，避免上次的翻页/选中残留到新 overlay
        this.overlayNav = { pagerPage: 0, paletteIndex: 0, rewindIndex: 0 }
        return this.overlay.activate(id)
      }
      default:
        return false
    }
  }

  /** 停用 overlay */
  deactivateOverlay(): void {
    this.overlay.deactivate()
    this.renderLive()
  }

  /** 返回 scrollback 完整文本（供 pager overlay 读取） */
  getScrollbackContent(): string {
    return this.commit.getContent()
  }

  /**
   * Overlay 导航键处理。返回 true 表示已消费（调用方应 return）。
   * - pager：j/↓/PgDn 下翻，k/↑/PgUp 上翻，Home/End 首末页，q 关闭
   * - command-palette：↑/↓ 移动选中，Enter 执行并关闭，q 关闭
   * - 其它 overlay（starmap/chronicle）：仅 q 关闭（无内部导航）
   * Esc/Ctrl+C 不在此消费，留给全局兜底统一关闭。
   */
  private handleOverlayKey(key: { name: string; char: string }): boolean {
    const id = this.overlay.activeId()
    const c = key.char.toLowerCase()

    // q 在所有 overlay 内统一关闭
    if (c === 'q') {
      this.deactivateOverlay()
      return true
    }

    if (id === 'pager') {
      const total = this.pagerTotalPages()
      const cur = this.overlayNav.pagerPage
      let next = cur
      if (key.name === 'down' || key.name === 'pagedown' || c === 'j') next = cur + 1
      else if (key.name === 'up' || key.name === 'pageup' || c === 'k') next = cur - 1
      else if (key.name === 'home') next = 0
      else if (key.name === 'end') next = total - 1
      else return false
      next = Math.max(0, Math.min(total - 1, next))
      if (next !== cur) {
        this.overlayNav.pagerPage = next
        this.overlay.rerender()
      }
      return true
    }

    if (id === 'command-palette') {
      const count = this.overlayData?.paletteCommands?.().commands.length ?? 0
      const cur = this.overlayNav.paletteIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayNav.paletteIndex = (cur + 1) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayNav.paletteIndex = (cur - 1 + count) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        if (count > 0 && this.paletteExec) {
          const idx = cur
          this.deactivateOverlay()
          this.paletteExec(idx)
        } else {
          this.deactivateOverlay()
        }
        return true
      }
      return false
    }

    if (id === 'rewind') {
      const count = this.overlayData?.rewindEntries?.().entries.length ?? 0
      const cur = this.overlayNav.rewindIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayNav.rewindIndex = Math.min(cur + 1, count - 1); this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayNav.rewindIndex = Math.max(cur - 1, 0); this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        if (count > 0) {
          const entry = this.overlayData?.rewindEntries?.().entries[cur]
          this.deactivateOverlay()
          if (entry) {
            // 将选中消息回填到输入框，用户可编辑后重新提交
            this.setInput(entry.content)
          }
        } else {
          this.deactivateOverlay()
        }
        return true
      }
      return false
    }

    return false
  }

  /** pager 总页数（与 renderPager 同口径：pageSize = rows - 4）。 */
  private pagerTotalPages(): number {
    const content = this.overlayData?.pagerContent?.().content ?? ''
    const lines = content.split('\n').length
    const pageSize = Math.max(1, this.rows - 4)
    return Math.max(1, Math.ceil(lines / pageSize))
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
    // 关闭 bracketed paste，恢复终端默认
    this.stdout.write('\x1B[?2004l')
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
      const target = slashCompletionTarget(value, this.slashCommands, this.slashSelectedIdx)
      if (target && target !== value) {
        this.inputLine.setValue(`${target} `)
        this.slashSelectedIdx = 0
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

  /** 设置模型信息（/model 切换后刷新 GlanceBar 显示） */
  setModelInfo(modelName: string, contextWindow?: number): void {
    this.state.modelName = modelName
    if (contextWindow !== undefined) this.contextWindow = contextWindow
    this.renderLive()
  }

  /** 设置外部 slash command 处理器（如 SlashRouter） */
  setSlashHandler(handler: (input: string) => boolean | Promise<boolean>): void {
    this.slashHandler = handler
  }

  /**
   * 注入真实指标提供者（main-ansi 闭包读 ctx.session）。
   * 设置后 GlanceBar 优先用真实数据；未设置则回退内部估算（保持可独立运行/可测）。
   */
  setMetricsProvider(provider: TuiMetricsProvider): void {
    this.metricsProvider = provider
  }

  /**
   * 读取当前真实指标快照（与 GlanceBar 同源）。无 provider 时返回 null。
   * 供 SlashRouter 让 /cost、maxTokens 等命令读到与 GlanceBar 一致的真实值，
   * 不再写死 cost: 0 或取 models[0]（非当前模型）。
   */
  getMetrics(): TuiMetrics | null {
    return this.metricsProvider?.() ?? null
  }

  /**
   * 注入 todo 列表访问器（main-ansi 读 TodoStore 单例），避免 T9 直接 import
   * 工具层。设置后 todo 工具结果 / turn 完成时拉取刷新常驻任务面板。
   */
  setTodosProvider(provider: () => TodoItem[]): void {
    this.todosProvider = provider
  }

  /** 直接设置任务面板内容（供测试与 provider 刷新复用）。 */
  setTodos(items: TodoItem[]): void {
    this.state.todos = items
    this.renderLive()
  }

  /** 从 provider 拉取最新 todo 列表刷新面板（无 provider 时 no-op）。 */
  private refreshTodos(): void {
    if (!this.todosProvider) return
    try {
      this.state.todos = this.todosProvider()
    } catch {
      // provider 失败不应中断渲染
    }
  }

  // ── Approval state ──────────────────────────────────────────

  /** Pending approval request — when set, InputHandler switches to approval mode */
  private approvalPending: {
    id: string
    name: string
    input: Record<string, unknown>
    resolve: (result: ApprovalResult | boolean) => void
  } | null = null

  /** Pending intent preview — when set, InputHandler switches to intent mode */
  private intentPending: {
    intent: IntentPreview
    resolve: (action: IntentPreviewAction) => void
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
    // 经 WriteBatcher 合并：DeepSeek reasoning_content 是逐字高频流，旧实现每个
    // token 直接 renderLive() → 全区域重写 + stringWidth×N，深思期持续刷屏卡顿。
    // 与正文流（blockWriter → writeBatcher.schedule）同口径：同一 microtask 内多次
    // delta 只渲染一次；120ms ticker 仍保底 spinner 帧率。
    this.writeBatcher.schedule()
  }

  private handleToolUse(id: string, name: string, input: Record<string, unknown>): void {
    this.setPhase('analyzing')
    this.markActivity()
    this.pendingTools.set(id, { name, input, startMs: Date.now() })
    // 子代理编排（delegate_* / team_orchestrate）切 GlanceBar domain 到天机。
    if (isDelegationTool(name)) {
      const badge = domainBadge(name)
      if (badge) {
        this.state.domainGlyph = badge.glyph
        this.state.domainName = badge.name
      }
    }

    // 工具折叠组：同族 tool 到达时，若异族则先 flush 旧组，再开新组
    const family = groupFamily(name)
    if (canCollapse(family)) {
      if (this.toolGroupBuffer && shouldFlushGroup(this.toolGroupBuffer, name)) {
        this.flushToolGroup()
      }
      if (!this.toolGroupBuffer) {
        this.toolGroupBuffer = { family, entries: [], startMs: Date.now() }
      }
      this.toolGroupBuffer.entries.push({
        toolName: name,
        input,
        displayName: toolEntryDisplay(name, input),
      })
    } else {
      if (this.toolGroupBuffer) this.flushToolGroup()
    }

    // Commit thinking if any
    if (this.state.thinkingText) {
      this.commitAbove(() => this.commitThinking())
    } else {
      this.renderLive()
    }
  }

  /** 将折叠组 buffer 刷新到 scrollback */
  private flushToolGroup(): void {
    if (!this.toolGroupBuffer || this.toolGroupBuffer.entries.length === 0) return
    const formatted = formatToolGroup({ group: this.toolGroupBuffer, theme: this.theme })
    this.commitAbove(() => {
      this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
      this.state.committedCount++
    })
    this.toolGroupBuffer = null
  }

  private handleToolResult(id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string): void {
    const displayContent = uiContent ?? result

    // Streaming chunk mode: isError === undefined means intermediate update
    if (isError === undefined) {
      // Accumulate for live tool card display — show last lines in live region
      const toolAcc = this.toolAccumulator.get(id) ?? ''
      this.toolAccumulator.set(id, toolAcc + result)
      this.markActivity()
      // 经 WriteBatcher 合并：长输出工具（bash/test）逐 chunk 上行，旧实现每 chunk
      // 直接 renderLive() 全区域重绘。与正文/思考流同口径合并到 microtask。
      this.writeBatcher.schedule()
      return
    }

    // Terminal result: commit to scrollback
    const toolAcc = this.toolAccumulator.get(id)
    this.toolAccumulator.delete(id)
    const meta = this.pendingTools.get(id)
    this.pendingTools.delete(id)
    const finalContent = toolAcc ? toolAcc + displayContent : displayContent

    // 可折叠 tool（read/grep/glob/ls/semantic_search）：累积内容到折叠组
    const family = groupFamily(name)
    if (canCollapse(family) && this.toolGroupBuffer) {
      const entry = this.toolGroupBuffer.entries[this.toolGroupBuffer.entries.length - 1]
      if (entry && entry.toolName === name) {
        entry.content = finalContent
        entry.lineCount = finalContent.split('\n').length
      }
      // 不单独 commit — 将在 flushToolGroup 时作为组渲染
      return
    }

    // team_orchestrate：把编码串 rivet:team-panel:v1:{...} 解码为 TeamPanel 面板，
    // 而非把裸编码串当工具卡片输出（对齐 Ink decodeTeamPanelModel + TeamPanel）。
    if (name === 'team_orchestrate') {
      const model = decodeTeamPanelModel(finalContent.trim())
      if (model) {
        const panel = formatTeamPanel(model, this.theme, this.columns)
        this.commitAbove(() => {
          this.commit.write({ text: panel.join('\n'), trailingNewline: true })
          this.state.committedCount++
        })
        return
      }
    }

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
      // 块尾空行：与 user/assistant/summary 统一间距契约
      this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
      this.state.committedCount++
    })

    // todo 工具写入后刷新常驻任务面板（canonical 源为 TodoStore）。
    if (name === 'todo') {
      this.refreshTodos()
      this.renderLive()
    }
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

    // Flush 工具折叠组残余
    if (this.toolGroupBuffer) this.flushToolGroup()

    // Flush any pending blocks from the writer, then commit the remaining tail
    await this.blockWriter.flush()
    this.streamRenderer.finalize()
    this.assistantHeaderDone = false

    // ── W3: 累计 usage → cache hit / context% / cost ────────────
    this.accumulateUsage(usage)

    // 兜底刷新任务面板（todo 工具结果未必每轮都到达）
    this.refreshTodos()

    if (isFinal) {
      // Reset state
      this.agentBusy = false
      this.state.thinkingText = ''
      this.state.isStreaming = false
      this.state.isThinking = false
      this.setPhase('idle')
      this.state.thinkStartMs = 0
      // 复位 GlanceBar domain（子代理编排结束 → 回默认天枢）
      this.state.domainGlyph = undefined
      this.state.domainName = undefined

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

  /**
   * 从 onTurnComplete 的 Usage 解析 cache hit / context% / session cost。
   *
   * 关键：agent 传入的 `usage` 已是 `session.getTotalUsage()` 的**累计**快照，
   * 因此这里是 snapshot 赋值而非 `+=`（旧实现每回合把累计值再累加，导致 cost
   * 随回合数指数级膨胀）。真实指标优先由 metricsProvider 提供，此处仅作回退。
   */
  private accumulateUsage(usage: Partial<Usage>): void {
    const input = usage.input_tokens ?? 0
    const output = usage.output_tokens ?? 0
    const cacheRead = usage.cache_read_input_tokens ?? 0
    const cacheCreate = usage.cache_creation_input_tokens ?? 0
    this.totalUsage = { input, output, cacheRead, cacheCreate }

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

  /**
   * Agent 是否在跑（可被打断的窗口）。
   * isStreaming/isThinking 只覆盖「已出 token」之后；agentBusy（submit 即 true）
   * 与 phase!=idle 还覆盖首 token 前、纯工具回合、dedup 缓冲期 —— 那些窗口同样应可打断。
   */
  private isAgentActive(): boolean {
    return this.agentBusy || this.state.isStreaming || this.state.isThinking || this.state.phase !== 'idle'
  }

  private handleAbort(): void {
    // 世代自增：被中断的旧 run 的迟到回调（bridge 捕获旧 gen）将被丢弃
    this._runGen++
    // 中断时若停在审批/意图确认态：解析为拒绝/否决，让 tool-pipeline 的前置 await
    // 立即 settle，并复位输入模式。否则审批/意图态残留——后续按键被当确认解析、
    // 输入框无法使用（这是 abort 中途审批"假死"的一个分支）。
    if (this.approvalPending) this.resolveApproval(false)
    if (this.intentPending) this.resolveIntent('veto')
    // Flush 工具折叠组残余
    if (this.toolGroupBuffer) this.flushToolGroup()
    // 保留 steer 队列：对齐 Ink。用户在卡死期间排队的指引不应因中断而丢失——
    // 下次 submit 会把排队内容归并进新 prompt（见 onSubmit 的 steer 收口）。
    this.streamRenderer.reset()
    this.blockWriter.discard()
    this.assistantHeaderDone = false
    this.pendingTools.clear()
    this.toolAccumulator.clear()
    this.agentBusy = false
    this.state.isStreaming = false
    this.state.isThinking = false
    this.setPhase('idle')
    this.live.clear()
    // 可见的中断提示：让用户确知 run 已被中止（而非无声卡死）
    this.commitAbove(() => {
      this.commit.write({
        text: color('⏹ Interrupted', this.theme.muted),
        trailingNewline: true,
      })
      this.state.committedCount++
    })
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
      lines.push({ text: ` ╰─ [y] approve  [n] deny ─────────────────────────` })
    }

    // 3a. Intent preview prompt (when pending) — 意图闸确认框
    if (this.intentPending) {
      const it = this.intentPending.intent
      const hasAlt = (it.alternatives?.length ?? 0) > 0
      lines.push({ text: ` ╭─ Intent Preview ─────────────────────────────────` })
      lines.push({ text: ` │ ${it.summary}` })
      for (const w of it.warnings ?? []) {
        lines.push({ text: ` │ ⚠ ${w}` })
      }
      for (const alt of it.alternatives ?? []) {
        lines.push({ text: ` │ ↳ ${alt}` })
      }
      const altKey = hasAlt ? '  [a] alternative' : ''
      lines.push({ text: ` ╰─ [y] continue  [n] veto${altKey} ────────────────` })
    }

    // ── 底部 chrome 起点：从此往后（任务面板 + GlanceBar + 输入框 + 提示）是
    //    恒可见的保留区，内容超屏时 LiveEngine 截断的是上方 dynamic 段，
    //    不会裁掉任务面板与输入框。
    const chromeStart = lines.length

    // 3b. 常驻任务面板（todo 列表）——空列表不渲染。
    const taskLines = formatTaskList(this.state.todos, this.theme, { width: this.columns, maxRows: 6 })
    if (taskLines.length > 0) {
      lines.push({ text: '' })
      for (const taskLine of taskLines) lines.push({ text: taskLine })
    }

    // 4. GlanceBar（phase glyph / context% / cache / cost / git branch）
    // 优先用真实指标 provider（main-ansi 读 ctx.session）；无则回退内部估算。
    const phaseInd = phaseIndicator(this.state.phase)
    const metrics = this.metricsProvider?.() ?? null
    let glanceCacheHitRate: number | undefined
    let glanceContextRatio: number | undefined
    let glanceCost: number
    let glanceEstimatedTokens: number | undefined
    let glanceMaxTokens: number | undefined
    if (metrics) {
      glanceCacheHitRate = metrics.cacheHitRate ?? undefined
      glanceContextRatio = metrics.maxTokens > 0 ? Math.min(1, metrics.estimatedTokens / metrics.maxTokens) : undefined
      glanceCost = metrics.cost
      glanceEstimatedTokens = metrics.estimatedTokens
      glanceMaxTokens = metrics.maxTokens
    } else {
      glanceCacheHitRate = this.lastCacheHitRate
      glanceContextRatio = this.lastContextRatio
      glanceCost = this.estimateSessionCost()
    }
    const glanceBar = formatGlanceBar({
      width: this.columns,
      domainGlyph: this.state.domainGlyph,
      domainName: this.state.domainName,
      branch: this.gitBranch,
      phaseGlyph: phaseInd.glyph,
      phaseLabel: phaseInd.label,
      modelName: this.state.modelName,
      cacheHitRate: glanceCacheHitRate,
      contextRatio: glanceContextRatio,
      estimatedTokens: glanceEstimatedTokens,
      maxTokens: glanceMaxTokens,
      cost: glanceCost,
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
        : [`〉 █${color(this.inputLine.placeholder, this.theme.dim)}`]
      if (this.inputLine.vimEnabled && this.inputLine.vimMode === 'normal') {
        lines.push({ text: `-- NORMAL -- ${inputLines[0] ?? ''}` })
        for (const extra of inputLines.slice(1)) lines.push({ text: extra })
      } else {
        for (const inputDisplayLine of inputLines) lines.push({ text: inputDisplayLine })
      }

      // 5b. slash 命令提示（输入以 / 开头且未含空格）
      const inputVal = this.inputLine.value
      if (inputVal.startsWith('/') && !inputVal.includes(' ')) {
        for (const hintLine of formatSlashHint({ input: inputVal, commands: this.slashCommands, selectedIdx: this.slashSelectedIdx }, this.theme)) {
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

    this.live.render(lines, { reservedTail: lines.length - chromeStart })
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
    // 权限 diff 预览：write/edit 审批前渲染变更块
    const diffPreview = formatPermissionDiff({ toolName: name, input, theme: this.theme })
    if (diffPreview) {
      this.commitAbove(() => {
        for (const line of diffPreview) {
          this.commit.write({ text: line, trailingNewline: line === diffPreview[diffPreview.length - 1] })
        }
        this.state.committedCount++
      })
    }
    return new Promise((resolve) => {
      this.approvalPending = { id, name, input, resolve }
      this.input.setMode('approval')
      this.setPhase('waiting')
      this.renderLive()
    })
  }

  private handleIntentPreview(intent: IntentPreview): Promise<IntentPreviewAction> {
    return new Promise((resolve) => {
      this.intentPending = { intent, resolve }
      this.input.setMode('intent')
      this.setPhase('waiting')
      this.renderLive()
    })
  }

  /**
   * 提交 slash 命令：await 外部 handler（SlashRouter）的结果，
   * handler 返回 false（透传命令如 /team、/review、/plan <x>）时把原始输入交给 agent。
   * 这修复了「async handler 一律视为已处理」吞掉透传命令的 bug。
   */
  private async submitSlashCommand(input: string): Promise<void> {
    let handled: boolean
    if (this.slashHandler) {
      try {
        handled = await this.slashHandler(input)
      } catch (err) {
        this.commitStatic(`Error: ${(err as Error).message}`)
        handled = true
      }
    } else {
      handled = this.handleSlashCommand(input)
    }
    if (!handled) {
      this.onSubmitCallback?.(input)
    }
  }

  /** 处理内置斜杠命令（无外部 handler 时的兜底），返回 true 表示已处理 */
  private handleSlashCommand(input: string): boolean {
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
    cockpitSnapshot?: () => CockpitSnapshot
    rewindEntries?: () => RewindData
  }, paletteExec?: (index: number) => void): void {
    this.overlayData = overlayData
    this.paletteExec = paletteExec
    // Pager — page 由 overlayNav 注入（覆盖 provider 的静态 page）
    this.overlay.register('pager', {
      render: (_w, _h) => {
        const data = overlayData?.pagerContent?.() ?? { content: '(no content)', page: 0 }
        return renderPager({ ...data, page: this.overlayNav.pagerPage }, this.columns, this.rows, this.theme)
      },
    })

    // Starmap
    this.overlay.register('starmap', {
      render: (_w, _h) => {
        const data = overlayData?.starmapEntries?.() ?? { entries: [] }
        return renderStarmap(data, this.columns, this.rows, this.theme)
      },
    })

    // Command palette — selectedIndex 由 overlayNav 注入
    this.overlay.register('command-palette', {
      render: (_w, _h) => {
        const data = overlayData?.paletteCommands?.() ?? { commands: [], selectedIndex: 0 }
        return renderCommandPalette({ ...data, selectedIndex: this.overlayNav.paletteIndex }, this.columns, this.rows, this.theme)
      },
    })

    // Cockpit
    this.overlay.register('cockpit', {
      render: (_w, _h) => {
        const data = overlayData?.cockpitSnapshot?.()
        if (!data) return ['Cockpit data not available.']
        return renderCockpit(data, this.columns, this.rows, this.theme)
      },
    })

    // Rewind — selectedIndex 由 overlayNav 注入
    this.overlay.register('rewind', {
      render: (_w, _h) => {
        const data = overlayData?.rewindEntries?.() ?? { entries: [], selectedIndex: 0 }
        return renderRewind({ ...data, selectedIndex: this.overlayNav.rewindIndex }, this.columns, this.rows, this.theme)
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
