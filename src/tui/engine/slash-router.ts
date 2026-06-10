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
import type { TuiApp } from './app.js'
import type { BootstrapContext } from '../../bootstrap.js'

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
    if (resolved !== null) return false

    const parts = trimmed.split(/\s+/)
    const command = parts[0]!.toLowerCase()

    // Build SlashHandlerContext adapter
    const handlerCtx: SlashHandlerContext = {
      parts,
      agent: this.ctx.agent,
      session: this.ctx.session,
      persist: this.ctx.persist,
      model: this.app.getModelInfo().modelName,
      maxTokens: this.ctx.provider.models[0]?.contextWindow ?? 128000,
      availableModels: this.ctx.provider.models.map(m => ({ id: m.id, alias: m.alias ?? m.id })),
      onModelSwitch: (_modelId: string): { ok: boolean; error?: string } => {
        // Model switching in T9 path requires recreating agent with new config.
        // For now, return not-supported.
        return { ok: false, error: 'Model switching not yet supported in T9 path. Restart with --model <id>.' }
      },
      allProviders: { [this.ctx.provider.name]: { models: this.ctx.provider.models.map(m => ({ id: m.id, alias: m.alias ?? m.id })) } },
      currentProvider: this.ctx.provider.name,
      currentSessionId: this.ctx.sessionId,
      cost: 0,
      cacheHitRate: this.cacheHitRate,
      autoSafeRef: this.autoSafeRef as unknown as React.MutableRefObject<boolean>,
      verboseRef: this.verboseRef as unknown as React.MutableRefObject<boolean>,
      setVerbose: (v: boolean) => { this.verbose = v; this.verboseRef.current = v },
      setAutoSafe: (v: boolean) => { this.autoSafe = v; this.autoSafeRef.current = v },
      rollbackTokenRef: this.rollbackTokenRef as unknown as React.MutableRefObject<string | null>,
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
      } as any,
      claimStoreRef: {
        current: this.ctx.claimStore,
      } as any,
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

    // Special-case /starmap, /chronicle — overlays
    if (command === '/starmap') {
      this.app.activateOverlay('starmap')
      return true
    }
    if (command === '/chronicle') {
      this.app.activateOverlay('chronicle')
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

  /** Check if input looks like a slash command (starts with /) */
  isSlashCommand(input: string): boolean {
    return input.trim().startsWith('/')
  }
}
