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
import { loadConfig as loadRivetConfig, setupProvider, setupCustomProvider, setUiConfig, setApprovalMode as persistApprovalDefault } from './config/manager.js'
import { isProFeatureEnabled } from './config/pro-license.js'
import type { GoalTracker as GoalTrackerInstance } from './agent/goal-tracker.js'
import { createUpdateGoalTool } from './tools/update-goal.js'
import { TuiApp } from './tui/engine/app.js'
import { wrapCallbacksWithTuiApp } from './tui/engine/bridge.js'
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
import { color } from './tui/engine/ansi.js'
import type { RewindMode } from './tui/format/rewind.js'
import { collectPostBoundaryEditIds } from './agent/file-history.js'
import { loadHistory } from './tui/history.js'
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
import type { PlanPickerEntry } from './tui/format/overlay.js'
import { skillRegistry } from './skills/skill-loader.js'
import { starDomainRegistry } from './agent/star-domain-registry.js'
import { buildDomainPickerEntries, DOMAIN_SWITCH_CACHE_WARNING } from './agent/domain-picker-entries.js'
import { isStarSoulEnabled } from './agent/star-soul-gate.js'
import { SessionPersist, formatExitSummary } from './agent/session-persist.js'
import { parseSessionCliArgs } from './agent/session-recovery.js'
import { loadConstellation } from './constellation/store.js'
import { formatMilestoneLine } from './constellation/format.js'
import { join } from 'path'
import { execSync } from 'child_process'
import { applyProjectTemplates, recordTemplatesDecision } from './bootstrap/project-templates.js'
import { checkForUpdate, formatUpdateBanner, detectInstallRoot, getCurrentVersion } from './tui/updater.js'
import { detectEnv, formatGitMissingBanner } from './tools/env-check.js'
import { computeUsageCost, findModelPricing } from './utils/pricing.js'
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
// Resolution + env signalling happens in main() before bootstrap so that
// getOrCreateSessionId picks it up regardless of call order.
const sessionCliArgs = parseSessionCliArgs(args)
const requestedResumeId = sessionCliArgs.resumeId
const wantContinue = sessionCliArgs.continueLatest
const wantSessionPicker = sessionCliArgs.openPicker
const wantNewSession = sessionCliArgs.forceNew
const skipWelcome = args.includes('--skip-welcome')

// ── Lifecycle ──────────────────────────────────────────────────

let app: TuiApp | null = null
let ctx: BootstrapContext | null = null
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
// skipped it, the process-exit event still fires (unless SIGKILL). MCP child
// processes (e.g. context7-mcp) are spawned via StdioClientTransport and would
// otherwise orphan to PPID=1, accumulating across dev restarts.
process.on('exit', () => {
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
    serveCommand(args.slice(1))
    return
  }

  // rivet sessions / rivet --list — print the session list and exit
  if (args[0] === 'sessions' || args.includes('--list')) {
    process.stdout.write(SessionPersist.formatSessionList(process.cwd()) + '\n')
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
      desktopTools: cfg.agent.desktopTools,
      computerUse: (process.platform === 'darwin' || process.platform === 'win32') && process.env.RIVET_COMPUTER_USE !== '0',
      proEnabled: isProFeatureEnabled(cfg, 'computerUse'),
      searchBackends: buildSearchBackends(cfg),
      fetchOptions: buildFetchOptions(cfg),
    }
    const prov = cfg.provider.providers[cfg.provider.default]
    if (!prov) { process.stderr.write('Provider not configured. Run: rivet config setup <provider>\n'); process.exit(1) }
    const key = prov.apiKey ?? process.env[prov.apiKeyEnv ?? '']
    if (!key) { process.stderr.write(`API key not set. Export ${prov.apiKeyEnv ?? 'API_KEY'} or run: rivet config setup ${prov.name}\n`); process.exit(1) }

    const model = prov.models[0]!
    const sessionId = crypto.randomUUID()

    // --budget N (default 100) is the hard turn cap for goal mode; it doubles as
    // the GoalTracker iteration budget so the two limits coincide. Non-goal -p
    // runs keep the original tight 15-turn cap.
    const goalBudget = parsed.budget ?? 100
    const headlessMaxTurns = parsed.goal ? goalBudget : 15
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
        })))
        toolRegistry.register(createUpdateGoalTool(
          () => goalTrackerRef.current,
          () => ({ sessionId, cwd: process.cwd() }),
        ))

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
          if (agent.config.goalJudge?.enabled !== false) {
            // Wire a minimal DelegationCoordinator so the goal judge can spawn
            // goal_judge workers. Without this, getGoalJudgeDeps returns empty
            // deps and the judge is a permanent no-op in headless mode.
            const coordinator = createHeadlessCoordinator({
              toolRegistry,
              provider: prov,
              providerName: cfg.provider.default,
              apiKey: key,
              auth: undefined,
              cwd: process.cwd(),
              sessionId,
            })
            agent.config.coordinatorRef = () => coordinator

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
      await runProviderConfigWizard()
      process.stderr.write('\nRestarting with new configuration...\n\n')
      ctx = await bootstrapInteractiveSession({
        cwd: process.cwd(),
        args,
        modelId: requestedModel,
        providerName: requestedProvider,
        asyncExtras: true,
      })
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
    perfMonitor: new TuiPerfMonitor({ enabled: isTuiPerfEnabled(args) }),
    onPerfSummary: summary => {
      perfSummaryFlush = ctx!.flushTuiPerfSummary(summary)
    },
  })

  // Register overlays with real data
  // app 在此处必定非 null（前有 app = new TuiApp 赋值，无重赋 null 路径）
  const tuiApp = app!
  tuiApp.setApprovalMode(ctx!.config.agent.approval ?? 'auto-safe')
  // Plan submit 成功后自动弹出审批面板（替代手动 /plan-approve）。
  ctx!.agent.onPlanApprovalRequested = (info) => {
    // 工具执行期间直接推 overlay 可能与 turn 收尾渲染冲突，defer 到下一事件循环。
    setImmediate(() => tuiApp.openPlanApprovalPanel(info))
  }
  // ask_user_question 含单选选项时自动弹出选择面板（替代手动输入编号）。
  ctx!.agent.onAskUserQuestionRequested = (info) => {
    setImmediate(() => tuiApp.openAskUserQuestionPanel(info))
  }
  // TUI 默认钉住天枢星域(与桌面端 auto 形成对比):在首个请求前设置,仅构建
  // 初始 frozenBase,无缓存代价;setSessionDomain 后 bindSessionDomain 的
  // `!== undefined` 守卫会跳过按任务的 auto 关键词绑定。尊重 STAR_SOUL 总开关;
  // 若已有钉住的域(理论上不会,TUI 不持久化选择态)则沿用。
  if (ctx!.agent.getSessionDomain() === undefined && isStarSoulEnabled()) {
    const tianshu = starDomainRegistry.get('tianshu')
    if (tianshu) {
      ctx!.agent.setSessionDomain({ id: tianshu.id, name: tianshu.name, volatileBlock: tianshu.volatileBlock, motto: tianshu.motto })
    }
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
  tuiApp.registerOverlays({
    // Pager — scrollback 内容 或 当前选中 worker 的 detail（用于 /tasks Enter）
    pagerContent: () => {
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
    // History search — Ctrl+R 反向搜索（实时 query 子串过滤）
    historySearchData: () => {
      const query = tuiApp.getOverlayQuery()
      const lower = query.toLowerCase()
      const all = loadHistory()
      const filtered = lower ? all.filter(e => e.toLowerCase().includes(lower)) : all
      return {
        entries: filtered.slice(0, 50),
        selectedIndex: 0,
        query,
      }
    },
    // Tasks — /tasks 显示子代理（per-worker，来自舰队读模型；filter 由 overlay nav 决定）
    tasksData: () => tuiApp.getTasksData(),
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
          { id: 'dangerously-skip-permissions', label: 'YOLO', description: '全自动执行，无刹车无打扰。回滚兜底（/rollback + git 检查点）。需二次确认。', current: current === 'dangerously-skip-permissions' },
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
        const entries = [
          { id: 'approve', label: '批准并执行', description: `执行计划「${title}」`, recommended: true },
          { id: 'reject', label: '驳回修订', description: '标记为 REJECTED，agent 可继续修改' },
          { id: 'reject-exit', label: '驳回并退出计划模式', description: '驳回计划并退出 plan mode' },
          { id: '__reject_comment__', label: '驳回并填写反馈…', description: '输入反馈后驳回，agent 可继续修订' },
        ]
        return { title: '计划审批 / Plan Approval', choices: entries, selectedIndex: 0, inputSubMode: tuiApp.getChoicePanelInputState() }
      }
      if (tuiApp.choicePanelKind === 'ask-user-question') {
        const q = tuiApp.pendingAskUserQuestion
        if (!q) return { title: '', choices: [], selectedIndex: 0 }
        const entries = q.options.map((opt, i) => ({
          id: String(i),
          label: opt,
          description: '',
        }))
        entries.push({ id: '__other__', label: 'Other… / 自定义输入', description: '直接输入文字回答' })
        return { title: q.prompt, choices: entries, selectedIndex: 0, inputSubMode: tuiApp.getChoicePanelInputState() }
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
      } else {
        tuiApp.setInput(name + ' ')
      }
    }
  }, /* rewindExec: */ (messageIndex: number, mode: RewindMode) => {
    // Rewind Enter 回调：按选择的粒度恢复（仅对话 / 仅代码 / 对话+代码）。
    const messages = ctx?.session.getMessages() ?? []
    const target = messages[messageIndex]
    const content = target && typeof target.content === 'string' ? target.content : ''
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
        ctx!.agent.setSessionDomain({ id: d.id, name: d.name, volatileBlock: d.volatileBlock, motto: d.motto })
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
      tuiApp.commitStatic(`Model switched to: ${res.modelName}`)
    } else {
      tuiApp.commitStatic(`⚠️ Model switch failed: ${res.error ?? 'unknown error'}`)
    }
  }, /* themePickerExec: */ (themeName: string) => {
    // Theme Picker Enter 回调：切换主题。
    setTheme(themeName as ThemeName)
    tuiApp.forceRedraw()
    tuiApp.commitStatic(`Theme switched to: ${themeName}`)
  }, /* themePickerSaveDefaultExec: */ (themeName: string) => {
    // Theme Picker S 键回调：设为默认主题并持久化。
    try {
      setUiConfig({ theme: themeName })
      tuiApp.commitStatic(`已设置默认主题为: ${themeName}（下次启动生效）`)
    } catch (err) {
      tuiApp.commitStatic(`⚠️ 设置默认主题失败: ${(err as Error).message}`)
    }
  }, /* choicePanelExec: */ (id: string) => {
    // 应用并持久化权限模式：会话内即时生效（agent）+ 底栏 badge 同步（tuiApp）+
    // 写入 ~/.rivet/config.json（重启后仍是该模式，无需重选）。
    const applyPermission = (mode: string) => {
      ctx!.agent.setApprovalMode(mode as import('./agent/loop-types.js').ApprovalMode)
      tuiApp.setApprovalMode(mode)
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
      // 计划审批面板回调：approve / reject / reject-exit。
      const info = tuiApp.pendingPlanApproval
      tuiApp.choicePanelKind = 'effort' // reset
      tuiApp.pendingPlanApproval = undefined
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
      // 问题选项面板回调：把选中的选项文本或自定义输入作为用户消息提交。
      const q = tuiApp.pendingAskUserQuestion
      tuiApp.choicePanelKind = 'effort' // reset
      tuiApp.pendingAskUserQuestion = undefined
      if (!q) return
      if (id === '__other__') {
        const text = tuiApp.choicePanelInputBuffer.trim()
        if (text) tuiApp.submitText(text)
        return
      }
      const idx = Number(id)
      const option = Number.isFinite(idx) ? q.options[idx] : undefined
      if (option) {
        tuiApp.submitText(option)
      }
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
    void approvePlanAndKickoff(
      {
        cwd: ctx!.agent.cwd,
        agent: ctx!.agent,
        submitToAgent: (prompt: string) => { tuiApp.submitText(prompt) },
        notify: (content: string, isError?: boolean) => tuiApp.commitStatic(content, { isError }),
      },
      slug,
    )
  })

  // ── Worker 直达通道（WaveC）─────────────────────────────────
  // /tasks x 键 → per-worker AbortController；worker 视图输入 → per-order steer 队列。
  // 动态读 refs.coordinator：switchModel 会重建 coordinator，闭包不能捕获旧实例。
  tuiApp.setWorkerKill(workerId => ctx?.refs.coordinator?.killWorker(workerId) ?? false)
  tuiApp.setWorkerSteer((workerId, text) => ctx?.refs.coordinator?.steerWorker(workerId, text) ?? false)

  // ── SlashRouter ──────────────────────────────────────────────
  registerTuiSlashCommands(app, ctx)

  // slash 命令提示列表：静态 palette 命令 + 动态已加载 skill 的 /skill <name>
  const paletteHints = getPaletteCommands()
    .filter(c => c.name.startsWith('/'))
    .map(c => ({ name: c.name, description: c.description }))
  const skillHints = skillRegistry.list().map(s => ({
    name: `/skill ${s.name}`,
    description: s.description ? s.description.split('\n')[0]! : `Load skill: ${s.name}`,
  }))
  app.setSlashCommands([...paletteHints, ...skillHints])

  // ── 真实指标 provider（GlanceBar cache/ctx/cost）─────────────
  // 闭包动态读 module-level ctx：/model 切换时 switchAgentRuntime 原地改 ctx.agent，
  // ctx.session 不变，因此读取始终命中当前 runtime（天然 /model 切换安全）。
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
    return {
      // Real occupancy: anchor on last API prompt_tokens + estimate the tail
      // appended since (provider-agnostic — works for DeepSeek/MiMo/GLM). Falls
      // back to the calibrated estimate before the first response / post-compact.
      estimatedTokens: session.getRealOccupancy(),
      // Visible conversation only (excluding system prompt / tool schemas / prefix
      // overhead) for the GlanceBar context display, so users see the chat-sized
      // context rather than the API-facing prompt bulk.
      conversationTokens: session.getConversationTokens(),
      maxTokens,
      cacheHitRate: session.getRecentTurnHitRate(3) ?? session.getCacheHitRate(),
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
  // Shift+Tab：纯 Plan Mode 叠层开关（不兼审批环）。
  // 进入记住当前审批模式且不改 approval；退出原样恢复（YOLO 不会被冲成 auto-safe/manual）。
  // 审批切换仍走 /permission 与 /yes；planning 期间改审批会同步更新 stash。未批准 draft 保留在 .rivet/plans/。
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
    const callbacks = wrapCallbacksWithTuiApp(app!)
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
    // diff review, and checkpoints. Mirrors the inline try/catch probe pattern
    // used at main.ts:396 (gitBranch detection).
    const gitAvailable = (() => {
      try {
        execSync('git rev-parse --is-inside-work-tree', { cwd: process.cwd(), stdio: 'pipe' })
        return true
      } catch {
        return false
      }
    })()

    const { createInterface } = await import('node:readline/promises')
    const rl = createInterface({ input: stdin, output: stdout })
    try {
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
      stdout.write('  [1] Create both (AGENTS.md + .rivet.md)\n')
      stdout.write('  [2] Skip                         \n')
      stdout.write('\n')
      const answer = (await rl.question('Choice [1-2] (default: 1): ')).trim()
      if (answer === '' || answer === '1') {
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
    } finally {
      rl.close()
      // Linux: readline.close() leaves stdin in flowing mode with residual
      // 'keypress' listeners. Without pause + removeAllListeners, keystrokes
      // typed between rl.close() and app.start() leak into the TUI input handler
      // as raw characters — the "press 1/2 becomes a chat message" bug.
      if (process.stdin.isTTY) {
        process.stdin.pause()
        process.stdin.removeAllListeners('data')
        process.stdin.removeAllListeners('keypress')
      }
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
    }, theme)
    for (const line of welcomeLines) {
      stdout.write(line + '\n')
    }
  }

  // 自然流：欢迎页写完后直接渲染底部 chrome（GlanceBar + 输入框），
  // 输入框以 append 模式落在欢迎页正下方。不再用 padding 撑底——padding 会
  // 与 cursor-resident live region 的相对光标假设冲突，切换 model/theme/domain
  // 提交内容触发滚动时造成顶部残影/塌行。随交互增长终端原生滚动自然把输入框保持在视口底部。
  app.start()

  // ── 会话恢复入口（Claude Code parity）───────────────────────────
  // 裸 --resume/-r：自动打开 Chronicle 会话选择器（Enter 直接切换）。
  // 普通新会话启动：有近期历史会话时打一行可发现性提示。
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
    } else if (existingMsgCount === 0 && recentSessions.length > 0) {
      app.commitStatic(color(
        `↺ ${recentSessions.length} 个历史会话 · /resume 恢复`,
        theme.muted,
      ))
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
