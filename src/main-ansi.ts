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
import { SteerBuffer } from './tui/steer-buffer.js'
import { killAllSync } from './tools/process-tracker.js'
import { formatUserMessage } from './tui/format/user-message.js'
import { getTheme } from './tui/theme.js'

// ── CLI args ───────────────────────────────────────────────────

const args = process.argv.slice(2)
const modelArgIdx = args.indexOf('--model')
const requestedModel = modelArgIdx >= 0 ? args[modelArgIdx + 1] : undefined
const providerArgIdx = args.indexOf('--provider')
const requestedProvider = providerArgIdx >= 0 ? args[providerArgIdx + 1] : undefined

// ── Lifecycle ──────────────────────────────────────────────────

let app: TuiApp | null = null
let ctx: BootstrapContext | null = null
let steerBuffer: SteerBuffer | null = null
let isStreaming = false

let isShuttingDown = false

function shutdown(code: number = 0) {
  if (isShuttingDown) return
  isShuttingDown = true

  app?.dispose()

  if (ctx) {
    try {
      ctx.persist.compactOai(ctx.session.getMessages())
      ctx.agent.flushStigmergySync()
      ctx.agent.abort()
    } catch (err) {
      try { process.stderr.write(`[T9 shutdown] ${(err as Error)?.message}\n`) } catch { /* noop */ }
    }
    try { ctx.refs.mcpManager?.killChildrenSync?.() } catch { /* best-effort */ }
    void ctx.refs.mcpManager?.shutdown?.()
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

  // ── Build TuiApp ─────────────────────────────────────────────
  const currentModel = ctx.provider.models[0]
  const modelName = currentModel?.alias ?? currentModel?.id ?? 'unknown'

  app = new TuiApp({
    stdout,
    stdin,
    cols: stdout.columns,
    rows: stdout.rows,
    modelName,
    history: [],
  })

  // Register overlays with real data (when available)
  app.registerOverlays()

  // ── SlashRouter ──────────────────────────────────────────────
  const slashRouter = new SlashRouter(app, ctx)
  app.setSlashHandler(async (input) => slashRouter.route(input))

  // ── SteerBuffer ──────────────────────────────────────────────
  steerBuffer = new SteerBuffer()
  app.steerBuffer = steerBuffer

  // ── Wire agent → TuiApp ──────────────────────────────────────
  app.onSubmit((text) => {
    const trimmed = text.trim()
    if (!trimmed) return

    if (isStreaming) {
      // Agent is streaming — push to steer buffer for later injection
      steerBuffer!.push(trimmed)
      return
    }

    // Commit user message to scrollback and start new turn
    const formattedUser = formatUserMessage({
      content: trimmed,
      width: stdout.columns,
    }, theme)

    // Start new turn with bridge callbacks
    isStreaming = true
    const callbacks = wrapCallbacksWithTuiApp(app!, {
      onSteerDrain: () => steerBuffer!.drain(),
      onTurnComplete: (usage, turnNumber, isFinal) => {
        if (isFinal) {
          isStreaming = false
        }
      },
      onError: (_error) => {
        isStreaming = false
      },
      onAbort: () => {
        isStreaming = false
      },
    })
    ctx!.agent.run(trimmed, callbacks).catch((err) => {
      process.stderr.write(`[T9] Agent error: ${(err as Error)?.message}\n`)
      isStreaming = false
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

  // ── Welcome message ──────────────────────────────────────────
  const welcomeLines = [
    `  ╔══════════════════════════════════════════╗`,
    `  ║       天枢 (Tiānshū) — T9 ANSI TUI       ║`,
    `  ║                                          ║`,
    `  ║  Model: ${modelName.padEnd(33)}║`,
    `  ║  CWD:   ${(process.cwd().length > 33 ? '...' + process.cwd().slice(-30) : process.cwd()).padEnd(33)}║`,
    `  ║                                          ║`,
    `  ║  /help     Show commands                 ║`,
    `  ║  /exit     Quit                          ║`,
    `  ║  Ctrl+C    Interrupt / Exit              ║`,
    `  ╚══════════════════════════════════════════╝`,
  ]
  for (const line of welcomeLines) {
    stdout.write(line + '\n')
  }

  process.stderr.write('[T9] Ready. Type a message and press Enter.\n')
}

main().catch((err) => {
  process.stderr.write(`[T9] Fatal: ${(err as Error)?.message}\n`)
  if ((err as Error).stack) {
    process.stderr.write((err as Error).stack! + '\n')
  }
  shutdown(1)
})
