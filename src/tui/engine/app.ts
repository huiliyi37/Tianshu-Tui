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
import { ToolGroupController } from './tool-group-controller.js'
import { OverlayController } from './overlay-controller.js'
import { ApprovalIntentController } from './approval-intent-controller.js'
import { MetricsGlanceController } from './metrics-glance-controller.js'
import { StreamRenderController } from './stream-render-controller.js'
import { InputController } from './input-controller.js'
import { color } from './ansi.js'
import { BlockStreamWriter } from '../block-stream-writer.js'
import { SteerBuffer } from '../steer-buffer.js'
import { getTheme, type RivetTheme } from '../theme.js'
import { formatUserMessage } from '../format/user-message.js'
import { formatToolCard, formatToolCardLive, isToolCardTruncated } from '../format/tool-card.js'
import { formatCollapsedGroup, formatCollapsedGroupLive, CollapsedReadSearchBuffer, isCollapsibleTool, type CollapsedReadSearchGroup } from '../format/collapsed-read-search.js'
import { formatPermissionDiff } from '../format/permission-diff.js'
import { formatThinking } from '../format/thinking.js'
import { formatGlanceBar, resolveStarDomainDisplay, resolveStarDomainAccent, formatGlanceLeft, formatGlanceRight, stripAnsiLen } from '../format/glance-bar.js'
import { STAR_DOMAINS } from '../../agent/star-domain.js'
import { formatTaskList } from '../format/task-list.js'
import type { TodoItem } from '../../tools/todo-store.js'
import { formatTeamPanel } from '../format/team-panel.js'
import { formatWorkerFleet } from '../format/worker-fleet.js'
import { decodeTeamPanelModel, overlayFleetStatus, TEAM_PANEL_UI_PREFIX, type TeamPanelModel } from '../team-panel-model.js'
import {
  delegationObjectiveFromInput,
  delegationProfileFromInput,
  domainBadge,
  isDelegationTool,
} from '../format/tool-domain.js'
import { formatSpinnerStatus, formatTurnWorkSummary } from '../format/spinner-status.js'
import { formatSlashHint, slashCompletionTarget, filterSlashCommands, type SlashHintEntry } from '../format/slash-hint.js'
import { extractAtToken, getCompletions, applyCompletion } from '../file-completer.js'
import stringWidth from 'string-width'
import { truncateToDisplayWidth } from '../width.js'
import { appendHistoryAsync, nextHistoryAfterSubmit } from '../history.js'
import { renderPager, renderStarmap, renderCommandPalette, renderChronicle, renderTasks, renderDomainPicker, renderModelPicker, renderThemePicker } from '../format/overlay.js'
import type { PagerData, StarmapData, PaletteData, ChronicleData, TasksData, TasksGroup, TasksWorkerRow, DomainPickerData, ModelPickerData, ThemePickerData } from '../format/overlay.js'
import { renderCockpit } from '../format/cockpit.js'
import type { CockpitSnapshot, Panel } from '../cockpit/types.js'
import { renderRewind, type RewindData } from '../format/rewind.js'
import { renderHistorySearch, type HistorySearchData } from '../format/history-search.js'
import { searchHistory, loadHistory } from '../history.js'

// NOTE: exported for the mid-tui decomposition safety net. These are pure leaf
// helpers slated to move into a TUI format/util module when TuiApp is split;
// `app-core.test.ts` pins their behavior so the extraction stays observably
// identical. (The full class still needs a TTY harness — deferred to that work.)
export function formatElapsedShort(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}

/** Truncate a string (possibly containing ANSI) to fit within maxWidth display columns. */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = stringWidth(ch)
    if (w + cw > maxWidth) break
    out += ch
    w += cw
  }
  return out
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
import type { DelegationActivity } from '../../tools/types.js'
import { FleetRegistry } from '../fleet-registry.js'

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number, isFinal?: boolean) => void
  onError: (error: Error) => void
  onAbort: (reason?: string) => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<ApprovalResult | boolean>
  onCheckpoint?: (hash: string) => void
  onPhaseChange?: (phase: string, detail?: { tool?: string; reason?: string }) => void
  onIntentPreview?: (intent: IntentPreview) => Promise<IntentPreviewAction>
  onSteerDrain?: () => string | null
  /** T4 — structured per-worker delegation status/progress feeding the fleet read model. */
  onDelegationActivity?: (activity: DelegationActivity) => void
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
  /** API 最近一轮返回的真实 prompt_tokens（校准基准）；0 表示尚无数据 */
  lastRealPromptTokens: number
}

/** 指标提供者：返回 null 表示暂无（回退 TUI 内部估算）。 */
export type TuiMetricsProvider = () => TuiMetrics | null

/**
 * 单个工具流式输出累加器的字节上限。超限时保留尾部（live 卡片只展示末尾），
 * 防止超大输出工具（如 cat 100MB 文件逐 chunk 上行）撑爆内存。终态结果
 * 提交到 scrollback 时用完整 result 字符串，不受此 cap 影响。
 */
export { TOOL_ACCUMULATOR_MAX_BYTES, capToolAccumulator } from './tool-accumulator.js'

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
  private get theme(): RivetTheme { return getTheme() }
  private columns: number
  private rows: number
  /** W-B1: tool lifecycle state manager */
  private toolGroupController = new ToolGroupController()
  /** W-B2: overlay navigation + data providers + exec callbacks */
  private overlayController = new OverlayController()
  /** W-B4: approval + intent pending state manager */
  private approvalIntentController = new ApprovalIntentController()
  /** 并行子代理舰队读模型（由 onDelegationActivity 事件流驱动） */
  private fleet = new FleetRegistry()
  /** team_orchestrate 运行中的实时 TeamPanel（计划 DAG，运行态由 fleet 叠加）。
   *  从流式块中拦截的初始编码面板解码而来；终态委派到 scrollback 后清空。 */
  private liveTeamModel: TeamPanelModel | null = null

  // ── W3: 渲染 ticker + 指标 ───────────────────────────────────
  /** W-B3: stream render state manager (ticker/tick/lastActivity/header) */
  private streamRenderController = new StreamRenderController()
  /** W-B6: metrics + glance + domain state manager */
  private metricsGlanceController = new MetricsGlanceController()
  /** todo 列表访问器（main-ansi 读 TodoStore 单例） */
  private todosProvider?: () => TodoItem[]
  /** Block stream writer: chunks streaming text into display-sized blocks */
  private blockWriter: BlockStreamWriter
  /** Write batcher: coalesces render calls into a single LiveEngine.render() */
  private writeBatcher: WriteBatcher
  /** Stream renderer: incremental markdown commit + live tail (W1) */
  private streamRenderer: StreamRenderer

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
  /** 当前会话审批模式（继承自 agent config），供 worker pills badge */
  private _approvalMode: string = 'auto-safe'
  /**
   * Run 世代计数 —— 唯一权威的「当前 run」标识。
   * 每次 abort 自增；被中断的旧 run 的迟到回调（经 bridge 包裹时捕获的旧 gen）
   * 与当前 gen 不符即被丢弃，杜绝旧 run 的 onAbort/onTextDelta 污染新 run 状态。
   */
  private _runGen = 0
  /** Consecutive watchdog auto-continues without intervening progress. Caps the
   *  goal-mode "⟳ Auto-recovering → continue" loop so a genuinely-wedged turn
   *  can't re-abort every hardStallMs and burn budget forever. Reset on any
   *  real turn completion or user submit. */
  private _watchdogAutoContinues = 0
  private static readonly MAX_WATCHDOG_AUTO_CONTINUES = 3

  // ── W4b: 输入辅助（W-B5: fields moved to InputController） ───
  /** W-B5: input state manager (slash/file-completion/history/ctrl+c/esc) */
  private inputController = new InputController()
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
    this.metricsGlanceController.contextWindow = options.contextWindow
    this.metricsGlanceController.gitBranch = options.gitBranch

    // Initialize engines
    this.commit = new CommitEngine({ stdout: options.stdout })
    this.live = new LiveEngine({ stdout: options.stdout, reservedRows: 3, maxRows: 28 })
    this.overlay = new OverlayEngine({
      stdout: options.stdout,
      getSize: () => ({ cols: this.columns, rows: this.rows }),
    })
    this.input = new InputHandler({ stdin: options.stdin, mode: 'input' })
    this.resize = new ResizeHandler({ stdout: options.stdout })
    this.inputController.inputHistory = options.history ?? []
    this.inputLine = new InputLine({
      history: options.history,
      placeholder: '询问任何事，或 / 唤起命令',
      onTabComplete: () => this.handleTabComplete(),
      onSubmit: (text) => {
        const trimmed = text.trim()

        // User-initiated submit is real progress: clear the goal-mode watchdog
        // auto-continue counter so a later legitimate stall gets the full
        // recovery budget again. (The auto-continue path resubmits via
        // onSubmitCallback directly and does NOT pass through here.)
        if (trimmed) this._watchdogAutoContinues = 0

        // 输入历史：会话内更新 + 持久化（queued 与直接 submit 都记录）
        if (trimmed) {
          this.inputController.inputHistory = nextHistoryAfterSubmit(this.inputController.inputHistory, trimmed)
          this.inputLine.setHistory(this.inputController.inputHistory)
          appendHistoryAsync(trimmed).catch(() => { /* 持久化失败静默 */ })
        }

        // W4a: agent 执行中 → 入队（turn 边界 drain 注入）。
        // 同时立即 commit 用户气泡到 scrollback，确保用户始终能看到自己说了什么。
        if (this.agentBusy && trimmed) {
          this.commitUserPrompt(trimmed)
          this.steerBuffer.push(trimmed)
          this.renderLive()
          return
        }

        // 跨 run steer 收口：上一 run 结束（text-only 收尾从不 drain）或
        // busy 闩残留时排队的 guidance 会滞留到这里。若放任不管，它会在
        // 下一次工具回合作为 [User guidance] 注入 —— 旧指令混进新任务上下文。
        // 归并进本次 prompt（排队内容本就是用户意图，按时间序拼在新消息前）。
        // 注意：steer 路径已为每条 queued 消息单独 commit 了用户气泡，
        // 此处不再重复 commit，仅输出合并提示并归并文本。
        let submitText = text
        let steerMerged = false
        if (trimmed && this.steerBuffer.hasPending()) {
          const pending = [...this.steerBuffer.getPending()]
          this.steerBuffer.clear()
          submitText = [...pending, trimmed].join('\n\n')
          steerMerged = true
          this.commitAbove(() => {
            this.commit.write({
              text: color(`↳ ${pending.length} queued message${pending.length > 1 ? 's' : ''} merged into this prompt`, this.theme.muted),
              trailingNewline: true,
            })
            this.state.committedCount++
          })
        }

        // Commit user message to scrollback（steer 已单独 commit 时跳过）
        if (trimmed) {
          if (!steerMerged) {
            this.commitUserPrompt(submitText.trim())
          }
          // 新 run 启动前丢弃上一 run 未 finalize 的流式残留：blockWriter 缓冲
          // 与 streamRenderer pending 若不清，会把上一轮文字追加进新轮输出。
          this.blockWriter.discard()
          this.streamRenderer.reset()
          this.streamRenderController.assistantHeaderDone = false
          this.agentBusy = true
        }
        // Reset turn timer for the new turn
        this.state.turnStartMs = Date.now()
        this.streamRenderController.lastActivityMs = Date.now()
        this.onSubmitCallback?.(submitText)
      },
    })

    // Write batcher: coalesce render calls
    this.writeBatcher = new WriteBatcher(() => this.renderLive())

    // Stream renderer: stable markdown prefix → scrollback, tail → live region
    this.streamRenderer = new StreamRenderer({
      commit: (ansi) => {
        this.commitAbove(() => {
          if (!this.streamRenderController.assistantHeaderDone) {
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
      thinkingExpanded: true,
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
      this.inputController.fileCompletion = null
      this.writeBatcher.schedule()
    })

    // Wire input: character input → inputLine → live region update
    this.input.onAnyKey((key) => {
      // ── Approval mode short-circuit (顶部，先于一切普通输入) ──
      // 审批态只解析审批动作，绝不落入 slash / inputLine —— 杜绝 Enter 双触发
      if (this.input.getMode() === 'approval' && this.approvalIntentController.approvalPending) {
        const c = key.char.toLowerCase()
        if (key.name === 'ctrl_c') {
          this.resolveApproval(false)
          // 继续走下方全局 ctrl_c（abort / exit）
        } else {
          if (key.name === 'return' || c === 'y') this.resolveApproval({ approved: true })
          else if (key.name === 'escape' || c === 'n') this.resolveApproval(false)
          else if (c === 'e') {
            // Enter edit mode — populate input line with formatted JSON
            this.approvalIntentController.approvalEditMode = true
            this.approvalIntentController.approvalEditError = ''
            this.inputLine.setValue(JSON.stringify(this.approvalIntentController.approvalPending.input, null, 2))
            this.input.setMode('input')
            this.renderLive()
          }
          // 其余按键在审批态一律吞掉，不污染输入框。
          return
        }
      }

      // ── Intent preview mode short-circuit ──
      // 意图闸是「先确认再动手」的安全机制，旧实现 onIntentPreview 永远 'continue'
      // 等于旁路了这道闸。这里把按键解析成 IntentPreviewAction，绝不落入普通输入。
      if (this.input.getMode() === 'intent' && this.approvalIntentController.intentPending) {
        const c = key.char.toLowerCase()
        const hasAlt = (this.approvalIntentController.intentPending.intent.alternatives?.length ?? 0) > 0
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

      // ── Approval edit mode short-circuit ──
      // 编辑工具入参模式：Enter 解析 JSON → approve with editedInput，
      // Esc 回到审批 y/n 提示。其余键落入 InputLine 正常编辑。
      if (this.approvalIntentController.approvalEditMode && this.approvalIntentController.approvalPending) {
        if (key.name === 'ctrl_c') {
          this.resolveApproval(false)
          this.approvalIntentController.approvalEditMode = false
          this.approvalIntentController.approvalEditError = ''
          // 继续走下方全局 ctrl_c（abort / exit）
        } else if (key.name === 'escape') {
          // Back to approval mode
          this.approvalIntentController.approvalEditMode = false
          this.approvalIntentController.approvalEditError = ''
          this.inputLine.setValue('')
          this.input.setMode('approval')
          this.renderLive()
          return
        } else if (key.name === 'return') {
          // Try to parse edited JSON
          try {
            const edited = JSON.parse(this.inputLine.value)
            this.approvalIntentController.approvalEditMode = false
            this.approvalIntentController.approvalEditError = ''
            this.inputLine.setValue('')
            this.resolveApproval({ approved: true, editedInput: edited })
          } catch (err) {
            this.approvalIntentController.approvalEditError = `Invalid JSON: ${(err as Error).message}`
            this.renderLive()
          }
          return
        }
        // All other keys (chars, arrows, backspace, etc.) fall through to InputLine
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
        } else if (this.inputController.ctrlCPendingSince > 0) {
          // Second Ctrl+C within window → exit
          this.inputController.ctrlCPendingSince = 0
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
          this.inputController.ctrlCPendingSince = Date.now()
          this.renderLive()
          setTimeout(() => { this.inputController.ctrlCPendingSince = 0 }, 2000)
        }
        return
      }
      if (key.name === 'escape' && key.ctrl) {
        // Ctrl+Esc → 激活命令面板
        this.overlayController.resetNav()
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
          // Idle: double-ESC within 400ms on empty input → rewind overlay
          const now = Date.now()
          if (this.inputLine.value.trim()) {
            // Has text: ESC clears input (like Claude Code)
            this.inputLine.setValue('')
            this.renderLive()
          } else if (now - this.inputController.lastEscAt < 400) {
            // Double-ESC → rewind
            this.inputController.lastEscAt = 0
            this.overlayController.resetNav()
            this.overlay.activate('rewind')
            this.renderLive()
          } else {
            // First ESC — record timestamp
            this.inputController.lastEscAt = now
          }
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
      if (key.name === 'ctrl_r') {
        if (!this.isAgentActive()) {
          this.overlayController.resetNav()
          this.overlay.activate('history-search')
        }
        return
      }
      // ── Slash command handling ──────────────────────────────
      const inputVal = this.inputLine.value
      if (inputVal.startsWith('/')) {
        // ↑↓ 选择仅对无参数命令生效（Tab 补全同理）
        if (!inputVal.includes(' ')) {
          const filtered = filterSlashCommands(this.inputController.slashCommands, inputVal.slice(1))
          if (key.name === 'up' && filtered.length > 0) {
            this.inputController.slashSelectedIdx = (this.inputController.slashSelectedIdx - 1 + filtered.length) % filtered.length
            this.renderLive()
            return
          }
          if (key.name === 'down' && filtered.length > 0) {
            this.inputController.slashSelectedIdx = (this.inputController.slashSelectedIdx + 1) % filtered.length
            this.renderLive()
            return
          }
          // Tab 在 inputLine.handleKey 里走 'tab' 事件 → handleTabComplete，无需在此处理
        }
        if (key.name === 'return') {
          // 先清空输入框，再异步处理（await handler 结果决定是否透传 agent）
          this.inputLine.setValue('')
          this.inputController.slashSelectedIdx = 0
          void this.submitSlashCommand(inputVal)
          return
        }
      } else {
        this.inputController.slashSelectedIdx = 0
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
        this.inputController.fileCompletion = null
        // 普通文本输入重置 slash 选中项（避免选了第 3 项又打字导致选中越界）
        this.inputController.slashSelectedIdx = 0
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
      onAbort: (reason) => this.handleAbort(reason),
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
      onDelegationActivity: (activity) => this.handleDelegationActivity(activity),
    }

    // 审批按键统一在 onAnyKey 顶部短路处理（见上），不再注册 mode-bound 处理器，
    // 避免与 onAnyKey 双触发。
  }

  // ── Approval resolution ─────────────────────────────────────

  private resolveApproval(result: ApprovalResult | boolean): void {
    if (!this.approvalIntentController.approvalPending) return
    this.approvalIntentController.approvalPending.resolve(result)
    this.approvalIntentController.approvalPending = null
    this.input.setMode('input')
    this.renderLive()
  }

  // ── Intent preview resolution ───────────────────────────────

  private resolveIntent(action: IntentPreviewAction): void {
    if (!this.approvalIntentController.intentPending) return
    this.approvalIntentController.intentPending.resolve(action)
    this.approvalIntentController.intentPending = null
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

  /**
   * 拒绝当前提交：撤销 submitSlashCommand 已设置的 agentBusy。
   * main.ts 在 resolveAppPromptInput 返回 null 时调用，避免 agentBusy 卡死。
   */
  rejectSubmit(): void {
    this.agentBusy = false
    this.setPhase('idle')
    this.renderLive()
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

  /** 切换 vim 键位，返回切换后的状态（供 /vim 命令）。 */
  toggleVim(): boolean {
    const next = !this.inputLine.vimEnabled
    this.inputLine.setVimEnabled(next)
    this.renderLive()
    return next
  }

  /** 当前是否启用 vim 键位。 */
  isVimEnabled(): boolean {
    return this.inputLine.vimEnabled
  }

  /** 设置 cockpit 聚焦面板（供 /cockpit <panel>）。激活时即时重渲染。 */
  setCockpitPanel(panel: Panel): void {
    this.overlayController.setCockpitPanel(panel)
    if (this.overlay.activeId() === 'cockpit') this.overlay.rerender()
  }

  /** 当前 cockpit 聚焦面板。 */
  getCockpitPanel(): Panel {
    return this.overlayController.getCockpitPanel()
  }

  /** 激活 overlay */
  activateOverlay(id: string): boolean {
    // 在激活任何全屏覆盖层之前，必须先干净地清除主屏幕底部的 live region（输入框和 GlanceBar），
    // 避免退出覆盖层后主屏幕残留旧的 live region 导致重影和重复行。
    this.live.clear()

    switch (id) {
      case 'pager':
      case 'starmap':
      case 'command-palette':
      case 'cockpit':
      case 'rewind':
      case 'history-search':
      case 'chronicle':
      case 'tasks': {
        // 复位导航状态，避免上次的翻页/选中残留到新 overlay
        this.overlayController.resetNav()
        return this.overlay.activate(id)
      }
      case 'domain-picker': {
        this.overlayController.resetNav()
        // 光标初始定位到当前生效星域，便于确认/切换。
        const entries = this.overlayController.getData()?.domainPickerData?.().entries ?? []
        const curIdx = entries.findIndex(e => e.current)
        if (curIdx >= 0) this.overlayController.nav().domainPickerIndex = curIdx
        return this.overlay.activate(id)
      }
      case 'model-picker': {
        this.overlayController.resetNav()
        const entries = this.overlayController.getData()?.modelPickerData?.().entries ?? []
        const curIdx = entries.findIndex(e => e.current)
        if (curIdx >= 0) this.overlayController.nav().modelPickerIndex = curIdx
        return this.overlay.activate(id)
      }
      case 'theme-picker': {
        this.overlayController.resetNav()
        const entries = this.overlayController.getData()?.themePickerData?.().entries ?? []
        const curIdx = entries.findIndex(e => e.current)
        if (curIdx >= 0) this.overlayController.nav().themePickerIndex = curIdx
        return this.overlay.activate(id)
      }
      default:
        return false
    }
  }

  /** 停用 overlay */
  deactivateOverlay(): void {
    this.overlay.deactivate()
    // 退出覆盖层后，由于我们在激活时已经干净地清除了旧的 live region，
    // 此时主屏幕底部是完全干净的，且光标也处于正确的起始行。
    // 我们只需直接调用 renderLive()，它会以 append 模式在最底部重新绘制全新的 live region。
    this.renderLive()
  }

  /** 返回 scrollback 完整文本（供 pager overlay 读取） */
  getScrollbackContent(): string {
    return this.commit.getContent()
  }

  /** 返回当前活跃星域名称（供 starmap overlay 高亮） */
  getDomainName(): string | undefined {
    return this.state.domainName
  }

  /**
   * Get running delegation workers for the `/tasks` overlay.
   * Reads per-worker state from the fleet read model (fed by onDelegationActivity),
   * grouped by the spawning delegation tool. Falls back to an empty fleet when no
   * delegation is in flight.
   */
  getRunningWorkers(): TasksData {
    const now = Date.now()
    const active = this.fleet.getActiveWorkers(now)
    const byParent = new Map<string, TasksWorkerRow[]>()
    for (const w of active) {
      const arr = byParent.get(w.parentToolId) ?? []
      arr.push({
        shortLabel: w.shortLabel,
        profile: w.profile,
        status: w.status,
        activity: w.activity,
        elapsedMs: w.elapsedMs,
      })
      byParent.set(w.parentToolId, arr)
    }
    const groups: TasksGroup[] = []
    for (const [parentToolId, workers] of byParent) {
      const p = this.fleet.getGroupProgress(parentToolId)
      groups.push({ parentToolId, total: p.total, done: p.done, failed: p.failed, running: p.running, workers })
    }
    return { groups }
  }

  /**
   * Overlay 导航键处理。返回 true 表示已消费（调用方应 return）。
   * - pager：j/↓/PgDn 下翻，k/↑/PgUp 上翻，Home/End 首末页，q 关闭
   * - command-palette：↑/↓ 移动选中，Enter 执行并关闭，q 关闭
   * - 其它 overlay（starmap/chronicle）：仅 q 关闭（无内部导航）
   * Esc/Ctrl+C 不在此消费，留给全局兜底统一关闭。
   */
  private handleOverlayKey(key: { name: string; char: string; ctrl?: boolean; meta?: boolean; shift?: boolean }): boolean {
    const id = this.overlay.activeId()
    const c = key.char.toLowerCase()
    const isSearch = id === 'command-palette' || id === 'history-search'

    // Tab switcher between domain-picker, model-picker, and theme-picker
    const tabs = ['domain-picker', 'model-picker', 'theme-picker']
    if (id && tabs.includes(id)) {
      if (key.name === 'right' || (key.name === 'tab' && !key.shift)) {
        const curIdx = tabs.indexOf(id)
        const nextId = tabs[(curIdx + 1) % tabs.length]!
        this.activateOverlay(nextId)
        return true
      }
      if (key.name === 'left' || (key.name === 'tab' && key.shift)) {
        const curIdx = tabs.indexOf(id)
        const nextId = tabs[(curIdx - 1 + tabs.length) % tabs.length]!
        this.activateOverlay(nextId)
        return true
      }
    }

    // q 关闭非搜索型 overlay；搜索型（palette/history）里 q 是普通查询字符，仅 Esc 关闭。
    if (c === 'q' && !isSearch) {
      this.deactivateOverlay()
      return true
    }

    if (id === 'pager') {
      const total = this.pagerTotalPages()
      const cur = this.overlayController.nav().pagerPage
      let next = cur
      if (key.name === 'down' || key.name === 'pagedown' || c === 'j') next = cur + 1
      else if (key.name === 'up' || key.name === 'pageup' || c === 'k') next = cur - 1
      else if (key.name === 'home') next = 0
      else if (key.name === 'end') next = total - 1
      else return false
      next = Math.max(0, Math.min(total - 1, next))
      if (next !== cur) {
        this.overlayController.nav().pagerPage = next
        this.overlay.rerender()
      }
      return true
    }

    if (id === 'command-palette') {
      const count = this.overlayController.getData()?.paletteCommands?.().commands.length ?? 0
      const cur = this.overlayController.nav().paletteIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().paletteIndex = (cur + 1) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().paletteIndex = (cur - 1 + count) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        if (count > 0 && this.overlayController.getPaletteExec()) {
          const idx = cur
          this.deactivateOverlay()
          this.overlayController.getPaletteExec()?.(idx)
        } else {
          this.deactivateOverlay()
        }
        return true
      }
      if (key.name === 'backspace') { this.editOverlayQuery(null); return true }
      if (this.isPrintableKey(key)) { this.editOverlayQuery(key.char); return true }
      return false
    }

    if (id === 'rewind') {
      const count = this.overlayController.getData()?.rewindEntries?.().entries.length ?? 0
      const cur = this.overlayController.nav().rewindIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().rewindIndex = Math.min(cur + 1, count - 1); this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().rewindIndex = Math.max(cur - 1, 0); this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        if (count > 0) {
          const entry = this.overlayController.getData()?.rewindEntries?.().entries[cur]
          this.deactivateOverlay()
          if (entry) {
            if (this.overlayController.getRewindExec()) {
              this.overlayController.getRewindExec()?.(entry.content)
            } else {
              // Fallback: just populate input (old behavior)
              this.setInput(entry.content)
            }
          }
        } else {
          this.deactivateOverlay()
        }
        return true
      }
      return false
    }

    if (id === 'history-search') {
      const count = this.overlayController.getData()?.historySearchData?.().entries.length ?? 0
      const cur = this.overlayController.nav().historySearchIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().historySearchIndex = Math.min(cur + 1, count - 1); this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().historySearchIndex = Math.max(cur - 1, 0); this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        if (count > 0) {
          const entry = this.overlayController.getData()?.historySearchData?.().entries[cur]
          this.deactivateOverlay()
          if (entry) this.setInput(entry)
        } else {
          this.deactivateOverlay()
        }
        return true
      }
      if (key.name === 'backspace') { this.editOverlayQuery(null); return true }
      if (this.isPrintableKey(key)) { this.editOverlayQuery(key.char); return true }
      return false
    }

    if (id === 'chronicle') {
      const count = this.overlayController.getData()?.chronicleEntries?.().entries.length ?? 0
      const cur = this.overlayController.nav().chronicleIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().chronicleIndex = Math.min(cur + 1, count - 1); this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().chronicleIndex = Math.max(cur - 1, 0); this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        const entry = count > 0 ? this.overlayController.getData()?.chronicleEntries?.().entries[cur] : undefined
        this.deactivateOverlay()
        if (entry?.id && this.overlayController.getChronicleExec()) this.overlayController.getChronicleExec()?.(entry.id)
        return true
      }
      return false
    }

    if (id === 'domain-picker') {
      const count = this.overlayController.getData()?.domainPickerData?.().entries.length ?? 0
      const cur = this.overlayController.nav().domainPickerIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().domainPickerIndex = (cur + 1) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().domainPickerIndex = (cur - 1 + count) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        const entry = count > 0 ? this.overlayController.getData()?.domainPickerData?.().entries[cur] : undefined
        this.deactivateOverlay()
        if (entry && this.overlayController.getDomainPickerExec()) this.overlayController.getDomainPickerExec()?.(entry.key)
        return true
      }
      return false
    }

    if (id === 'model-picker') {
      const count = this.overlayController.getData()?.modelPickerData?.().entries.length ?? 0
      const cur = this.overlayController.nav().modelPickerIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().modelPickerIndex = (cur + 1) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().modelPickerIndex = (cur - 1 + count) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        const entry = count > 0 ? this.overlayController.getData()?.modelPickerData?.().entries[cur] : undefined
        this.deactivateOverlay()
        if (entry && this.overlayController.getModelPickerExec()) this.overlayController.getModelPickerExec()?.(entry.id)
        return true
      }
      return false
    }

    if (id === 'theme-picker') {
      const count = this.overlayController.getData()?.themePickerData?.().entries.length ?? 0
      const cur = this.overlayController.nav().themePickerIndex
      if (key.name === 'down') {
        if (count > 0) { this.overlayController.nav().themePickerIndex = (cur + 1) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'up') {
        if (count > 0) { this.overlayController.nav().themePickerIndex = (cur - 1 + count) % count; this.overlay.rerender() }
        return true
      }
      if (key.name === 'return') {
        const entry = count > 0 ? this.overlayController.getData()?.themePickerData?.().entries[cur] : undefined
        this.deactivateOverlay()
        if (entry && this.overlayController.getThemePickerExec()) this.overlayController.getThemePickerExec()?.(entry.name)
        return true
      }
      return false
    }

    return false
  }

  /** 当前搜索型 overlay 的实时查询串（command-palette / history-search）。
   *  直接返回 overlayNav.query（不按 active overlay 门控）：activateOverlay 每次都把
   *  query 复位为 ''，非搜索 overlay 因此读到空串；而 paletteExec 在 deactivateOverlay
   *  之后、下次 activate 之前执行，此时 query 仍是用户输入值 → 过滤索引与 display 一致。 */
  getOverlayQuery(): string {
    return this.overlayController.getQuery()
  }

  /** 判断按键是否为可打印字符（用于搜索型 overlay 的字符输入）。 */
  private isPrintableKey(key: { name: string; char: string; ctrl?: boolean; meta?: boolean }): boolean {
    if (key.ctrl || key.meta) return false
    const ch = key.char
    return !!ch && ch.length === 1 && ch.charCodeAt(0) >= 0x20 && ch !== '\x7f'
  }

  /** 编辑搜索型 overlay 的 query：传字符追加，传 null 退格删一字符。每次编辑复位选中索引。 */
  private editOverlayQuery(ch: string | null): void {
    this.overlayController.editQuery(ch)
    this.overlay.rerender()
  }

  /** pager 总页数（与 renderPager 同口径：pageSize = rows - 4）。 */
  private pagerTotalPages(): number {
    const content = this.overlayController.getData()?.pagerContent?.().content ?? ''
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
    if (this.streamRenderController.ticker) {
      clearInterval(this.streamRenderController.ticker)
      this.streamRenderController.ticker = null
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
   * Force a clean full redraw — physically erase the live region then repaint.
   * Use after any state change that alters GlanceBar layout (theme color codes,
   * domain name, model name) to prevent ghost rendering from stale lineCache.
   */
  forceRedraw(): void {
    // 主题/域/模型变更会改变颜色码，记忆化的 thinking 行需失效以用新主题重算。
    this.thinkingLinesMemo = null
    this.live.clear()
    this.renderLive()
  }

  /**
   * Submit text directly to the agent — resolves the ecosystem workflow path
   * where SlashRouter already has a resolved prompt from resolveAppPromptInput.
   * Commits the user prompt to scrollback and fires onSubmitCallback.
   */
  submitText(text: string): void {
    this.commitUserPrompt(text)
    this.blockWriter.discard()
    this.streamRenderer.reset()
    this.streamRenderController.assistantHeaderDone = false
    this.agentBusy = true
    this.state.turnStartMs = Date.now()
    this.streamRenderController.lastActivityMs = Date.now()
    this.onSubmitCallback?.(text)
  }

  /**
   * Mid-stream commit 协议：先擦除 live region（光标停在其起始行），
   * 写入 scrollback 内容，再重绘 live region。
   * 不走该协议的裸 commit 会留下 ghost 行 / 覆盖已提交文本。
   */
  private commitAbove(write: () => void): void {
    // H3：clearForCommit + commit + renderLive 三段写入用 cork/uncork 合并为一次 flush，
    // 减少 syscall 与中间态可见（提交时的瞬时闪烁）。协议顺序不变。
    const s = this.stdout as WriteStream & { cork?: () => void; uncork?: () => void }
    const canCork = typeof s.cork === 'function' && typeof s.uncork === 'function'
    if (canCork) s.cork()
    try {
      this.live.clearForCommit()
      write()
      this.renderLive()
    } finally {
      if (canCork) s.uncork!()
    }
  }

  /**
   * 统一用户消息提交入口。在 scrollback 中写入 ▍ You 气泡。
   * 所有 submit 路径（idle / slash passthrough / steer）共用此入口，
   * 确保用户始终能在终端历史中看到自己输入的内容。
   */
  private commitUserPrompt(content: string): void {
    this.commitAbove(() => {
      const formatted = formatUserMessage({
        content: content.trim(),
        width: this.columns,
      }, this.theme)
      this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
      this.state.committedCount++
    })
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
    if (active && !this.streamRenderController.ticker) {
      this.streamRenderController.ticker = setInterval(() => {
        this.streamRenderController.tick++
        if (this.metricsGlanceController.domainSyncProvider && this.streamRenderController.tick % 8 === 0) {
          this.syncSessionStarDomainFromAgent()
        }
        // Keep todo panel in sync during long agent runs (not just on tool result / turn boundary).
        this.refreshTodos()
        // H4：ticker 经 WriteBatcher 调度而非直接 renderLive，与流式 chunk 的渲染在
        // 同一 microtask 合并为单帧；配合 H2 无变化短路，spinner 空转 tick 变廉价。
        this.writeBatcher.schedule()
      }, 120)
      this.streamRenderController.ticker.unref?.()
    } else if (!active && this.streamRenderController.ticker) {
      clearInterval(this.streamRenderController.ticker)
      this.streamRenderController.ticker = null
    }
  }

  /** 记录 token/输出活动时间（spinner stall 检测） */
  private markActivity(): void {
    this.streamRenderController.lastActivityMs = Date.now()
  }

  // ── W4b: 输入辅助 ────────────────────────────────────────────

  /** 注入 slash 命令列表（main-ansi 启动时调用） */
  setSlashCommands(commands: SlashHintEntry[]): void {
    this.inputController.slashCommands = commands
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
      const target = slashCompletionTarget(value, this.inputController.slashCommands, this.inputController.slashSelectedIdx)
      if (target && target !== value) {
        this.inputLine.setValue(`${target} `)
        this.inputController.slashSelectedIdx = 0
        return true
      }
      return false
    }

    // @ 文件补全（Tab 循环候选）
    if (this.inputController.fileCompletion) {
      const fc = this.inputController.fileCompletion
      fc.idx = (fc.idx + 1) % fc.candidates.length
      const applied = applyCompletion(fc.baseText, fc.baseCursor, fc.candidates[fc.idx]!)
      this.inputLine.setValue(applied.text, applied.cursor)
      return true
    }

    const token = extractAtToken(value, cursor)
    if (token === null) return false
    const candidates = getCompletions(token, process.cwd(), 8)
    if (candidates.length === 0) return false

    this.inputController.fileCompletion = { baseText: value, baseCursor: cursor, candidates, idx: 0 }
    const applied = applyCompletion(value, cursor, candidates[0]!)
    this.inputLine.setValue(applied.text, applied.cursor)
    if (candidates.length === 1) {
      this.inputController.fileCompletion = null // 唯一候选，无需循环
    }
    return true
  }

  /** Commit `▍ Rivet` 标签行（每段 assistant 流式输出一次） */
  private commitAssistantHeader(): void {
    this.commit.write({
      text: `${color('▍', this.theme.assistantColor, { bold: true })} ${color('Rivet', this.theme.assistantColor)}`,
    })
    this.streamRenderController.assistantHeaderDone = true
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
    if (contextWindow !== undefined) this.metricsGlanceController.contextWindow = contextWindow
    this.forceRedraw()
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
    this.metricsGlanceController.metricsProvider = provider
  }

  /** 设置当前审批模式（供 worker pills 显示 badge） */
  setApprovalMode(mode: string): void {
    this._approvalMode = mode
  }

  /**
   * 设置会话星域显示（/domain 切换 → GlanceBar）。
   * undefined 表示 auto/off/未设定，GlanceBar 回退默认「天枢」。
   */
  setSessionStarDomain(domainName: string | undefined): void {
    this.metricsGlanceController.sessionStarDomainName = domainName
    if (!this.metricsGlanceController.delegationDomainOverride) {
      this.applyGlanceDomainDisplay()
    }
    this.forceRedraw()
  }

  /** 注册 agent 星域同步（streaming ticker ~1Hz 读取 getSessionDomain） */
  setDomainSyncProvider(provider: () => string | undefined): void {
    this.metricsGlanceController.domainSyncProvider = provider
  }

  private applyGlanceDomainDisplay(): void {
    if (this.metricsGlanceController.delegationDomainOverride) {
      this.state.domainGlyph = this.metricsGlanceController.delegationDomainOverride.glyph
      this.state.domainName = this.metricsGlanceController.delegationDomainOverride.name
      return
    }
    const display = resolveStarDomainDisplay(this.metricsGlanceController.sessionStarDomainName)
    if (display) {
      this.state.domainGlyph = display.glyph
      this.state.domainName = display.name
    } else {
      this.state.domainGlyph = undefined
      this.state.domainName = undefined
    }
  }

  private syncSessionStarDomainFromAgent(): void {
    if (!this.metricsGlanceController.domainSyncProvider) return
    const next = this.metricsGlanceController.domainSyncProvider()
    if (next === this.metricsGlanceController.sessionStarDomainName) return
    this.metricsGlanceController.sessionStarDomainName = next
    if (!this.metricsGlanceController.delegationDomainOverride) {
      this.applyGlanceDomainDisplay()
    }
  }

  /**
   * 读取当前真实指标快照（与 GlanceBar 同源）。无 provider 时返回 null。
   * 供 SlashRouter 让 /cost、maxTokens 等命令读到与 GlanceBar 一致的真实值，
   * 不再写死 cost: 0 或取 models[0]（非当前模型）。
   */
  getMetrics(): TuiMetrics | null {
    return this.metricsGlanceController.metricsProvider?.() ?? null
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

  // ── Approval state (W-B4: fields moved to ApprovalIntentController) ───

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
    this.toolGroupController.setPending(id, { name, input, startMs: Date.now(), _approvalMode: this._approvalMode })
    // 子代理编排（delegate_* / team_orchestrate）切 GlanceBar domain 到天机。
    if (isDelegationTool(name)) {
      const badge = domainBadge(name)
      if (badge) {
        this.metricsGlanceController.delegationDomainOverride = { glyph: badge.glyph, name: badge.name }
        this.state.domainGlyph = badge.glyph
        this.state.domainName = badge.name
      }
    }

    // 工具折叠组：collapsible → push entry；non-collapsible → 先 flush 再单独走 tool card
    if (isCollapsibleTool(name)) {
      this.toolGroupController.pushUse(id, name, input)
    } else {
      if (this.toolGroupController.isActiveGroup()) this.flushToolGroup()
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
    const group = this.toolGroupController.flushGroup()
    if (!group || group.entries.length === 0) return
    // 记录最近 flush 的组供 ctrl+o 展开
    this.toolGroupController.flushGroup()
    const formatted = formatCollapsedGroup({ group, theme: this.theme })
    this.commitAbove(() => {
      this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
      this.state.committedCount++
    })
  }

  /**
   * T4 — 结构化 per-worker 委派活动 → 舰队读模型。
   * 仅更新读模型并安排一次合并渲染（live 区的 worker 面板 / `/tasks` overlay
   * 据此实时刷新）。终态清理在委派工具 result 到达时统一处理。
   */
  private handleDelegationActivity(activity: DelegationActivity): void {
    this.fleet.apply(activity)
    this.markActivity()
    this.writeBatcher.schedule()
  }

  /**
   * 将 team_orchestrate 的静态计划面板叠加运行态：依据 fleet 中在跑 worker 的
   * workOrderId（"team:T1" / "wo_team:T1"）反查 task id，把对应 waiting 任务标 running。
   * 终态任务（在 fleet 已无活跃记录）保持 waiting，待终态面板权威覆盖。
   */
  private teamModelWithLiveStatus(model: TeamPanelModel): TeamPanelModel {
    // P5: overlay full live fleet status (running/done/failed + elapsed/activity +
    // dependency-unlock cue) from all observed workers, not just running task ids.
    return overlayFleetStatus(model, this.fleet.getWorkers())
  }

  private handleToolResult(id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string): void {
    const displayContent = uiContent ?? result

    // Streaming chunk mode: isError === undefined means intermediate update
    if (isError === undefined) {
      // team_orchestrate fleet viz: the orchestrator streams an initial encoded
      // TeamPanel (all-waiting DAG) before dispatch. Intercept it into liveTeamModel
      // and DO NOT accumulate — otherwise it would double-decode at terminal
      // (indexOf would hit this stale panel before the real one) and leak the raw
      // encoded string into the live tool tail.
      if (name === 'team_orchestrate' && result.includes(TEAM_PANEL_UI_PREFIX)) {
        const model = decodeTeamPanelModel(result)
        if (model) {
          this.liveTeamModel = model
          this.markActivity()
          this.writeBatcher.schedule()
          return
        }
      }
      // Accumulate for live tool card display — show last lines in live region
      const toolAcc = this.toolGroupController.getAccumulated(id) ?? ''
      this.toolGroupController.accumulate(id, result)
      this.markActivity()
      // 经 WriteBatcher 合并：长输出工具（bash/test）逐 chunk 上行，旧实现每 chunk
      // 直接 renderLive() 全区域重绘。与正文/思考流同口径合并到 microtask。
      this.writeBatcher.schedule()
      return
    }

    // Terminal result: commit to scrollback
    const toolAcc = this.toolGroupController.getAccumulated(id)
    this.toolGroupController.deleteAccumulated(id)
    const meta = this.toolGroupController.getPending(id)
    this.toolGroupController.deletePending(id)
    // 委派工具终态：清理该组在舰队读模型中的 worker 记录（终态摘要已通过
    // onDelegationActivity 到达，面板转入 scrollback 后无需常驻 live 区）。
    if (meta && isDelegationTool(meta.name)) {
      this.fleet.clearGroup(id)
    }
    const finalContent = toolAcc ? toolAcc + displayContent : displayContent

    // 可折叠 tool（read/grep/glob/repo_map 等探索型）：按 toolUseId 绑定结果到折叠组
    if (isCollapsibleTool(name)) {
      // G4 修复：buffer 已被 flush（如 write 打断），迟到 result 自动开新组
      if (!this.toolGroupController.isActiveGroup()) {
        this.toolGroupController.pushUse(id, name, meta?.input ?? {})
      }
      this.toolGroupController.attachResult(id, finalContent, isError)
      // 不单独 commit — 将在 flushToolGroup 时作为组渲染
      return
    }

    // team_orchestrate：把编码串 rivet:team-panel:v1:{...} 解码为 TeamPanel 面板，
    // 而非把裸编码串当工具卡片输出（对齐 Ink decodeTeamPanelModel + TeamPanel）。
    if (name === 'team_orchestrate') {
      // Live panel is being committed to scrollback — drop the in-flight overlay.
      this.liveTeamModel = null
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
      this.toolGroupController.setLastTruncatedTool({
        toolName: name,
        content: finalContent,
        isError,
        rawPath,
        toolInput: meta?.input,
      })
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

  /** ctrl+o：展开最近被截断的工具结果或折叠组 */
  private expandLastTruncatedTool(): void {
    // 优先展开折叠组
    const collapsed = this.toolGroupController.getLastCollapsedGroup()
    if (collapsed) {
      const g = collapsed
      this.toolGroupController.clearLastCollapsedGroup()
      const formatted = formatCollapsedGroup({ group: g, expanded: true, theme: this.theme })
      this.commitAbove(() => {
        this.commit.write({ text: formatted.join('\n'), trailingNewline: true })
        this.state.committedCount++
      })
      return
    }
    // 回退：展开单个截断工具卡片
    const t = this.toolGroupController.getLastTruncatedTool()
    if (!t) return
    this.toolGroupController.clearLastTruncatedTool()
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

    // A completed turn (even intermediate) is forward progress: the stream
    // produced output, so the prior boundary stall cleared. Reset the goal-mode
    // watchdog auto-continue counter to restore the full recovery budget.
    this._watchdogAutoContinues = 0

    // Flush 工具折叠组残余
    if (this.toolGroupController.isActiveGroup()) this.flushToolGroup()

    // Flush any pending blocks from the writer, then commit the remaining tail
    await this.blockWriter.flush()
    this.streamRenderer.finalize()
    this.streamRenderController.assistantHeaderDone = false

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
      // 清除委派 override，恢复 /domain 设定的会话星域
      this.metricsGlanceController.delegationDomainOverride = undefined
      this.applyGlanceDomainDisplay()

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
      this.renderLive()
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
    this.metricsGlanceController.totalUsage = { input, output, cacheRead, cacheCreate }

    if (input > 0) {
      this.metricsGlanceController.lastCacheHitRate = Math.min(1, cacheRead / input)
    }
    if (this.metricsGlanceController.contextWindow && this.metricsGlanceController.contextWindow > 0 && input > 0) {
      this.metricsGlanceController.lastContextRatio = Math.min(1, (input + output) / this.metricsGlanceController.contextWindow)
    }
  }

  /** 估算累计费用（对齐 app.tsx 的近似定价：normal $1/M、cache $0.1/M、out $4/M） */
  private estimateSessionCost(): number {
    const normalInput = Math.max(0, this.metricsGlanceController.totalUsage.input - this.metricsGlanceController.totalUsage.cacheRead)
    return (normalInput * 1 + this.metricsGlanceController.totalUsage.cacheRead * 0.1 + this.metricsGlanceController.totalUsage.output * 4) / 1_000_000
  }

  private handleError(error: Error): void {
    this.agentBusy = false
    this.setPhase('idle')
    this.state.isStreaming = false
    this.state.isThinking = false
    // 与 abort 同口径回收 run 本地状态：provider 在工具/委派回合中报错走 onError，
    // 此时 pendingTools/toolAccumulator 可能持有半成品数据。只清 fleet 而漏清这两者，
    // 下一轮会读到上轮孤儿条目（live 区显示已死工具卡片、累加器跨 run 污染）。
    this.resetRunLocalState()
    this.commitAbove(() => {
      this.commit.write({
        text: `Error: ${error.message}`,
        trailingNewline: true,
      })
    })
  }

  /**
   * 统一的 run 本地状态回收：abort 与 error 两条收尾路径共用。
   *
   * 清四项随 run 存亡的本地状态：pendingTools（进行中工具元数据）、
   * toolAccumulator（流式工具输出累加）、fleet（舰队读模型）、liveTeamModel
   * （运行态 TeamPanel）。
   *
   * 为什么 handleError 必须与 handleAbort 同口径：provider 在委派/工具回合中
   * 报错走 onError（非 onAbort），此时 pendingTools/toolAccumulator 可能持有
   * 进行中工具的半成品数据。若只回收 fleet 而漏清这两个 Map，下一轮 run 会读到
   * 上一轮的孤儿条目（live 区显示已死的工具卡片、toolAccumulator 累加跨 run 污染）。
   */
  private resetRunLocalState(): void {
    this.toolGroupController.clear()
    this.fleet.clear()
    this.liveTeamModel = null
  }

  /**
   * Agent 是否在跑（可被打断的窗口）。
   * isStreaming/isThinking 只覆盖「已出 token」之后；agentBusy（submit 即 true）
   * 与 phase!=idle 还覆盖首 token 前、纯工具回合、dedup 缓冲期 —— 那些窗口同样应可打断。
   */
  private isAgentActive(): boolean {
    return this.agentBusy || this.state.isStreaming || this.state.isThinking || this.state.phase !== 'idle'
  }

  private handleAbort(reason?: string): void {
    // 世代自增：被中断的旧 run 的迟到回调（bridge 捕获旧 gen）将被丢弃
    this._runGen++
    // 中断时若停在审批/意图确认态：解析为拒绝/否决，让 tool-pipeline 的前置 await
    // 立即 settle，并复位输入模式。否则审批/意图态残留——后续按键被当确认解析、
    // 输入框无法使用（这是 abort 中途审批"假死"的一个分支）。
    if (this.approvalIntentController.approvalPending) { this.approvalIntentController.approvalEditMode = false; this.approvalIntentController.approvalEditError = ''; this.resolveApproval(false) }
    if (this.approvalIntentController.intentPending) this.resolveIntent('veto')
    // Flush 工具折叠组残余
    if (this.toolGroupController.isActiveGroup()) this.flushToolGroup()
    // 保留 steer 队列：对齐 Ink。用户在卡死期间排队的指引不应因中断而丢失——
    // 下次 submit 会把排队内容归并进新 prompt（见 onSubmit 的 steer 收口）。
    this.streamRenderer.reset()
    this.blockWriter.discard()
    this.streamRenderController.assistantHeaderDone = false
    // 统一回收 run 本地状态（pendingTools/toolAccumulator/fleet/liveTeamModel），
    // 与 handleError 同口径，防止中断后委派工具不到终态导致 records 单调泄露。
    this.resetRunLocalState()
    this.agentBusy = false
    this.state.isStreaming = false
    this.state.isThinking = false
    this.setPhase('idle')
    this.live.clear()
    // 可见的中断提示：watchdog abort → 自动恢复提示；用户中断 → 原样
    const isWatchdog = reason?.startsWith('watchdog')
    const isWatchdogGoal = reason === 'watchdog:goal'
    // Goal-mode auto-continue is bounded: a turn that re-stalls every
    // hardStallMs would otherwise loop "⟳ Auto-recovering → continue" forever
    // and burn budget. After MAX_WATCHDOG_AUTO_CONTINUES consecutive watchdog
    // aborts with no intervening progress, stop auto-continuing and surface a
    // plain interrupt so the user can intervene.
    const autoContinueExhausted = isWatchdogGoal
      && this._watchdogAutoContinues >= TuiApp.MAX_WATCHDOG_AUTO_CONTINUES
    this.commitAbove(() => {
      this.commit.write({
        text: isWatchdog && !autoContinueExhausted
          ? color('⟳ Auto-recovering (boundary stall)', this.theme.muted)
          : autoContinueExhausted
            ? color('⏹ Stalled repeatedly — auto-recovery paused (type to continue)', this.theme.muted)
            : color('⏹ Interrupted', this.theme.muted),
        trailingNewline: true,
      })
      this.state.committedCount++
    })
    // Watchdog abort in goal mode: auto-resubmit so the agent continues
    // without waiting for the user to type "continue" — but only while under
    // the consecutive-stall cap.
    if (isWatchdogGoal && !autoContinueExhausted) {
      this._watchdogAutoContinues++
      this.onSubmitCallback?.('continue')
    }
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
  /** H5：thinking 行 split 结果记忆化，key = expanded 标志 + 全文。
   *  header:false 时 formatThinking 输出与 elapsedMs 无关，故仅文本/展开态变化才需重算。
   *  ticker / 批渲染帧文本未变时直接复用，消除每帧 O(n) split。主题切换经 forceRedraw 失效。 */
  private thinkingLinesMemo: { key: string; lines: string[] } | null = null

  private getThinkingLines(expanded: boolean): string[] {
    const text = this.state.thinkingText
    const key = `${expanded ? '1' : '0'}\u0000${text}`
    if (this.thinkingLinesMemo?.key === key) return this.thinkingLinesMemo.lines
    const computed = formatThinking({
      text,
      elapsedMs: Date.now() - this.state.thinkStartMs,
      header: false,
      expanded,
    }, this.theme)
    this.thinkingLinesMemo = { key, lines: computed }
    return computed
  }

  /**
   * 把「逻辑上应占单行」的动态 live 元素钳制到终端宽度内。
   *
   * 用 ambiguousAsWide 上界度量截断（box/block 仍按 1 列）：保证即便终端把
   * `—`/`…`/`↑↓`/`·` 等 ambiguous 符号按 2 列渲染，该行也不会换行——否则
   * LiveEngine.rowsForLine（按 string-width 窄计）低估行数 → 回顶欠擦 → 旧帧
   * 顶框泄漏进 scrollback（输入框重影）。多行内容（流式 tail/思考/工具卡片）
   * 是有意换行的，不走此钳制。
   */
  private clampLine(text: string): string {
    // 留 1 列余量：吸收 get-east-asian-width 判为 neutral、但个别 CJK 终端仍按 2 列
    // 渲染的几何符（如 ◧）带来的 +1 残余误差。
    return truncateToDisplayWidth(text, Math.max(1, this.columns - 1), { ambiguousAsWide: true })
  }

  private renderLive(): void {
    const lines: LiveRegionLine[] = []

    // 1. Spinner 状态行（⠋ Thinking… (12s · esc to interrupt)），10s 无 token 变琥珀
    const stalled = this.streamRenderController.lastActivityMs > 0 && Date.now() - this.streamRenderController.lastActivityMs > 10_000
    const spinnerLine = formatSpinnerStatus({
      tick: this.streamRenderController.tick,
      phase: this.state.phase,
      elapsedMs: Date.now() - this.state.turnStartMs,
      stalled,
    }, this.theme)
    if (spinnerLine) {
      lines.push({ text: spinnerLine })
    }

    // 1b. Thinking 展开内容（状态行已由 spinner 承担）。split 结果记忆化见 getThinkingLines。
    if (this.state.isThinking && this.state.thinkingText) {
      for (const line of this.getThinkingLines(this.state.thinkingExpanded)) {
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
      lines.push({ text: this.clampLine(color(`⏳ queued: "${preview}"${more} · ↑ to edit`, this.theme.muted)) })
    }

    // 2b2. 子代理可视化 —
    //  - team_orchestrate 运行中：渲染 wave/task DAG（运行态由 fleet 叠加）。
    //  - delegate_*：渲染 FleetRegistry 驱动的 per-worker 结构化总览。
    //  - 刚启动、活动未上行的窗口期：回退工具级 pill，避免空白。
    if (this.liveTeamModel) {
      const model = this.teamModelWithLiveStatus(this.liveTeamModel)
      for (const line of formatTeamPanel(model, this.theme, this.columns)) {
        lines.push({ text: line })
      }
    } else {
    const activeWorkers = this.fleet.getActiveWorkers()
    if (activeWorkers.length > 0) {
      const summary = activeWorkers.reduce(
        (acc, w) => {
          const p = this.fleet.getGroupProgress(w.parentToolId)
          if (!acc.seen.has(w.parentToolId)) {
            acc.seen.add(w.parentToolId)
            acc.total += p.total
            acc.done += p.done
          }
          acc.running += 1
          return acc
        },
        { total: 0, done: 0, running: 0, seen: new Set<string>() },
      )
      const fleetLines = formatWorkerFleet(
        activeWorkers,
        this.theme,
        this.columns,
        { done: summary.done, total: summary.total, running: summary.running },
      )
      for (const line of fleetLines) lines.push({ text: line })
    } else {
      const delegationTools = [...this.toolGroupController.getPendingEntries()]
        .filter(([, meta]) => isDelegationTool(meta.name))
      if (delegationTools.length > 0) {
        const pills = delegationTools.map(([, meta]) => {
          const elapsed = Date.now() - meta.startMs
          const elapsedStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(0)}s` : `${elapsed}ms`
          const approvalBadge = meta._approvalMode === 'dangerously-skip-permissions'
            ? color('[auto]', this.theme.success)
            : color('[ask]', this.theme.warning)
          const profile = delegationProfileFromInput(meta.name, meta.input)
          return `${domainBadge(meta.name)?.glyph ?? '◆'} ${profile} ${color(elapsedStr, this.theme.muted)} ${approvalBadge}`
        })
        lines.push({ text: this.clampLine(` ${pills.join('  ')}`) })
      }
    }
    }

    // 2c. Collapsible 探索工具聚合行（避免 read×5 + grep×3 刷屏 live 区）
    if (this.toolGroupController.isActiveGroup()) {
      const activeGroup = this.toolGroupController.getActiveGroup()
      if (activeGroup && activeGroup.entries.length > 0) {
        const groupLines = formatCollapsedGroupLive(activeGroup, this.theme, this.columns)
        for (const line of groupLines) {
          lines.push({ text: line })
        }
      }
    }

    // 2d. 进行中非 collapsible 工具：● 标题行 + 末 3 行输出（⎿ 缩进）
    if (this.toolGroupController.getPendingSize() > 0) {
      for (const [id, meta] of this.toolGroupController.getPendingEntries()) {
        // 跳过已归入折叠组的 collapsible 工具（它们在 2c 聚合行中显示）
        if (isCollapsibleTool(meta.name)) continue
        const toolLines = formatToolCardLive({
          toolName: meta.name,
          toolInput: meta.input,
          outputTail: this.toolGroupController.getAccumulated(id),
          elapsedMs: Date.now() - meta.startMs,
          columns: this.columns,
        }, this.theme)
        for (const line of toolLines) {
          lines.push({ text: line })
        }
      }
    }

    // 3. Approval prompt (when pending)
    if (this.approvalIntentController.approvalPending) {
      const p = this.approvalIntentController.approvalPending
      if (this.approvalIntentController.approvalEditMode) {
        // Edit mode: show edit header, InputLine contains the JSON
        lines.push({ text: this.clampLine(` ╭─ Edit Tool Input ───────────────────────────────`) })
        lines.push({ text: this.clampLine(` │ Tool: ${p.name}`) })
        if (this.approvalIntentController.approvalEditError) {
          lines.push({ text: this.clampLine(` │ ${color(`⚠ ${this.approvalIntentController.approvalEditError}`, this.theme.warning)}`) })
        }
        lines.push({ text: this.clampLine(` │ Edit the JSON below, then Enter to confirm:`) })
        lines.push({ text: this.clampLine(` ╰─ Enter confirm  Esc back  Ctrl+C deny ─────────`) })
      } else {
        const inputSummary = JSON.stringify(p.input).slice(0, 80)
        lines.push({ text: this.clampLine(` ╭─ Approval Required ──────────────────────────────`) })
        lines.push({ text: this.clampLine(` │ Tool: ${p.name}`) })
        lines.push({ text: this.clampLine(` │ Input: ${inputSummary}${JSON.stringify(p.input).length > 80 ? '...' : ''}`) })
        lines.push({ text: this.clampLine(` ╰─ [y] approve  [n] deny  [e] edit ───────────────`) })
      }
    }

    // 3a. Intent preview prompt (when pending) — 意图闸确认框
    if (this.approvalIntentController.intentPending) {
      const it = this.approvalIntentController.intentPending.intent
      const hasAlt = (it.alternatives?.length ?? 0) > 0
      lines.push({ text: this.clampLine(` ╭─ Intent Preview ─────────────────────────────────`) })
      lines.push({ text: this.clampLine(` │ ${it.summary}`) })
      for (const w of it.warnings ?? []) {
        lines.push({ text: this.clampLine(` │ ⚠ ${w}`) })
      }
      for (const alt of it.alternatives ?? []) {
        lines.push({ text: this.clampLine(` │ ↳ ${alt}`) })
      }
      const altKey = hasAlt ? '  [a] alternative' : ''
      lines.push({ text: this.clampLine(` ╰─ [y] continue  [n] veto${altKey} ────────────────`) })
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

    // 4. GlanceBar（context% / cache / cost / git branch） metrics 计算
    // 优先用真实指标 provider（main-ansi 读 ctx.session）；无则回退内部估算。
    // 运行态相位已收敛到顶部 spinner 状态行，GlanceBar 不再重复显示 phase。
    const metrics = this.metricsGlanceController.metricsProvider?.() ?? null
    let glanceCacheHitRate: number | undefined
    let glanceContextRatio: number | undefined
    let glanceCost: number
    let glanceEstimatedTokens: number | undefined
    let glanceMaxTokens: number | undefined
    if (metrics) {
      glanceCacheHitRate = metrics.cacheHitRate ?? undefined
      // estimatedTokens is now calibrated against real API prompt_tokens in
      // SessionContext, so it reflects current context occupancy rather than a
      // stale single-turn request size. Use it as the progress numerator.
      glanceContextRatio = metrics.maxTokens > 0 ? Math.min(1, metrics.estimatedTokens / metrics.maxTokens) : undefined
      glanceCost = metrics.cost
      glanceEstimatedTokens = metrics.estimatedTokens
      glanceMaxTokens = metrics.maxTokens
    } else {
      glanceCacheHitRate = this.metricsGlanceController.lastCacheHitRate
      glanceContextRatio = this.metricsGlanceController.lastContextRatio
      glanceCost = this.estimateSessionCost()
    }

    // 5. Input line / Ctrl+C hint（多行输入：每行单独 push）
    if (this.inputController.ctrlCPendingSince > 0) {
      lines.push({ text: '(Ctrl+C again to exit)' })
    } else {
      const inputVal = this.inputLine.value
      const isSlash = inputVal.startsWith('/') && !inputVal.includes('\n')
      const isStreaming = this.state.phase !== 'idle'

      // Domain-accent border color: slash=primary, streaming=dim, else domain accent
      const borderColor = isSlash ? this.theme.primary
        : isStreaming ? this.theme.dim
        : resolveStarDomainAccent(this.state.domainName, this.theme)

      // 1. 获取当前生效星域的 Persona
      const activeDomainId = this.state.domainName ? Object.keys(STAR_DOMAINS).find(k => (STAR_DOMAINS as any)[k].name === this.state.domainName) : null
      const starDomain = activeDomainId ? (STAR_DOMAINS as any)[activeDomainId] : null
      const uiSep = starDomain?.uiPersona?.separator ?? 'thin'

      // 2. 根据 separator 确定线框字符
      const chars = ({
        thin:  { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', m: '┬' },
        thick: { tl: '┏', tr: '┓', bl: '┗', br: '┛', h: '━', v: '┃', m: '┳' },
        dots:  { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '┄', v: '┊', m: '┬' },
      } as any)[uiSep] ?? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│', m: '┬' }

      const innerWidth = Math.max(20, this.columns - 6)
      const leftBar = color(chars.v + ' ', borderColor)
      const rightBar = color(' ' + chars.v, borderColor)
      const botBorder = color(`${chars.bl}${chars.h.repeat(innerWidth + 2)}${chars.br}`, borderColor)

      // 3. 构建高保真左右指标 Segment
      const leftStr = formatGlanceLeft({
        width: this.columns,
        domainGlyph: this.state.domainGlyph,
        domainName: this.state.domainName,
        branch: this.metricsGlanceController.gitBranch,
      }, this.theme)

      const rightStr = formatGlanceRight({
        width: this.columns,
        modelName: this.state.modelName,
        cacheHitRate: glanceCacheHitRate,
        estimatedTokens: glanceEstimatedTokens,
        maxTokens: glanceMaxTokens,
        cost: glanceCost,
        elapsedMs: Date.now() - this.state.turnStartMs,
        turnCount: this.state.turnNumber,
      }, this.theme)

      const plainLeft = stripAnsiLen(leftStr)
      const plainRight = stripAnsiLen(rightStr)

      // 4. 计算并拼接一体化顶部边框：╭─ leftStr ─┬─ rightStr ─╮
      let topBorder = ''
      if (innerWidth < plainLeft + plainRight + 10) {
        topBorder = color(`${chars.tl}${chars.h.repeat(innerWidth + 2)}${chars.tr}`, borderColor)
      } else {
        const lineRem = innerWidth - plainLeft - plainRight - 4 // 4 = label border paddings
        const leftFill = Math.max(2, Math.floor(lineRem * 0.4))
        const rightFill = Math.max(2, lineRem - leftFill)
        
        topBorder = color(chars.tl, borderColor) + 
                    color(chars.h.repeat(2), borderColor) + 
                    leftStr + 
                    color(chars.h.repeat(leftFill), borderColor) + 
                    color(chars.m, borderColor) + 
                    color(chars.h.repeat(rightFill), borderColor) + 
                    rightStr + 
                    color(chars.h.repeat(2), borderColor) + 
                    color(chars.tr, borderColor)
      }

      const MAX_INPUT_DISPLAY_LINES = 12
      const arrowColor = this.theme.success
      const inputLines = this.inputLine.value
        ? this.inputLine.displayLines({ maxLines: MAX_INPUT_DISPLAY_LINES, maxWidth: innerWidth })
        : [`${color('〉', arrowColor)} ${color('█', this.theme.primary)}${color(this.inputLine.placeholder, this.theme.dim)}`]

      /** 着色输入行：光标行前缀 〉 涂 success 绿，其余保持原样。
       *  光标行已在 displayLines 内做了水平视窗截断，不再二次 truncateToWidth。 */
      const colorizeInputLine = (raw: string): string => {
        if (raw.startsWith('〉 ')) return color('〉', arrowColor) + ' ' + raw.slice(2)
        return raw
      }

      lines.push({ text: topBorder })
      if (this.inputLine.vimEnabled && this.inputLine.vimMode === 'normal') {
        const firstLine = truncateToWidth(`-- NORMAL -- ${colorizeInputLine(inputLines[0] ?? '')}`, innerWidth)
        lines.push({ text: `${leftBar}${firstLine}${' '.repeat(Math.max(0, innerWidth - stringWidth(firstLine)))}${rightBar}` })
        for (const extra of inputLines.slice(1)) {
          const t = truncateToWidth(colorizeInputLine(extra), innerWidth)
          lines.push({ text: `${leftBar}${t}${' '.repeat(Math.max(0, innerWidth - stringWidth(t)))}${rightBar}` })
        }
      } else {
        for (const inputDisplayLine of inputLines) {
          const t = truncateToWidth(colorizeInputLine(inputDisplayLine), innerWidth)
          lines.push({ text: `${leftBar}${t}${' '.repeat(Math.max(0, innerWidth - stringWidth(t)))}${rightBar}` })
        }
      }
      lines.push({ text: botBorder })

      // 5b. slash 命令提示（输入以 / 开头且未含空格）
      if (isSlash && !inputVal.includes(' ')) {
        for (const hintLine of formatSlashHint({ input: inputVal, commands: this.inputController.slashCommands, selectedIdx: this.inputController.slashSelectedIdx }, this.theme)) {
          lines.push({ text: this.clampLine(hintLine) })
        }
      }

      // 5c. @ 文件补全候选列表（Tab 循环时显示）
      if (this.inputController.fileCompletion && this.inputController.fileCompletion.candidates.length > 1) {
        const fc = this.inputController.fileCompletion
        for (let i = 0; i < Math.min(fc.candidates.length, 6); i++) {
          const selected = i === fc.idx
          const marker = selected ? color('❯ ', this.theme.primary) : '  '
          const name = color(fc.candidates[i]!, selected ? this.theme.primary : this.theme.muted)
          lines.push({ text: this.clampLine(`${marker}${name}`) })
        }
        lines.push({ text: this.clampLine(color('tab to cycle', this.theme.dim)) })
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

  /**
   * 将 thinking 文本 commit 到 scrollback（保留内部状态）。
   *
   * collapse-on-commit：流式期已完整显示推理，turn 结束只在 scrollback 留一行
   * 过去式摘要「✶ 已推理 · Ns · N 行」，避免啰嗦推理逐轮堆满历史。终端 scrollback
   * 是只读追加的，无法像桌面端那样回溯折叠已打印的行，故在 commit 时即收敛为摘要。
   */
  private commitThinkingToScrollback(): void {
    if (!this.state.thinkingText) return
    const formatted = formatThinking({
      text: this.state.thinkingText,
      elapsedMs: Date.now() - this.state.thinkStartMs,
      done: true,
      expanded: false,
    }, this.theme)
    if (formatted.length === 0) return
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
      this.approvalIntentController.approvalPending = { id, name, input, resolve }
      this.input.setMode('approval')
      this.setPhase('waiting')
      this.renderLive()
    })
  }

  private handleIntentPreview(intent: IntentPreview): Promise<IntentPreviewAction> {
    return new Promise((resolve) => {
      this.approvalIntentController.intentPending = { intent, resolve }
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
      // 透传给 agent 前 commit 用户消息到 scrollback，确保 slash 命令
      // 也能在终端历史中看到（之前只有 agent 回复无用户气泡）。
      this.commitUserPrompt(input)
      this.blockWriter.discard()
      this.streamRenderer.reset()
      this.streamRenderController.assistantHeaderDone = false
      this.agentBusy = true
      this.state.turnStartMs = Date.now()
      this.streamRenderController.lastActivityMs = Date.now()
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
    historySearchData?: () => HistorySearchData
    tasksData?: () => TasksData
    domainPickerData?: () => DomainPickerData
    modelPickerData?: () => ModelPickerData
    themePickerData?: () => ThemePickerData
  }, paletteExec?: (index: number) => void, rewindExec?: (content: string) => void, chronicleExec?: (id: string) => void, domainPickerExec?: (key: string) => void, modelPickerExec?: (key: string) => void, themePickerExec?: (key: string) => void): void {
    this.overlayController.setData(overlayData)
    this.overlayController.setPaletteExec(paletteExec)
    this.overlayController.setRewindExec(rewindExec)
    this.overlayController.setChronicleExec(chronicleExec)
    this.overlayController.setDomainPickerExec(domainPickerExec)
    this.overlayController.setModelPickerExec(modelPickerExec)
    this.overlayController.setThemePickerExec(themePickerExec)
    // Pager — page 由 overlayNav 注入（覆盖 provider 的静态 page）
    this.overlay.register('pager', {
      render: (_w, _h) => {
        const data = overlayData?.pagerContent?.() ?? { content: '(no content)', page: 0 }
        return renderPager({ ...data, page: this.overlayController.nav().pagerPage }, this.columns, this.rows, this.theme)
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
        return renderCommandPalette({ ...data, selectedIndex: this.overlayController.nav().paletteIndex, searchText: this.overlayController.getQuery() || data.searchText }, this.columns, this.rows, this.theme)
      },
    })

    // Cockpit
    this.overlay.register('cockpit', {
      render: (_w, _h) => {
        const data = overlayData?.cockpitSnapshot?.()
        if (!data) return ['Cockpit data not available.']
        return renderCockpit(data, this.columns, this.rows, this.theme, this.overlayController.getCockpitPanel())
      },
    })

    // Rewind — selectedIndex 由 overlayNav 注入
    this.overlay.register('rewind', {
      render: (_w, _h) => {
        const data = overlayData?.rewindEntries?.() ?? { entries: [], selectedIndex: 0 }
        return renderRewind({ ...data, selectedIndex: this.overlayController.nav().rewindIndex }, this.columns, this.rows, this.theme)
      },
    })

    // History search — selectedIndex 由 overlayNav 注入
    this.overlay.register('history-search', {
      render: (_w, _h) => {
        const data = overlayData?.historySearchData?.() ?? { entries: [], selectedIndex: 0, query: '' }
        return renderHistorySearch({ ...data, selectedIndex: this.overlayController.nav().historySearchIndex, query: this.overlayController.getQuery() || data.query }, this.columns, this.rows, this.theme)
      },
    })

    // Chronicle
    this.overlay.register('chronicle', {
      render: (_w, _h) => {
        const data = overlayData?.chronicleEntries?.() ?? { entries: [] }
        return renderChronicle({ ...data, selectedIndex: this.overlayController.nav().chronicleIndex }, this.columns, this.rows, this.theme)
      },
    })

    // Tasks — /tasks 显示运行中子代理
    this.overlay.register('tasks', {
      render: (_w, _h) => {
        const data = overlayData?.tasksData?.() ?? { groups: [] }
        return renderTasks(data, this.columns, this.rows, this.theme)
      },
    })

    // Domain Picker — 裸 /domain 打开 CC 风星域选择器；selectedIndex 由 overlayNav 注入
    this.overlay.register('domain-picker', {
      render: (_w, _h) => {
        const data = overlayData?.domainPickerData?.() ?? { entries: [], selectedIndex: 0 }
        return renderDomainPicker({ ...data, selectedIndex: this.overlayController.nav().domainPickerIndex }, this.columns, this.rows, this.theme)
      },
    })

    // Model Picker — 裸 /model 打开模型选择器；selectedIndex 由 overlayNav 注入
    this.overlay.register('model-picker', {
      render: (_w, _h) => {
        const data = overlayData?.modelPickerData?.() ?? { entries: [], selectedIndex: 0 }
        return renderModelPicker({ ...data, selectedIndex: this.overlayController.nav().modelPickerIndex }, this.columns, this.rows, this.theme)
      },
    })

    // Theme Picker — 裸 /theme 打开主题选择器；selectedIndex 由 overlayNav 注入
    this.overlay.register('theme-picker', {
      render: (_w, _h) => {
        const data = overlayData?.themePickerData?.() ?? { entries: [], selectedIndex: 0 }
        return renderThemePicker({ ...data, selectedIndex: this.overlayController.nav().themePickerIndex }, this.columns, this.rows, this.theme)
      },
    })
  }
}
