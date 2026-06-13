/**
 * 天枢 T9 主入口 — 纯 ANSI 终端 UI，零 React/Ink 依赖。
 *
 * 使用 bootstrap.ts 完成完整初始化，连接 AgentLoop 到 TuiApp 渲染引擎。
 *
 * 运行方式：
 *   npx tsx src/main.ts
 *   npx tsx src/main.ts --model deepseek-v4-pro
 *   npx tsx src/main.ts --dangerously-skip-permissions
 */

import { bootstrapInteractiveSession, createShutdownHandler } from './bootstrap.js'
import type { BootstrapContext } from './bootstrap.js'
import { TuiApp } from './tui/engine/app.js'
import { wrapCallbacksWithTuiApp } from './tui/engine/bridge.js'
import { SlashRouter } from './tui/engine/slash-router.js'
import { getPaletteCommands } from './tui/command-palette.js'
import type { PaletteCommand } from './tui/command-palette.js'
import { buildCockpitSnapshot } from './tui/cockpit/state.js'
import { getTodos } from './tools/todo.js'
import { formatWelcome } from './tui/format/welcome.js'
import { loadHistory } from './tui/history.js'
import { killAllSync } from './tools/process-tracker.js'
import { getTheme } from './tui/theme.js'
import { resolveAppPromptInput } from './tui/slash-commands.js'
import { starDomainRegistry } from './agent/star-domain-registry.js'
import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { execSync } from 'child_process'

// ── CLI args ───────────────────────────────────────────────────

const args = process.argv.slice(2)
const modelArgIdx = args.indexOf('--model')
const requestedModel = modelArgIdx >= 0 ? args[modelArgIdx + 1] : undefined
const providerArgIdx = args.indexOf('--provider')
const requestedProvider = providerArgIdx >= 0 ? args[providerArgIdx + 1] : undefined

// ── Lifecycle ──────────────────────────────────────────────────

let app: TuiApp | null = null
let ctx: BootstrapContext | null = null
let heartbeatInterval: ReturnType<typeof setInterval> | null = null

let isShuttingDown = false

function shutdown(code: number = 0) {
  if (isShuttingDown) return
  isShuttingDown = true

  app?.dispose()

  // Delegate core cleanup to bootstrap shutdown handler
  if (ctx) {
    try { ctx.shutdown() } catch { /* already handled */ }
  }

  if (heartbeatInterval) {
    clearInterval(heartbeatInterval)
    heartbeatInterval = null
  }

  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false)
  }
  killAllSync()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const stdout = process.stdout
  const stdin = process.stdin

  // ── Headless / config routing ──────────────────────────────
  // 在 TTY 检查之前：先检测无头模式（-p/--print/--json）、配置命令（config），
  // 若命中则直接路由到对应处理器，不启动 TUI。

  // rivet config ...
  if (args[0] === 'config') {
    const { runConfigCLI } = await import('./config/manager.js')
    await runConfigCLI(args.slice(1))
    return
  }

  // rivet -p "prompt" / rivet --print "prompt" [--json] [--stream-json]
  const isHeadless = args.includes('-p') || args.includes('--print')

  if (isHeadless) {
    const { parseCliArgs, runHeadless } = await import('./headless.js')
    const { loadConfig } = await import('./config/manager.js')
    const { AgentLoop } = await import('./agent/loop.js')
    const { SessionContext } = await import('./agent/context.js')
    const { createAgentConfig, createMainAgentConfigInput } = await import('./agent/create-agent-config.js')
    const { createDefaultToolRegistry } = await import('./tools/default-registry.js')

    const parsed = parseCliArgs(args)
    if (!parsed.prompt) {
      process.stderr.write('Usage: rivet -p "<prompt>" [--json] [--stream-json]\n')
      process.exit(2)
    }

    const cfg = loadConfig()
    const prov = cfg.provider.providers[cfg.provider.default]
    if (!prov) { process.stderr.write('Provider not configured. Run: rivet config setup <provider>\n'); process.exit(1) }
    const key = prov.apiKey ?? process.env[prov.apiKeyEnv ?? '']
    if (!key) { process.stderr.write(`API key not set. Export ${prov.apiKeyEnv ?? 'API_KEY'} or run: rivet config setup ${prov.name}\n`); process.exit(1) }

    const model = prov.models[0]!
    const sessionId = crypto.randomUUID()

    const result = await runHeadless({
      prompt: parsed.prompt,
      json: parsed.json,
      streamJson: parsed.streamJson,
      createAgent: () => {
        const toolRegistry = createDefaultToolRegistry([], { desktopTools: cfg.agent.desktopTools })
        const agentCfg = createAgentConfig(createMainAgentConfigInput({
          apiKey: key,
          model: { id: model.id, maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort },
          cwd: process.cwd(),
          provider: prov,
          config: cfg,
          sessionId,
          toolDefinitions: toolRegistry.getDefinitions(),
          sessionMemoryBlock: undefined,
          auth: undefined,
        }))
        const session = new SessionContext()
        return new AgentLoop({ ...agentCfg, toolRegistry, maxTurns: 15 }, session, process.cwd())
      },
    })

    if (result.stdout) process.stdout.write(result.stdout + '\n')
    else if (result.json) process.stdout.write(JSON.stringify(result.json) + '\n')
    process.exit(result.exitCode)
  }

  // ── Interactive TUI (requires TTY) ──────────────────────────

  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write('[T9] stdout and stdin must be TTY (use -p for headless mode).\n')
    process.exit(1)
  }

  // ── Bootstrap agent runtime ──────────────────────────────────
  process.stderr.write('[T9] Initializing agent runtime...\n')

  ctx = await bootstrapInteractiveSession({
    cwd: process.cwd(),
    args,
    modelId: requestedModel,
    providerName: requestedProvider,
    asyncExtras: true,
  })

  const theme = getTheme()

  process.stderr.write(`[T9] Provider: ${ctx.provider.name}, Model: ${ctx.config.provider.default}\n`)
  process.stderr.write(`[T9] Session: ${ctx.sessionId.slice(0, 8)}...\n`)

  // Store heartbeat for shutdown cleanup
  heartbeatInterval = ctx.heartbeatInterval

  // ── Build TuiApp ─────────────────────────────────────────────
  const currentModel = ctx.provider.models[0]
  const modelName = currentModel?.alias ?? currentModel?.id ?? 'unknown'

  // git branch（启动时读取一次，GlanceBar 显示）
  let gitBranch: string | undefined
  try {
    gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim() || undefined
  } catch { /* 非 git 目录 */ }

  app = new TuiApp({
    stdout,
    stdin,
    cols: stdout.columns,
    rows: stdout.rows,
    modelName,
    history: loadHistory(),
    contextWindow: currentModel?.contextWindow,
    gitBranch,
  })

  // Register overlays with real data
  // app 在此处必定非 null（前有 app = new TuiApp 赋值，无重赋 null 路径）
  const tuiApp = app!
  tuiApp.setApprovalMode(ctx!.config.agent.approval ?? 'auto-safe')
  const initialDomain = ctx!.agent.getSessionDomain()?.name
  if (initialDomain) {
    tuiApp.setSessionStarDomain(initialDomain)
  }
  tuiApp.setDomainSyncProvider(() => ctx!.agent.getSessionDomain()?.name ?? undefined)
  tuiApp.registerOverlays({
    // Pager — scrollback 内容
    pagerContent: () => ({
      content: tuiApp.getScrollbackContent() || '(no messages yet)',
      page: 0,
      title: 'Scrollback',
    }),
    // Starmap
    starmapEntries: () => {
      const domains = starDomainRegistry.list()
      return {
        entries: domains.map(d => ({
          name: d.name,
          glyph: '✦',
          description: d.motto ?? '',
          active: false,
        })),
      }
    },
    // Command palette
    paletteCommands: () => {
      const cmds: PaletteCommand[] = getPaletteCommands().filter(c => c.name.startsWith('/') || c.name.startsWith('__surface:'))
      return {
        commands: cmds.map(c => ({ label: c.name, description: c.description, hotkey: c.hotkey })),
        selectedIndex: 0,
      }
    },
    // Cockpit — 运行时仪表盘
    cockpitSnapshot: () => {
      if (!ctx) return undefined as any
      const metrics = tuiApp.getMetrics()
      return buildCockpitSnapshot({
        agent: ctx.agent,
        session: ctx.session,
        model: ctx.provider.models[0]?.alias ?? ctx.provider.models[0]?.id ?? 'unknown',
        cacheHitRate: ctx.session.getRecentTurnHitRate(3) ?? ctx.session.getCacheHitRate(),
        cost: metrics?.cost ?? 0,
        mcpManager: ctx.refs.mcpManager,
      })
    },
    // Rewind — 最近用户消息
    rewindEntries: () => {
      const messages = ctx?.session.getMessages() ?? []
      const userMsgs = messages
        .filter(m => m.role === 'user')
        .slice(-30)
        .map((m, i) => ({
          index: i + 1,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        }))
      return { entries: userMsgs, selectedIndex: 0 }
    },
    // Chronicle
    chronicleEntries: () => {
      const sessionsDir = join(homedir(), '.rivet', 'sessions')
      if (!existsSync(sessionsDir)) return { entries: [] }
      try {
        const files = readdirSync(sessionsDir)
          .filter(f => f.endsWith('.jsonl') && !f.startsWith('worker-') && !f.endsWith('.claims.jsonl'))
          .slice(0, 20)
        const entries = files.map((f, i) => {
          const id = f.replace('.jsonl', '')
          return {
            index: i + 1,
            time: '',
            summary: `Session ${id.slice(0, 8)}`,
            current: id === ctx!.sessionId,
          }
        })
        return { entries }
      } catch {
        return { entries: [] }
      }
    },
    // History search — Ctrl+R 反向搜索
    historySearchData: () => ({
      entries: loadHistory().slice(0, 50),
      selectedIndex: 0,
      query: '',
    }),
    // Tasks — /tasks 显示运行中子代理
    tasksData: () => ({
      workers: tuiApp.getRunningWorkers(),
    }),
  }, /* paletteExec: */ (index: number) => {
    // Command palette Enter 回调：执行选中命令
    const cmds = getPaletteCommands()
    const name = cmds[index]?.name
    if (!name) return
    if (name.startsWith('__surface:')) {
      const surfaceId = name.slice('__surface:'.length)
      if (['pager', 'cockpit', 'starmap', 'chronicle', 'tasks'].includes(surfaceId)) {
        tuiApp.activateOverlay(surfaceId)
      }
    } else if (name.startsWith('/')) {
      if (name === '/starmap' || name === '/chronicle') {
        tuiApp.activateOverlay(name.slice(1))
      } else if (name === '/scroll' || name === '/pager') {
        tuiApp.activateOverlay('pager')
      } else if (name === '/cockpit') {
        tuiApp.activateOverlay('cockpit')
      } else if (name === '/rewind') {
        tuiApp.activateOverlay('rewind')
      } else {
        tuiApp.setInput(name + ' ')
      }
    }
  })

  // ── SlashRouter ──────────────────────────────────────────────
  const slashRouter = new SlashRouter(app, ctx)
  app.setSlashHandler(async (input) => slashRouter.route(input))

  // slash 命令提示列表（仅 / 开头的 command 类，过滤 __surface: 面板项）
  app.setSlashCommands(
    getPaletteCommands()
      .filter(c => c.name.startsWith('/'))
      .map(c => ({ name: c.name, description: c.description })),
  )

  // ── 真实指标 provider（GlanceBar cache/ctx/cost）─────────────
  // 闭包动态读 module-level ctx：/model 切换时 switchAgentRuntime 原地改 ctx.agent，
  // ctx.session 不变，因此读取始终命中当前 runtime（天然 /model 切换安全）。
  app.setMetricsProvider(() => {
    if (!ctx) return null
    const session = ctx.session
    const total = session.getTotalUsage()
    const cacheRead = total.cache_read_input_tokens
    const normalInput = Math.max(0, total.input_tokens - cacheRead)
    // Ink 近似定价：normal $1/M · cacheRead $0.1/M · out $4/M（单次计算，不累加）
    const cost = (normalInput * 1 + cacheRead * 0.1 + total.output_tokens * 4) / 1_000_000
    const maxTokens = ctx.agent.config.contextWindow ?? currentModel?.contextWindow ?? 0
    return {
      estimatedTokens: session.getEstimatedTokens(),
      maxTokens,
      cacheHitRate: session.getRecentTurnHitRate(3) ?? session.getCacheHitRate(),
      cost,
      inputTokens: total.input_tokens,
      outputTokens: total.output_tokens,
    }
  })

  // ── 常驻任务面板 provider（todo 列表）──────────────────────
  // 读 TodoStore 单例（todo 工具的 canonical 源），T9 不直接 import 工具层单例。
  app.setTodosProvider(() => getTodos())

  // ── Wire agent → TuiApp ──────────────────────────────────────
  // 消息队列已收编进 TuiApp：streaming 时 Enter 由 TuiApp 入队（steerBuffer），
  // onSteerDrain 由 TuiApp callbacks 真实 drain，此处无需外层 override。
  app.onSubmit((text) => {
    const trimmed = text.trim()
    if (!trimmed) return

    // 将 slash 命令解析为 agent prompt（对齐 Ink resolveAppPromptInput）。
    // /review → "deliver_task(...)"；未知 slash → null → 显示错误提示。
    const prompt = resolveAppPromptInput(trimmed, process.cwd())
    if (prompt === null) {
      app!.rejectSubmit()
      app!.commitStatic(`⚠️  Unknown command: ${trimmed.split(/\s/)[0]}\nType /help for available commands.`)
      return
    }

    // 单一权威：TuiApp.agentBusy 是唯一的 streaming 闩。app.onSubmit 只在 TuiApp
    // 判定空闲时触发（busy 时输入已被 TuiApp 入队 steerBuffer），故此处无需再自管
    // isStreaming 标志——正是「双门异步清除时机不同」造成 Esc 后死会话的根因。
    // run 生命周期回调（完成/错误/中止）由 bridge 桥接到 TuiApp，并带世代守卫。
    const callbacks = wrapCallbacksWithTuiApp(app!)
    ctx!.agent.run(prompt, callbacks).catch((err) => {
      process.stderr.write(`[T9] Agent error: ${(err as Error)?.message}\n`)
    })
  })

  // ── Wire abort ───────────────────────────────────────────────
  app.onAbort(() => {
    if (ctx) {
      ctx.agent.abort()
    }
  })

  // ── Wire exit ────────────────────────────────────────────────
  app.onExit(() => {
    shutdown(0)
  })

  // ── Clear screen ─────────────────────────────────────────────
  stdout.write('\x1B[2J\x1B[H')

  // ── Welcome message（精简 ≤3 行，自适应终端宽） ───────────────
  const existingMsgCount = ctx.session.getMessages().length
  const welcomeLines = formatWelcome({
    modelName,
    cwd: process.cwd(),
    sessionId: ctx.sessionId,
    priorMsgCount: existingMsgCount,
    columns: stdout.columns || 80,
  }, theme)
  for (const line of welcomeLines) {
    stdout.write(line + '\n')
  }
  // 欢迎与底部 chrome 之间留一空行
  stdout.write('\n')

  process.stderr.write('[T9] Ready. Type a message and press Enter.\n')

  // 首屏渲染底部 chrome（GlanceBar + 输入框），不必等第一次按键
  app.start()
}

main().catch((err) => {
  process.stderr.write(`[T9] Fatal: ${(err as Error)?.message}\n`)
  if ((err as Error).stack) {
    process.stderr.write((err as Error).stack! + '\n')
  }
  shutdown(1)
})
