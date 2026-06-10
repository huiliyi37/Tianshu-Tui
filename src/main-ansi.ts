/**
 * T9 ANSI 入口点 — 零 React/Ink 启动路径（实验性骨架）。
 *
 * 当前状态：独立 TuiApp 实例 + 渲染管线验证。
 * AgentLoop 完整接线在后续迭代中完成（需对齐 createAgentConfig API）。
 *
 * 运行方式：
 *   npx tsx src/main-ansi.ts
 *
 * @experimental
 */

import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici'

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
if (proxyUrl) setGlobalDispatcher(new EnvHttpProxyAgent())

import { TuiApp } from './tui/engine/app.js'
import { killAllSync } from './tools/process-tracker.js'

// ── Lifecycle ─────────────────────────────────────────────────

let app: TuiApp | null = null

function shutdown(code: number) {
  app?.dispose()
  if (process.stdin.isTTY && process.stdin.setRawMode) {
    process.stdin.setRawMode(false)
  }
  killAllSync()
  process.exit(code)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

// ── Main ──────────────────────────────────────────────────────

async function main() {
  const stdout = process.stdout
  const stdin = process.stdin

  if (!stdout.isTTY || !stdin.isTTY) {
    process.stderr.write('[T9] stdout and stdin must be TTY.\n')
    process.exit(1)
  }

  // Build TuiApp with engine stack
  app = new TuiApp({
    stdout,
    stdin,
    cols: stdout.columns,
    rows: stdout.rows,
    modelName: process.env.MODEL ?? 'deepseek-v4',
    history: [],
  })
  app.registerOverlays()

  // Clear screen for fresh start
  stdout.write('\x1B[2J\x1B[H')

  // TODO: Wire AgentLoop callbacks via wrapCallbacksWithTuiApp(bridge)
  //       and connect real overlay data sources (starmap, chronicle).
  //       See docs/teamtask/t9_ansi渲染重写_bb78308b.plan.md Phase 6-7.

  process.stderr.write('[T9] ANSI rendering engine loaded.\n')
  process.stderr.write('[T9] Next: wire AgentLoop callbacks + overlay data sources.\n')
}

main().catch((err) => {
  process.stderr.write(`[T9] Fatal: ${(err as Error)?.message}\n`)
  shutdown(1)
})
