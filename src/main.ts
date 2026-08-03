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

// Windows EPERM scandir noise filter — must register before any dependency
// that might trigger fs operations against system-protected directories.
import { installEpermFilter } from './platform/eperm-filter.js'
import { setTargetConventions, applyConfiguredGitBashPath } from './platform.js'
installEpermFilter()

import { bootstrapInteractiveSession, createShutdownHandler, switchAgentRuntime, restorePlanModeFromMeta } from './bootstrap.js'
import type { BootstrapContext } from './bootstrap.js'
import { maybePrintStaticPromptCacheWarning } from './cli/prompt-version-warning.js'
import { loadConfig as loadRivetConfig, setupProvider, setupCustomProvider, setUiConfig, setApprovalMode as persistApprovalDefault, setDefaultDomainConfig, setDefaultModelConfig } from './config/manager.js'
import { isProFeatureEnabled } from './config/pro-license.js'
import type { GoalTracker as GoalTrackerInstance } from './agent/goal-tracker.js'
import { createUpdateGoalTool } from './tools/update-goal.js'
import { presetIncludes } from './tools/tool-preset.js'
import { applySandboxPolicyForApprovalMode } from './tools/sandbox-profile.js'
import { TuiApp } from './tui/engine/app.js'
import { wrapCallbacksWithTuiApp } from './tui/engine/bridge.js'
import { tapAgentCallbacks, type EventSink } from './agent/event-tap.js'
import { createNdjsonEventSink, type EventStreamFile } from './agent/event-stream-sink.js'
import { formatEventForScreenReader } from './tui/screen-reader.js'
import { getPaletteCommands, filterCommands } from './tui/command-palette.js'
import type { PaletteCommand } from './tui/command-palette.js'
import { buildCockpitSnapshot } from './tui/cockpit/state.js'
import { loadTodos, setTodoSession } from './tools/todo.js'
import { setPlanSession } from './agent/plan-store.js'
import {
  nextShiftTabPlanToggle,
  shiftTabPlanToggleHint,
} from './agent/plan-mode.js'
import type { ApprovalMode } from './agent/loop-types.js'
import { statSync } from 'node:fs'
import { join as pathJoin } from 'node:path'
import { formatWelcome } from './tui/format/welcome.js'
import { HANDOFF_NUDGE_RATIO, formatHandoffNudge } from './tui/handoff.js'
import { color } from './tui/engine/ansi.js'
import type { RewindMode } from './tui/format/rewind.js'
import { explainToolRisk } from './agent/risk-explain.js'
import { askSideQuestion } from './agent/side-question.js'
import { collectPostBoundaryEditIds } from './agent/file-history.js'
import { loadHistory, searchHistory } from './tui/history.js'
import { parseScrollbackTranscript } from './tui/scrollback-transcript.js'
import { buildWorkerDetailContent } from './tui/worker-detail.js'
import { killAllSync } from './tools/process-tracker.js'
import { getTheme, getActiveThemeName, setTheme, THEMES, listCustomThemes, resolveThemeEntry, type ThemeName } from './tui/theme.js'
import { loadCustomThemes } from './tui/theme-custom.js'
import { detectTerminalBackground, autoThemeFor } from './tui/theme-detect.js'
import { configureSpinnerVerbs, setReducedMotion } from './tui/format/spinner-status.js'
import { StatusLineRunner } from './tui/statusline.js'
import { buildVerboseTranscript } from './tui/transcript-verbose.js'
import { resolveAppPromptInput, registerTuiSlashCommands, approvePlanAndKickoff } from './tui/slash-commands.js'
import { listPlansSync, rejectPlan } from './plan/plan-store.js'
import { resolveAutoApproveMs, shouldArm } from './tui/plan-auto-approve.js'
import type { PlanPickerEntry } from './tui/format/overlay.js'
import { skillRegistry } from './skills/skill-loader.js'
import { starDomainRegistry } from './agent/star-domain-registry.js'
import { buildDomainPickerEntries, DOMAIN_SWITCH_CACHE_WARNING } from './agent/domain-picker-entries.js'
import { SessionPersist, formatExitSummary } from './agent/session-persist.js'
import { parseSessionCliArgs } from './agent/session-recovery.js'
import { loadConstellation } from './constellation/store.js'
import { formatMilestoneLine } from './constellation/format.js'
import { join } from 'path'
import { execSync } from 'child_process'
import { applyProjectTemplates, recordTemplatesDecision } from './bootstrap/project-templates.js'
import { applyInitCommit, formatInitApplyReport } from './bootstrap/init-scaffold.js'
import { checkForUpdate, formatUpdateBanner, detectInstallRoot, getCurrentVersion } from './tui/updater.js'
import { detectEnv, formatGitMissingBanner } from './tools/env-check.js'
import { computeUsageCost, findModelPricing } from './utils/pricing.js'
import { projectCacheTelemetry } from './tui/cache-telemetry.js'
import { CachePanelSource } from './tui/cache-panel-source.js'
import { sessionsDir } from './config/paths.js'
import { fetchOfficialUsage } from './cache/deepseek-official-usage.js'
import type { CacheStatus } from './tui/status-types.js'
import { TuiPerfMonitor, isTuiPerfEnabled } from './tui/engine/perf-monitor.js'
import { runTuiShutdownSequence } from './tui/engine/shutdown-sequence.js'

// ── CLI args ───────────────────────────────────────────────────

const args = process.argv.slice(2)
const modelArgIdx = args.indexOf('--model')
const requestedModel = modelArgIdx >= 0 ? args[modelArgIdx + 1] : undefined
const providerArgIdx = args.indexOf('--provider')
const requestedProvider = providerArgIdx >= 0 ? args[providerArgIdx + 1] : undefined

// R1: default startup is a fresh session. Session selection flags (Claude Code parity):
//   --continue / -c              → resume the most recent session for this cwd
//   --resume <id|prefix> / -r <id|prefix> → resume a specific session (short prefix ok)
//   --resume / -r (bare)         → open the session picker after the TUI starts
//   --new                        → force a brand-new session
//   --list / `rivet sessions`    → print the session list and exit
// 排查入口（不启动 TUI）：`rivet logs` 列出会话/缓存/六维/桌面日志的落点，
// `rivet logs --json` 输出结构化清单便于上报 issue。
// Resolution + env signalling happens in main() before bootstrap so that
// getOrCreateSessionId picks it up regardless of call order.
const sessionCliArgs = parseSessionCliArgs(args)
const requestedResumeId = sessionCliArgs.resumeId
const wantContinue = sessionCliArgs.continueLatest
const wantSessionPicker = sessionCliArgs.openPicker
const wantNewSession = sessionCliArgs.forceNew
const skipWelcome = args.includes('--skip-welcome')

// --stream-events <path> → mirror the run as NDJSON `SessionEvent`s (the same
// records the sidecar serves to `attach`). A path is required rather than
// optional: in TUI mode stdout is the render surface.
const wantScreenReader = args.includes('--screen-reader')
let screenReaderMode = false

const streamEventsIdx = args.indexOf('--stream-events')
const streamEventsArg = streamEventsIdx >= 0 ? args[streamEventsIdx + 1] : undefined
const streamEventsPath = streamEventsArg && !streamEventsArg.startsWith('-') ? streamEventsArg : undefined
if (streamEventsIdx >= 0 && !streamEventsPath) {
  process.stderr.write('--stream-events requires a file path (stdout is the TUI render surface)\n')
  process.exit(2)
}

// ── Lifecycle ──────────────────────────────────────────────────

let app: TuiApp | null = null
let ctx: BootstrapContext | null = null
// Constructed eagerly but does no I/O until the first event lands.
const eventStream: EventStreamFile | null = streamEventsPath
  ? createNdjsonEventSink(streamEventsPath)
  : null
let heartbeatInterval: ReturnType<typeof setInterval> | null = null
let perfSummaryFlush: Promise<void> = Promise.resolve()

/** advisory status 通道环形缓冲（最近 N 条,cockpit advisory 面板展示） */
const ADVISORY_STATUS_BUFFER_MAX = 20
const advisoryStatusNotices: string[] = []

let isShuttingDown = false

async function shutdown(code: number = 0): Promise<void> {
  if (isShuttingDown) return
  isShuttingDown = true

  await runTuiShutdownSequence({
    dispose: () => { app?.dispose() },
    flushTelemetry: () => perfSummaryFlush,
    cleanup: [
      () => {
        // Delegate core cleanup to bootstrap shutdown handler.
        ctx?.shutdown()
      },
      () => eventStream?.close(),
      () => {
        // Post-teardown resume hint: printed AFTER TUI dispose so it lands on the
        // normal scrollback and survives the exit — the session id would otherwise
        // be undiscoverable ("how do I reconnect?").
        if (ctx) {
          const summary = formatExitSummary(ctx.persist.loadMetadata(), ctx.sessionId)
          if (summary) process.stdout.write(`\n${summary}\n`)
        }
      },
      () => {
        if (heartbeatInterval) {
          clearInterval(heartbeatInterval)
          heartbeatInterval = null
        }
      },
      () => {
        if (process.stdin.isTTY && process.stdin.setRawMode) {
          process.stdin.setRawMode(false)
        }
      },
      () => { killAllSync() },
    ],
    exit: exitCode => process.exit(exitCode),
    reportErrors: error => {
      try {
        const details = error.errors.map(item => item instanceof Error ? item.message : String(item)).join('; ')
        process.stderr.write(`[shutdown] ${error.errors.length} cleanup error(s): ${details}\n`)
      } catch { /* reporting must not block exit */ }
    },
  }, code)
}

process.on('SIGINT', () => { void shutdown(0) })
process.on('SIGTERM', () => { void shutdown(0) })

// Last-resort sync hook: even if shutdown() threw or an uncaughtException
// skipped it, the process-exit event still fires (unless SIGKILL).
//
// Terminal modes come first — an uncaught throw skips shutdown()/dispose()
// entirely, stranding the user with a hidden cursor, bracketed paste still
// armed and the terminal in raw mode (`tput reset` territory). We deliberately
// do NOT register an `uncaughtException` listener to do this: that would
// suppress Node's default crash behaviour for genuine synchronous errors
// (see platform/eperm-filter.ts). This hook fires either way.
//
// MCP child processes (e.g. context7-mcp) are spawned via StdioClientTransport
// and would otherwise orphan to PPID=1, accumulating across dev restarts.
process.on('exit', () => {
  try { app?.restoreTerminalSync() } catch { /* best-effort */ }
  try {
    if (process.stdin.isTTY && process.stdin.setRawMode) process.stdin.setRawMode(false)
  } catch { /* best-effort */ }
  try { ctx?.refs.mcpManager?.killChildrenSync?.() } catch { /* best-effort */ }
})

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

  // rivet serve [--port N] — HTTP+SSE Runtime API (localhost sidecar for 桌面版)
  if (args[0] === 'serve') {
    const { serveCommand } = await import('./server/serve.js')
    await serveCommand(args.slice(1))
    return
  }

  // rivet sessions / rivet --list — print the session list and exit
  if (args[0] === 'sessions' || args.includes('--list')) {
    process.stdout.write(SessionPersist.formatSessionList(process.cwd()) + '\n')
    return
  }

  // rivet browser [status|install [--no-mirror]] — chromium 就绪检查 / 一键安装。
  // 放在 TTY 门与 bootstrap 之前：装浏览器不需要 agent/配置/联网到模型，且新用户
  // 最可能在 TUI 起来前就想先把浏览器备好。
  if (args[0] === 'browser') {
    const { runBrowserCLI } = await import('./cli/browser-cli.js')
    const code = await runBrowserCLI(args.slice(1))
    if (code !== 0) process.exit(code)
    return
  }

  // rivet logs [open [desktop]] [--session <id>] [--json]
  // 日志落点排查。刻意放在 TTY 门与 bootstrap 之前：TUI 起不来（sidecar 崩、
  // 配置坏、非 TTY 管道里）恰恰是最需要知道日志在哪的时候，这条路径不初始化
  // agent、不读配置、不联网。
  if (args[0] === 'logs') {
    const { runLogsCLI } = await import('./diagnostics/logs-cli.js')
    const { output, exitCode } = runLogsCLI(args.slice(1), { cwd: process.cwd() })
    ;(exitCode === 0 ? process.stdout : process.stderr).write(output + '\n')
    if (exitCode !== 0) process.exit(exitCode)
    return
  }

  // rivet web search <query> / rivet web fetch <url> / rivet web status
  // web 工具命令行入口与连通性自检——不经过 agent/LLM，确定性可脚本化。
  // 放在 TTY 门与 bootstrap 之前：纯 CLI（SSH/CI）场景验证代理与 backend 连通性，
  // 不需要初始化 agent、不联网到模型。
  if (args[0] === 'web') {
    const { runWebCLI } = await import('./cli/web-cli.js')
    const code = await runWebCLI(args.slice(1))
    if (code !== 0) process.exit(code)
    return
  }

  // ── Session selection → env signalling for getOrCreateSessionId ──
  // Resolve BEFORE the TTY gate so ambiguous/not-found errors are clear even in
  // a pipe; the env is still set before bootstrap reads it via getOrCreateSessionId.
  if (wantNewSession) {
    process.env.RIVET_NEW_SESSION = '1'
  } else if (requestedResumeId) {
    const resolved = SessionPersist.resolveSessionId(process.cwd(), requestedResumeId)
    if (!resolved) {
      process.stderr.write(`未找到匹配会话: "${requestedResumeId}"。用 rivet --list 查看会话列表。\n`)
      process.exit(1)
    }
    if ('ambiguous' in resolved) {
      process.stderr.write(
        `会话前缀 "${requestedResumeId}" 匹配到多个会话,请用更长前缀:\n` +
        resolved.ambiguous.map(id => `  ${id.slice(0, 12)}`).join('\n') + '\n',
      )
      process.exit(1)
    }
    process.env.RIVET_RESUME_ID = resolved.id
  } else if (wantContinue) {
    process.env.RIVET_RESUME = '1'
  }
  // 裸 --resume / -r（wantSessionPicker）：不设 env——先开新会话，TUI 启动后
  // 自动打开 Chronicle 选择器让用户挑（对齐 Claude Code 裸 -r 行为）。

  // rivet -p "prompt" / rivet --print "prompt" [--json] [--stream-json]
  // rivet --goal "task" [--budget N] [--json] [--stream-json] — headless goal autonomy
  const isHeadless = args.includes('-p') || args.includes('--print') || args.includes('--goal')

  if (isHeadless) {
    const { parseCliArgs, runHeadless } = await import('./headless.js')
    const { loadConfig } = await import('./config/manager.js')
    const { AgentLoop } = await import('./agent/loop.js')
    const { GoalTracker, buildGoalModePrompt } = await import('./agent/goal-tracker.js')
    const { SessionContext } = await import('./agent/context.js')
    const { createAgentConfig, createMainAgentConfigInput } = await import('./agent/create-agent-config.js')
    const { createDefaultToolRegistry } = await import('./tools/default-registry.js')
    const { createDeliverTaskTool } = await import('./agent/deliver-task.js')
    const { createTaskLedger } = await import('./agent/task-ledger.js')
    const { createOwnershipLedger } = await import('./agent/ownership-ledger.js')
    const { createVerificationAttribution } = await import('./agent/verification-attribution.js')
    const { createDeliveryGateV2 } = await import('./agent/delivery-gate-v2.js')
    const { createWorktreeBaseline } = await import('./agent/worktree-baseline.js')
    const { createHeadlessCoordinator } = await import('./agent/headless-coordinator.js')
    const { initializePlugins } = await import('./plugins/plugin-loader.js')
    const { createGalaxyTool } = await import('./tools/galaxy.js')
    const { createStarflowTool } = await import('./tools/starflow.js')
    const { createCouncilConveneTool } = await import('./tools/council-convene.js')
    const { createTeamOrchestrateTool } = await import('./tools/team-orchestrate.js')
    const { DomainKnowledgeStore } = await import('./agent/domain-knowledge-store.js')

    const parsed = parseCliArgs(args)
    // Goal mode drives the same AgentLoop + GoalTracker as the TUI /goal command;
    // the continuation loop runs entirely inside a single agent.run() (see
    // TurnOrchestrator), so the headless path only has to attach the tracker.
    const effectivePrompt = parsed.goal ? buildGoalModePrompt(parsed.goal) : parsed.prompt
    if (!effectivePrompt) {
      process.stderr.write('Usage: rivet -p "<prompt>" [--json] [--stream-json]\n   or: rivet --goal "<task>" [--budget N] [--json] [--stream-json]\n')
      process.exit(2)
    }

    const cfg = loadConfig()
    setTargetConventions(cfg.editor.platform, cfg.editor.eol)
    applyConfiguredGitBashPath(cfg.env.gitBashPath)
    const { buildSearchBackends } = await import('./tools/web-search.js')
    const { buildFetchOptions } = await import('./tools/web-fetch/build-options.js')
    const registryOptions = {
      preset: (await import('./tools/tool-preset.js')).resolveToolPreset(process.cwd()),
      desktopTools: cfg.agent.desktopTools,
      computerUse: (process.platform === 'darwin' || process.platform === 'win32') && process.env.RIVET_COMPUTER_USE !== '0',
      proEnabled: isProFeatureEnabled(cfg, 'computerUse'),
      // 透传 network.{proxy,noProxy}：headless 模式 web_search 也需走代理，
      // 与 web_fetch 对齐（详见 bootstrap.ts 同名调用注释）。
      searchBackends: buildSearchBackends(cfg, {
        proxy: {
          ...(cfg.network.proxy ? { proxyUrl: cfg.network.proxy } : {}),
          ...(cfg.network.noProxy ? { noProxy: cfg.network.noProxy } : {}),
        },
      }),
      fetchOptions: buildFetchOptions(cfg),
    }
    // headless 此前完全忽略 --model/--provider（只有 TUI 路径经
    // bootstrapInteractiveSession 生效）——对齐：显式 flag 优先，缺省走配置默认。
    const provName = requestedProvider ?? cfg.provider.default
    const prov = cfg.provider.providers[provName]
    if (!prov) { process.stderr.write(`Provider not configured: ${provName}. Run: rivet config setup <provider>\n`); process.exit(1) }
    const key = prov.apiKey ?? process.env[prov.apiKeyEnv ?? '']
    if (!key) { process.stderr.write(`API key not set. Export ${prov.apiKeyEnv ?? 'API_KEY'} or run: rivet config setup ${prov.name}\n`); process.exit(1) }

    const model = requestedModel
      ? (prov.models.find(m => m.id === requestedModel || m.alias === requestedModel) ?? prov.models[0]!)
      : prov.models[0]!
    const sessionId = crypto.randomUUID()

    // --budget N (default 100) is the hard turn cap for goal mode; it doubles as
    // the GoalTracker iteration budget so the two limits coincide. Non-goal -p
    // runs keep the original tight 15-turn cap — benchmark/eval harnesses can
    // raise it via RIVET_HEADLESS_MAX_TURNS (JobBench 多文档任务实证 15 轮不够：
    // agent 分析到一半被掐断，交付物残缺但进程仍以 success:false 退出)。
    const goalBudget = parsed.budget ?? 100
    const headlessMaxTurns = parsed.goal
      ? goalBudget
      : Math.max(1, Number(process.env.RIVET_HEADLESS_MAX_TURNS) || 15)
    // Tracker is created inside createAgent (attached to the agent) but referenced
    // here so we can read achievement state after the run completes. A ref object
    // (not a bare let) is used so the opaque runHeadless() call invalidates CFA
    // narrowing — a closure-only assignment would otherwise keep it typed as null.
    const goalTrackerRef: { current: GoalTrackerInstance | null } = { current: null }

    // Load plugins (async, before creating agent — cache discipline: only at session start).
    // Use a pre-filled registry so conflict detection runs against the real built-in tool set,
    // not an empty set. (Wave 1 regression: empty PluginRegistry let every plugin pass.)
    const pluginRegistry = createDefaultToolRegistry([], registryOptions)
    const pluginResult = await initializePlugins(cfg.plugins, pluginRegistry, process.cwd())
    if (pluginResult.warnings.length > 0) {
      process.stderr.write(`[plugins] ${pluginResult.loaded}/${pluginResult.scanned} loaded; warnings: ${pluginResult.warnings.join('; ')}\n`)
    }

    // Extract only the plugin tools (not built-ins) for the real registry.
    const builtinNames = new Set(createDefaultToolRegistry([], registryOptions).getAllNames())
    const pluginTools = pluginRegistry.getAll().filter(t => !builtinNames.has(t.definition.name))

    const result = await runHeadless({
      prompt: effectivePrompt,
      json: parsed.json,
      streamJson: parsed.streamJson,
      sessionId,
      model: model.id,
      createAgent: () => {
        const toolRegistry = createDefaultToolRegistry([], registryOptions)

        // Register plugin tools (loaded during startup, already conflict-checked)
        for (const tool of pluginTools) {
          toolRegistry.register(tool)
        }
        for (const name of pluginResult.suppressTools) {
          toolRegistry.remove(name)
        }

        // B1 deliver_task: headless 模式下也需要交付门禁工具。
        // 无 DelegationCoordinator，reviewDeps 不可用（deliver_task 内部降级处理）。
        const b1TaskLedger = createTaskLedger({ taskId: sessionId })
        // headless 无 pre-existing dirty 概念 — 用空基线
        const b1Baseline = createWorktreeBaseline({
          branch: '', head: '', preExistingDirty: [], preExistingUntracked: [], capturedAt: Date.now(),
        })
        const b1Ownership = createOwnershipLedger({
          baseline: b1Baseline,
          taskLedger: b1TaskLedger,
        })
        const b1Attribution = createVerificationAttribution({ ownership: b1Ownership })
        const b1Gate = createDeliveryGateV2({
          taskLedger: b1TaskLedger,
          ownership: b1Ownership,
          attribution: b1Attribution,
        })
        // W1 回归防线: agent 在工具注册后才创建，经 mutable ref 延迟接线
        const headlessAgentRef: { current: import('./agent/loop.js').AgentLoop | null } = { current: null }
        toolRegistry.register(createDeliverTaskTool(() => ({
          taskLedger: b1TaskLedger,
          ownership: b1Ownership,
          gate: b1Gate,
          isGoalActive: () => goalTrackerRef.current?.isActive() ?? false,
          isGoalAchieved: () => goalTrackerRef.current?.isGoalAchieved() ?? false,
          getLastVerdict: () => goalTrackerRef.current?.getLastVerdict() ?? null,
          getImpactedTests: () => headlessAgentRef.current ? [...headlessAgentRef.current.getEvidenceState().impactedTests] : [],
          // 收编 #2：冗余义务门禁消费（headless 生产注入）
          getObligationStore: () => headlessAgentRef.current?.obligations.getStore()
            ?? { obligations: [] },
          // 证据防火墙 Phase 2：claim tracker（headless 生产注入；hook 未装配时 fail-open）
          getClaimTracker: () => headlessAgentRef.current?.externalClaimTracker?.(),
          scoutFirewallConfig: cfg.agent.scoutEvidenceFirewall,
        })))
        if (presetIncludes(registryOptions.preset, 'update_goal')) {
          toolRegistry.register(createUpdateGoalTool(
            () => goalTrackerRef.current,
            () => ({ sessionId, cwd: process.cwd() }),
          ))
        }

        // Headless DelegationCoordinator — 此前只在 --goal 模式创建（供 goal
        // judge），-p 模式没有任何编排工具可用。常驻创建并注册 galaxy：
        // headless 冒烟/benchmark 需要真实的星河扇出（worker 侧缓存指标经
        // worker cache-log.jsonl 落盘，是预热收益的量化来源）。
        // 注意：必须在 createAgentConfig（取 toolDefinitions）之前注册，
        // 否则模型看不到工具定义——registry 有但 prompt 里没有，工具"不在线"。
        const headlessCoordinator = createHeadlessCoordinator({
          toolRegistry,
          provider: prov,
          providerName: provName,
          apiKey: key,
          auth: undefined,
          cwd: process.cwd(),
          sessionId,
        })
        const headlessGalaxyTool = createGalaxyTool({
          delegateBatch: async (requests, policy, abortSignal, onProgress, onWorkerSettled) =>
            headlessCoordinator.delegateBatch(requests, policy, abortSignal, onProgress, onWorkerSettled),
          // 路由学习（收编 #5）：headless 无 SharedRuntime，per-session 建库即可。
          domainKnowledgeStore: new DomainKnowledgeStore(join(process.cwd(), '.rivet', 'knowledge')),
          // DP 证据冗余（收编 #2）：agent 创建后由 headlessAgentRef 惰性提供。
          get obligationTracker() { return headlessAgentRef.current?.obligations },
        })
        toolRegistry.register(headlessGalaxyTool)

        // starflow — 星流代码级编排（council→team→galaxy 硬门禁状态机）。
        // headless 不注册 council_convene / team_orchestrate（模型不可见），
        // 星流按相同 coordinator 包装等价自构三个子工具实例。
        toolRegistry.register(createStarflowTool({
          councilTool: createCouncilConveneTool({
            delegateBatch: async (requests, policy, abortSignal, onProgress) =>
              headlessCoordinator.delegateBatch(requests, policy, abortSignal, onProgress),
          }),
          teamTool: createTeamOrchestrateTool({
            delegateBatch: async (requests, policy, abortSignal, onProgress, onWorkerSettled) =>
              headlessCoordinator.delegateBatch(requests, policy, abortSignal, onProgress, onWorkerSettled),
            delegate: async (request, abortSignal) => headlessCoordinator.delegate(request, abortSignal),
          }),
          galaxyTool: headlessGalaxyTool,
          cwd: process.cwd(),
        }))

        const agentCfg = createAgentConfig(createMainAgentConfigInput({
          apiKey: key,
          model: { id: model.id, maxTokens: model.maxTokens, contextWindow: model.contextWindow, reasoningEffort: model.reasoningEffort },
          cwd: process.cwd(),
          provider: prov,
          allProviders: cfg.provider.providers,
          config: cfg,
          sessionId,
          toolDefinitions: toolRegistry.getDefinitions(),
          sessionMemoryBlock: undefined,
          auth: undefined,
        }))
        const session = new SessionContext()
        const agent = new AgentLoop({ ...agentCfg, toolRegistry, maxTurns: headlessMaxTurns }, session, process.cwd())
        headlessAgentRef.current = agent
        agent.config.coordinatorRef = () => headlessCoordinator

        if (parsed.goal) {
          const tracker = new GoalTracker({
            goal: parsed.goal,
            maxIterations: goalBudget,
            contextWindow: model.contextWindow ?? 0,
            maxJudgeRuns: agent.config.goalJudge?.maxRuns,
          })
          goalTrackerRef.current = tracker
          agent.setGoalTracker(tracker)
          // Side-path criteria extraction for the completion judge. Async + fail-open:
          // criteria default to a generic template. With the headless coordinator
          // wired, the judge actually runs; without it, it degrades to inconclusive.
          // （coordinator 已在上方常驻创建——goal judge 与 galaxy 共用同一实例。）
          if (agent.config.goalJudge?.enabled !== false) {
            // Fail-closed: browser verification requires interactive TUI approval
            // (web_fetch/browser need permission prompts). Headless degrades to
            // web_fetch-only read-only mode; full browser is disabled.
            if (cfg.agent.goal?.judge?.browser === true) {
              process.stderr.write('[goal] ⚠ goal-judge browser disabled in headless mode — web_fetch read-only only\n')
            }

            const goal = parsed.goal
            void (async () => {
              try {
                const { extractGoalCriteria, completionFromClient, buildCheapClient } = await import('./agent/goal-criteria.js')
                // Prefer dedicated cheap client to avoid sharing main session's client.
                const cheapProfile = cfg.workers?.profiles?.cheap
                const allProviders = agent.config.allProviders ?? {}
                let completion
                if (cheapProfile && allProviders[cheapProfile.provider]) {
                  const cheap = buildCheapClient(cheapProfile, allProviders)
                  completion = cheap
                    ? completionFromClient(cheap.client, cheap.model)
                    : completionFromClient(agent.config.client, model.id)
                } else {
                  completion = completionFromClient(agent.config.client, model.id)
                }
                const criteria = await extractGoalCriteria(goal, completion)
                tracker.setSuccessCriteria(criteria)
                process.stderr.write(`[goal] judge criteria:\n${criteria.map((c, i) => `  ${i + 1}. ${c}`).join('\n')}\n`)
              } catch {
                // non-fatal — judge falls back to wide judgment
                process.stderr.write('[goal] criteria extraction failed — judge will use wide judgment\n')
              }
            })()
          }
        }
        return agent
      },
    })

    if (result.stdout) process.stdout.write(result.stdout + '\n')
    else if (result.json) process.stdout.write(JSON.stringify(result.json) + '\n')
    // In goal mode, success is "goal achieved", not merely "no API error". A run
    // that exhausts the iteration/context budget without the completion marker
    // exits non-zero so CI/scripts can detect incomplete goals.
    const exitCode = parsed.goal
      ? (goalTrackerRef.current?.isGoalAchieved() ? 0 : 1)
      : result.exitCode
    process.exit(exitCode)
  }

  // ── Interactive TUI (requires TTY) ──────────────────────────

  const forceRecoveryCli = process.env.RIVET_FORCE_RECOVERY_CLI === '1'

  if (!forceRecoveryCli && (!stdout.isTTY || !stdin.isTTY)) {
    process.stderr.write('[T9] stdout and stdin must be TTY (use -p for headless mode or RIVET_FORCE_RECOVERY_CLI=1).\n')
    process.exit(1)
  }

  // ── Bootstrap agent runtime ──────────────────────────────────
  process.stderr.write('[T9] Initializing agent runtime...\n')
  maybePrintStaticPromptCacheWarning()

  try {
    ctx = await bootstrapInteractiveSession({
      cwd: process.cwd(),
      args,
      modelId: requestedModel,
      providerName: requestedProvider,
      asyncExtras: true,
    })
  } catch (bootErr) {
    const msg = (bootErr as Error).message ?? ''
    if (msg.includes('No API key') || msg.includes('not configured')) {
      process.stderr.write(`\n[T9] ${msg}\n\n`)
      process.stderr.write('Running first-time setup wizard...\n\n')
      const { runProviderConfigWizard } = await import('./config/provider-wizard.js')
      const result = await runProviderConfigWizard()
      // 用户跳过 wizard——降级启动（无 key 进 TUI，发消息时报错指引配 key）。
      // 与桌面端「先进界面再提醒」体验对齐，不让新用户被困在启动门。
      if (result.skipped) {
        process.stderr.write('\nStarting in degraded mode (no API key). Configure via /config or `rivet config setup`.\n\n')
        ctx = await bootstrapInteractiveSession({
          cwd: process.cwd(),
          args,
          modelId: requestedModel,
          providerName: requestedProvider,
          asyncExtras: true,
          allowMissingKey: true,
        })
      } else {
        process.stderr.write('\nRestarting with new configuration...\n\n')
        ctx = await bootstrapInteractiveSession({
          cwd: process.cwd(),
          args,
          modelId: requestedModel,
          providerName: requestedProvider,
          asyncExtras: true,
        })
      }
    } else {
      throw bootErr
    }
  }

  // ── 主题装载 ──────────────────────────────────────────────────
  // 1. 注册 ~/.rivet/themes/*.json 自定义主题（custom:<name> 引用）
  // 2. 解析配置值：'auto' → OSC 11 背景检测（500ms 超时，COLORFGBG 兜底）
  //    → cobalt(dark)/paper(light)；未配置时保持向后兼容的 tianshu。
  // 3. setTheme 对未知名（如自定义主题文件被删）no-op，落到 tianshu 兜底。
  loadCustomThemes()
  const configuredTheme = ctx.config.ui?.theme ?? 'tianshu'
  let themeName: string = configuredTheme
  if (configuredTheme === 'auto') {
    // 必须在 TUI 接管 stdin 前查询——此处 raw-mode 探测后即恢复。
    const detected = await detectTerminalBackground()
    themeName = autoThemeFor(detected)
    if (process.env['RIVET_DEBUG']) {
      process.stderr.write(`[T9] Theme auto-detect: ${detected} background → ${themeName}\n`)
    }
  }
  if (!setTheme(themeName)) setTheme('tianshu')
  const theme = getTheme()

  // ── Spinner 词池 / reducedMotion 配置接线 ─────────────────────
  if (ctx.config.ui?.spinnerVerbs?.length) {
    configureSpinnerVerbs(ctx.config.ui.spinnerVerbs, ctx.config.ui.spinnerVerbsMode ?? 'replace')
  }
  if (ctx.config.ui?.reducedMotion) setReducedMotion(true)

  // 读屏档是 reducedMotion 的超集：冻结字形还不够，会反复被朗读的是每 120ms
  // 的重绘本身。CLI 开关优先于配置。
  screenReaderMode = wantScreenReader || ctx.config.ui?.screenReader === true
  if (screenReaderMode) {
    setReducedMotion(true)
    app?.setScreenReader(true)
  }

  // Provider/Model/Session 已在欢迎屏头部展示，常规启动不再重复打印。
  if (process.env['RIVET_DEBUG']) {
    process.stderr.write(`[T9] Provider: ${ctx.provider.name}, Model: ${ctx.config.provider.default}\n`)
    process.stderr.write(`[T9] Session: ${ctx.sessionId.slice(0, 8)}...\n`)
  }

  // Store heartbeat for shutdown cleanup
  heartbeatInterval = ctx.heartbeatInterval

  // ── Advisory status 通道点亮（dark cockpit 单感官通道）──────────
  // status 条目不进 prompt、不占 Top-N 预算,只落环形缓冲进 cockpit
  // advisory 面板。未设 sink 的路径(server/desktop)保持 bus 回退。
  ctx.agent.advisoryBus.setStatusSink(entries => {
    for (const e of entries) {
      advisoryStatusNotices.push(e.content)
    }
    if (advisoryStatusNotices.length > ADVISORY_STATUS_BUFFER_MAX) {
      advisoryStatusNotices.splice(0, advisoryStatusNotices.length - ADVISORY_STATUS_BUFFER_MAX)
    }
  })

  // ── Recovery CLI fallback ────────────────────────────────────
  if (forceRecoveryCli) {
    const { runRecoveryCli } = await import('./recovery-cli.js')
    await runRecoveryCli(ctx)
    await shutdown(0)
    return
  }

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
    // 审批时判定工作区外路径，显示「批准并记住此目录」选项。
    cwd: ctx.cwd,
    perfMonitor: new TuiPerfMonitor({ enabled: isTuiPerfEnabled(args) }),
    onPerfSummary: summary => {
      perfSummaryFlush = ctx!.flushTuiPerfSummary(summary)
    },
  })

  // Register overlays with real data
  // app 在此处必定非 null（前有 app = new TuiApp 赋值，无重赋 null 路径）
  const tuiApp = app!
  tuiApp.setApprovalMode(ctx!.config.agent.approval ?? 'auto-safe')
  // 审批提示的 Ctrl+E 风险解释：侧路请求，只在按键时才发。
  tuiApp.setRiskExplainer(async (toolName, input) => explainToolRisk({
    client: ctx?.agent.config.client,
    promptEngine: ctx!.agent.config.promptEngine,
    getMessages: () => ctx?.session.getMessages() ?? [],
    contextWindow: ctx!.agent.config.contextWindow,
    recordUsage: (usage, model) => ctx?.agent.recordSidePathUsage('risk-explain', usage, model),
  }, { toolName, input }))
  // `/btw` 侧问：同一条侧路纪律，流式回填浮层。
  tuiApp.setSideQuestionAsker(async (question, onDelta) => askSideQuestion({
    client: ctx?.agent.config.client,
    promptEngine: ctx!.agent.config.promptEngine,
    getMessages: () => ctx?.session.getMessages() ?? [],
    contextWindow: ctx!.agent.config.contextWindow,
    recordUsage: (usage, model) => ctx?.agent.recordSidePathUsage('side-question', usage, model),
  }, { question, onDelta }))
  // Plan submit 成功后自动弹出审批面板（替代手动 /plan-approve）。
  ctx!.agent.onPlanApprovalRequested = (info) => {
    // 工具执行期间直接推 overlay 可能与 turn 收尾渲染冲突，defer 到下一事件循环。
    // 预览摘要在开面板时一次性读取（避免渲染路径每帧读盘；修订重提同 slug 也能取到新内容）。
    setImmediate(() => tuiApp.openPlanApprovalPanel(info, planExcerptFor(info.slug)))
    // Goal 模式倒计时自动批准（2026-07-24，与 sidecar 同语义同 env）：
    // goal 激活 + 窗口开启才武装；非 goal 会话保持纯手动审批。
    const delayMs = resolveAutoApproveMs()
    if (shouldArm(ctx!.refs.goalTrackerRef.current?.isActive() === true, delayMs)) {
      tuiApp.armPlanAutoApprove(info.slug, delayMs)
    }
  }
  // 倒计时触发守卫：idle（非运行中）+ goal 仍激活 + 计划仍 submitted。
  tuiApp.planAutoApproveGuardsProvider = () => ({
    idle: !tuiApp.isAgentBusy,
    goalActive: ctx!.refs.goalTrackerRef.current?.isActive() === true,
    planStillSubmitted: listPlansSync(ctx!.agent.cwd).find(p => p.slug === tuiApp.planAutoApproveSlug)?.status === 'submitted',
  })
  // 倒计时到期 → 自动批准并执行（默认方案：Recommended 否则首个，与面板 approve 同逻辑）。
  tuiApp.onPlanAutoApproveFire = (slug) => {
    const plan = listPlansSync(ctx!.agent.cwd).find(p => p.slug === slug)
    const option = plan?.options?.find(o => o.label.includes('Recommended')) ?? plan?.options?.[0]
    tuiApp.commitStatic(`⏳ Goal 模式：倒计时结束，自动批准计划「${plan?.title ?? slug}」并执行`)
    void approvePlanAndKickoff(
      {
        cwd: ctx!.agent.cwd,
        agent: ctx!.agent,
        submitToAgent: (prompt: string) => { tuiApp.submitText(prompt) },
        notify: (content: string, isError?: boolean) => tuiApp.commitStatic(content, { isError }),
      },
      slug,
      option?.label,
    )
  }
  // ask_user_question 含单选选项时自动弹出选择面板（替代手动输入编号）。
  ctx!.agent.onAskUserQuestionRequested = (info) => {
    setImmediate(() => tuiApp.openAskUserQuestionPanel(info))
  }
  const initialDomain = ctx!.agent.getSessionDomain()?.name
  if (initialDomain) {
    tuiApp.setSessionStarDomain(initialDomain)
  }
  tuiApp.setDomainSyncProvider(() => ctx!.agent.getSessionDomain()?.name ?? undefined)
  // 实时思考强度：优先 agent 当前生效 effort（auto-reasoning 动态调整），回退 config floor。
  tuiApp.setReasoningEffortProvider(() => ctx!.agent.getReasoningEffort() ?? ctx!.agent.config.reasoningEffort)

  // ── GlanceBar 密度默认档 + 可脚本化 statusline 接线 ─────────────
  if (ctx!.config.ui?.glanceDensity) tuiApp.glanceDensity = ctx!.config.ui.glanceDensity
  let statusLineTimer: ReturnType<typeof setInterval> | null = null
  if (ctx!.config.ui?.statusLine?.command) {
    const slConfig = ctx!.config.ui.statusLine
    const runner = new StatusLineRunner(slConfig, text => tuiApp.setStatusLine(text))
    const pushStatusLine = (): void => {
      const metrics = tuiApp.getMetrics()
      runner.refresh({
        session_id: ctx!.sessionId,
        model: { display_name: tuiApp.getModelInfo().modelName },
        workspace: { current_dir: process.cwd() },
        git: { branch: gitBranch },
        context: metrics?.maxTokens
          ? { ratio: (metrics.estimatedTokens ?? 0) / metrics.maxTokens, estimated_tokens: metrics.estimatedTokens, max_tokens: metrics.maxTokens }
          : undefined,
        cost: { total_yuan: metrics?.cost },
      })
    }
    pushStatusLine()
    statusLineTimer = setInterval(pushStatusLine, Math.max(1000, slConfig.intervalMs ?? 3000))
    statusLineTimer.unref?.()
  }

  // ── 会话级 UI 状态恢复（side panel / todo）─────────────────────
  const initialMeta = ctx!.persist.loadMetadata()
  if (initialMeta?.sidePanelOpen) {
    tuiApp.setSidePanelOpen(true)
  }
  loadTodos(ctx!.sessionId, ctx!.cwd)
  setTodoSession(ctx!.sessionId, ctx!.cwd)
  setPlanSession(ctx!.sessionId)
  tuiApp.setSidePanelChangeCallback((open) => {
    ctx!.persist.updateMetadata({ sidePanelOpen: open })
  })

  // ── /cache 面板数据源 ─────────────────────────────────────────
  // 本会话实时口径与 GlanceBar 同源（getTotalUsage + getRecentTurnHitRate），
  // 历史走跨会话聚合器，官方账单走共享凭证降级链。三者都在 source 内做 TTL 缓存。
  const cachePanelSource = new CachePanelSource({
    sessionsRoot: () => sessionsDir(ctx!.cwd),
    resolvePricing: model => findModelPricing(
      ctx?.agent.config.allProviders ?? {},
      ctx?.agent.config.providerName,
      model,
    ),
    session: () => {
      if (!ctx) return null
      const total = ctx.session.getTotalUsage()
      if (!total.input_tokens && !total.output_tokens) return null
      const pricing = findModelPricing(
        ctx.agent.config.allProviders ?? {},
        ctx.agent.config.providerName,
        ctx.agent.config.promptEngine.getModel(),
      )
      const cacheRead = total.cache_read_input_tokens ?? 0
      const savings = pricing
        ? cacheRead / 1_000_000 * Math.max(0, (pricing.input ?? 0) - (pricing.cacheRead ?? pricing.input ?? 0))
        : null
      return {
        hitRate: ctx.session.getRecentTurnHitRate(3) ?? ctx.session.getCacheHitRate(),
        input: total.input_tokens,
        output: total.output_tokens,
        cacheRead,
        cacheCreate: total.cache_creation_input_tokens ?? 0,
        cost: pricing ? computeUsageCost(total, pricing).total : null,
        savings,
      }
    },
    loadOfficial: () => {
      const provider = ctx?.provider
      const apiKey = provider?.apiKey ?? (provider?.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
      return fetchOfficialUsage({ apiKey, baseUrl: provider?.baseUrl })
    },
    onUpdate: () => { tuiApp.refreshOverlay('cache') },
  })

  // 命令面板的过滤列表：display 与 paletteExec 必须共用同一份（含实时 query 过滤 + 排序），
  // 否则选中索引会错位（Enter 执行到错误命令）。
  const filteredPaletteCommands = (): PaletteCommand[] => {
    const base = getPaletteCommands().filter(c => c.name.startsWith('/') || c.name.startsWith('__surface:'))
    return filterCommands(base, tuiApp.getOverlayQuery())
  }
  // 待批计划(submitted)映射为 plan-picker 条目。同步读盘,供渲染 provider 与
  // Shift+Tab 触发判定共用。多方案计划附上方案标签。
  const pendingPlanPickerEntries = (): PlanPickerEntry[] => {
    try {
      return listPlansSync(ctx!.agent.cwd)
        .filter(p => p.status === 'submitted')
        .map(p => ({
          slug: p.slug,
          title: p.title,
          status: p.status,
          createdAt: p.createdAt.toLocaleString(),
          options: p.options?.map(o => o.label),
        }))
    } catch {
      return []
    }
  }
  // 审批卡片的计划正文预览：剥 frontmatter 与 Status/Model 留痕行后取前 6 行
  // 非空行（截 76 列）。读不到计划（已删/盘外）返回 undefined，面板退化为纯标题。
  const planExcerptFor = (slug: string): string | undefined => {
    try {
      const doc = listPlansSync(ctx!.agent.cwd).find(p => p.slug === slug)
      if (!doc) return undefined
      const rawLines = doc.content.split('\n')
      // 仅剥开头一处 frontmatter（--- ... ---），正文中的 --- 分隔线保留。
      let start = 0
      if (rawLines[0]?.trim() === '---') {
        const close = rawLines.findIndex((l, i) => i > 0 && l.trim() === '---')
        if (close > 0) start = close + 1
      }
      const out: string[] = []
      for (const raw of rawLines.slice(start)) {
        const t = raw.trim()
        if (!t) continue
        if (t.startsWith('> **Status:') || t.startsWith('> **Model:')) continue
        out.push(t.length > 76 ? `${t.slice(0, 75)}…` : t)
        if (out.length >= 6) break
      }
      return out.length > 0 ? out.join('\n') : undefined
    } catch {
      return undefined
    }
  }
  tuiApp.registerOverlays({
    // Pager — scrollback 内容 或 当前选中 worker 的 detail（用于 /tasks Enter）
    pagerContent: () => {
      // Job 日志（/jobs Enter）— 优先于 worker detail
      const jobId = tuiApp.getJobDetailId()
      if (jobId) {
        const text = tuiApp.getJobDetailView(jobId)
        if (text) {
          return {
            content: text,
            page: 0,
            title: `后台任务日志: ${jobId}`,
            messages: parseScrollbackTranscript(text),
          }
        }
      }
      const workerId = tuiApp.getWorkerDetailId()
      if (workerId) {
        const liveView = tuiApp.getWorkerDetailView(workerId)
        const { content, title, messages } = buildWorkerDetailContent(workerId, process.cwd(), liveView)
        return {
          content,
          page: 0,
          title,
          messages,
        }
      }
      // verbose 层（`v` 切换）：从会话真实历史重建含完整工具输出的转录
      if (tuiApp.isPagerVerbose()) {
        const verbose = buildVerboseTranscript(ctx!.session.getMessages())
        return {
          content: verbose.content || '(no messages yet)',
          page: 0,
          title: 'Transcript',
          messages: verbose.messages,
        }
      }
      const content = tuiApp.getScrollbackContent() || '(no messages yet)'
      return {
        content,
        page: 0,
        title: 'Scrollback',
        messages: parseScrollbackTranscript(content),
      }
    },
    // Starmap
    starmapEntries: () => {
      const domains = starDomainRegistry.list()
      const constellation = ctx ? loadConstellation(ctx.cwd) : null
      const milestones = constellation
        ? constellation.milestones.slice(-5).reverse().map(m => formatMilestoneLine(m))
        : []
      const activeDomainName = tuiApp.getDomainName?.()
      return {
        entries: domains.map(d => ({
          name: d.name,
          glyph: d.uiPersona.glyph,
          description: d.motto ?? '',
          active: activeDomainName != null && (d.name === activeDomainName || d.id === activeDomainName),
          accent: d.uiPersona.accent,
        })),
        milestones,
      }
    },
    // Command palette — 实时 query 过滤（与 paletteExec 共用 filteredPaletteCommands）
    paletteCommands: () => {
      const cmds = filteredPaletteCommands()
      return {
        commands: cmds.map(c => ({ label: c.name, description: c.description, hotkey: c.hotkey })),
        selectedIndex: 0,
        searchText: tuiApp.getOverlayQuery() || undefined,
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
        advisoryStatusNotices,
      })
    },
    // Rewind — 最近用户消息（携带真实 messageIndex 作为回溯边界）
    rewindEntries: () => {
      const messages = ctx?.session.getMessages() ?? []
      const all: { index: number; messageIndex: number; content: string }[] = []
      let ord = 0
      messages.forEach((m, i) => {
        if (m.role === 'user' && typeof m.content === 'string') {
          ord++
          all.push({ index: ord, messageIndex: i, content: m.content })
        }
      })
      return { entries: all.slice(-30), selectedIndex: 0 }
    },
    // Rewind phase 2 — 摘要动作的缓存代价是否值得标注（非前缀缓存 provider 不标）
    rewindCachePreserving: () => ctx?.agent.compaction.isCachePreservingProvider() ?? false,
    // Rewind phase 2 — 精确到选中消息的代码回滚会影响哪些文件
    rewindFilePreview: (messageIndex: number) => {
      const fh = ctx?.agent.getFileHistory()
      if (!fh) return []
      const messages = ctx?.session.getMessages() ?? []
      return fh.getBoundaryFiles(collectPostBoundaryEditIds(messages, messageIndex))
    },
    // Chronicle
    chronicleEntries: () => {
      try {
        // listMainSessions 已读 meta 并按 updatedAt 排序,与 /resume 序号同源。
        const sessions = SessionPersist.listMainSessions(process.cwd()).slice(0, 20)
        const entries = sessions.map((s, i) => {
          const title = (s.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 60)
          const turns = s.turnCount ?? 0
          const model = s.model ?? '?'
          return {
            index: i + 1,
            time: s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '',
            summary: `${s.id.slice(0, 8)}  ${turns}轮 ${model}${title ? '  ' + title : ''}`,
            current: s.id === ctx!.sessionId,
            id: s.id,
          }
        })
        return { entries }
      } catch {
        return { entries: [] }
      }
    },
    // History search — Ctrl+R 反向搜索（searchHistory 评分排序：前缀 +10 / 词命中 +5）
    historySearchData: () => {
      const query = tuiApp.getOverlayQuery()
      const all = loadHistory()
      const filtered = query ? searchHistory(query, 50) : all.slice(0, 50)
      return {
        entries: filtered,
        selectedIndex: 0,
        query,
      }
    },
    // Tasks — /tasks 显示子代理（per-worker，来自舰队读模型；filter 由 overlay nav 决定）
    tasksData: () => tuiApp.getTasksData(),
    // Jobs — /jobs 显示后台 shell 任务（来自 TUI job 读模型）
    jobsData: () => tuiApp.getJobsData(),
    // Cache — /cache DeepSeek 缓存面板（period 由 overlay nav 注入）
    cachePanelData: () => cachePanelSource.data(),
    // Domain Picker — 裸 /domain 打开的 CC 风星域选择器（entries 由共享 builder 构造）
    domainPickerData: () => ({
      entries: buildDomainPickerEntries(ctx!.agent.getSessionDomain()),
      selectedIndex: 0,
    }),
    modelPickerData: () => {
      const activeModelId = ctx?.agent.config.promptEngine.getModel()
      const entries: { id: string; alias: string; provider: string; current: boolean; contextWindow: number }[] = []
      for (const [provName, prov] of Object.entries(ctx?.config.provider.providers ?? {})) {
        for (const m of prov.models) {
          entries.push({
            id: m.id,
            alias: m.alias ?? m.id,
            provider: provName,
            current: m.id === activeModelId,
            contextWindow: m.contextWindow,
          })
        }
      }
      return {
        entries,
        selectedIndex: 0,
      }
    },
    themePickerData: () => {
      const currentTheme = getActiveThemeName()
      const defaultTheme = ctx?.config.ui?.theme
      // 内置主题 + ~/.rivet/themes/*.json 自定义主题（custom: 前缀）。
      // 描述从主题元数据取（theme-palettes.ts 单一事实来源）。
      const builtins = (Object.keys(THEMES) as ThemeName[]).map(t => ({
        name: t as string,
        current: t === currentTheme,
        isDefault: t === defaultTheme,
        description: THEMES[t].description,
      }))
      const customs = listCustomThemes().map(n => {
        const key = `custom:${n}`
        return {
          name: key,
          current: key === currentTheme,
          isDefault: key === defaultTheme,
          description: resolveThemeEntry(key)?.description ?? 'Custom color theme',
        }
      })
      return {
        entries: [...builtins, ...customs],
        selectedIndex: 0,
      }
    },
    // Effort / Permission 选择面板——/effort 或 /permission 无参数时弹出，上下选择 + 回车确认。
    choicePanelData: () => {
      if (tuiApp.choicePanelKind === 'permission') {
        const current = ctx?.agent.config.approvalMode ?? 'auto-safe'
        const entries = [
          { id: 'manual', label: 'Manual', description: '每个高风险工具都弹确认。最大控制，适合敏感项目。', current: current === 'manual' },
          { id: 'auto-safe', label: 'Auto', description: '低/无风险工具自动执行，高风险仍需确认。可配每 N 轮暂停检查点。', current: current === 'auto-safe', recommended: true },
          { id: 'dangerously-skip-permissions', label: 'YOLO', description: '全自动执行，无审批打扰；写边界仍在（沙箱自动开启），仅工作区外写会询问。回滚兜底（/rollback + git 检查点）。需二次确认。', current: current === 'dangerously-skip-permissions' },
        ]
        return { title: '权限模式 / Permission', choices: entries, selectedIndex: Math.max(0, entries.findIndex(e => e.current)) }
      }
      if (tuiApp.choicePanelKind === 'permission-yolo-confirm') {
        const entries = [
          { id: 'cancel', label: '取消', description: '保持当前权限模式不变。', current: true },
          { id: 'confirm-yolo', label: '⚠ 确认进入 YOLO', description: '无轮次刹车 · 无进度播报 · 所有工具直接执行（沙箱仍拦项目外写入）。回滚兜底：/rollback + git 检查点。也可直接输入 /yes。设为默认后重启仍是 YOLO。' },
        ]
        return { title: '确认 YOLO 模式 / Confirm YOLO', choices: entries, selectedIndex: 0 }
      }
      if (tuiApp.choicePanelKind === 'plan-approval') {
        const info = tuiApp.pendingPlanApproval
        const title = info?.title ?? '待审批计划'
        // 标题区附计划正文预览（开面板时提取，剥掉 frontmatter/留痕行的前 6 行）。
        const excerpt = tuiApp.planApprovalExcerpt
        // Goal 倒计时行：每次渲染重算剩余秒（armed 时 1s tick 驱动重绘）。
        const countdown = tuiApp.planAutoApproveRemainSec
        const countdownLine = countdown !== undefined
          ? `\n⏳ Goal 模式：${countdown}s 后自动批准（批准/驳回即取消；Esc 收起不取消）`
          : ''
        const fullTitle = excerpt
          ? `计划审批 / Plan Approval\n「${title}」${countdownLine}\n──\n${excerpt}`
          : `计划审批 / Plan Approval\n「${title}」${countdownLine}`
        const entries = []
        const options = info?.options ?? []
        if (options.length > 1) {
          // 多方案计划：每个方案一个「批准并执行」条目，Recommended 带 ★ 并预定位光标。
          for (const [i, o] of options.entries()) {
            const recommended = /recommended/i.test(o.label)
            const cleanLabel = o.label.replace(/\s*[(（]?\s*recommended\s*[)）]?/i, '').trim()
            entries.push({
              id: `approve:${i}`,
              label: `批准并执行 — ${cleanLabel}`,
              description: o.description || `以方案「${cleanLabel}」执行计划`,
              recommended,
            })
          }
        } else {
          entries.push({ id: 'approve', label: '批准并执行', description: `执行计划「${title}」`, recommended: true })
        }
        entries.push(
          { id: 'reject', label: '驳回修订', description: '标记为 REJECTED，agent 可继续修改' },
          { id: 'reject-exit', label: '驳回并退出计划模式', description: '驳回计划并退出 plan mode' },
          { id: '__reject_comment__', label: '驳回并填写反馈…', description: '输入反馈后驳回，agent 可继续修订' },
        )
        const recommendedIndex = Math.max(0, entries.findIndex(e => e.recommended))
        return { title: fullTitle, choices: entries, selectedIndex: recommendedIndex, inputSubMode: tuiApp.getChoicePanelInputState() }
      }
      if (tuiApp.choicePanelKind === 'ask-user-question') {
        // ask 面板走 app.ts 的 Tab 化专用渲染器（buildAskPanelData），
        // 不经过通用 choicePanelData 管线——这里是不可达的兜底。
        return { title: '', choices: [], selectedIndex: 0 }
      }
      const current = ctx?.agent.getReasoningEffort() ?? ctx?.agent.config.reasoningEffort ?? 'high'
      const isAuto = ctx?.agent.config.autoReasoning && !ctx?.agent.userReasoningOverride
      const entries: Array<{ id: string; label: string; description: string; recommended?: boolean; current?: boolean }> = [
        { id: 'auto', label: 'Auto', description: '按任务复杂度自动选档（架构/安全/根因→max，重构/调试→high，查看→low）', recommended: isAuto, current: isAuto },
        { id: 'max', label: 'Max', description: '完整推理链。最深度思考，适合架构设计、安全审查、根因排查', current: !isAuto && current === 'max' },
        { id: 'high', label: 'High', description: '认真推理。复杂重构、bug 修复、功能实现', current: !isAuto && current === 'high' },
        { id: 'medium', label: 'Medium', description: '标准编码。常规改动、添加测试', current: !isAuto && current === 'medium' },
        { id: 'low', label: 'Low', description: '轻量推理。简单查询、读取文件', current: !isAuto && current === 'low' },
        { id: 'off', label: 'Off', description: '关闭思考。最快响应，纯执行', current: !isAuto && current === 'off' },
      ]
      return { title: '推理强度 / Reasoning Effort', choices: entries, selectedIndex: Math.max(0, entries.findIndex(e => e.current)) }
    },
    // Plan Picker — /plan-approve 无参打开的待批计划选择器。
    // 同步读盘（渲染路径不能 await），只列出等待批准的 submitted 计划。
    planPickerData: () => ({ entries: pendingPlanPickerEntries(), selectedIndex: 0 }),
  }, /* paletteExec: */ (index: number) => {
    // Command palette Enter 回调：执行选中命令。
    // 必须用与 display 相同的过滤后列表，否则 query 过滤时索引错位。
    const cmds = filteredPaletteCommands()
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
      } else if (name === '/cache') {
        tuiApp.activateOverlay('cache')
      } else {
        tuiApp.setInput(name + ' ')
      }
    }
  }, /* rewindExec: */ (messageIndex: number, mode: RewindMode) => {
    // Rewind Enter 回调：按选择的粒度恢复（仅对话 / 仅代码 / 对话+代码），
    // 或对选定区段做定点摘要（/compact 压全部，这里只压用户圈定的一段）。
    const messages = ctx?.session.getMessages() ?? []
    const target = messages[messageIndex]
    const content = target && typeof target.content === 'string' ? target.content : ''

    if (mode === 'summarize-from' || mode === 'summarize-to') {
      const scope = mode === 'summarize-from' ? 'from' : 'to'
      tuiApp.commitStatic(`⏳ 正在摘要${scope === 'from' ? '此消息之后' : '此消息之前'}的对话…`)
      void ctx?.agent.compaction.summarizeRange({ scope, messageIndex }).then(
        result => {
          if (!result.ok) {
            tuiApp.commitStatic(`摘要失败：${result.reason}`, { isError: true })
            return
          }
          const saved = result.beforeTokens - result.afterTokens
          tuiApp.commitStatic(
            `⏪ 已把 ${result.replaced} 条消息压成摘要 — ${result.beforeTokens} → ${result.afterTokens} tokens（省 ${saved}）`,
          )
        },
        err => tuiApp.commitStatic(`摘要失败：${(err as Error).message}`, { isError: true }),
      )
      return
    }

    const doCode = mode === 'code' || mode === 'both'
    const doConvo = mode === 'convo' || mode === 'both'

    if (doCode) {
      const fh = ctx?.agent.getFileHistory()
      if (fh) {
        const ids = collectPostBoundaryEditIds(messages, messageIndex)
        fh.rewindToBoundary(ids).then(
          changed => tuiApp.commitStatic(`⏪ 已把 ${changed.length} 个文件恢复到此消息${changed.length ? '' : '（无可恢复的编辑）'}`),
          err => tuiApp.commitStatic(`回滚代码失败：${(err as Error).message}`),
        )
      } else {
        tuiApp.commitStatic('无文件历史，无法恢复代码。')
      }
    }

    if (doConvo && messageIndex >= 0) {
      ctx!.session.rewindToMessages(messages.slice(0, messageIndex))
      ctx!.agent.config.promptEngine.resetAppendixBaseline()
      tuiApp.commitStatic('⏪ 已截断对话到此消息 — 已回填输入框。')
      tuiApp.setInput(content)
    }
  }, /* chronicleExec: */ (id: string) => {
    // Chronicle Enter 回调：直接切换到所选会话（对齐 Claude Code 选择器一步到位）。
    // 经 /resume slash 命令派发,复用同一条恢复链路(onSessionSwitch:
    // 消息历史 + todos + goal + 侧栏 + 计划模式),含"已在当前会话"守卫。
    void tuiApp.tryDispatchSlash(`/resume ${id}`)
  }, /* domainPickerExec: */ (key: string) => {
    // Domain Picker Enter 回调：应用选中星域，引擎照常注入方法论，scrollback 仅写单行确认。
    const midSession = ctx!.agent.getSessionTurnCount() > 0
    if (key === 'auto') {
      ctx!.agent.resetSessionDomain()
      tuiApp.setSessionStarDomain(undefined)
      tuiApp.commitStatic('Domain → Auto（按任务匹配）')
    } else {
      const d = starDomainRegistry.get(key)
      if (d) {
        ctx!.agent.setSessionDomain({ id: d.id, name: d.name, volatileBlock: d.volatileBlock, motto: d.motto, courageThreshold: d.courageThreshold })
        tuiApp.setSessionStarDomain(d.name)
        tuiApp.commitStatic(`Domain → ${d.name} (${d.decisionStyle})`)
      } else {
        return
      }
    }
    if (midSession) tuiApp.commitStatic(DOMAIN_SWITCH_CACHE_WARNING)
  }, /* modelPickerExec: */ (modelId: string) => {
    // Model Picker Enter 回调：执行模型切换。
    try { ctx!.agent.abort() } catch {}
    const res = switchAgentRuntime(ctx!, modelId)
    if (res.ok && res.modelName) {
      tuiApp.setModelInfo(res.modelName, res.contextWindow)
      attachJobSubscription()
      tuiApp.commitStatic(`Model switched to: ${res.modelName}`)
    } else {
      tuiApp.commitStatic(`⚠️ Model switch failed: ${res.error ?? 'unknown error'}`)
    }
  }, /* domainPickerSaveDefaultExec: */ (key: string) => {
    // Domain Picker S 键回调：应用星域 + 设为默认并持久化。
    const midSession = ctx!.agent.getSessionTurnCount() > 0
    if (key === 'auto') {
      ctx!.agent.resetSessionDomain()
      tuiApp.setSessionStarDomain(undefined)
      tuiApp.commitStatic('Domain → Auto（按任务匹配）')
    } else {
      const d = starDomainRegistry.get(key)
      if (d) {
        ctx!.agent.setSessionDomain({ id: d.id, name: d.name, volatileBlock: d.volatileBlock, motto: d.motto, courageThreshold: d.courageThreshold })
        tuiApp.setSessionStarDomain(d.name)
        tuiApp.commitStatic(`Domain → ${d.name} (${d.decisionStyle})`)
      } else {
        tuiApp.commitStatic(`⚠️ 未知星域: ${key}`)
        return
      }
    }
    try { setDefaultDomainConfig({ defaultDomain: key }) } catch (err) {
      tuiApp.commitStatic(`⚠️ 设置默认失败: ${(err as Error).message}`)
    }
    if (midSession) tuiApp.commitStatic(DOMAIN_SWITCH_CACHE_WARNING)
  }, /* modelPickerSaveDefaultExec: */ (provider: string, modelId: string) => {
    // Model Picker S 键回调：切换模型 + 设为默认并持久化。
    try { ctx!.agent.abort() } catch {}
    const res = switchAgentRuntime(ctx!, modelId)
    if (res.ok && res.modelName) {
      tuiApp.setModelInfo(res.modelName, res.contextWindow)
      attachJobSubscription()
      tuiApp.commitStatic(`Model switched to: ${res.modelName}`)
    } else {
      tuiApp.commitStatic(`⚠️ Model switch failed: ${res.error ?? 'unknown error'}`)
    }
    try {
      setDefaultModelConfig({ defaultModel: `${provider}:${modelId}` })
    } catch (err) {
      tuiApp.commitStatic(`⚠️ 设置默认失败: ${(err as Error).message}`)
    }
  }, /* themePickerExec: */ (themeName: string) => {
    // Theme Picker Enter 回调：切换主题。
    setTheme(themeName as ThemeName)
    tuiApp.forceRedraw()
    tuiApp.commitStatic(`Theme switched to: ${themeName}`)
  }, /* themePickerSaveDefaultExec: */ (themeName: string) => {
    // Theme Picker S 键回调：切换主题 + 设为默认并持久化。
    setTheme(themeName as ThemeName)
    tuiApp.forceRedraw()
    tuiApp.commitStatic(`Theme switched to: ${themeName}`)
    try {
      setUiConfig({ theme: themeName })
    } catch (err) {
      tuiApp.commitStatic(`⚠️ 设置默认失败: ${(err as Error).message}`)
    }
  }, /* choicePanelExec: */ (id: string) => {
    // 应用并持久化权限模式：会话内即时生效（agent）+ 底栏 badge 同步（tuiApp）+
    // 写入 ~/.rivet/config.json（重启后仍是该模式，无需重选）。
    const applyPermission = (mode: string) => {
      ctx!.agent.setApprovalMode(mode as import('./agent/loop-types.js').ApprovalMode)
      tuiApp.setApprovalMode(mode)
      // Switching to YOLO mid-session must also raise the write boundary.
      applySandboxPolicyForApprovalMode(mode)
      // YOLO 联动无限轮次：真正全自动，不被 maxTurns 截断。
      // 其他模式恢复默认 200 轮预算。
      const yoloMaxTurns = mode === 'dangerously-skip-permissions' ? 0 : 200
      ctx!.agent.config.maxTurns = yoloMaxTurns
      try {
        persistApprovalDefault(mode)
      } catch (err) {
        tuiApp.commitStatic(`⚠ 权限模式已切换但持久化失败: ${(err as Error).message}`)
      }
      const label = { manual: 'Manual', 'auto-safe': 'Auto', 'dangerously-skip-permissions': 'YOLO' }[mode] ?? mode
      const turnNote = mode === 'dangerously-skip-permissions' ? '（无限轮次）' : ''
      tuiApp.commitStatic(`权限模式 → ${label}${turnNote}（已设为默认，重启后仍生效）`)
    }

    if (tuiApp.choicePanelKind === 'permission') {
      // Permission 选择面板回调
      tuiApp.choicePanelKind = 'effort' // reset
      if (id === 'dangerously-skip-permissions') {
        // YOLO 需二次确认。面板在 exec 后会被 deactivateOverlay 关闭（app.ts），
        // 故用 setImmediate 在关闭之后再把确认面板推起来。
        setImmediate(() => {
          tuiApp.choicePanelKind = 'permission-yolo-confirm'
          tuiApp.activateOverlay('choice-panel')
        })
        return
      }
      applyPermission(id)
      return
    }
    if (tuiApp.choicePanelKind === 'permission-yolo-confirm') {
      // YOLO 确认面板回调
      tuiApp.choicePanelKind = 'effort' // reset
      if (id === 'confirm-yolo') {
        applyPermission('dangerously-skip-permissions')
      } else {
        tuiApp.commitStatic('已取消 — 权限模式未改变。')
      }
      return
    }
    if (tuiApp.choicePanelKind === 'plan-approval') {
      // 计划审批面板回调：approve / approve:<idx> / reject / reject-exit。
      const info = tuiApp.pendingPlanApproval
      // 任何审批决策 = 用户参与——取消倒计时自动批准
      tuiApp.cancelPlanAutoApprove()
      tuiApp.choicePanelKind = 'effort' // reset
      tuiApp.pendingPlanApproval = undefined
      tuiApp.planApprovalExcerpt = undefined
      if (!info) return
      const deps = {
        cwd: ctx!.agent.cwd,
        agent: ctx!.agent,
        submitToAgent: (prompt: string) => { tuiApp.submitText(prompt) },
        notify: (content: string, isError?: boolean) => tuiApp.commitStatic(content, { isError }),
      }
      if (id === 'approve') {
        const option = info.options?.find(o => o.label.includes('Recommended')) ?? info.options?.[0]
        void approvePlanAndKickoff(deps, info.slug, option?.label)
      } else if (id.startsWith('approve:')) {
        // 多方案计划：面板内选定的方案（索引编码在条目 id 里）。
        const idx = Number(id.slice('approve:'.length))
        const option = Number.isInteger(idx) ? info.options?.[idx] : undefined
        void approvePlanAndKickoff(deps, info.slug, option?.label)
      } else if (id === 'reject') {
        void rejectPlan(ctx!.agent.cwd, info.slug).then(doc => {
          deps.notify(doc ? `计划「${info.title}」已驳回，可继续修订。` : '计划不存在或已被删除。')
        })
      } else if (id === 'reject-exit') {
        void rejectPlan(ctx!.agent.cwd, info.slug).then(doc => {
          ctx!.agent.exitPlanMode()
          deps.notify(doc ? `计划「${info.title}」已驳回，已退出 plan mode。` : '已退出 plan mode。')
        })
      } else if (id === '__reject_comment__') {
        const comment = tuiApp.choicePanelInputBuffer.trim()
        void rejectPlan(ctx!.agent.cwd, info.slug).then(doc => {
          if (!doc) {
            deps.notify('计划不存在或已被删除。')
            return
          }
          deps.notify(`计划「${info.title}」已驳回${comment ? '（含反馈）' : ''}，可继续修订。`)
          if (comment) {
            deps.submitToAgent(
              `User rejected the plan. Feedback:\n\n${comment}\n\nRevise the plan in \`.rivet/plans/${info.slug}.md\`, then call plan action=submit again.`,
            )
          }
        })
      }
      return
    }
    if (tuiApp.choicePanelKind === 'ask-user-question') {
      // Handled inside TuiApp.resolveAskChoice / advanceAskFlow (multi-question).
      // Legacy single-shot path should not double-submit via this callback.
      const done = tuiApp.resolveAskChoice(id)
      if (!done) return
      return
    }
    // Effort 选择面板回车回调。
    ctx!.agent.setReasoningEffort(id as import('./agent/auto-reasoning.js').ReasoningEffort | 'auto')
    const label = id === 'auto' ? 'Auto（按任务复杂度自动选档）' : id
    tuiApp.commitStatic(`Reasoning effort → ${label}`)
  }, /* connectExec: */ (commit, summary) => {
    // Connect 向导提交回调：写盘 → 重载 → 内存回填 → 即时切到新默认模型。
    try {
      if (commit.mode === 'preset') {
        setupProvider(commit.setup)
      } else {
        setupCustomProvider({
          providerName: commit.providerName,
          baseUrl: commit.baseUrl,
          apiKey: commit.apiKey,
          model: commit.model,
          makeDefault: commit.makeDefault,
        })
      }
    } catch (e) {
      tuiApp.commitStatic(`⚠️ 配置保存失败: ${e instanceof Error ? e.message : String(e)}`)
      return
    }

    // Reload from disk and hot-swap the in-memory provider table so
    // switchAgentRuntime (which reads ctx.config) sees the new provider.
    let liveApplied = false
    try {
      const fresh = loadRivetConfig()
      if (ctx) {
        ctx.config.provider = fresh.provider
        const prov = fresh.provider.providers[fresh.provider.default]
        const modelAlias = prov?.models[0]?.alias ?? prov?.models[0]?.id
        if (modelAlias) {
          try { ctx.agent.abort() } catch { /* idle */ }
          const res = switchAgentRuntime(ctx, modelAlias)
          if (res.ok && res.modelName) {
            tuiApp.setModelInfo(res.modelName, res.contextWindow)
            attachJobSubscription()
            liveApplied = true
          }
        }
      }
    } catch { /* fall through to restart hint */ }

    tuiApp.commitStatic(
      liveApplied
        ? `✅ ${summary}`
        : `✅ ${summary}\n（已保存到配置。若模型未切换，重启天枢后生效。）`,
    )
  }, /* planPickerExec: */ (slug: string) => {
    // Plan Picker Enter 回调：批准选中计划并自动 kickoff 分波执行（与 /plan-approve 共用）。
    // 手动批准 = 用户参与——取消倒计时自动批准
    tuiApp.cancelPlanAutoApprove()
    void approvePlanAndKickoff(
      {
        cwd: ctx!.agent.cwd,
        agent: ctx!.agent,
        submitToAgent: (prompt: string) => { tuiApp.submitText(prompt) },
        notify: (content: string, isError?: boolean) => tuiApp.commitStatic(content, { isError }),
      },
      slug,
    )
  }, /* initExec: */ (commit, summary) => {
    // /init 向导提交回调：逐项应用（不存在才创建，存在则补缺/跳过），输出逐项报告。
    try {
      const report = applyInitCommit(ctx!.agent.cwd, commit)
      tuiApp.commitStatic(`✅ ${summary}\n${formatInitApplyReport(report)}`)
    } catch (e) {
      tuiApp.commitStatic(`⚠️ 项目初始化失败: ${e instanceof Error ? e.message : String(e)}`)
    }
  })

  // ── Worker 直达通道（WaveC）─────────────────────────────────
  // /tasks x 键 → per-worker AbortController；worker 视图输入 → per-order steer 队列。
  // 动态读 refs.coordinator：switchModel 会重建 coordinator，闭包不能捕获旧实例。
  tuiApp.setWorkerKill(workerId => ctx?.refs.coordinator?.killWorker(workerId) ?? false)
  tuiApp.setWorkerSteer((workerId, text) => ctx?.refs.coordinator?.steerWorker(workerId, text) ?? false)

  // ── 后台 Job 直达通道 ─────────────────────────────────────────
  // agent.jobs 是 SessionJobs（EventEmitter）。/model 切换会 new AgentLoop →
  // 新建 SessionJobs，故订阅必须可重入：每次 (re)attach 到当前 ctx.agent.jobs。
  // subscribedJobs 去重防止对同一实例重复 on()。
  let subscribedJobs: import('./tools/job-store.js').SessionJobs | undefined
  let jobListener: ((ev: import('./tools/job-store.js').JobEvent) => void) | undefined
  const attachJobSubscription = () => {
    const jobs = ctx?.agent.jobs
    if (!jobs || jobs === subscribedJobs) return
    // 换实例时旧实例的 listener 必须摘除——否则旧 job 的事件继续进读模型，
    // 而 kill 已路由到新实例，读模型与真实状态分叉。
    if (subscribedJobs && jobListener) subscribedJobs.removeListener('event', jobListener)
    subscribedJobs = jobs
    jobListener = (ev: import('./tools/job-store.js').JobEvent) => { tuiApp.handleJobEvent(ev) }
    jobs.on('event', jobListener)
    // 回填：attach 之前已存在的 job（重启/换实例后的首轮）不能是空的——
    // 按当前快照补一发合成事件进读模型。
    for (const snap of jobs.list()) {
      tuiApp.handleJobEvent({ kind: snap.status === 'running' ? 'started' : 'exit', job: snap })
    }
  }
  attachJobSubscription()
  tuiApp.setJobKill(jobId => ctx?.agent.jobs?.kill(jobId) ?? false)
  tuiApp.setJobLogs(jobId => ctx?.agent.jobs?.logs(jobId) ?? null)

  // ── SlashRouter ──────────────────────────────────────────────
  registerTuiSlashCommands(app, ctx)

  // slash 命令提示列表：静态 palette 命令 + 动态已加载 skill 的 /skill <name>
  const paletteHints = getPaletteCommands()
    .filter(c => c.name.startsWith('/'))
    .map(c => ({ name: c.name, description: c.description, ...(c.argsHint ? { argsHint: c.argsHint } : {}) }))
  const skillHints = skillRegistry.list().map(s => ({
    name: `/skill ${s.name}`,
    description: s.description ? s.description.split('\n')[0]! : `Load skill: ${s.name}`,
  }))
  app.setSlashCommands([...paletteHints, ...skillHints])

  // ── 真实指标 provider（GlanceBar cache/ctx/cost）─────────────
  // 闭包动态读 module-level ctx：/model 切换时 switchAgentRuntime 原地改 ctx.agent，
  // ctx.session 不变，因此读取始终命中当前 runtime（天然 /model 切换安全）。
  let prevCacheStatus: CacheStatus = 'healthy'
  app.setMetricsProvider(() => {
    if (!ctx) return null
    const session = ctx.session
    const total = session.getTotalUsage()
    // 真实定价：从 provider config 查当前模型的 pricing（CNY per 1M tokens），
    // 按 input/output/cacheRead/cacheWrite/reasoning 五档精确计算。无 pricing 时回退 0。
    const providers = ctx.agent.config.allProviders ?? {}
    const providerName = ctx.agent.config.providerName
    const modelId = ctx?.provider.models[0]?.id
    const pricing = findModelPricing(providers, providerName, modelId)
    const cost = pricing ? computeUsageCost(total, pricing).total : 0
    const maxTokens = ctx.agent.config.contextWindow ?? currentModel?.contextWindow ?? 0
    const turnNumber = session.getTurnCount()
    const cacheProjection = projectCacheTelemetry(session, turnNumber, prevCacheStatus)
    prevCacheStatus = cacheProjection.status
    return {
      estimatedTokens: session.getRealOccupancy(),
      conversationTokens: session.getConversationTokens(),
      maxTokens,
      cacheHitRate: session.getRecentTurnHitRate(3) ?? session.getCacheHitRate(),
      cacheStatus: cacheProjection.status,
      cost,
      inputTokens: total.input_tokens,
      outputTokens: total.output_tokens,
      lastRealPromptTokens: session.getLastRealPromptTokens(),
    }
  })

  // ── 常驻任务面板 provider（todo 列表）──────────────────────
  // 统一读本会话 refs.todoStore（多会话隔离的 canonical 源）。TUI 下它就是全局
  // defaultStore，故与旧的 getTodos() 行为一致；server/桌面下则各会话独立。
  app.setTodosProvider(() => ctx!.refs.todoStore.read())

  // ── 当前已批准计划指针 provider ─────────────────────────────
  // 读 PromptEngine 中的 activePlanPointer，供右侧面板 lightweight 展示当前计划。
  app.setActivePlanProvider(() => ctx!.agent.config.promptEngine?.getActivePlanPointer())
  app.setPlanDraftProvider(() => {
    const agent = ctx!.agent
    if (agent.planModeState !== 'planning') return null
    const path = agent.getActivePlanFilePath()
    if (!path) return null
    try {
      const abs = pathJoin(agent.cwd, path)
      const bytes = statSync(abs).size
      return { path, bytes }
    } catch {
      return { path }
    }
  })

  // ── Goal / plan-mode / plan-trace providers ──────────────────
  // 把 AgentLoop 的运行时状态暴露给 TUI，用于 GlanceBar 和 side panel。
  app.setGoalTrackerProvider(() => ctx!.refs.goalTrackerRef.current)
  app.setPlanModeProvider(() => ctx!.agent.planModeState === 'planning')
  app.setAskModeProvider(() => ctx!.agent.askModeState === 'asking')
  // Shift+Tab：纯 Plan Mode 叠层开关（不兼审批环）。
  // 进入记住当前审批模式且不改 approval；退出原样恢复（YOLO 不会被冲成 auto-safe/manual）。
  // 审批切换仍走 /permission 与 /yes；planning 期间改审批会同步更新 stash。未批准 draft 保留在 .rivet/plans/。
  // enterPlanMode 内部会自动退出 Ask（互斥）。
  app.setPlanModeToggleHandler(() => {
    const agent = ctx!.agent
    const setSessionApproval = (mode: ApprovalMode) => {
      agent.setApprovalMode(mode)
      app!.setApprovalMode(mode)
      // YOLO 联动无限轮次（与 /yes、权限面板一致）
      agent.config.maxTurns = mode === 'dangerously-skip-permissions' ? 0 : 200
    }
    const current = agent.config.approvalMode ?? 'auto-safe'
    const decision = nextShiftTabPlanToggle({
      isPlanning: agent.planModeState === 'planning',
      currentApprovalMode: current,
      approvalModeBeforePlan: (app!.approvalModeBeforePlan as ApprovalMode | null) ?? null,
    })
    if (decision.action === 'enter') {
      app!.approvalModeBeforePlan = decision.stashMode
      agent.enterPlanMode()
      const path = agent.getActivePlanFilePath()
      const hint = shiftTabPlanToggleHint('enter', decision.stashMode)
      app!.commitStatic(path ? `${hint}（计划文件: \`${path}\`）` : hint)
      return
    }
    agent.exitPlanMode()
    setSessionApproval(decision.restoreMode)
    app!.approvalModeBeforePlan = null
    app!.commitStatic(shiftTabPlanToggleHint('exit', decision.restoreMode))
  })
  app.setPlanTraceProvider(() => ctx!.agent.planTrace)

  // 同步 vision 状态到 TUI，使其能在用户气泡中提示图片处理方式。
  app.setVisionInfo(
    ctx!.agent.config.supportsVision ?? false,
    !!ctx!.agent.config.visionClient,
    ctx!.agent.config.visionBridge?.source,
  )

  // ── Wire agent → TuiApp ──────────────────────────────────────
  // 消息队列已收编进 TuiApp：streaming 时 Enter 由 TuiApp 入队（steerBuffer），
  // onSteerDrain 由 TuiApp callbacks 真实 drain，此处无需外层 override。
  app.onSubmit((text, images) => {
    const trimmed = text.trim()
    if (!trimmed) return

    // 将 slash 命令解析为 agent prompt（对齐 Ink resolveAppPromptInput）。
    // /review → "deliver_task(...)"；未知 slash → null → 显示错误提示。
    const resolved = resolveAppPromptInput(trimmed, process.cwd(), app!.getCommandPredicate())
    if (resolved === null) {
      // Backstop: a registered slash command (e.g. /plan-approve) may slip past
      // normal dispatch. Give the registry one more chance before reporting
      // "Unknown command" — kills the silent failure users hit on /plan-* copy-paste.
      app!.rejectSubmit()
      void (async () => {
        const handled = await app!.tryDispatchSlash(trimmed)
        if (!handled) {
          const firstTok = trimmed.split(/\s/)[0]
          const planHint = firstTok?.startsWith('/plan')
            ? '\n提示: /plan-approve 无参打开待批计划选择器，或 /plan-list 查看全部计划。'
            : ''
          app!.commitStatic(`⚠️  Unknown command: ${firstTok}\nType /help for available commands.${planHint}`)
        }
      })()
      return
    }

    // workflow 声明的 EXTENDED 工具在发 run 前挂载——prompt 契约与工具可见性同源
    // （会话 5158719d：/council 指示调 council_convene 而门控把它摘了 → 模型被迫模拟）。
    for (const toolName of resolved.requiredTools ?? []) {
      const mount = ctx!.agent.enableTool(toolName)
      if (mount.status === 'mounted') {
        const costNote = mount.cacheImpact === 'prefix-invalidated'
          ? '（下一请求前缀缓存一次性 MISS，后续轮次按新工具集重新缓存）'
          : ''
        app!.commitStatic(`🔧 已为本次 workflow 挂载工具 ${toolName}${costNote}`)
      }
      // already-active / gating-off → 静默（工具本就可见）
      // unknown / not-extended → 不应发生（requiredTools 与 EXTENDED_TOOLS 的一致性由 workflow 测试钉住）
    }

    // 单一权威：TuiApp.agentBusy 是唯一的 streaming 闩。app.onSubmit 只在 TuiApp
    // 判定空闲时触发（busy 时输入已被 TuiApp 入队 steerBuffer），故此处无需再自管
    // isStreaming 标志——正是「双门异步清除时机不同」造成 Esc 后死会话的根因。
    // run 生命周期回调（完成/错误/中止）由 bridge 桥接到 TuiApp，并带世代守卫。
    const base = wrapCallbacksWithTuiApp(app!)
    // The tap wraps the OUTSIDE of the bridge rather than riding its `original`
    // parameter: bridge.ts lets `original.onApprovalRequired` *replace* the
    // app's handler (bridge.ts:77-80), so passing an observer in there would
    // hijack the approval UI. Decorating the finished set only observes.
    //
    // Both consumers share one tap — a second tap would double-count `seq`.
    const sinks: EventSink[] = []
    if (eventStream) sinks.push(eventStream.sink)
    if (screenReaderMode) {
      sinks.push((event) => {
        const line = formatEventForScreenReader(event)
        if (line) app!.commitStatic(line)
      })
    }
    const callbacks = sinks.length > 0
      ? tapAgentCallbacks(base, (event) => { for (const s of sinks) s(event) })
      : base
    ctx!.agent.run(resolved.prompt, callbacks, images).catch((err) => {
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
    void shutdown(0)
  })

  // ── First-run template prompt (before clearing screen) ───────
  if (ctx.templatesPendingAgents && !args.includes('--dangerously-skip-permissions')) {
    // Detect git availability to advise first-run users. Git is optional (the
    // agent runs in-place without it), but unlocks worktree isolation, commit,
    // diff review, and checkpoints. Use `git --version` — `git rev-parse
    // --is-inside-work-tree` fails outside a repo even when git is installed.
    const gitAvailable = (() => {
      try {
        execSync('git --version', { cwd: process.cwd(), stdio: 'pipe' })
        return true
      } catch {
        return false
      }
    })()

    // Interactive picker with ↑↓ navigation — replaces the old readline prompt
    // that leaked keystrokes into the TUI input ("press 1 becomes chat message").
    const options = ['Create both (AGENTS.md + .rivet.md)', 'Skip'] as const
    let selectedIdx = 0

    const renderPicker = (idx: number) => {
      stdout.write('\x1B[2K\r') // clear current line
      stdout.write('\x1B[1A\x1B[2K\r') // clear previous line
      for (let i = 0; i < options.length; i++) {
        const prefix = i === idx ? '\x1B[7m ❯' : '   '
        const suffix = i === idx ? ' \x1B[0m' : ''
        stdout.write(`${prefix} ${options[i]}${suffix}\n`)
      }
      stdout.write(`\n  ↑↓ navigate · Enter confirm · Esc skip\n`)
      // Move cursor back up so re-render overwrites the same lines
      stdout.write(`\x1B[${options.length + 2}A`)
    }

    stdout.write('\n')
    stdout.write('╭─ First-run setup ────────────────────────────────╮\n')
    stdout.write('│ This project has no AGENTS.md or .rivet.md.     │\n')
    stdout.write('│ Create them from templates?                      │\n')
    stdout.write('╰──────────────────────────────────────────────────╯\n')
    if (!gitAvailable) {
      stdout.write('\n')
      stdout.write('  ⚠ 未检测到 git。git 是可选依赖——不装也能正常用，\n')
      stdout.write('    但安装后可解锁：委派隔离 / 检查点回滚 / commit / diff 审查。\n')
      stdout.write('    安装：https://git-scm.com/downloads\n')
      stdout.write('\n')
    }
    stdout.write('\n')
    renderPicker(selectedIdx)

    // Read keys in raw mode — no readline buffering that leaks into TUI.
    let created = false
    let aborted = false
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true)
      process.stdin.resume()
      let onData: ((chunk: Buffer) => void) | undefined
      try {
        await new Promise<void>((resolve) => {
          let buf = ''
          onData = (chunk: Buffer) => {
            const str = chunk.toString()
            buf += str

            // Arrow keys arrive as ESC sequences: ↑ = \x1B[A, ↓ = \x1B[B
            if (buf === '\x1B[A' || buf === '\x1B[1;2A') {
              // Up
              selectedIdx = (selectedIdx - 1 + options.length) % options.length
              renderPicker(selectedIdx)
              buf = ''
              return
            }
            if (buf === '\x1B[B' || buf === '\x1B[1;2B') {
              // Down
              selectedIdx = (selectedIdx + 1) % options.length
              renderPicker(selectedIdx)
              buf = ''
              return
            }
            // k / j — vim-style up/down
            if (buf === 'k' && selectedIdx > 0) {
              selectedIdx--
              renderPicker(selectedIdx)
              buf = ''
              return
            }
            if (buf === 'j' && selectedIdx < options.length - 1) {
              selectedIdx++
              renderPicker(selectedIdx)
              buf = ''
              return
            }
            // Enter
            if (str === '\r' || str === '\n') {
              created = selectedIdx === 0
              buf = ''
              resolve()
              return
            }
            // Direct number selection (1-2) — still works for muscle memory
            if (str === '1') { selectedIdx = 0; created = true; resolve(); return }
            if (str === '2') { selectedIdx = 1; created = false; resolve(); return }
            // Escape — skip
            if (str === '\x1B' && buf.length === 1) {
              aborted = true
              resolve()
              return
            }
            // Any other key: if it starts a known sequence, wait; otherwise ignore
            if (buf.length >= 6) buf = '' // flush garbled escape sequences
          }
          process.stdin.on('data', onData)
        })
      } finally {
        if (onData) process.stdin.removeListener('data', onData)
      }
    }

    // Move past the picker rendering
    stdout.write(`\x1B[${options.length + 2}B`)
    if (aborted) {
      applyProjectTemplates(process.cwd(), { agentsMode: 'skip' })
      recordTemplatesDecision(process.cwd(), 'declined')
      stdout.write('Skipped template creation.\n')
    } else if (created) {
      const result = applyProjectTemplates(process.cwd(), { agentsMode: 'overwrite' })
      recordTemplatesDecision(process.cwd(), 'created', {
        created: result.created,
        appended: result.appended,
        skipped: result.skipped,
      })
      stdout.write(`✓ Created: ${result.created.join(', ') || 'none'}\n`)
    } else {
      applyProjectTemplates(process.cwd(), { agentsMode: 'skip' })
      recordTemplatesDecision(process.cwd(), 'declined')
      stdout.write('Skipped template creation.\n')
    }
  } else if (ctx.templatesPendingAgents) {
    // headless / --dangerously-skip-permissions: silent .rivet.md, decline AGENTS.md
    applyProjectTemplates(process.cwd(), { agentsMode: 'skip' })
    recordTemplatesDecision(process.cwd(), 'declined')
  }

  // ── Clear screen ─────────────────────────────────────────────
  stdout.write('\x1B[2J\x1B[H')

  // ── Welcome message（CC 头式 3 行紧凑头） ─────────────────────
  const existingMsgCount = ctx.session.getMessages().length
  if (!skipWelcome) {
    const installRoot = detectInstallRoot()
    // 首屏框与输入框的线框同源——否则 thick/dots 星域下刊头是 thin、输入框
    // 是域个性，两个框并排时风格断裂。（提前取 id：let  narrowing 不进闭包）
    const sessionDomainId = ctx.agent.getSessionDomain()?.id
    const welcomeLines = formatWelcome({
      modelName,
      cwd: process.cwd(),
      sessionId: ctx.sessionId,
      priorMsgCount: existingMsgCount,
      columns: stdout.columns || 80,
      rows: stdout.rows || 24,
      numericId: ctx.agent.sessionNumericId,
      compact: existingMsgCount > 0,
      version: installRoot ? getCurrentVersion(installRoot) : null,
      approvalMode: ctx.config.agent.approval ?? 'auto-safe',
      reasoningEffort: (ctx.agent.planModeState === 'planning')
        ? 'max'
        : (ctx.agent.config.autoReasoning && !ctx.agent.userReasoningOverride)
          ? 'auto'
          : (ctx.agent.getReasoningEffort() ?? ctx.agent.config.reasoningEffort),
      separator: starDomainRegistry.list().find(d => d.id === sessionDomainId)?.uiPersona?.separator,
    }, theme)
    for (const line of welcomeLines) {
      stdout.write(line + '\n')
    }
  }

  // 自然流：欢迎页写完后直接渲染底部 chrome（GlanceBar + 输入框），输入框以 append
  // 模式落在欢迎页正下方，随交互增长由终端原生滚动保持在视口底部。
  //
  // 不补空行撑底 —— 试过两种补法都不成立：补在欢迎屏之后，欢迎屏钉在顶部、输入框沉到
  // 底，中间撑开一大片空白（Claude Code v2.1.168 的 #66191 形态）；补在欢迎屏之前，
  // 整块下沉，空白全堆到上方。输出流 append-only，凭空造出的空白只能二选一地堆在某侧，
  // 两者都比自然流难看。真正扎眼的「输入框下方死区」另有其因（活动期动态段恒定垫高、
  // 轮末塌回），已由 getDynamicBudget 的轮内高水位治本。
  app.start()

  // 首屏交接提醒（resume 场景）：上下文已过半的会话，建议先 /handoff 再开新会话——
  // 交接自动注入新会话，比整段回连省前缀重建成本。
  if (existingMsgCount > 0) {
    try {
      const est = ctx.session.getEstimatedTokens()
      const max = ctx.agent.config.contextWindow
      if (max > 0 && est / max >= HANDOFF_NUDGE_RATIO) {
        app.commitStatic(formatHandoffNudge(est / max))
      }
    } catch { /* best-effort */ }
  }

  // ── 会话恢复入口（Claude Code parity）───────────────────────────
  // 裸 --resume/-r：自动打开 Chronicle 会话选择器（Enter 直接切换）。
  // 普通新会话启动：仅 wantSessionPicker 时开选择器。启动页的
  // 「↺ N 个历史会话 · /resume 恢复」提示行已移除（2026-07-25）——resume
  // 功能保留但不主动展示，降低顺手回连带来的碎缓存风险。
  {
    const recentSessions = SessionPersist.listMainSessions(process.cwd())
      .filter(s => s.id !== ctx!.sessionId && (s.turnCount ?? 0) > 0
        && typeof s.updatedAt === 'number' && Date.now() - s.updatedAt < 7 * 24 * 60 * 60 * 1000)
    if (wantSessionPicker) {
      if (recentSessions.length > 0) {
        app.activateOverlay('chronicle')
      } else {
        app.commitStatic('没有可恢复的历史会话 — 已开启新会话。')
      }
    }
  }

  // Resume 会话的计划模式恢复：上次退出时在 planning 且 draft 仍在 → 重进计划模式。
  {
    const restoredPlan = restorePlanModeFromMeta(ctx.agent, ctx.cwd, initialMeta)
    if (restoredPlan) {
      app.commitStatic(`🔍 已恢复计划模式（draft: ${restoredPlan}）— /plan-mode 退出或批准计划后执行。`)
    }
  }

  // 首次启动引导：默认服务商没有可用密钥（且非 OAuth）→ 自动打开 /connect 向导，
  // 让新用户点选内置服务商 + 粘贴密钥即可开跑，无需手改 config.json。
  if (ctx && !ctx.auth && (!ctx.apiKey || ctx.apiKey.trim() === '') && existingMsgCount === 0) {
    app.commitStatic('尚未配置模型服务商的 API 密钥 — 正在打开配置向导（/connect 可随时再次打开）。')
    app.startConnect()
  }

  // 启动期主动环境体检：git 缺失时(尤其 Windows，Git Bash 是命令执行首选 shell)
  // 醒目提示，而非等命令失败后被动提醒。异步、失败静默、不阻塞启动。
  void (async () => {
    try {
      const env = await detectEnv(process.cwd())
      const banner = formatGitMissingBanner(env.git.available, env.platform)
      if (banner) app?.commitStatic(banner)
    } catch {
      // fail-open: 环境探测失败不打扰用户
    }
  })()

  // 浏览器体检：仅当工具集含 browser_debug(frontend/full preset)时才查——纯 CLI
  // 用户(minimal)不需要 chromium，不该每次启动被浏览器提示打扰。缺失则给一键
  // 安装入口。异步、失败静默、不阻塞启动(同 git banner 姿态)。
  void (async () => {
    try {
      const { resolveToolPreset } = await import('./tools/tool-preset.js')
      if (!presetIncludes(resolveToolPreset(process.cwd()), 'browser_debug')) return
      const { probeChromium, formatBrowserMissingBanner } = await import('./tools/net/browser-readiness.js')
      const probe = await probeChromium()
      const banner = formatBrowserMissingBanner(probe)
      if (banner) app?.commitStatic(banner)
    } catch {
      // fail-open: 浏览器探测失败不打扰用户
    }
  })()

  // 异步检查更新：不阻塞启动，失败静默，有新版本时写入 scrollback 提示。
  if (!process.env.RIVET_NO_UPDATE_CHECK) {
    void (async () => {
      try {
        const update = await checkForUpdate()
        if (update?.hasUpdate) {
          app.commitStatic(formatUpdateBanner(update.current, update.latest))
        }
      } catch {
        // fail-open: 离线/注册表不可达时不打扰用户
      }
    })()
  }
}

main().catch((err) => {
  process.stderr.write(`[T9] Fatal: ${(err as Error)?.message}\n`)
  if ((err as Error).stack) {
    process.stderr.write((err as Error).stack! + '\n')
  }
  void shutdown(1)
})
