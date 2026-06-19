/**
 * T9 SlashRouter — 桥接 slash-commands.ts 到 TuiApp（非 React 路径）。
 *
 * 将 TuiApp 的 handleSlashCommand 委托给现有的 slash-commands.ts 的
 * handleSlashCommand，通过适配器模式消除 React MutableRefObject / setState 依赖。
 *
 * 用法：
 *   const router = new SlashRouter({ app, ctx })
 *   const handled = await router.route(input)
 *   // handled === true: command was handled
 *   // handled === false: unrecognized, pass through to agent
 */

import { handleSlashCommand, resolveAppPromptInput, type SlashHandlerContext } from '../slash-commands.js'
import { switchAgentRuntime, switchAgentSession } from '../../bootstrap.js'
import type { TuiApp } from './app.js'
import type { BootstrapContext } from '../../bootstrap.js'
import { createCoordinatorReviewDeps } from '../../agent/review-coordinator-deps.js'
import { routeReviewWorkflow, type ReviewMode, type ReviewOutcome } from '../../agent/review-router.js'
import type { ChangeSet } from '../../agent/review-discipline.js'
import { PANELS, type Panel } from '../cockpit/types.js'

// ── React-free mutable ref adapter ─────────────────────────────

class MutableRef<T> {
  current: T
  constructor(initial: T) { this.current = initial }
}

// ── SlashRouter ────────────────────────────────────────────────

export class SlashRouter {
  private app: TuiApp
  private ctx: BootstrapContext
  private autoSafe = true
  private verbose = false
  private autoSafeRef = new MutableRef(true)
  private verboseRef = new MutableRef(false)
  private rollbackTokenRef = new MutableRef<string | null>(null)
  private cacheHitRate = 0

  constructor(app: TuiApp, ctx: BootstrapContext) {
    this.app = app
    this.ctx = ctx
  }

  /**
   * 路由 slash 命令。返回 true 表示已处理，false 表示未识别（透传 agent）。
   */
  async route(input: string): Promise<boolean> {
    const trimmed = input.trim()
    if (!trimmed.startsWith('/')) return false

    // Check if this is a pass-through command (handled by agent, not local handler)
    const resolved = resolveAppPromptInput(trimmed, this.ctx.cwd)
    if (resolved !== null) {
      // Ecosystem workflow resolution: submit the resolved prompt directly
      // instead of returning false with the raw input (which discards the prompt).
      this.app.submitText(resolved)
      return true
    }

    const parts = trimmed.split(/\s+/)
    const command = parts[0]!.toLowerCase()

    // 真实指标快照（与 GlanceBar 同源）：让 /cost、maxTokens 读当前 runtime 真实值，
    // 不再写死 cost: 0 或取 models[0]（非当前模型）。无 provider 时回退。
    const metrics = this.app.getMetrics()
    const maxTokens = metrics?.maxTokens && metrics.maxTokens > 0
      ? metrics.maxTokens
      : (this.ctx.provider.models[0]?.contextWindow ?? 128000)
    const cost = metrics?.cost ?? 0

    // Build SlashHandlerContext adapter
    const handlerCtx: SlashHandlerContext = {
      parts,
      agent: this.ctx.agent,
      session: this.ctx.session,
      persist: this.ctx.persist,
      model: this.app.getModelInfo().modelName,
      maxTokens,
      availableModels: this.ctx.provider.models.map(m => ({ id: m.id, alias: m.alias ?? m.id })),
      onModelSwitch: (modelId: string): { ok: boolean; error?: string } => {
        // T9 模型切换：重建 AgentLoop（switchAgentRuntime 原地更新 ctx.agent），
        // 再刷新 GlanceBar 显示。streaming 中先中止旧 run，避免旧回调写脏屏。
        try { this.ctx.agent.abort() } catch { /* idle agent abort 无害 */ }
        const res = switchAgentRuntime(this.ctx, modelId)
        if (res.ok && res.modelName) {
          this.app.setModelInfo(res.modelName, res.contextWindow)
        }
        return { ok: res.ok, error: res.error }
      },
      onSessionSwitch: (targetId: string) => {
        // 运行时会话身份切换:先中止旧 run(避免旧回调写脏屏),再原地重建 ctx.agent。
        try { this.ctx.agent.abort() } catch { /* idle agent abort 无害 */ }
        const res = switchAgentSession(this.ctx, targetId)
        if (res.ok) {
          // GlanceBar/会话标识刷新 — sessionId 已切,模型不变。
          this.app.setStreamingState(false)
        }
        return res
      },
      allProviders: this.buildAllProviders(),
      currentProvider: this.ctx.provider.name,
      currentSessionId: this.ctx.sessionId,
      cost,
      cacheHitRate: metrics?.cacheHitRate ?? this.cacheHitRate,
      autoSafeRef: this.autoSafeRef,
      verboseRef: this.verboseRef,
      setVerbose: (v: boolean) => { this.verbose = v; this.verboseRef.current = v },
      setAutoSafe: (v: boolean) => { this.autoSafe = v; this.autoSafeRef.current = v },
      rollbackTokenRef: this.rollbackTokenRef,
      setCockpitPanel: (_v: unknown) => { /* noop in T9 */ },
      surfacePush: undefined,
      surfacePop: undefined,
      pushStatic: (entry) => {
        this.app.commitStatic(entry.content)
      },
      setIsStreaming: (v: boolean) => {
        this.app.setStreamingState(v)
      },
      setCacheHitRate: (v: number) => { this.cacheHitRate = v },
      setSummaryState: (_v: unknown) => { /* noop in T9 */ },
      mcpManagerRef: {
        current: this.ctx.refs.mcpManager,
      },
      claimStoreRef: {
        current: this.ctx.claimStore,
      },
      // T5: bandit promotion observability — without this, /status in T9
      // always shows the "(no bandit state available)" placeholder.
      banditState: this.ctx.refs.banditState ?? undefined,
      onDomainChange: (domainName: string | undefined) => {
        this.app.setSessionStarDomain(domainName)
      },
        // 独立审查回调——/review 不经过 deliver_task 直接调 routeReviewWorkflow
        runReview: this.ctx.refs.coordinator
          ? (() => {
              // 构造一次 reviewDeps，复用给每次 /review 调用
              const reviewDeps = createCoordinatorReviewDeps(this.ctx.refs.coordinator!, {
                parentTurnId: 'slash-review',
                reviewDepth: 0,
              })
              return (change: ChangeSet, mode: ReviewMode, focus?: string) =>
                routeReviewWorkflow(change, reviewDeps, { mode, focusHint: focus })
            })()
          : undefined,
      // Submit a prompt directly to the agent pipeline, bypassing slash routing.
      // Used by /goal (injects the goal prompt without the /goal prefix).
      submitToAgent: (prompt: string) => {
        this.app.submitText(prompt)
      },
      goalTrackerRef: this.ctx.refs.goalTrackerRef,
    }

    // Special-case /exit and /quit — shutdown handler already persists session
    if (command === '/exit' || command === '/quit') {
      this.app.commitStatic('Session saved. Goodbye!')
      this.ctx.shutdown()
      return true
    }

    // Special-case /clear — ANSI clear
    if (command === '/clear') {
      process.stdout.write('\x1B[2J\x1B[H')
      this.app.setStreamingState(false)
      return true
    }

    // Special-case /starmap, /chronicle, /scroll, /cockpit, /palette, /rewind — overlays
    if (command === '/starmap') {
      this.app.activateOverlay('starmap')
      return true
    }
    if (command === '/chronicle') {
      this.app.activateOverlay('chronicle')
      return true
    }
    if (command === '/scroll' || command === '/pager') {
      this.app.activateOverlay('pager')
      return true
    }
    if (command === '/cockpit') {
      const arg = parts[1]?.toLowerCase()
      if (arg === 'off') {
        this.app.deactivateOverlay()
        this.app.commitStatic('Cockpit collapsed.')
        this.app.setStreamingState(false)
        return true
      }
      const panel: Panel = (arg && (PANELS as string[]).includes(arg)) ? (arg as Panel) : 'summary'
      this.app.setCockpitPanel(panel)
      this.app.activateOverlay('cockpit')
      if (arg && panel === 'summary' && arg !== 'summary') {
        this.app.commitStatic(`Unknown cockpit panel "${arg}". Showing summary. Panels: ${PANELS.join(', ')}`)
      }
      return true
    }
    if (command === '/palette') {
      this.app.activateOverlay('command-palette')
      return true
    }
    if (command === '/rewind') {
      this.app.activateOverlay('rewind')
      return true
    }
    if (command === '/tasks') {
      this.app.activateOverlay('tasks')
      return true
    }

    // ── 裸 /domain（无参）→ 打开 CC 风星域选择器；带参（list/auto/off/status/<name>）走文本路径 ──
    if (command === '/domain' && parts.length === 1) {
      this.app.activateOverlay('domain-picker')
      return true
    }

    // ── 裸 /model（无参）→ 打开模型选择器面板 ──
    if (command === '/model' && parts.length === 1) {
      this.app.activateOverlay('model-picker')
      return true
    }

    // ── 裸 /theme（无参）→ 打开主题选择器面板 ──
    if (command === '/theme' && parts.length === 1) {
      this.app.activateOverlay('theme-picker')
      return true
    }

    // ── /vim — 切换 vim 键位（InputLine 状态，shared handler 无 app 句柄，故在此特判）──
    if (command === '/vim') {
      const next = this.app.toggleVim()
      this.app.commitStatic(next
        ? 'Vim keybindings: on (Esc → normal mode, i/a → insert)'
        : 'Vim keybindings: off')
      this.app.setStreamingState(false)
      return true
    }

    // ── /auto — 切换审批模式，同步更新 TuiApp 的 worker pills badge ──
    if (command === '/auto') {
      const next = !this.autoSafe
      this.autoSafe = next
      this.autoSafeRef.current = next
      const mode = next ? 'auto-safe' : 'manual'
      this.ctx.agent.setApprovalMode(mode)
      this.app.setApprovalMode(mode)
      this.app.commitStatic(next
        ? 'Auto-approve: on (auto-safe — high-risk still requires approval)'
        : 'Auto-approve: off (manual — all mutating tools require approval)')
      this.app.setStreamingState(false)
      return true
    }

    // Delegate to shared slash-commands handler
    try {
      return await handleSlashCommand(handlerCtx)
    } catch (err) {
      this.app.commitStatic(`Error: ${(err as Error).message}`)
      return true
    }
  }

  /** 构建全 provider 模型表（供 /model list 跨 provider 显示与切换查找） */
  private buildAllProviders(): Record<string, { models: Array<{ id: string; alias: string }> }> {
    const all: Record<string, { models: Array<{ id: string; alias: string }> }> = {}
    for (const [name, prov] of Object.entries(this.ctx.config.provider.providers)) {
      all[name] = { models: prov.models.map(m => ({ id: m.id, alias: m.alias ?? m.id })) }
    }
    return all
  }

  /** Check if input looks like a slash command (starts with /) */
  isSlashCommand(input: string): boolean {
    return input.trim().startsWith('/')
  }
}
