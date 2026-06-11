/**
 * T9 ANSI 入口点 — 零 React/Ink 启动路径。
 *
 * 使用 bootstrap.ts 完成完整初始化，连接 AgentLoop 到 TuiApp 渲染引擎。
 * 对标 main.tsx 的完整功能，但不依赖 React/Ink。
 *
 * 运行方式：
 *   npx tsx src/main-ansi.ts
 *   npx tsx src/main-ansi.ts --model deepseek-v4-pro
 *   npx tsx src/main-ansi.ts --dangerously-skip-permissions
 */

import { bootstrapInteractiveSession, createShutdownHandler } from './bootstrap.js'
import type { BootstrapContext } from './bootstrap.js'
import { TuiApp } from './tui/engine/app.js'
import { wrapCallbacksWithTuiApp } from './tui/engine/bridge.js'
import { SlashRouter } from './tui/engine/slash-router.js'
import { getPaletteCommands } from './tui/command-palette.js'
import { getTodos } from './tools/todo.js'
import { formatWelcome } from './tui/format/welcome.js'
import { loadHistory } from './tui/history.js'
import { killAllSync } from './tools/process-tracker.js'
import { getTheme } from './tui/theme.js'
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

  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write('[T9] stdout and stdin must be TTY.\n')
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
  app.registerOverlays({
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

    // 单一权威：TuiApp.agentBusy 是唯一的 streaming 闩。app.onSubmit 只在 TuiApp
    // 判定空闲时触发（busy 时输入已被 TuiApp 入队 steerBuffer），故此处无需再自管
    // isStreaming 标志——正是「双门异步清除时机不同」造成 Esc 后死会话的根因。
    // run 生命周期回调（完成/错误/中止）由 bridge 桥接到 TuiApp，并带世代守卫。
    const callbacks = wrapCallbacksWithTuiApp(app!)
    ctx!.agent.run(trimmed, callbacks).catch((err) => {
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
