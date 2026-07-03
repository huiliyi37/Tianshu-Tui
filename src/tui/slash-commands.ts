import type { AgentLoop } from '../agent/loop.js'
import type { SessionContext } from '../agent/context.js'
import { SessionPersist, getSessionDir } from '../agent/session-persist.js'
import { forkSession, listBranches, countMessageLines } from '../agent/session-fork.js'
import { type StarDomainId } from '../agent/star-domain.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import { DOMAIN_SWITCH_CACHE_WARNING } from '../agent/domain-picker-entries.js'
import { microCompactOai, estimateOaiTokens } from '../compact/micro.js'
import { rollbackToCheckpoint, getRollbackPreview } from '../agent/checkpoint.js'
import { runResumePreflightOai } from '../context/resume-preflight.js'
import { resolveCustomCommand } from '../commands/loader.js'
import { getTheme, setTheme, getActiveThemeName, THEMES, type ThemeName } from './theme.js'
import {
  checkForUpdate,
  detectInstallRoot,
  formatUpdateBanner,
  restartProcess,
  runUpdate,
  spawnWindowsSelfUpdate,
} from './updater.js'
import { PhaseTracker } from './phase-tracker.js'
import { createLogEntry, type LogEntry } from './log-state.js'
import { getPaletteCommands } from './command-palette.js'
import { openInEditor } from './external-editor.js'
import { formatMissionStrip } from './mission.js'
import { PANEL_LABELS, PANELS, type Panel } from './cockpit/types.js'
import type { SummaryState } from './summary-state.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimStatus } from '../context/claims.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { exportDurableClaims, importClaims } from '../context/claim-export.js'
import { resolveEcosystemWorkflowInput } from '../workflows/ecosystem-workflows.js'
import { formatVolatilePayloadReport } from '../context/payload-diagnostic.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { exportsDir } from '../config/paths.js'
import { listPlans, approvePlan, rejectPlan } from '../plan/plan-store.js'
import { fullRebuild, generateCodebaseIndexBlock, getHeadSha } from '../repo/codebase-index.js'
import { isDiagramType, buildDiagramDoc, renderDiagramBlock, formatDiagramList } from './diagram-templates.js'
import { renderRecoveryStack } from '../agent/recovery-stack.js'
import { skillRegistry, listSkillFiles, importSkillsIntoRivet, countInstalledSkills, RECOMMENDED_MAX_SKILLS, SKILL_RESTRAINT_NOTICE } from '../skills/skill-loader.js'
import { listSkillDrafts, approveSkillDraft, rejectSkillDraft } from '../agent/skill-distill.js'
import { formatReviewHealthLine } from '../agent/review-health.js'
import {
  loadConstellation,
  initConstellation,
  surveySkeleton,
  appendMilestone,
} from '../constellation/store.js'
import { formatConstellationView, formatConstellationHistory } from '../constellation/format.js'
import { extractMilestone, buildDepartureMilestone } from '../constellation/milestone.js'
import { shortHash } from '../constellation/schema.js'
import { buildAgentMark, VOID_SYMBOL } from '../agent/void-identity.js'

import type { TuiApp } from './engine/app.js'
import type { SlashCommand } from './slash-command-registry.js'
import type { BootstrapContext } from '../bootstrap.js'
import { switchAgentRuntime, switchAgentSession } from '../bootstrap.js'
import { loadTodos, setTodoSession } from '../tools/todo.js'
import { restoreGoalTracker } from '../agent/goal-persist.js'
import { setPlanSession } from '../agent/plan-store.js'
import { isToolAllowed, isToolDenied, isBashCommandAllowlisted, isBashCommandDenied } from '../agent/permissions.js'
import { getMirrorConfig, setMirrorConfig } from '../config/manager.js'
import { formatMirrorStatus } from '../tools/mirror-env.js'
import { detectEnv, formatEnvGuidance, recommendUvSetup, isPythonProject } from '../tools/env-check.js'
import { getResolvedEnv, getResolvedPathDiff } from '../tools/resolved-env.js'
import { getShellCommand } from '../platform.js'
import { createCoordinatorReviewDeps } from '../agent/review-coordinator-deps.js'
import { routeReviewWorkflow, type ReviewMode, type ReviewOutcome } from '../agent/review-router.js'
import type { ChangeSet } from '../agent/review-discipline.js'
const HELP_TEXT = `Available commands:
/help — Show this help
/exit — Exit Rivet
/quit — Exit
/update — Check and install the latest Rivet release
/compact [status|llm] — Micro-compact context (/compact status for stats)
/model [name|list] — Show or switch model
/domain [list|<name>|auto|off] — Show or switch star domain personality
/verbose — Toggle verbose tool output
/auto — Toggle auto-approve
/permission [status|mode|allow|deny|bash|remove|reset|test] — Manage permission mode and rules
/theme [cobalt|gemini|antigravity|slate|ziwei|tianshu|midnight|pastel|cyberpunk|observatory|starfield|claude] — Switch color theme (default: cobalt)
/vim — Toggle vim keybindings
/effort [off|low|medium|high|max] — Set reasoning effort
/undo [<number>|preview <number>] — Undo file changes with preview
/clear — Clear screen
/sessions — List all saved sessions
/resume <number> — Restore a saved session
/fork [name] — Fork current session into a new copy and switch to it
/fork at <N> [name] — Fork from message line N (truncate after)
/branch — Show branch tree (parent + children)
/branch back — Switch back to parent session
/memory [text|add|search|forget] — Session memory entries
/mission — Show current task contract
/constellation [view|init|update <summary>|history|shift <summary>] — Project blueprint & milestone chronicle
/leave [symbol] <summary> — Leave your mark in the starmap as you depart
/context [pin|claims|antibodies|conflicts|reload|export|import] — Context ledger
/verify — Show verification status
/evidence — Show last turn evidence summary
/debug [prompt|fingerprint|cache|context-payload|mcp] — Debug info
/mcp — Show MCP server status
/cockpit [summary|trace|verify|context|safety|model|off] — Toggle cockpit panel
/scroll — Browse session history in pager
/skill [list|install <name>|import <name>|<name>|off <name>|review|approve <name>|reject <name>] — List/load skills; install from .claude/skills; review drafts
/interview <topic> — Deep interview before coding
/plan <feature> — Create implementation plan
/plan close <file> --tasks <range|all> [--preview] — Close implementation plan tasks
/team <task|plan> — Run team-mode workflow through team_orchestrate
/team max <task> — Run team-mode max planning through team_orchestrate
/council <task> [--seats id1,id2,...] [--rounds 1-2] — Convene a star-domain council (single round; --rounds 2 enables a rebuttal round)
/review — Manually trigger L2 review (single adversarial verifier) on current changes via deliver_task
/review max — Manually trigger L3 review (Review Squadron, 5 inspectors) on current changes via deliver_task
(auto: every non-trivial deliver_task commit runs a single Wiring inspector — short budget, never blocks on infra failure)
/sensorium — Show 天枢 3D self-awareness state
/dream — Distill session decisions into project memory
/index — Rebuild codebase index (modules + CLI entries)
/diagram [list|<type>] — Generate a mermaid diagram skeleton (architecture|dataflow|sequence|flowchart|comparison|state)
/model [id] — Switch model (no arg = open model picker)
/domain [id|list] — Switch star domain (no arg = open domain picker)
/status — Show agent status (model, domain, cache, tokens)
/mirror [status|on|off|china|default] — Toggle domestic mirrors for GitHub/npm/pip/go/rust downloads
/python [status|setup] — Check Python/uv/Git environment or auto-setup a Python project with uv
/doctor — Environment health check (Node/Git/Python/uv) + which shell the bash tool uses
/tools — Show available tools and their descriptions
/compact — Compact context (summarize old messages)
/workflow [list|<name>|replay <id>] — YAML workflow orchestration + trace replay
/todo [list|add <content>|done <id>|skip <id>|move <id> up|down] — Manage task list
/plan-template [list|<name>|save <name>] — Reusable plan templates
/team-resume [groupId] — Resume team execution from wave checkpoint
/goal <objective> [--max N] [--budget M] [--criteria '["..."]'] — Set autonomous goal
/goal-status — Show current goal state
/goal-pause — Pause active goal
/goal-resume — Resume paused/blocked goal
/goal-cancel — Cancel autonomous goal
/goal-criteria [set '["..."]'] — View or set success criteria
/rollback [<N>] — Rollback file changes (alias of /undo)
/write-plan — Write current plan to file
Ctrl+C — Interrupt current turn (press twice to exit)`

/**
 * Framework-agnostic mutable ref. Structurally compatible with React's
 * `MutableRefObject<T>` (`{ current: T }`) AND the T9 engine's plain
 * `MutableRef` adapter, so the non-React SlashRouter no longer needs to fake a
 * React type with `as unknown as React.MutableRefObject<...>` / `as any`.
 */
export interface MutableRefLike<T> {
  current: T
}

export interface SlashHandlerContext {
  parts: string[]
  agent: AgentLoop
  session: SessionContext
  persist: SessionPersist
  model: string
  maxTokens: number
  availableModels: Array<{ id: string; alias: string }>
  onModelSwitch: (modelId: string) => { ok: boolean; error?: string }
  allProviders: Record<string, { models: Array<{ id: string; alias: string }> }>
  currentProvider: string
  currentSessionId: string
  /**
   * Runtime session identity switch for /resume <id>. Rebuilds the agent runtime
   * against the target session so subsequent messages/logs write to the SAME id.
   * Returns the loaded message count or an error. Undefined → /resume falls back
   * to the legacy in-memory-only restore (no identity switch).
   */
  onSessionSwitch?: (targetId: string) => { ok: boolean; error?: string; messageCount?: number; repaired?: boolean; safe?: boolean }
  cost: number
  cacheHitRate: number
  autoSafeRef: MutableRefLike<boolean>
  verboseRef: MutableRefLike<boolean>
  setVerbose: (v: boolean) => void
  setAutoSafe: (v: boolean) => void
  rollbackTokenRef: MutableRefLike<string | null>
  setCockpitPanel: (v: Panel | ((prev: Panel) => Panel)) => void
  activeOverlay?: string | null
  surfacePush?: (id: string) => void
  surfacePop?: () => void
  pushStatic: (entry: LogEntry) => void
  setIsStreaming: (v: boolean) => void
  setCacheHitRate: (v: number) => void
  setSummaryState: (v: SummaryState | ((prev: SummaryState) => SummaryState)) => void
  mcpManagerRef: MutableRefLike<import('../mcp/manager.js').McpManager | null>
  claimStoreRef: MutableRefLike<ContextClaimStore | null>
  setReasoningEffort?: (effort: import('../agent/auto-reasoning.js').ReasoningEffort | 'auto') => void
  reasoningEffort?: string
  onDomainChange?: (domainName: string | undefined) => void
  /** T5: bandit promotion state for /status observability. */
  banditState?: import('../server/routes.js').BanditStatusEntry[]
  /** 独立审查回调——/review 不经过 deliver_task 直接调 routeReviewWorkflow。
   *  未注入时 /review fallback 到 resolveAppPromptInput → deliver_task 旧路径。 */
  runReview?: (change: import('../agent/review-discipline.js').ChangeSet, mode: import('../agent/review-router.js').ReviewMode, focus?: string) => Promise<import('../agent/review-router.js').ReviewOutcome>
  /** Submit a prompt directly to the agent pipeline, bypassing slash routing.
   *  Used by commands that need to transform the input before sending (e.g. /goal). */
  submitToAgent?: (prompt: string) => void
  /** Mutable ref to the current GoalTracker. Set when /goal creates a tracker;
   *  read by deliver_task's B1Context for auto-review gating. */
  goalTrackerRef?: { current: import('../agent/goal-tracker.js').GoalTracker | null }
}

/** 收集当前工作区未提交的改动文件（unstaged + staged + untracked）。 */
async function collectDirtyFiles(cwd: string): Promise<string[]> {
  const { spawnSync } = await import('node:child_process')
  const run = (gitArgs: string[]): string[] => {
    const r = spawnSync('git', ['-c', 'core.quotePath=false', ...gitArgs], { cwd, encoding: 'utf-8', timeout: 5000 })
    return r.status === 0 ? r.stdout.split('\0').filter(Boolean) : []
  }
  try {
    const unstaged = run(['diff', '--name-only', '-z'])
    const staged = run(['diff', '--cached', '--name-only', '-z'])
    const untracked = run(['ls-files', '--others', '--exclude-standard', '-z'])
    return [...new Set([...unstaged, ...staged, ...untracked])].sort()
  } catch {
    return []
  }
}

interface ParsedGoalArgs {
  goalText: string
  maxIterations?: number
  wallClockMs?: number
  criteria?: string[]
}

/** 解析 /goal 命令行参数，支持 --max N / --budget M / --criteria '["..."]'
 *  其余部分合并为目标描述。 */
function parseGoalArgs(parts: string[]): ParsedGoalArgs {
  const out: ParsedGoalArgs = { goalText: '' }
  const textParts: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!
    if (p === '--max' && parts[i + 1]) {
      const n = Number(parts[i + 1])
      if (Number.isInteger(n) && n > 0) out.maxIterations = n
      i++
      continue
    }
    if (p === '--budget' && parts[i + 1]) {
      const n = Number(parts[i + 1])
      if (!Number.isNaN(n) && n > 0) out.wallClockMs = Math.round(n * 60000)
      i++
      continue
    }
    if (p === '--criteria' && parts[i + 1]) {
      try {
        const parsed = JSON.parse(parts[i + 1]!)
        if (Array.isArray(parsed) && parsed.every((c: unknown) => typeof c === 'string')) {
          out.criteria = parsed as string[]
        }
      } catch { /* ignore invalid JSON */ }
      i++
      continue
    }
    textParts.push(p)
  }
  out.goalText = textParts.join(' ').trim()
  return out
}

/** 把 GoalTracker 状态持久化到会话目录（best-effort）。 */
async function persistGoalState(ctx: SlashHandlerContext, tracker: import('../agent/goal-tracker.js').GoalTracker): Promise<void> {
  if (!ctx.currentSessionId) return
  try {
    const { saveGoalState } = await import('../agent/goal-persist.js')
    const { getSessionDir } = await import('../agent/session-persist.js')
    saveGoalState(getSessionDir(ctx.agent.cwd), ctx.currentSessionId, tracker)
  } catch { /* best-effort */ }
}

/** 格式化当前 goal 状态供 /goal-status 使用。 */
function formatGoalStatus(tracker: import('../agent/goal-tracker.js').GoalTracker): string {
  const status = tracker.getStatus()
  const statusLabels: Record<string, string> = { active: '进行中', paused: '已暂停', blocked: '已阻塞', complete: '已完成' }
  const lines = [
    `🎯 ${tracker.getGoal()}`,
    `状态: ${statusLabels[status] ?? status}`,
    `迭代: ${tracker.getIteration()}/${tracker.getMaxIterations()}`,
    `已用时间: ${Math.round(tracker.getWallClockElapsedMs() / 1000)}s`,
  ]
  const budget = tracker.getWallClockBudgetMs()
  if (budget !== undefined) lines.push(`时间预算: ${Math.round(budget / 60000)}m`)
  const criteria = tracker.getSuccessCriteria()
  if (criteria.length > 0) {
    lines.push('验收项:')
    criteria.forEach((c, i) => lines.push(`  ${i + 1}. ${c}`))
  }
  const verdict = tracker.getLastVerdict()
  if (verdict) {
    lines.push(`最近核验: ${verdict.overall} · ${verdict.criteriaMet}/${verdict.criteriaTotal} 项通过`)
  }
  return lines.join('\n')
}

function formatClaimLine(claim: import('../context/claims.js').ContextClaim): string {
  return `- [${claim.status}] ${claim.kind}: ${claim.text}`
}

export function formatContextClaimsCommand(store: ContextClaimStore, status?: ContextClaimStatus): string {
  const claims = status
    ? store.listClaims({ status: [status] })
    : store.listClaims()
  if (claims.length === 0) return 'No context claims.'
  return claims.map(formatClaimLine).join('\n')
}

export function formatVerificationStatus(agent: AgentLoop): string {
  const summary = agent.getVerificationSummary()
  if (summary.total === 0) return 'Verification Status\n\nNo modified files tracked in this turn.'
  const lines = summary.files.map(file => {
    const icon = file.level === 'pending' ? '✗' : '✓'
    return `  ${icon} ${file.path} (${file.level})`
  })
  const percent = Math.round((summary.verified / summary.total) * 100)
  const state = agent.getEvidenceState()
  const last = state.verifications.at(-1)
  const lastLine = last ? `\nLast verification: ${last.status} — ${last.command}` : '\nLast verification: none'
  return `Verification Status\n\nModified files:\n${lines.join('\n')}\n\nVerification: ${summary.verified}/${summary.total} (${percent}%)${lastLine}`
}

function knowledgeDir(): string {
  return join(process.cwd(), '.rivet', 'knowledge')
}

function appendProjectKnowledge(text: string): string {
  const dir = knowledgeDir()
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'memory.md')
  const line = `- ${new Date().toISOString()} ${text}\n`
  writeFileSync(file, line, { flag: 'a' })
  return file
}

export function formatMemoryOverview(ctx: SlashHandlerContext): string {
  const memory = ctx.persist.loadMemory()
  const sessionLines = memory.entries.length === 0
    ? ['  (empty)']
    : memory.entries.slice(-8).map(e => `  • [${e.id}] ${e.text}`)

  const pheromones = ctx.agent.getLatestPheromones?.() ?? []
  const pheromoneLines = pheromones.length === 0
    ? ['  (none loaded yet)']
    : pheromones.slice(0, 8).map(p => `  • ${p.path} — ${p.signal} (${p.strength.toFixed(2)})`)

  const dir = knowledgeDir()
  const knowledgeFiles = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.md')).slice(0, 8)
    : []
  const knowledgeLines = knowledgeFiles.length === 0
    ? ['  (none)']
    : knowledgeFiles.map(f => `  • ${f}`)

  return `天枢记忆\n\n📝 当前 session (${memory.entries.length} 条)\n${sessionLines.join('\n')}\n\n🧠 项目直觉 (${pheromones.length} 条)\n${pheromoneLines.join('\n')}\n\n📚 项目知识 (${knowledgeFiles.length} 篇)\n${knowledgeLines.join('\n')}\n\n命令: /memory add <内容> | /memory search <query> | /memory forget <id>`
}

export function searchMemory(ctx: SlashHandlerContext, query: string): string {
  const needle = query.toLowerCase()
  const sessionHits = ctx.persist.loadMemory().entries
    .filter(e => e.text.toLowerCase().includes(needle))
    .map(e => `session:${e.id} ${e.text}`)
  const pheromoneHits = (ctx.agent.getLatestPheromones?.() ?? [])
    .filter(p => `${p.path} ${p.signal} ${p.context ?? ''}`.toLowerCase().includes(needle))
    .map(p => `pheromone:${p.path} ${p.signal} ${p.context ?? ''}`)
  const dir = knowledgeDir()
  const knowledgeHits = existsSync(dir)
    ? readdirSync(dir).filter(f => f.endsWith('.md')).flatMap(file => {
      const content = readFileSync(join(dir, file), 'utf-8')
      return content.toLowerCase().includes(needle) ? [`knowledge:${file} ${content.slice(0, 160).replaceAll('\n', ' ')}`] : []
    })
    : []
  const hits = [...sessionHits, ...pheromoneHits, ...knowledgeHits].slice(0, 20)
  return hits.length === 0 ? `No memory found for "${query}".` : `Memory search: ${query}\n${hits.map(h => `- ${h}`).join('\n')}`
}

export interface ResolvedPromptInput {
  prompt: string
  /** 见 WorkflowResolveResult.requiredTools。仅 ecosystem workflow 路径可能非空。 */
  requiredTools?: readonly string[]
}

export function resolveAppPromptInput(input: string, cwd: string): ResolvedPromptInput | null {
  if (!input.startsWith('/')) return { prompt: input }
  const workflow = resolveEcosystemWorkflowInput(input)
  if (workflow) return { prompt: workflow.prompt, requiredTools: workflow.requiredTools }
  const custom = resolveCustomCommand(cwd, input)
  if (custom) return { prompt: custom }
  const skillPrompt = resolveSkillPrompt(input, cwd)
  if (skillPrompt !== null) return { prompt: skillPrompt }
  // /review [max] [focus description] — map to deliver_task instruction for the agent
  const reviewMatch = input.match(/^\/review(?:\s+(max))?(?:\s+(.*))?$/i)
  if (reviewMatch) {
    const isMax = !!reviewMatch[1]
    const focusText = reviewMatch[2]?.trim()
    const level = isMax ? 'L3' : 'L2'
    const levelLabel = level === 'L3' ? 'L3 Review Squadron (5 inspectors)' : 'L2 adversarial verifier'
    const focusInstruction = focusText ? ` Focus specifically on: ${focusText}.` : ''
    return { prompt: `Run code review on the current uncommitted changes: call deliver_task with commit=true and review_level="${level}". This triggers ${levelLabel}.${focusInstruction}` }
  }
  // /review typos — don't silently drop user input
  if (/^\/review/i.test(input)) {
    return { prompt: `User typed "${input}" which looks like a /review command but didn't match the expected format. Usage: /review [max] [focus description]. Run /review max to trigger L3 Review Squadron.` }
  }
  // Unrecognized slash command — return null to signal "blocked"
  return null
}

/**
 * Resolve `/skill <name> [user task...]` into the skill's full body prompt.
 * Reserved subcommands (list/install/etc.) and unknown skills return null so
 * they fall back to the slash handler's local behavior or error message.
 */
function resolveSkillPrompt(input: string, cwd: string): string | null {
  const match = input.trim().match(/^\/skill\s+(\S+)(?:\s+(.*))?$/s)
  if (!match) return null
  const name = match[1]!
  const userTask = match[2]?.trim() ?? ''
  const reserved = new Set(['list', 'ls', 'install', 'import', 'review', 'drafts', 'approve', 'reject', 'off', 'complete'])
  if (reserved.has(name.toLowerCase())) return null
  const skill = skillRegistry.get(name) ?? skillRegistry.list().find(s => s.name.toLowerCase() === name.toLowerCase())
  if (!skill) return null
  let prompt = `[Skill loaded: ${skill.name}]\n<skill name="${skill.name}">\n${skill.body}\n</skill>`
  if (skill.skillDir) {
    const files = listSkillFiles(skill.skillDir)
    if (files.length > 0) {
      prompt += `\n<skill-files dir="${skill.skillDir}" note="Read on demand with read_file/grep/glob; page large sub-files completely with offset/limit.">\n${files.map(f => '  ' + f.path).join('\n')}\n</skill-files>`
    }
  }
  if (userTask) {
    prompt += `\n\nUser task: ${userTask}`
  }
  return prompt
}

/**
 * Resolve `/enter <worker-id-or-label> [message]` into a prompt that resumes
 * the worker via delegate_task, or return a usage/error message.
 */
export function resolveEnterWorkerInput(
  app: TuiApp,
  input: string,
): { prompt: string } | { error: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/enter')) return null
  const parts = trimmed.split(/\s+/)
  if (parts.length < 2) {
    return { error: 'Usage: /enter <worker-id-or-label> [continuation message]' }
  }
  const target = parts[1]!
  const message = parts.slice(2).join(' ').trim()
  const resolved = app.resolveWorkerId(target)
  if (!resolved) {
    return { error: `Worker not found: "${target}". Use /tasks to see available workers.` }
  }
  const objective = message || 'Continue from where you left off.'
  const prior = resolved.objective ? ` Previous objective: ${resolved.objective}.` : ''
  const prompt = `Resume worker ${resolved.workerId} (profile: ${resolved.profile}).${prior} Continue with: ${objective} Call delegate_task with resume="${resolved.workerId}" and objective="${objective}".`
  return { prompt }
}


interface TuiSlashCommandDef {
  readonly name: string
  readonly description?: string
  readonly immediate?: true
  readonly handler: (ctx: SlashHandlerContext) => boolean | Promise<boolean>
}

const TUI_SLASH_COMMANDS: readonly TuiSlashCommandDef[] = [
  {
    name: '/tools',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      if (sub === 'enable') {
        const toolName = parts[2]
        if (!toolName) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /tools enable <tool_name>\nMounts an EXTENDED-layer tool onto the primary agent at this turn boundary.\nAlternatively, use delegate_task to dispatch a worker with that tool (zero cache cost).' }))
        } else {
          const result = ctx.agent.enableTool(toolName)
          switch (result.status) {
            case 'mounted': {
              const costLine = result.cacheImpact === 'prefix-invalidated'
                ? `⚠ Cache impact: provider "${result.prefixCacheStrategy}" uses exact-prefix caching — the NEXT request will be a full prefix-cache MISS (one-time cost; subsequent turns re-cache against the new tool set).`
                : `✓ Cache impact: provider "${result.prefixCacheStrategy}" has no prefix cache — no cache penalty.`
              pushStatic(createLogEntry({ type: 'system', content: `Mounted EXTENDED tool "${toolName}" onto the primary agent.\n${costLine}` }))
              break
            }
            case 'already-active':
              pushStatic(createLogEntry({ type: 'system', content: `"${toolName}" is already mounted on the primary agent. No change.` }))
              break
            case 'not-extended':
              pushStatic(createLogEntry({ type: 'system', content: `"${toolName}" is a CORE or already-visible tool — it's available without mounting. No change.` }))
              break
            case 'unknown':
              pushStatic(createLogEntry({ type: 'system', content: `Unknown tool "${toolName}". Run /tools to list available tiers.` }))
              break
            case 'gating-off':
              pushStatic(createLogEntry({ type: 'system', content: `Tool gating is disabled — all tools are already visible to the primary agent. No change.` }))
              break
          }
        }
      } else {
        // List current tool tiers
        const { CORE_TOOLS, EXTENDED_TOOLS, isExtendedTool } = await import('../agent/tool-tiers.js')
        const active = new Set(ctx.agent.getActiveToolNames())
        const mountedExtras = [...active].filter(isExtendedTool)
        const lines: string[] = ['Tool Gating Tiers', '═════════════════════', '', `CORE (${CORE_TOOLS.length}):`, ...CORE_TOOLS.map(t => `  ✓ ${t}`), '', `EXTENDED (${EXTENDED_TOOLS.length}):`, ...EXTENDED_TOOLS.map(t => `  ${active.has(t) ? '✓ (mounted)' : '·'} ${t}`), '']
        if (mountedExtras.length > 0) {
          lines.push(`Runtime-mounted EXTENDED: ${mountedExtras.join(', ')}`, '')
        }
        lines.push('EXTENDED tools are available to workers via delegate_task.', 'Use /tools enable <name> to mount one onto the primary agent.')
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/help',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: HELP_TEXT }))
      setIsStreaming(false)
      return true

    },
  },
  {
    name: '/status',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const lines: string[] = ['Bandit Promotion State', '═══════════════════════']
      if (ctx.banditState && ctx.banditState.length > 0) {
        for (const b of ctx.banditState) {
          lines.push(`${b.source}: ${b.mode} (enabled=${b.enabled})`)
          lines.push(`  reason: ${b.reason}`)
          lines.push(`  samples: ${b.totalShadowSamples}`)
        }
      } else {
        lines.push('(no bandit state available — run bootstrap first)')
      }
      lines.push('', 'Review Infra Health', '═══════════════════════')
      lines.push(formatReviewHealthLine())
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/exit',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.persist.compactOai(ctx.session.getMessages())
      pushStatic(createLogEntry({ type: 'system', content: 'Session saved. Goodbye!' }))
      process.emit('SIGINT')
      return true

    },
  },
  {
    name: '/quit',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.persist.compactOai(ctx.session.getMessages())
      pushStatic(createLogEntry({ type: 'system', content: 'Session saved. Goodbye!' }))
      process.emit('SIGINT')
      return true

    },
  },
  {
    name: '/compact',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      const msgs = ctx.session.getMessages()
      const beforeTokens = estimateOaiTokens(msgs)

      if (sub === 'status') {
        const compacts = ctx.session.getCompactEvents()
        const ledger = ctx.session.getContextLedger()
        const pct = ledger ? Math.round(ledger.tokenBudget.estimatedTokens / ledger.tokenBudget.maxTokens * 100) : 0
        const compactStr = compacts.length === 0
          ? 'No compact events yet.'
          : compacts.slice(-5).map(e => `  turn ${e.turn}: tier ${e.tier}, ${e.beforeTokens.toLocaleString()}→${e.afterTokens.toLocaleString()}`).join('\n')
        pushStatic(createLogEntry({ type: 'system', content: `Compact status: ${beforeTokens.toLocaleString()}/${ctx.maxTokens.toLocaleString()} tokens (${pct}%)\n\nRecent events:\n${compactStr}\n\nUse /compact to micro-compact, /compact llm to resume LLM compact.` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'llm' || sub === 'deep') {
        // LLM compact — deferred to next turn (triggers automatically at thresholds)
        pushStatic(createLogEntry({ type: 'system', content: `LLM compact will trigger automatically at context thresholds (currently ${beforeTokens.toLocaleString()} tokens). Use /compact for immediate micro-compact.` }))
        setIsStreaming(false)
        return true
      }

      // micro compact (default)
      pushStatic(createLogEntry({ type: 'system', content: 'Micro-compacting conversation...' }))
      const { messages: compacted, truncated } = microCompactOai(msgs, ctx.maxTokens, beforeTokens)
      ctx.session.replaceMessages(compacted)
      ctx.agent.config.promptEngine.resetAppendixBaseline()
      const afterTokens = estimateOaiTokens(compacted)
      ctx.session.recordCompactEvent({
        turn: ctx.session.getTurnCount(),
        tier: 1,
        reason: 'manual /compact command',
        beforeTokens,
        afterTokens,
        createdAt: Date.now(),
      })
      const pctRemoved = beforeTokens > 0 ? Math.round((1 - afterTokens / beforeTokens) * 100) : 0
      pushStatic(createLogEntry({ type: 'system', content: `Compacted: ${beforeTokens.toLocaleString()} → ${afterTokens.toLocaleString()} tokens (-${pctRemoved}%, ${truncated} msgs removed, ${compacted.length} remaining).` }))
      ctx.setSummaryState(prev => ({ ...prev, compactEvent: { beforeTokens, afterTokens } }))
      setTimeout(() => ctx.setSummaryState(prev => ({ ...prev, compactEvent: null })), 8000)
      ctx.setCacheHitRate(ctx.session.getCacheHitRate())
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/team',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /team <task|docs/superpowers/plans/file.md>\n       /team max <task>' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/council',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /council <要会诊的计划/问题> [--seats id1,id2,...] [--rounds 1-2]' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/review',
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // /review [max] [focus] — 独立审查入口（不经过 deliver_task）。
      // 当 ctx.runReview 可用时直接调 routeReviewWorkflow；否则 fallback 到旧路径。
      const isMax = parts[1]?.toLowerCase() === 'max'
      const focus = parts.slice(isMax ? 2 : 1).join(' ').trim()

      if (!ctx.runReview) {
        // Fallback: 让 resolveAppPromptInput 映射为 deliver_task 指令
        return false
      }

      // 动态导入避免循环依赖 + 避免顶层 import 增加初始 bundle
      const { isCrossModule, isFixContext } = await import('../agent/review-discipline.js')
      const { reviewWorkflowBudgetMs } = await import('../agent/review-router.js')
      type ChangeSet = import('../agent/review-discipline.js').ChangeSet
      type ReviewMode = import('../agent/review-router.js').ReviewMode

      // 从 git diff 构造 ChangeSet
      const dirtyFiles = await collectDirtyFiles(ctx.agent.cwd)
      if (dirtyFiles.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: '没有未提交的改动可以审查。' }))
        setIsStreaming(false)
        return true
      }

      const change: ChangeSet = {
        files: dirtyFiles,
        crossModule: isCrossModule(dirtyFiles),
        isFix: isFixContext(focus || ''),
        ...(isMax ? { forceLevel: 'L3' as const } : {}),
      }

      const mode: ReviewMode = 'manual'
      const budgetSec = Math.round(reviewWorkflowBudgetMs(mode, isMax ? 'L3' : undefined) / 1000)
      const levelLabel = isMax ? 'L3 Squadron (5 inspectors)' : 'auto-classify'
      pushStatic(createLogEntry({ type: 'system', content: `⏳ 审查启动中 (${levelLabel}, ≤${budgetSec}s)...\n` }))

      try {
        const outcome = await ctx.runReview(change, mode, focus || undefined)
        const icon = outcome.verdict === 'verified' ? '🟢'
                   : outcome.verdict === 'rejected' ? '🔴' : '🟡'
        const lines = [`${icon} 审查结果 [${outcome.tier}]: ${outcome.verdict}`]
        if (typeof outcome.rounds === 'number') lines.push(`   轮次：${outcome.rounds}`)
        if (outcome.evidence) lines.push(`   证据：${outcome.evidence}`)
        if (outcome.verdict === 'rejected' || outcome.escalated) {
          lines.push('   → 请在后续提交中处理审查发现。')
        }
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      } catch (err) {
        pushStatic(createLogEntry({ type: 'system', content: `审查失败：${(err as Error).message}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/model',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const targetModel = parts[1]
      if (!targetModel || targetModel === 'list') {
        const lines: string[] = []
        for (const [provName, prov] of Object.entries(ctx.allProviders)) {
          const marker = provName === ctx.currentProvider ? ' ← current' : ''
          lines.push(`[${provName}]${marker}`)
          for (const m of prov.models) {
            const isCurrent = m.alias === ctx.model || m.id === ctx.model
            lines.push(`  ${m.alias} (${m.id})${isCurrent ? ' ←' : ''}`)
          }
        }
        pushStatic(createLogEntry({ type: 'system', content: `Models:\n${lines.join('\n')}\n\nCurrent: ${ctx.model} [${ctx.currentProvider}]\nContext: ${ctx.maxTokens.toLocaleString()} tokens\nCost: ¥${ctx.cost.toFixed(4)}` }))
      } else {
        const result = ctx.onModelSwitch(targetModel)
        if (result.ok) {
          pushStatic(createLogEntry({ type: 'system', content: `Switched to ${targetModel}` }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: result.error ?? `Model "${targetModel}" not found.` }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mirror',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      const current = getMirrorConfig()

      if (sub === 'on') {
        const next = setMirrorConfig({ enabled: true, preset: current.preset === 'default' ? 'china' : current.preset })
        pushStatic(createLogEntry({ type: 'system', content: `✅ Mirrors enabled.\n${formatMirrorStatus(next)}` }))
      } else if (sub === 'off') {
        const next = setMirrorConfig({ enabled: false })
        pushStatic(createLogEntry({ type: 'system', content: `✅ Mirrors disabled.\n${formatMirrorStatus(next)}` }))
      } else if (sub === 'china') {
        const next = setMirrorConfig({ enabled: true, preset: 'china' })
        pushStatic(createLogEntry({ type: 'system', content: `✅ Switched to China mirror preset.\n${formatMirrorStatus(next)}` }))
      } else if (sub === 'default') {
        const next = setMirrorConfig({ enabled: false, preset: 'default', github: 'default', npm: 'default', pypi: 'default', go: 'default', rust: 'default' })
        pushStatic(createLogEntry({ type: 'system', content: `✅ Reset mirrors to default (off).\n${formatMirrorStatus(next)}` }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `${formatMirrorStatus(current)}\n\nUsage: /mirror [on|off|china|default]` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/python',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming, agent } = ctx
      const sub = parts[1]?.toLowerCase()
      const env = await detectEnv(agent.cwd)

      if (sub === 'status') {
        const lines = [
          `Python: ${env.python.available ? `${env.python.command} (${env.python.version ?? 'unknown'})` : '未安装'}`,
          `uv: ${env.uv.available ? `已安装 (${env.uv.version ?? 'unknown'})` : '未安装'}`,
          `Git: ${env.git.available ? `已安装 (${env.git.version ?? 'unknown'})` : '未安装'}`,
          `Node: ${env.node.available ? `已安装 (${env.node.version ?? 'unknown'})` : '未安装'}`,
          `平台: ${env.platform}`,
        ]
        const guidance = formatEnvGuidance(env)
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') + (guidance ? '\n\n' + guidance : '') }))
      } else if (sub === 'setup') {
        if (!env.python.available) {
          pushStatic(createLogEntry({ type: 'system', content: '未检测到 Python，无法自动配置项目。\n\n' + formatEnvGuidance(env) }))
        } else if (!env.uv.available) {
          pushStatic(createLogEntry({ type: 'system', content: '已检测到 Python。推荐安装 uv 来自动管理依赖：\n\n' + formatEnvGuidance(env) }))
        } else {
          const recommendation = recommendUvSetup(agent.cwd)
          if (recommendation.ok && recommendation.command) {
            pushStatic(createLogEntry({ type: 'system', content: `${recommendation.message}\n即将执行：${recommendation.command}\n\n你可以直接粘贴该命令，或者说"执行 Python 项目初始化"。` }))
          } else {
            pushStatic(createLogEntry({ type: 'system', content: recommendation.message }))
          }
        }
      } else {
        const hasProject = isPythonProject(agent.cwd)
        pushStatic(createLogEntry({ type: 'system', content: `当前目录 ${hasProject ? '是' : '不像'} Python 项目。\n\nUsage: /python [status|setup]` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/doctor',
    immediate: true,
    async handler(ctx) {
      const { pushStatic, setIsStreaming, agent } = ctx
      // Probe against the RESOLVED env (not raw process env) so results reflect
      // what the agent can actually run after GUI-launch PATH recovery.
      const resolved = getResolvedEnv(agent.cwd)
      const env = await detectEnv(agent.cwd, resolved)
      const shell = getShellCommand()
      const toolLine = (label: string, t: { available: boolean; command?: string; version?: string }): string =>
        `${label} ${t.available ? `已安装 (${t.version ?? t.command ?? 'unknown'})` : '未安装 / 未在 PATH'}`
      const lines = [
        '环境体检 (/doctor)',
        '═══════════════════════',
        `平台: ${env.platform}`,
        toolLine('Node:  ', env.node),
        toolLine('Git:   ', env.git),
        toolLine('Python:', env.python),
        toolLine('uv:    ', env.uv),
        toolLine('Java:  ', env.java),
        toolLine('Maven: ', env.maven),
        toolLine('Gradle:', env.gradle),
        '',
        'Shell (bash 工具实际使用)',
        '───────────────────────',
        `kind: ${shell.kind}   cmd: ${shell.cmd}`,
      ]
      if (env.platform === 'win32' && shell.kind !== 'bash') {
        lines.push('', '⚠ Windows 未使用 Git Bash — 命令执行已退回 ' + shell.kind + '。')
        lines.push('  安装 Git for Windows 可获得更可靠的 POSIX 命令执行。')
      }

      // PATH recovery diff: show what the resolver added on top of the raw
      // process PATH, so the user knows whether GUI-launch recovery kicked in and
      // what to add to `env.extraPath` if a tool is still missing.
      const diff = getResolvedPathDiff(agent.cwd)
      lines.push('', 'PATH 解析 (GUI 启动兜底)', '───────────────────────')
      lines.push(`process PATH 条目: ${diff.processPath.length}   resolved PATH 条目: ${diff.resolvedPath.length}`)
      if (diff.added.length > 0) {
        lines.push('已补全以下目录（进程 PATH 缺失）:')
        for (const d of diff.added.slice(0, 20)) lines.push(`  + ${d}`)
        if (diff.added.length > 20) lines.push(`  … 及另外 ${diff.added.length - 20} 项`)
      } else {
        lines.push('resolved PATH 与 process PATH 一致（无需补全）。')
      }
      const stillMissing = [
        !env.git.available ? 'git' : null,
        !env.java.available ? 'java' : null,
        !env.maven.available ? 'mvn' : null,
        !env.gradle.available ? 'gradle' : null,
      ].filter(Boolean)
      if (stillMissing.length > 0) {
        lines.push('', `仍未找到: ${stillMissing.join(', ')}`)
        lines.push('若已安装，请把其可执行目录加入配置 env.extraPath（数组），或设置对应的 *_HOME 变量后重启天枢。')
      }

      const guidance = formatEnvGuidance(env)
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') + (guidance ? '\n\n' + guidance : '') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/chat',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: '模式已由消息内容自动检测，无需手动切换。任务脚手架在有明确意图时自动开启。' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/task',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: '模式已由消息内容自动检测，无需手动切换。任务脚手架在有明确意图时自动开启。' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mode',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: '模式已由消息内容自动检测，无需手动切换。' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const parsed = parseGoalArgs(parts.slice(1))
      if (!parsed.goalText) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /goal <task description> [--max N] [--budget M] [--criteria \'["..."]\']\nSets a persistent goal. The agent will auto-continue until the goal is achieved or the budget is exhausted.\nCancel with /goal-cancel.' }))
        setIsStreaming(false)
        return true
      }
      const { GoalTracker, buildGoalModePrompt } = await import('../agent/goal-tracker.js')
      const maxIterations = parsed.maxIterations ?? Math.max(50, Math.floor(ctx.maxTokens / 4000))
      const tracker = new GoalTracker({
        goal: parsed.goalText,
        maxIterations,
        contextWindow: ctx.maxTokens,
        wallClockMs: parsed.wallClockMs,
        maxJudgeRuns: ctx.agent.config.goalJudge?.maxRuns,
      })
      if (parsed.criteria) {
        tracker.setSuccessCriteria(parsed.criteria)
      }
      ctx.agent.setGoalTracker(tracker)
      if (ctx.goalTrackerRef) ctx.goalTrackerRef.current = tracker
      await persistGoalState(ctx, tracker)
      const budgetHint = parsed.wallClockMs !== undefined
        ? `Wall-clock budget: ${Math.round(parsed.wallClockMs / 60000)}m. `
        : ''
      pushStatic(createLogEntry({ type: 'system', content: `🎯 Goal activated: ${parsed.goalText}\nMax iterations: ${maxIterations}. ${budgetHint}Output "GOAL ACHIEVED" to complete, "GOAL BLOCKED" for blockers, or /goal-cancel to abort.\nUse /goal-pause to pause, /goal-resume to resume.` }))
      if (ctx.agent.config.goalJudge?.enabled !== false && !parsed.criteria) {
        void (async () => {
          try {
            const { extractGoalCriteria, completionFromClient, buildCheapClient } = await import('../agent/goal-criteria.js')
            const { loadConfig } = await import('../config/manager.js')
            const cfg = await loadConfig()
            const cheapProfile = cfg.workers?.profiles?.cheap
            const allProviders = ctx.agent.config.allProviders ?? {}
            let completion
            if (cheapProfile && allProviders[cheapProfile.provider]) {
              const cheap = buildCheapClient(cheapProfile, allProviders)
              completion = cheap
                ? completionFromClient(cheap.client, cheap.model)
                : completionFromClient(ctx.agent.config.client, ctx.agent.config.promptEngine.getModel())
            } else {
              completion = completionFromClient(ctx.agent.config.client, ctx.agent.config.promptEngine.getModel())
            }
            const criteria = await extractGoalCriteria(parsed.goalText, completion)
            tracker.setSuccessCriteria(criteria)
            await persistGoalState(ctx, tracker)
            pushStatic(createLogEntry({ type: 'system', content: `🔍 Judge 验收项（完成时独立核验）：\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}` }))
          } catch {
            pushStatic(createLogEntry({ type: 'system', content: '🔍 验收项提取已降级为宽判模式（extraction failed）。' }))
          }
        })()
      }
      setIsStreaming(false)
      ctx.submitToAgent?.(buildGoalModePrompt(parsed.goalText))
      return true
    },
  },
  {
    name: '/cancel-goal',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.agent.setGoalTracker(null)
      if (ctx.goalTrackerRef) ctx.goalTrackerRef.current = null
      // Clean up persisted goal state if session info is available
      if (ctx.currentSessionId) {
        try {
          const { deleteGoalState } = await import('../agent/goal-persist.js')
          const { getSessionDir } = await import('../agent/session-persist.js')
          deleteGoalState(getSessionDir(ctx.agent.cwd), ctx.currentSessionId)
        } catch { /* best-effort */ }
      }
      pushStatic(createLogEntry({ type: 'system', content: '🚫 Goal cancelled.' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal-resume',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No paused or blocked goal to resume. Use /goal <task> to start one.' }))
        setIsStreaming(false)
        return true
      }
      const status = tracker.getStatus()
      if (status !== 'paused' && status !== 'blocked') {
        pushStatic(createLogEntry({ type: 'system', content: `Goal is ${status}, cannot resume.` }))
        setIsStreaming(false)
        return true
      }
      tracker.resume('user')
      const wallElapsed = Math.round(tracker.getWallClockElapsedMs() / 1000)
      pushStatic(createLogEntry({ type: 'system', content: `▶️ Goal resumed: ${tracker.getGoal()}\nIteration: ${tracker.getIteration()}/${tracker.getMaxIterations()} | ⏱ ${wallElapsed}s elapsed.` }))
      ctx.submitToAgent?.(`[GOAL RESUME] 继续执行目标: ${tracker.getGoal()}`)
      return true
    },
  },
  {
    name: '/goal-criteria',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No active goal. Use /goal <task> first.' }))
        setIsStreaming(false)
        return true
      }
      const subCmd = parts[1]?.toLowerCase()
      if (subCmd === 'set') {
        // /goal-criteria set <json array>
        const jsonText = parts.slice(2).join(' ').trim()
        if (!jsonText) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /goal-criteria set \'["criterion 1", "criterion 2"]\'' }))
          setIsStreaming(false)
          return true
        }
        try {
          const criteria = JSON.parse(jsonText)
          if (!Array.isArray(criteria) || !criteria.every((c: unknown) => typeof c === 'string')) {
            throw new Error('Expected a JSON array of strings')
          }
          tracker.setSuccessCriteria(criteria as string[])
          pushStatic(createLogEntry({ type: 'system', content: `✅ 验收项已更新（${(criteria as string[]).length} 项）:\n${(criteria as string[]).map((c, i) => `${i + 1}. ${c}`).join('\n')}` }))
        } catch (e) {
          pushStatic(createLogEntry({ type: 'system', content: `❌ 解析失败: ${(e as Error).message}` }))
        }
      } else {
        // Show current criteria
        const criteria = tracker.getSuccessCriteria()
        if (criteria.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: '当前无验收项（提取未完成或失败）。\n用 /goal-criteria set \'["..."]\' 手动设置。' }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: `📋 Judge 验收项（${criteria.length} 项）:\n${criteria.map((c, i) => `${i + 1}. ${c}`).join('\n')}\n\n用 /goal-criteria set \'["..."]\' 覆盖。` }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal-status',
    immediate: true,
    handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No active goal. Use /goal <task> to start one.' }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: formatGoalStatus(tracker) }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/goal-pause',
    immediate: true,
    async handler(ctx) {
      const { pushStatic, setIsStreaming } = ctx
      const tracker = ctx.goalTrackerRef?.current
      if (!tracker) {
        pushStatic(createLogEntry({ type: 'system', content: 'No active goal to pause. Use /goal <task> to start one.' }))
        setIsStreaming(false)
        return true
      }
      const status = tracker.getStatus()
      if (status !== 'active') {
        pushStatic(createLogEntry({ type: 'system', content: `Goal is ${status}, cannot pause.` }))
        setIsStreaming(false)
        return true
      }
      tracker.pause('Paused by user', 'user')
      await persistGoalState(ctx, tracker)
      pushStatic(createLogEntry({ type: 'system', content: `⏸ Goal paused: ${tracker.getGoal()}\nIteration: ${tracker.getIteration()}/${tracker.getMaxIterations()} | Use /goal-resume to continue.` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/domain',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()
      if (!sub || sub === 'status') {
        // Show current domain
        const current = ctx.agent.getSessionDomain()
        if (current === undefined) {
          pushStatic(createLogEntry({ type: 'system', content: '星域\n\n尚未激活。发送第一条消息后将根据内容自动匹配。\n使用 /domain list 查看所有星域，/domain <名称> 手动指定。' }))
        } else if (current === null) {
          pushStatic(createLogEntry({ type: 'system', content: '星域\n\n当前无星域（自动匹配未命中）。\n使用 /domain <名称> 手动指定，或 /domain auto 重置为自动检测。' }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: `星域\n\n当前: ${current.name} (${current.id})\n座右铭: ${current.motto}\n\n${current.volatileBlock}` }))
        }
      } else if (sub === 'list' || sub === 'ls') {
        const current = ctx.agent.getSessionDomain()
        const currentId = current?.id
        const lines = (starDomainRegistry.list() as Array<{ id: StarDomainId; name: string; keywords: string[]; decisionStyle: string; motto: string }>).map(d => {
          const marker = d.id === currentId ? ' ← current' : ''
          return `  ${d.name} (${d.id}) [${d.decisionStyle}]${marker}\n    ${d.motto}\n    keywords: ${d.keywords.join(', ')}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `星域一览\n\n${lines.join('\n\n')}\n\n使用 /domain <id|名称> 切换，/domain auto 恢复自动检测。` }))
      } else if (sub === 'auto') {
        const midSession = ctx.agent.getSessionTurnCount() > 0
        ctx.agent.resetSessionDomain()
        ctx.onDomainChange?.(undefined)
        pushStatic(createLogEntry({ type: 'system', content: '星域已重置为自动检测模式。下一次对话将根据输入内容自动匹配星域。' }))
        if (midSession) pushStatic(createLogEntry({ type: 'system', content: DOMAIN_SWITCH_CACHE_WARNING }))
      } else {
        // Try to match by id or Chinese name
        const allDomains = starDomainRegistry.list()
        const matched = allDomains.find(d => d.id === sub || d.name === parts[1] || d.id === parts[1]?.toLowerCase())
        if (matched) {
          const midSession = ctx.agent.getSessionTurnCount() > 0
          const domain = { id: matched.id, name: matched.name, volatileBlock: matched.volatileBlock, motto: matched.motto }
          ctx.agent.setSessionDomain(domain)
          ctx.onDomainChange?.(domain.name)
          pushStatic(createLogEntry({ type: 'system', content: `星域切换: ${domain.name} (${domain.id})\n${domain.motto}\n\n${domain.volatileBlock}` }))
          if (midSession) pushStatic(createLogEntry({ type: 'system', content: DOMAIN_SWITCH_CACHE_WARNING }))
        } else {
          const validNames = allDomains.map(d => `${d.name}|${d.id}`).join(', ')
          pushStatic(createLogEntry({ type: 'system', content: `未知星域: "${parts[1]}"\n\n可用星域: ${validNames}\n\n使用 /domain list 查看所有星域。`, isError: true }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/verbose',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const nextVerbose = !ctx.verboseRef.current
      ctx.setVerbose(nextVerbose)
      pushStatic(createLogEntry({ type: 'system', content: nextVerbose ? 'Verbose mode: on (show 200 lines)' : 'Verbose mode: off (show 20 lines)' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/evidence',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const state = ctx.agent.getEvidenceState()
      if (state.verifications.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: 'No evidence recorded yet this session.' }))
      } else {
        const recent = state.verifications.slice(-10)
        const lines = ['Evidence Summary (last 10 verifications):', '']
        for (const v of recent) {
          const glyph = v.status === 'passed' ? '✓' : v.status === 'failed' ? '✗' : '◐'
          const time = v.timestamp ? new Date(v.timestamp).toLocaleTimeString() : ''
          lines.push(`  ${glyph} ${v.command}  (${v.status})  ${time}`)
        }
        const passRate = Math.round((recent.filter(v => v.status === 'passed').length / recent.length) * 100)
        lines.push('', `Pass rate: ${passRate}% (${recent.filter(v => v.status === 'passed').length}/${recent.length})`)
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/auto',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const next = !ctx.autoSafeRef.current
      ctx.setAutoSafe(next)
      ctx.agent.setApprovalMode(next ? 'auto-safe' : 'manual')
      pushStatic(createLogEntry({ type: 'system', content: next ? 'Auto-approve: on (auto-safe — high-risk still requires approval)' : 'Auto-approve: off (manual — all mutating tools require approval)' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/yes',
    immediate: true,
    handler(ctx) {
      const { parts, agent, pushStatic, setIsStreaming } = ctx
      const sub = parts[1]?.toLowerCase()
      const currentlyYolo = (agent.config.approvalMode ?? 'manual') === 'dangerously-skip-permissions'
      let enable: boolean
      if (sub === 'on') enable = true
      else if (sub === 'off') enable = false
      else enable = !currentlyYolo // bare /yes toggles

      if (enable) {
        agent.setApprovalMode('dangerously-skip-permissions')
        ctx.setAutoSafe(false)
        pushStatic(createLogEntry({ type: 'system', content: 'YES 模式：开启 — 跳过所有审批，不再弹确认。⚠️ 高风险操作也会直接执行，请谨慎。' }))
      } else {
        agent.setApprovalMode('auto-safe')
        ctx.setAutoSafe(true)
        pushStatic(createLogEntry({ type: 'system', content: 'YES 模式：关闭 — 恢复 auto-safe（高风险操作仍会弹确认）。' }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/permission',
    immediate: true,
    handler(ctx) {
      const { parts, agent, pushStatic, setIsStreaming } = ctx
      const sub = parts[1]?.toLowerCase()

      const VALID_MODES = ['auto-accept', 'auto-safe', 'manual', 'dangerously-skip-permissions'] as const
      type RuntimeMode = typeof VALID_MODES[number]
      function isRuntimeMode(m: string): m is RuntimeMode {
        return (VALID_MODES as readonly string[]).includes(m)
      }
      const MODE_LABELS: Record<RuntimeMode, string> = {
        'auto-accept': 'auto-accept — 自动接受低风险工具调用',
        'auto-safe': 'auto-safe — 低/无风险自动过，高风险仍弹确认',
        'manual': 'manual — 所有需 approval 的工具都弹确认',
        'dangerously-skip-permissions': 'yolo (dangerously-skip-permissions) — 跳过所有权限确认',
      }

      function parseKvPairs(tokens: string[]): Record<string, string> {
        const out: Record<string, string> = {}
        for (const t of tokens) {
          const idx = t.indexOf('=')
          if (idx > 0) {
            let value = t.slice(idx + 1)
            if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
              value = value.slice(1, -1)
            }
            out[t.slice(0, idx)] = value
          }
        }
        return out
      }

      function ruleSource(rules: unknown[], overlay: unknown[], index: number): string {
        if (index < rules.length) return '[config]'
        return '[session]'
      }

      function formatRules() {
        const cfg = agent.config.permissions
        const overlay = agent.config.permissionsOverlay
        const allow = [...(cfg?.allow ?? []), ...(overlay?.allow ?? [])]
        const deny = [...(cfg?.deny ?? []), ...(overlay?.deny ?? [])]
        const bashAllow = [...(cfg?.bash?.allowlist ?? []), ...(overlay?.bashAllow ?? [])]
        const bashDeny = [...(cfg?.bash?.denylist ?? []), ...(overlay?.bashDeny ?? [])]

        const lines: string[] = []
        const currentMode = agent.config.approvalMode ?? 'manual'
        lines.push(`当前模式: ${currentMode}`)
        lines.push('\n可选模式：')
        for (const m of VALID_MODES) {
          const marker = m === currentMode ? '→ ' : '  '
          lines.push(`${marker}${MODE_LABELS[m]}`)
        }

        if (allow.length > 0) {
          lines.push('\nAllow 规则：')
          allow.forEach((r, i) => {
            const params = r.params ? Object.entries(r.params).map(([k, v]) => `${k}="${v}"`).join(' ') : ''
            lines.push(`  ${i}. ${ruleSource(cfg?.allow ?? [], overlay?.allow ?? [], i)} ${r.tool}${params ? ' ' + params : ''}`)
          })
        }
        if (deny.length > 0) {
          lines.push('\nDeny 规则：')
          deny.forEach((r, i) => {
            const params = r.params ? Object.entries(r.params).map(([k, v]) => `${k}="${v}"`).join(' ') : ''
            lines.push(`  ${i}. ${ruleSource(cfg?.deny ?? [], overlay?.deny ?? [], i)} ${r.tool}${params ? ' ' + params : ''}`)
          })
        }
        if (bashAllow.length > 0) {
          lines.push(`\nBash 前缀白名单：${bashAllow.join(', ')}`)
        }
        if (bashDeny.length > 0) {
          lines.push(`\nBash 前缀黑名单：${bashDeny.join(', ')}`)
        }
        if (allow.length === 0 && deny.length === 0 && bashAllow.length === 0 && bashDeny.length === 0) {
          lines.push('\n当前没有任何 allow/deny 规则。')
        }
        lines.push('\n说明：deny 规则优先于 allow 和 approval mode；session 规则仅本次会话有效。')
        return lines.join('\n')
      }

      if (!sub || sub === 'status') {
        pushStatic(createLogEntry({ type: 'system', content: formatRules() }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'mode') {
        const mode = parts[2]
        if (!mode || !isRuntimeMode(mode)) {
          pushStatic(createLogEntry({ type: 'system', content: `用法: /permission mode <${VALID_MODES.join('|')}>`, isError: true }))
          setIsStreaming(false)
          return true
        }
        agent.setApprovalMode(mode)
        // Keep /auto toggle ref in sync for users who still use /auto.
        ctx.setAutoSafe(mode === 'auto-safe')
        pushStatic(createLogEntry({ type: 'system', content: `Approval mode → ${mode}` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'allow' || sub === 'deny') {
        const tool = parts[2]
        if (!tool) {
          pushStatic(createLogEntry({ type: 'system', content: `用法: /permission ${sub} <tool> [param=value]...`, isError: true }))
          setIsStreaming(false)
          return true
        }
        const rule = { tool, params: parseKvPairs(parts.slice(3)) }
        if (Object.keys(rule.params).length === 0) delete (rule as { params?: Record<string, string> }).params
        if (sub === 'allow') agent.addAllowRule(rule)
        else agent.addDenyRule(rule)
        const paramsStr = rule.params ? Object.entries(rule.params).map(([k, v]) => `${k}="${v}"`).join(' ') : ''
        pushStatic(createLogEntry({ type: 'system', content: `已添加 ${sub} 规则: ${tool}${paramsStr ? ' ' + paramsStr : ''}` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'bash') {
        const action = parts[2]?.toLowerCase()
        if (action !== 'allow' && action !== 'deny') {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /permission bash allow|deny <prefix>', isError: true }))
          setIsStreaming(false)
          return true
        }
        const prefix = parts.slice(3).join(' ')
        if (!prefix) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /permission bash allow|deny <prefix>', isError: true }))
          setIsStreaming(false)
          return true
        }
        if (action === 'allow') agent.addBashAllowPrefix(prefix)
        else agent.addBashDenyPrefix(prefix)
        pushStatic(createLogEntry({ type: 'system', content: `已添加 bash ${action === 'allow' ? '白名单' : '黑名单'}前缀: ${prefix}` }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'remove') {
        const kindRaw = parts[2]?.toLowerCase()
        const target = parts[3]
        if (!kindRaw || !target || !['allow', 'deny', 'bashallow', 'bashdeny'].includes(kindRaw)) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /permission remove allow|deny|bashAllow|bashDeny <index|pattern>', isError: true }))
          setIsStreaming(false)
          return true
        }
        const kind = kindRaw as 'allow' | 'deny' | 'bashAllow' | 'bashDeny'
        const idx = parseInt(target, 10)
        const key = Number.isNaN(idx) ? target : idx
        const ok = agent.removePermissionRule(kind, key)
        pushStatic(createLogEntry({ type: 'system', content: ok ? `已移除 ${kind} 规则: ${target}` : `未找到 ${kind} 规则: ${target}`, isError: !ok }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'reset') {
        agent.resetPermissionOverlay()
        pushStatic(createLogEntry({ type: 'system', content: '已清空本次会话所有运行时权限覆盖。' }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'test') {
        const tool = parts[2]
        const json = parts.slice(3).join(' ')
        if (!tool || !json) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /permission test <tool> <json input>', isError: true }))
          setIsStreaming(false)
          return true
        }
        let input: Record<string, unknown>
        try {
          input = JSON.parse(json) as Record<string, unknown>
        } catch {
          pushStatic(createLogEntry({ type: 'system', content: 'JSON 解析失败', isError: true }))
          setIsStreaming(false)
          return true
        }
        const allDeny = [...(agent.config.permissions?.deny ?? []), ...(agent.config.permissionsOverlay?.deny ?? [])]
        const allAllow = [...(agent.config.permissions?.allow ?? []), ...(agent.config.permissionsOverlay?.allow ?? [])]
        const bashDeny = [...(agent.config.permissions?.bash?.denylist ?? []), ...(agent.config.permissionsOverlay?.bashDeny ?? [])]
        const bashAllow = [...(agent.config.permissions?.bash?.allowlist ?? []), ...(agent.config.permissionsOverlay?.bashAllow ?? [])]

        const denied = tool === 'bash' && typeof input.command === 'string'
          ? isBashCommandDenied(input.command, bashDeny)
          : isToolDenied(tool, input, allDeny)
        if (denied) {
          pushStatic(createLogEntry({ type: 'system', content: `结果: deny（命中 deny 规则）` }))
          setIsStreaming(false)
          return true
        }
        const allowlisted = tool === 'bash' && typeof input.command === 'string'
          ? isBashCommandAllowlisted(input.command, bashAllow)
          : isToolAllowed(tool, input, allAllow)
        if (allowlisted) {
          pushStatic(createLogEntry({ type: 'system', content: '结果: allow（命中 allow 规则）' }))
          setIsStreaming(false)
          return true
        }
        const needsApproval = agent.config.toolRegistry.needsApproval(tool, { input, toolUseId: 'test', cwd: ctx.agent.cwd })
        pushStatic(createLogEntry({ type: 'system', content: `结果: ask（需要 approval：${needsApproval ? '是' : '否'}）` }))
        setIsStreaming(false)
        return true
      }

      pushStatic(createLogEntry({ type: 'system', content: '未知子命令。用法: /permission [status|mode|allow|deny|bash|remove|reset|test]', isError: true }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-mode',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.agent.enterPlanMode()
      pushStatic(createLogEntry({ type: 'system', content: '🔍 Plan Mode activated. Write operations are blocked except the active plan file.\n\nWorkflow: identify key questions → delegate_task (code_scout) / web_search → write plan incrementally → ask_user_question or plan submit.\n\nWhen ready:\n  plan action=submit — submit for approval\n  /plan-list — list submitted plans\n  /plan-approve <slug> [option] — approve and start execution\n  /plan-reject <slug> <feedback> — reject with feedback (plan mode stays active)' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-list',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd
      const plans = await listPlans(cwd)
      if (plans.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: 'No plans found. Use /plan-mode to enter plan mode and create a plan.' }))
      } else {
        const lines = plans.map(p => {
          const statusIcon = p.status === 'approved' ? '✅' : p.status === 'rejected' ? '❌' : p.status === 'executed' ? '🏁' : '📋'
          return `  ${statusIcon} \`${p.slug}\` — ${p.title} (${p.status}, ${p.createdAt.toLocaleString()})`
        })
        pushStatic(createLogEntry({ type: 'system', content: `Plans (.rivet/plans/):\n\n${lines.join('\n')}\n\nUse /plan-approve <slug> to approve, /plan-reject <slug> to reject.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-approve',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const slug = parts[1]?.toLowerCase()
      const selectedApproach = parts.slice(2).join(' ').trim() || undefined
      if (!slug) {
        // No slug — list plans and hint
        const cwd = ctx.agent.cwd
        const plans = await listPlans(cwd)
        if (plans.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No plans to approve. Use /plan-mode to create one.' }))
        } else {
          const submitted = plans.filter(p => p.status === 'submitted')
          if (submitted.length === 0) {
            pushStatic(createLogEntry({ type: 'system', content: `No submitted plans awaiting approval.\n\nUse /plan-list to see all plans.` }))
          } else {
            const hint = submitted.map(p => `  /plan-approve ${p.slug} — ${p.title}`).join('\n')
            pushStatic(createLogEntry({ type: 'system', content: `Submitted plans awaiting approval:\n\n${hint}` }))
          }
        }
        setIsStreaming(false)
        return true
      }

      const cwd = ctx.agent.cwd
      const approved = await approvePlan(cwd, slug)
      if (!approved) {
        pushStatic(createLogEntry({ type: 'system', content: `Plan not found: "${slug}". Use /plan-list to see available plans.`, isError: true }))
        setIsStreaming(false)
        return true
      }

      if (selectedApproach && approved.options && approved.options.length > 0) {
        const known = approved.options.some(o => o.label === selectedApproach)
        if (!known) {
          const available = approved.options.map(o => `  \`${o.label}\``).join('\n')
          pushStatic(createLogEntry({
            type: 'system',
            content: `Unknown option "${selectedApproach}". Available options:\n${available}`,
            isError: true,
          }))
          setIsStreaming(false)
          return true
        }
      }

      // Inject a tiny pointer (slug/title/path) into the dynamic appendix — the
      // plan body stays on disk to keep the prefix cache intact. setActivePlan
      // also releases plan mode internally.
      ctx.agent.setActivePlan({
        slug,
        title: approved.title,
        selectedApproach: selectedApproach || undefined,
      })
      const approachLine = selectedApproach ? `\nSelected approach: **${selectedApproach}**` : ''
      pushStatic(createLogEntry({ type: 'system', content: `✅ Plan approved: **${approved.title}** (\`${slug}\`)${approachLine}\n\n方案指针已加载,正文在 \`.rivet/plans/${slug}.md\`。Plan Mode 已退出 — 执行可开始。\n\nUse /plan-list to view all plans.` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-reject',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const slug = parts[1]?.toLowerCase()
      const feedback = parts.slice(2).join(' ').trim()
      if (!slug) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /plan-reject <slug> [feedback]\n\nUse /plan-list to see available plans.', isError: true }))
        setIsStreaming(false)
        return true
      }

      const cwd = ctx.agent.cwd
      const rejected = await rejectPlan(cwd, slug)
      if (!rejected) {
        pushStatic(createLogEntry({ type: 'system', content: `Plan not found: "${slug}". Use /plan-list to see available plans.`, isError: true }))
        setIsStreaming(false)
        return true
      }

      ctx.agent.enterPlanMode({ planFilePath: `.rivet/plans/${slug}.md` })
      pushStatic(createLogEntry({
        type: 'system',
        content: `❌ Plan rejected: **${rejected.title}** (\`${slug}\`)\n\nPlan mode remains active. Revise \`.rivet/plans/${slug}.md\` in place, then resubmit with \`plan action=submit\`.${feedback ? '' : '\n\nTip: /plan-reject <slug> <feedback> injects revision guidance.'}`,
      }))
      if (feedback && ctx.submitToAgent) {
        ctx.submitToAgent(`User rejected the plan. Feedback:\n\n${feedback}`)
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/theme',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const raw = parts[1]?.toLowerCase()
      // validThemes derives from THEMES so theme.ts remains the single source of truth.
      const validThemes = Object.keys(THEMES) as ThemeName[]
      if (!raw || raw === 'list') {
        const current = getActiveThemeName()
        const list = validThemes.map(t => `  ${t}${t === current ? ' ← current' : ''}`).join('\n')
        pushStatic(createLogEntry({ type: 'system', content: `Available themes:\n${list}\n\nUsage: /theme <name>` }))
      } else if ((validThemes as string[]).includes(raw)) {
        setTheme(raw as ThemeName)
        pushStatic(createLogEntry({ type: 'system', content: `Theme switched to: ${raw}` }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `Theme "${raw}" not found. Available: ${validThemes.join(', ')}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/debug',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const subcmd = parts[1]
      const info = ctx.agent.getDebugInfo()
      if (subcmd === 'prompt') {
        pushStatic(createLogEntry({ type: 'system', content: `System prompt (${info.systemPromptLength} chars):\n${info.systemPromptPreview}\n\nTools (${info.toolCount}): ${info.toolNames.join(', ')}` }))
      } else if (subcmd === 'fingerprint') {
        const fp = info.fingerprint
        const drift = info.drift
        pushStatic(createLogEntry({ type: 'system', content: `Fingerprint:\n  system:  ${fp.systemSha256.slice(0, 16)}...\n  tools:   ${fp.toolsSha256.slice(0, 16)}...\n  combined: ${fp.combinedSha256.slice(0, 16)}...\n\nDrift: ${drift ? drift.message : 'none (cache stable)'}` }))
      } else if (subcmd === 'cache') {
        const usage = ctx.session.getTotalUsage()
        const hitRate = ctx.cacheHitRate
        const totalCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        pushStatic(createLogEntry({ type: 'system', content: `Cache:\n  hit rate: ${(hitRate * 100).toFixed(1)}%\n  read tokens: ${usage.cache_read_input_tokens.toLocaleString()}\n  write tokens: ${usage.cache_creation_input_tokens.toLocaleString()}\n  total cached: ${totalCached.toLocaleString()}\n  input tokens: ${usage.input_tokens.toLocaleString()}\n  output tokens: ${usage.output_tokens.toLocaleString()}\n  estimated: ${ctx.session.getEstimatedTokens().toLocaleString()}\n  cost: ¥${ctx.cost.toFixed(4)}\n  saved: ¥${((usage.cache_read_input_tokens * 0.9) / 1_000_000).toFixed(4)} (cache discount)` }))
      } else if (subcmd === 'context-payload') {
        pushStatic(createLogEntry({ type: 'system', content: formatVolatilePayloadReport(info.volatilePayloadReport) }))
      } else if (subcmd === 'mcp') {
        const mgr = ctx.mcpManagerRef.current
        if (!mgr) {
          pushStatic(createLogEntry({ type: 'system', content: 'MCP not initialized (no servers configured or MCP disabled).' }))
        } else {
          const states = mgr.getStates()
          const tools = mgr.getAllTools()
          const lines = [`MCP Status (${states.length} server(s), ${tools.length} tool(s)):`]
          for (const s of states) {
            const detail = s.status === 'connected'
              ? `connected — ${s.toolCount} tools`
              : s.status === 'error'
                ? `error: ${s.error}`
                : s.status
            lines.push(`  ${s.serverId}: ${detail}`)
          }
          if (tools.length > 0) {
            lines.push('Tools: ' + tools.map(t => t.definition.name).join(', '))
          }
          pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
        }
      } else {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /debug [prompt|fingerprint|cache|context-payload|mcp]' }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/rollback',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      return false

    },
  },
  {
    name: '/clear',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // Clear visual state — reset streaming text and thinking buffers
      setIsStreaming(false)
      pushStatic(createLogEntry({ type: 'system', content: 'Screen cleared.' }))
      return true

    },
  },
  {
    name: '/fork',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // /fork [name]       — fork current session, auto-switch to the copy
      // /fork at <N>       — fork from message line N (truncate after)
      // /fork at <N> <name>— fork from line N with a branch name
      const sessionDir = getSessionDir(ctx.agent.cwd)
      const sourceJsonl = join(sessionDir, `${ctx.currentSessionId}.jsonl`)
      const arg1 = parts[1]?.toLowerCase()

      let upToLine: number | undefined
      let branchName: string | undefined

      if (arg1 === 'at') {
        const n = parseInt(parts[2] ?? '', 10)
        if (!Number.isFinite(n) || n < 1) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /fork at <行号> [分支名]。行号必须 ≥ 1。' }))
          setIsStreaming(false)
          return true
        }
        upToLine = n
        branchName = parts.slice(3).join(' ').trim() || undefined
      } else if (arg1) {
        branchName = parts.slice(1).join(' ').trim() || undefined
      }

      if (!existsSync(sourceJsonl)) {
        pushStatic(createLogEntry({ type: 'system', content: `找不到当前会话日志: ${sourceJsonl}` }))
        setIsStreaming(false)
        return true
      }

      // Validate upToLine against actual message count
      if (upToLine !== undefined) {
        const total = countMessageLines(sourceJsonl)
        if (upToLine > total) {
          pushStatic(createLogEntry({ type: 'system', content: `行号 ${upToLine} 超出当前消息总数 (${total})。` }))
          setIsStreaming(false)
          return true
        }
      }

      const result = forkSession({
        sourceJsonlPath: sourceJsonl,
        targetDir: sessionDir,
        upToLine,
        parentSessionId: ctx.currentSessionId,
        branchName,
      })

      const lineInfo = upToLine ? ` (截取前 ${upToLine} 行)` : ' (完整历史)'
      const nameInfo = branchName ? ` 分支名: ${branchName}` : ''
      pushStatic(createLogEntry({
        type: 'system',
        content: `🌿 Fork 已创建\n  新会话 ID: ${result.newSessionId}${lineInfo}${nameInfo}\n  (短码: ${result.newSessionId.slice(0, 8)})\n正在切换到新会话...`,
      }))

      // Auto-switch to the new session
      if (ctx.onSessionSwitch) {
        const res = ctx.onSessionSwitch(result.newSessionId)
        if (!res.ok) {
          pushStatic(createLogEntry({ type: 'system', content: `⚠ Fork 文件已创建但切换失败: ${res.error ?? '未知错误'}\n用 /resume ${result.newSessionId.slice(0, 8)} 手动切换。\n完整 ID: ${result.newSessionId}` }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `✅ 已切换到 fork 会话 (${result.newSessionId.slice(0, 8)})。\n完整 ID: ${result.newSessionId}\n原会话保持不变，用 /branch back 回去。`,
          }))
        }
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `✅ Fork 已创建。\n用 /resume ${result.newSessionId.slice(0, 8)} 切换过去。\n完整 ID: ${result.newSessionId}` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/branch',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // /branch            — show branch tree for current session
      // /branch list       — same
      // /branch back       — switch back to parent session
      const sub = parts[1]?.toLowerCase()
      const sessionDir = getSessionDir(ctx.agent.cwd)

      if (sub === 'back') {
        // Read current session's parentSessionId from meta.json
        const metaPath = join(sessionDir, `${ctx.currentSessionId}.meta.json`)
        if (!existsSync(metaPath)) {
          pushStatic(createLogEntry({ type: 'system', content: '当前会话没有父会话（这是一个根会话）。' }))
          setIsStreaming(false)
          return true
        }
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
          if (!meta.parentSessionId) {
            pushStatic(createLogEntry({ type: 'system', content: '当前会话没有父会话。' }))
            setIsStreaming(false)
            return true
          }
          if (ctx.onSessionSwitch) {
            const res = ctx.onSessionSwitch(meta.parentSessionId)
            if (!res.ok) {
              pushStatic(createLogEntry({ type: 'system', content: `切换回父会话失败: ${res.error ?? '未知错误'}` }))
            } else {
              pushStatic(createLogEntry({ type: 'system', content: `↩️ 已切换回父会话 (${meta.parentSessionId.slice(0, 8)})。\n完整 ID: ${meta.parentSessionId}` }))
            }
          } else {
            pushStatic(createLogEntry({ type: 'system', content: `父会话: ${meta.parentSessionId}\n用 /resume ${meta.parentSessionId.slice(0, 8)} 切换。` }))
          }
        } catch {
          pushStatic(createLogEntry({ type: 'system', content: '无法读取当前会话的元数据。' }))
        }
        setIsStreaming(false)
        return true
      }

      // Default: /branch or /branch list — show branch tree
      const lines: string[] = ['分支树', '════════']

      // Check if current session has a parent
      const currentMetaPath = join(sessionDir, `${ctx.currentSessionId}.meta.json`)
      if (existsSync(currentMetaPath)) {
        try {
          const meta = JSON.parse(readFileSync(currentMetaPath, 'utf-8'))
          if (meta.parentSessionId) {
            const parentMetaPath = join(sessionDir, `${meta.parentSessionId}.meta.json`)
            let parentLabel = meta.parentSessionId
            if (existsSync(parentMetaPath)) {
              const parentMeta = JSON.parse(readFileSync(parentMetaPath, 'utf-8'))
              if (parentMeta.title) parentLabel += ` "${parentMeta.title}"`
              if (parentMeta.branchName) parentLabel += ` (${parentMeta.branchName})`
            }
            lines.push(`⬆️ 父会话: ${parentLabel}`)
          } else {
            lines.push('⬆️ 父会话: 无 (根会话)')
          }
          if (meta.branchName) {
            lines.push(`🏷️ 当前分支名: ${meta.branchName}`)
          }
        } catch { /* meta corrupted */ }
      } else {
        lines.push('⬆️ 父会话: 无 (根会话)')
      }

      // List child branches
      const children = listBranches(sessionDir, ctx.currentSessionId)
      if (children.length > 0) {
        lines.push('', `⬇️ 子分支 (${children.length}):`)
        for (const child of children) {
          const name = child.branchName ?? '(unnamed)'
          const time = existsSync(join(sessionDir, `${child.sessionId}.meta.json`))
            ? (() => {
                try {
                  const m = JSON.parse(readFileSync(join(sessionDir, `${child.sessionId}.meta.json`), 'utf-8'))
                  return m.createdAt ? new Date(m.createdAt).toLocaleString() : ''
                } catch { return '' }
              })()
            : ''
          lines.push(`  ├️ ${child.sessionId} "${name}" ${time}`)
        }
      } else {
        lines.push('', '⬇️ 子分支: 无')
      }

      lines.push('', '提示: /fork [名称] 创建新分支, /branch back 回到父会话')
      pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/sessions',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const list = SessionPersist.formatSessionList(ctx.agent.cwd, ctx.currentSessionId)
      // Enhance with fork annotations: mark sessions that have a parentSessionId
      const sessionDir = getSessionDir(ctx.agent.cwd)
      const mainSessions = SessionPersist.listMainSessions(ctx.agent.cwd)
      const forkAnnotations: string[] = []
      for (const s of mainSessions) {
        const metaPath = join(sessionDir, `${s.id}.meta.json`)
        if (!existsSync(metaPath)) continue
        try {
          const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
          if (meta.parentSessionId) {
            const shortId = s.id.slice(0, 8)
            const shortParent = String(meta.parentSessionId).slice(0, 8)
            const name = meta.branchName ? ` "${meta.branchName}"` : ''
            forkAnnotations.push(`  ${shortId} ← fork from ${shortParent}${name}`)
          }
        } catch { /* skip */ }
      }
      const forkSection = forkAnnotations.length > 0
        ? `\n\n Fork 关系:\n${forkAnnotations.join('\n')}`
        : ''
      pushStatic(createLogEntry({
        type: 'system',
        content: `会话列表(按最近更新排序):\n${list}\n\n/resume <id前缀 或 序号> 切换会话${forkSection}`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/resume',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const arg = parts[1]
      if (!arg) {
        pushStatic(createLogEntry({ type: 'system', content: '用法: /resume <id前缀 或 序号>。用 /sessions 查看会话列表。' }))
        setIsStreaming(false)
        return true
      }

      // 序号(兼容旧习惯)或 id 前缀 → 解析为完整 id。
      const ordered = SessionPersist.listMainSessions(ctx.agent.cwd)
      let targetId: string | null = null
      if (/^\d+$/.test(arg)) {
        const idx = parseInt(arg, 10) - 1
        if (idx < 0 || idx >= ordered.length) {
          pushStatic(createLogEntry({ type: 'system', content: `序号超出范围(共 ${ordered.length} 个会话)。用 /sessions 查看。` }))
          setIsStreaming(false)
          return true
        }
        targetId = ordered[idx]!.id
      } else {
        const resolved = SessionPersist.resolveSessionId(ctx.agent.cwd, arg)
        if (!resolved) {
          pushStatic(createLogEntry({ type: 'system', content: `未找到匹配会话: "${arg}"。用 /sessions 查看会话列表。` }))
          setIsStreaming(false)
          return true
        }
        if ('ambiguous' in resolved) {
          const cands = resolved.ambiguous.map(id => `  ${id.slice(0, 12)}`).join('\n')
          pushStatic(createLogEntry({ type: 'system', content: `前缀 "${arg}" 匹配多个会话,请用更长前缀:\n${cands}` }))
          setIsStreaming(false)
          return true
        }
        targetId = resolved.id
      }

      if (targetId === ctx.currentSessionId) {
        pushStatic(createLogEntry({ type: 'system', content: `已经在会话 ${targetId.slice(0, 8)} 中。` }))
        setIsStreaming(false)
        return true
      }

      // 真正的身份切换(Phase 4):会话id = 日志id = pointer id 一致。
      if (ctx.onSessionSwitch) {
        const res = ctx.onSessionSwitch(targetId)
        if (!res.ok) {
          pushStatic(createLogEntry({ type: 'system', content: `切换失败: ${res.error ?? '未知错误'}` }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `🔄 已切换到会话 ${targetId.slice(0, 8)}: 载入 ${res.messageCount ?? 0} 条消息(将重建前缀缓存)${res.repaired ? ' · 已修复孤儿工具调用' : ''}。`,
          }))
        }
        setIsStreaming(false)
        return true
      }

      // Fallback:无切换回调时退化为仅内存恢复(身份不切,旧行为)。
      const p = new SessionPersist(targetId, ctx.agent.cwd)
      const preflight = runResumePreflightOai(p.loadOai())
      ctx.session.replaceMessages(preflight.messages)
      ctx.agent.config.promptEngine.resetAppendixBaseline()
      if (preflight.repaired) p.compactOai(preflight.messages)
      pushStatic(createLogEntry({ type: 'system', content: `已恢复会话 ${targetId.slice(0, 8)} (${preflight.messages.length} 条消息, apiSafe=${preflight.safe})` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/context',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const args = parts.slice(1).join(' ').trim()
      if (args.startsWith('pin ')) {
        const text = args.slice(4).trim()
        if (text) {
          ctx.agent.addAnchor('user_preference', text)
          pushStatic(createLogEntry({ type: 'system', content: `Pinned: "${text}"` }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /context pin <text>' }))
        }
        setIsStreaming(false)
        return true
      }

      if (args.startsWith('claims')) {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const statusArg = args.slice(7).trim()
        const validStatuses = ['active', 'stale', 'conflicted', 'durable']
        if (statusArg && !validStatuses.includes(statusArg)) {
          pushStatic(createLogEntry({ type: 'system', content: `Usage: /context claims [${validStatuses.join('|')}]` }))
          setIsStreaming(false)
          return true
        }
        const output = formatContextClaimsCommand(store, statusArg as ContextClaimStatus | undefined)
        pushStatic(createLogEntry({ type: 'system', content: output }))
        setIsStreaming(false)
        return true
      }

      if (args === 'antibodies') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const antibodies = store.listClaims({ kind: ['failure_pattern'], status: ['active', 'durable_candidate', 'durable'] })
        if (antibodies.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No active antibodies.' }))
          setIsStreaming(false)
          return true
        }
        const lines = antibodies.map(c => {
          const tag = c.tags.filter(t => t !== 'antibody')[0] ?? c.kind
          return `  [${tag}] ${c.text.slice(0, 80)}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `Antibodies (${antibodies.length}):\n${lines.join('\n')}` }))
        setIsStreaming(false)
        return true
      }

      if (args === 'conflicts') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const conflicted = store.listClaims({ status: ['conflicted'] })
        if (conflicted.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No conflicted claims.' }))
          setIsStreaming(false)
          return true
        }
        const lines = conflicted.map(c => `  [${c.id.slice(0, 8)}] ${c.text.slice(0, 80)}`)
        pushStatic(createLogEntry({ type: 'system', content: `Conflicts (${conflicted.length}):\n${lines.join('\n')}` }))
        setIsStreaming(false)
        return true
      }

      if (args === 'reload') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        // Stale existing project_rule claims so deleted rule files are cleaned up
        const existing = store.listClaims({ kind: ['project_rule'] })
        for (const c of existing) {
          store.updateClaimStatus(c.id, 'stale', 'reload: rules directory refreshed')
        }
        const proposals = loadProjectRules(process.cwd())
        let loaded = 0
        for (const p of proposals) {
          store.propose(p)
          loaded++
        }
        pushStatic(createLogEntry({ type: 'system', content: `Reloaded ${loaded} project rules from .rivet/rules/ (${existing.length} previous rules cleared)` }))
        setIsStreaming(false)
        return true
      }

      if (args === 'export') {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const outPath = join(exportsDir(), `${timestamp}.json`)
        const count = exportDurableClaims(store, outPath)
        pushStatic(createLogEntry({ type: 'system', content: `Exported ${count} durable claims to ${outPath}` }))
        setIsStreaming(false)
        return true
      }

      if (args.startsWith('import ')) {
        const store = ctx.claimStoreRef.current
        if (!store) {
          pushStatic(createLogEntry({ type: 'system', content: 'Claim store not available.' }))
          setIsStreaming(false)
          return true
        }
        const filePath = args.slice('import '.length).trim()
        const count = importClaims(store, filePath)
        pushStatic(createLogEntry({ type: 'system', content: count > 0 ? `Imported ${count} claims (confidence ×0.8)` : `No claims imported. Check file path: ${filePath}` }))
        setIsStreaming(false)
        return true
      }

      const ledger = ctx.session.getContextLedger()
      if (!ledger) {
        pushStatic(createLogEntry({ type: 'system', content: 'Context ledger not available yet. Send a message to build the first ledger snapshot.' }))
        setIsStreaming(false)
        return true
      }

      const sections = ledger.tokenBudget
      const diagnostics = ledger.apiInvariantStatus.brokenRounds === 0
        ? 'API rounds: safe'
        : `⚠ ${ledger.apiInvariantStatus.brokenRounds} broken rounds`
      const compacts = ctx.session.getCompactEvents()
      const compactStr = compacts.length === 0
        ? 'No compact events.'
        : compacts.slice(-5).map(e => `- turn ${e.turn}: tier ${e.tier}, ${e.beforeTokens}→${e.afterTokens}`).join('\n')

      const anchorLines = ledger.anchors.length > 0
        ? `\n\nPinned Anchors:\n${ledger.anchors.map(a => `  [${a.kind}] ${a.text.slice(0, 60)}`).join('\n')}`
        : ''

      // 占用明细头：cache 命中率 + 本轮 cost（与 GlanceBar 同源），对齐 Claude Code /context。
      const usagePct = sections.maxTokens > 0 ? Math.round(sections.estimatedTokens / sections.maxTokens * 100) : 0
      const cacheStr = ctx.cacheHitRate !== undefined ? `${Math.round(ctx.cacheHitRate * 100)}%` : 'n/a'
      const costStr = `¥${(ctx.cost ?? 0).toFixed(2)}`
      const realTokens = ctx.session.getLastRealPromptTokens()
      const realStr = realTokens > 0 ? `\nAPI (last): ${realTokens.toLocaleString()} tokens` : ''

      // Recall visibility: compacted history can be pulled back verbatim via
      // read_section. Surface how often that happened this session (observe-only).
      const recall = ctx.agent.getRecallSummary?.()
      const recallStr = recall && recall.totalRecalls > 0
        ? `\nRecall: ${recall.totalRecalls} recalls / ${recall.uniqueArtifacts} archives${recall.avgTurnDistance !== null ? `, avg ${Math.round(recall.avgTurnDistance)} turns back` : ''}`
        : ''

      pushStatic(createLogEntry({
        type: 'system',
        content: `Context: ${sections.compactionState}\nTokens (est): ${sections.estimatedTokens.toLocaleString()}/${sections.maxTokens.toLocaleString()} (${usagePct}%)${realStr}${recallStr}\nCache hit: ${cacheStr}    Cost: ${costStr}\nRounds: ${ledger.rounds.length}\n${diagnostics}\n\nCompaction:\n${compactStr}${anchorLines}`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/verify',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const verify = formatVerificationStatus(ctx.agent)
      const recovery = renderRecoveryStack(process.cwd())
      pushStatic(createLogEntry({ type: 'system', content: `${verify}\n\n${recovery}` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/memory',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const subcmd = parts[1]
      const text = parts.slice(2).join(' ').trim()
      if (!subcmd) {
        pushStatic(createLogEntry({ type: 'system', content: formatMemoryOverview(ctx) }))
      } else if (subcmd === 'add') {
        if (!text) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /memory add <content>', isError: true }))
        } else {
          const file = appendProjectKnowledge(text)
          pushStatic(createLogEntry({ type: 'system', content: `Saved to project knowledge: ${file}` }))
        }
      } else if (subcmd === 'search') {
        if (!text) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /memory search <query>', isError: true }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: searchMemory(ctx, text) }))
        }
      } else if (subcmd === 'forget') {
        pushStatic(createLogEntry({ type: 'system', content: 'Forget is not yet destructive in Wave 1. Use the displayed memory id/file to remove manually for now.' }))
      } else {
        const legacyText = parts.slice(1).join(' ').trim()
        ctx.persist.appendMemory({ text: legacyText, source: 'manual', createdAt: Date.now() })
        ctx.agent.updateSessionMemory(ctx.persist.buildMemoryBlock())
        pushStatic(createLogEntry({ type: 'system', content: 'Saved to session memory.' }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mcp',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      pushStatic(createLogEntry({ type: 'system', content: 'MCP status: use /debug mcp for detailed connection info, or check startup logs.' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/todo',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const { getTodos, setTodos } = await import('../tools/todo.js')
      const { TodoStore } = await import('../tools/todo-store.js')
      const subcmd = parts[1]
      const arg = parts.slice(2).join(' ').trim()
      const todos = getTodos()

      if (!subcmd || subcmd === 'list') {
        // List current todos
        const text = todos.length === 0
          ? 'No todos. The agent will create tasks via the todo tool.'
          : TodoStore.formatList(todos)
        pushStatic(createLogEntry({ type: 'system', content: text }))
      } else if (subcmd === 'add') {
        if (!arg) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /todo add <content>', isError: true }))
        } else {
          const id = `user-${Date.now().toString(36)}`
          setTodos([...todos, { id, content: arg, status: 'pending' as const }])
          pushStatic(createLogEntry({ type: 'system', content: `Added: ○ [${id}] ${arg}` }))
        }
      } else if (subcmd === 'done') {
        const item = todos.find(t => t.id === arg || t.id.startsWith(arg))
        if (!item) {
          pushStatic(createLogEntry({ type: 'system', content: `No todo matching "${arg}". Use /todo list to see ids.`, isError: true }))
        } else {
          setTodos(todos.map(t => t.id === item.id ? { ...t, status: 'completed' as const } : t))
          pushStatic(createLogEntry({ type: 'system', content: `✓ Done: ${item.content}` }))
        }
      } else if (subcmd === 'skip') {
        const item = todos.find(t => t.id === arg || t.id.startsWith(arg))
        if (!item) {
          pushStatic(createLogEntry({ type: 'system', content: `No todo matching "${arg}". Use /todo list to see ids.`, isError: true }))
        } else {
          // Remove the item entirely (skip = don't do it)
          setTodos(todos.filter(t => t.id !== item.id))
          pushStatic(createLogEntry({ type: 'system', content: `⊘ Skipped: ${item.content}` }))
        }
      } else if (subcmd === 'move') {
        const id = parts[2]
        const dir = parts[3] // 'up' or 'down'
        if (!id || (dir !== 'up' && dir !== 'down')) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /todo move <id> <up|down>', isError: true }))
        } else {
          const idx = todos.findIndex(t => t.id === id || t.id.startsWith(id))
          if (idx === -1) {
            pushStatic(createLogEntry({ type: 'system', content: `No todo matching "${id}".`, isError: true }))
          } else {
            const swapWith = dir === 'up' ? idx - 1 : idx + 1
            if (swapWith < 0 || swapWith >= todos.length) {
              pushStatic(createLogEntry({ type: 'system', content: 'Already at edge.' }))
            } else {
              const next = [...todos]
              ;[next[idx], next[swapWith]] = [next[swapWith]!, next[idx]!]
              setTodos(next)
              pushStatic(createLogEntry({ type: 'system', content: `Moved ${dir}: ${todos[idx]!.content}` }))
            }
          }
        }
      } else {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /todo [list|add <content>|done <id>|skip <id>|move <id> <up|down>]' }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/mission',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const snapshot = ctx.agent.getCognitiveSnapshot?.()
      const strip = formatMissionStrip(snapshot)
      pushStatic(createLogEntry({ type: 'system', content: strip ? `Mission\n\n${strip}` : 'Mission\n\nNo actionable task contract is active.' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/plan-template',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd ?? process.cwd()
      const sub = parts[1]
      const { loadPlanTemplates, getPlanTemplate, savePlanTemplate, formatTemplateList } = await import('../agent/plan-templates.js')

      if (!sub || sub === 'list') {
        const templates = loadPlanTemplates(cwd)
        pushStatic(createLogEntry({ type: 'system', content: formatTemplateList(templates) }))
      } else if (sub === 'save') {
        const name = parts[2]
        const description = parts.slice(3).join(' ').trim()
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /plan-template save <name> [description]', isError: true }))
        } else {
          // Save current plan (if any) as template
          const { getStoredPlan } = await import('../agent/plan-store.js')
          const currentPlan = getStoredPlan(ctx.currentSessionId)
          if (!currentPlan) {
            pushStatic(createLogEntry({ type: 'system', content: 'No active plan to save. Run /plan first.', isError: true }))
          } else {
            savePlanTemplate(cwd, name, `\`\`\`json\n${currentPlan}\n\`\`\`\n`, description)
            pushStatic(createLogEntry({ type: 'system', content: `✓ Saved template "${name}" to .rivet/plan-templates/${name}.md` }))
          }
        }
      } else {
        // Treat as template name to load
        const tpl = getPlanTemplate(cwd, sub)
        if (!tpl) {
          pushStatic(createLogEntry({ type: 'system', content: `Template "${sub}" not found. Use /plan-template list to see available templates.`, isError: true }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `Loaded template: ${tpl.name}\n${tpl.description ? tpl.description + '\n' : ''}${tpl.estimatedWaves ? `Estimated waves: ${tpl.estimatedWaves}\n` : ''}\n${tpl.content}\n\n→ Use /plan to refine, or /team to execute.`,
          }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/workflow',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd ?? process.cwd()
      const sub = parts[1]
      const { listWorkflows, loadWorkflow, listTraces, loadTrace, formatTrace, parseWorkflow } = await import('../agent/workflow-runner.js')

      if (!sub || sub === 'list') {
        const names = listWorkflows(cwd)
        const text = names.length === 0
          ? 'No workflows. Create one in .rivet/workflows/*.yaml'
          : `Available workflows:\n\n${names.map(n => `  ${n}`).join('\n')}\n\nUse: /workflow <name> to execute.`
        pushStatic(createLogEntry({ type: 'system', content: text }))
      } else if (sub === 'replay') {
        const traceId = parts[2]
        if (!traceId) {
          const traces = listTraces(cwd, 10)
          const text = traces.length === 0
            ? 'No traces available.'
            : `Recent traces:\n\n${traces.map(t => `  ${t.traceId} — ${t.workflowName} (${t.finalStatus})`).join('\n')}\n\nUse: /workflow replay <id> to view.`
          pushStatic(createLogEntry({ type: 'system', content: text }))
        } else {
          const trace = loadTrace(cwd, traceId)
          if (!trace) {
            pushStatic(createLogEntry({ type: 'system', content: `Trace "${traceId}" not found.`, isError: true }))
          } else {
            pushStatic(createLogEntry({ type: 'system', content: formatTrace(trace) }))
          }
        }
      } else {
        // Execute workflow by name
        const wf = loadWorkflow(cwd, sub)
        if (!wf) {
          pushStatic(createLogEntry({ type: 'system', content: `Workflow "${sub}" not found. Use /workflow list to see available workflows.`, isError: true }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `▶ Workflow "${wf.name}" loaded (${wf.steps.length} steps).\n${wf.description ?? ''}\n\n→ Type your objective to execute, or /cancel to abort.`,
          }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/constellation',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd ?? process.cwd()
      const sub = (parts[1] ?? 'view').toLowerCase()
      const now = Date.now()

      if (sub === 'init') {
        const skeleton = surveySkeleton(cwd)
        const c = initConstellation(cwd, { skeleton, sessionId: ctx.currentSessionId }, now)
        pushStatic(createLogEntry({
          type: 'system',
          content: `Constellation initialized for ${c.name}\n\n${formatConstellationView(c, { now })}`,
        }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'shift') {
        const summary = parts.slice(2).join(' ').trim() || 'skeleton re-surveyed'
        const skeleton = surveySkeleton(cwd)
        const c = initConstellation(cwd, { skeleton, sessionId: ctx.currentSessionId, shiftSummary: summary }, now)
        pushStatic(createLogEntry({
          type: 'system',
          content: `Architecture shift recorded (${c.architectureShifts.length} total): ${summary}`,
        }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'update') {
        const summary = parts.slice(2).join(' ').trim()
        if (!summary) {
          pushStatic(createLogEntry({ type: 'system', content: 'Usage: /constellation update <summary> — records a milestone for current changes.' }))
          setIsStreaming(false)
          return true
        }
        const dirty = await collectDirtyFiles(cwd)
        const domain = ctx.agent.getSessionDomain()?.id ?? ''
        const milestone = extractMilestone({
          sessionId: ctx.currentSessionId,
          agentMark: buildAgentMark({ symbol: VOID_SYMBOL, domain }),
          domain,
          chronicleEntries: [{ type: 'milestone', turn: 0, timestamp: now, summary, files: dirty }],
          cycleClose: shortHash(`${ctx.currentSessionId}:${now}`),
          now,
          force: true,
        })
        if (!milestone) {
          pushStatic(createLogEntry({ type: 'system', content: 'Nothing to record.' }))
          setIsStreaming(false)
          return true
        }
        appendMilestone(cwd, milestone, now)
        pushStatic(createLogEntry({ type: 'system', content: `Milestone recorded: ${milestone.summary} (${milestone.filesChanged.length} files)` }))
        setIsStreaming(false)
        return true
      }

      const c = loadConstellation(cwd)
      if (!c) {
        pushStatic(createLogEntry({ type: 'system', content: 'No constellation yet. Use /constellation init to survey this project.' }))
        setIsStreaming(false)
        return true
      }

      if (sub === 'history') {
        pushStatic(createLogEntry({ type: 'system', content: formatConstellationHistory(c, { now }) }))
        setIsStreaming(false)
        return true
      }

      // default: view
      pushStatic(createLogEntry({ type: 'system', content: formatConstellationView(c, { now }) }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/leave',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // User-triggered departure ritual: seal a mark into the starmap now.
      // First token may be a single-glyph symbol; the rest is the summary.
      const cwd = ctx.agent.cwd ?? process.cwd()
      const now = Date.now()
      const rest = parts.slice(1)
      let symbol = VOID_SYMBOL
      let summaryParts = rest
      if (rest.length > 0 && [...rest[0]!].length <= 2) {
        symbol = rest[0]!
        summaryParts = rest.slice(1)
      }
      const summary = summaryParts.join(' ').trim()
      if (!summary) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /leave [symbol] <summary> — leave your mark in the starmap as you depart.' }))
        setIsStreaming(false)
        return true
      }
      const domain = ctx.agent.getSessionDomain()?.id ?? ''
      const dirty = await collectDirtyFiles(cwd)
      const milestone = buildDepartureMilestone({
        sessionId: ctx.currentSessionId,
        agentMark: buildAgentMark({ symbol, domain }),
        domain,
        summary,
        filesChanged: dirty,
        now,
      })
      appendMilestone(cwd, milestone, now)
      pushStatic(createLogEntry({
        type: 'system',
        content: `✶ Mark ${milestone.agentMark.symbol} sealed into the starmap.\n${milestone.summary}`,
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/undo',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const fh = ctx.agent.getFileHistory()
      if (!fh) {
        pushStatic(createLogEntry({ type: 'system', content: 'Undo not available (no file history).' }))
        setIsStreaming(false)
        return true
      }
      const snapshots = fh.getAllSnapshots()
      if (snapshots.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: 'No undo history yet.' }))
        setIsStreaming(false)
        return true
      }
      const arg = parts[1]
      if (arg && /^\d+$/.test(arg)) {
        const idx = parseInt(arg, 10) - 1
        if (idx < 0 || idx >= snapshots.length) {
          pushStatic(createLogEntry({ type: 'system', content: `Invalid index. History has ${snapshots.length} entries (1-${snapshots.length}).` }))
          setIsStreaming(false)
          return true
        }
        const target = snapshots[idx]!
        const pinnedPush = pushStatic
        fh.rewind(target.messageId).then(
          restored => pinnedPush(createLogEntry({ type: 'system', content: `Undo complete. Restored files: ${restored.join(', ') || '(none)'}` })),
          err => pinnedPush(createLogEntry({ type: 'system', content: `Undo failed: ${(err as Error).message}` })),
        )
        pushStatic(createLogEntry({ type: 'system', content: `Undoing snapshot #${idx + 1}...` }))
      } else if (arg === 'preview' || arg === 'p') {
        const previewIdx = parts[2] ? parseInt(parts[2], 10) - 1 : snapshots.length - 1
        if (previewIdx < 0 || previewIdx >= snapshots.length) {
          pushStatic(createLogEntry({ type: 'system', content: `Invalid index. History has ${snapshots.length} entries.` }))
          setIsStreaming(false)
          return true
        }
        const target = snapshots[previewIdx]!
        const files = Object.keys(target.trackedFileBackups)
        const detail = files.map(f => `  ${f}`).join('\n')
        pushStatic(createLogEntry({ type: 'system', content: `Undo preview #${previewIdx + 1} [${target.messageId.slice(0, 8)}]:\n${detail || '(no files)'}\n\nUse /undo ${previewIdx + 1} to revert.` }))
      } else {
        const recent = snapshots.slice(-10).reverse()
        const lines = recent.map((s, i) => {
          const n = snapshots.length - i
          const files = Object.keys(s.trackedFileBackups).join(', ')
          return `  ${n}. [${s.messageId.slice(0, 8)}] ${files || '(no files)'}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `Undo history (${snapshots.length} total):\n${lines.join('\n')}\n\nUse /undo <number> to revert, /undo preview <number> to inspect.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/team-resume',
    immediate: true,
    async handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const cwd = ctx.agent.cwd ?? process.cwd()
      const { listCheckpoints, formatCheckpointList, loadCheckpoint } = await import('../agent/wave-checkpoint.js')
      const groupId = parts[1]

      if (!groupId) {
        const checkpoints = listCheckpoints(cwd)
        pushStatic(createLogEntry({ type: 'system', content: formatCheckpointList(checkpoints) }))
      } else {
        const cp = loadCheckpoint(cwd, groupId)
        if (!cp) {
          pushStatic(createLogEntry({ type: 'system', content: `No checkpoint found for "${groupId}".`, isError: true }))
        } else {
          pushStatic(createLogEntry({
            type: 'system',
            content: `Checkpoint: ${cp.groupId}\nResume from wave ${cp.lastCompletedWave + 2}/${cp.totalWaves} (${cp.remainingOrders.length} tasks remaining).\nObjective: ${cp.objective}`,
          }))
        }
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/cockpit',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const subcmd = parts[1] as Panel | 'off' | undefined
      if (subcmd === 'off') {
        ctx.surfacePop?.()
        pushStatic(createLogEntry({ type: 'system', content: 'Cockpit panel collapsed.' }))
      } else if (subcmd && subcmd in PANEL_LABELS) {
        ctx.setCockpitPanel(subcmd as Panel)
        ctx.surfacePush?.('cockpit')
        pushStatic(createLogEntry({ type: 'system', content: `Cockpit: ${PANEL_LABELS[subcmd as Panel]} panel. /cockpit off to collapse.` }))
      } else {
        const wasOpen = ctx.activeOverlay === 'cockpit'
        if (wasOpen) {
          ctx.surfacePop?.()
        } else {
          ctx.setCockpitPanel('summary')
          ctx.surfacePush?.('cockpit')
        }
        pushStatic(createLogEntry({ type: 'system', content: wasOpen ? 'Cockpit panel collapsed.' : `Cockpit: ${PANEL_LABELS['summary']} panel. /cockpit off to collapse.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/scroll',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      ctx.surfacePush?.('pager')
      pushStatic(createLogEntry({ type: 'system', content: 'Scrollback pager opened. Press q or Esc to close.' }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/effort',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming, surfacePush } = ctx
      const cmd = parts[0]!.toLowerCase()
      const level = parts[1]?.toLowerCase() as 'off' | 'low' | 'medium' | 'high' | 'max' | 'auto' | undefined
      const valid: Array<'off' | 'low' | 'medium' | 'high' | 'max' | 'auto'> = ['off', 'low', 'medium', 'high', 'max', 'auto']
      if (!level) {
        // 无参数 → 打开交互式选择面板（上下选、回车确认）。
        surfacePush?.('choice-panel')
        setIsStreaming(false)
        return true
      }
      if ((valid as string[]).includes(level)) {
        ctx.setReasoningEffort?.(level)
        pushStatic(createLogEntry({ type: 'system', content: level === 'auto'
          ? 'Reasoning effort: auto (autoReasoning picks per task)'
          : `Reasoning effort set to: ${level}` }))
      } else {
        pushStatic(createLogEntry({ type: 'system', content: `Usage: /effort [off|low|medium|high|max|auto]\n\nSet max for full reasoning on every turn. auto lets autoReasoning pick per-task complexity.` }))
      }
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/interview',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const topic = parts.slice(1).join(' ').trim()
      if (!topic) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /interview <topic>\nExample: /interview add a notification system' }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/plan',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const feature = parts.slice(1).join(' ').trim()
      if (!feature) {
        pushStatic(createLogEntry({ type: 'system', content: `Usage: ${cmd} <feature>\n       /plan close <docs/superpowers/plans/file.md> --tasks <1-7|all> [--preview]\nExample: ${cmd} add Context7 MCP preset` }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/write-plan',
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const feature = parts.slice(1).join(' ').trim()
      if (!feature) {
        pushStatic(createLogEntry({ type: 'system', content: `Usage: ${cmd} <feature>\n       /plan close <docs/superpowers/plans/file.md> --tasks <1-7|all> [--preview]\nExample: ${cmd} add Context7 MCP preset` }))
        setIsStreaming(false)
        return true
      }
      return false
    },
  },
  {
    name: '/skill',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const sub = parts[1]?.toLowerCase()

      // Single source of truth: the shared skillRegistry (loaded at bootstrap
      // from .rivet/skills only — external .claude dirs are never scanned in
      // place; designated skills are copied in via importFromClaude). No
      // re-scan, no truncation — same Tier-1/Tier-2 model the model uses.
      const sourceTag = (source?: string): string =>
        source === 'global-claude' ? '🌐' : '📁'
      const allSkills = skillRegistry.list()

      // ── Auto-distilled draft review (human-in-loop) ──
      if (sub === 'review' || sub === 'drafts') {
        const drafts = listSkillDrafts(ctx.agent.cwd)
        if (drafts.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: '没有待审核的 skill 草稿。\n会话结束时,验证通过的可复用流程会自动蒸馏到 .rivet/skills/_drafts/。' }))
        } else {
          const lines = drafts.map(d => `  📝 ${d.name} — ${(d.description || '(no description)').slice(0, 120)}`)
          pushStatic(createLogEntry({ type: 'system', content: `待审核 skill 草稿 (${drafts.length}):\n${lines.join('\n')}\n\n/skill approve <name> 入库  ·  /skill reject <name> 丢弃` }))
        }
        setIsStreaming(false)
        return true
      }

      if (sub === 'approve') {
        const name = parts[2]
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /skill approve <name>(用 /skill review 查看草稿)' }))
          setIsStreaming(false)
          return true
        }
        const res = approveSkillDraft(ctx.agent.cwd, name)
        if (res.ok && res.skill) {
          // Do NOT hot-load into the live registry: changing the available-skill
          // set mid-session shatters the prefix cache (cost can be tens of times
          // higher). The draft is persisted to disk; it takes effect on next session.
          pushStatic(createLogEntry({ type: 'system', content: `✅ 已入库 skill: ${res.skill.name} → .rivet/skills/\n⚠ 需重开会话才生效:会话内热加载新技能会打碎前缀缓存,成本可达几十倍。` }))
        } else {
          pushStatic(createLogEntry({ type: 'system', content: `❌ 入库失败: ${res.error ?? 'unknown error'}` }))
        }
        setIsStreaming(false)
        return true
      }

      if (sub === 'reject') {
        const name = parts[2]
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: '用法: /skill reject <name>(用 /skill review 查看草稿)' }))
          setIsStreaming(false)
          return true
        }
        const ok = rejectSkillDraft(ctx.agent.cwd, name)
        pushStatic(createLogEntry({ type: 'system', content: ok ? `🗑 已丢弃草稿: ${name}` : `草稿 "${name}" 不存在` }))
        setIsStreaming(false)
        return true
      }

      // /skill off <name> — manually release an invoked skill so its instructions
      // are no longer re-injected into the dynamic appendix.
      if (sub === 'off' || sub === 'complete') {
        const name = parts[2]
        if (!name) {
          pushStatic(createLogEntry({ type: 'system', content: `用法: /skill ${sub} <name>\n停止持续注入该技能的完整指令。` }))
          setIsStreaming(false)
          return true
        }
        ctx.agent.markSkillCompleted?.(name)
        pushStatic(createLogEntry({ type: 'system', content: `🛑 已停止技能: ${name}` }))
        setIsStreaming(false)
        return true
      }

      // /skill install <name> [...] — copy from .claude/skills/ into .rivet/skills/
      if (sub === 'install' || sub === 'import') {
        const names = parts.slice(2).filter(Boolean)
        if (names.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: `用法: /skill ${sub} <name> [name2 ...]\n从 .claude/skills/<name> 复制到 .rivet/skills/<name>。` }))
          setIsStreaming(false)
          return true
        }
        const { copied, skipped, errors } = importSkillsIntoRivet(ctx.agent.cwd, names)
        // Do NOT hot-load into the live registry: changing the available-skill set
        // mid-session shatters the prefix cache (cost can be tens of times higher).
        // Files are copied to disk; they take effect on next session.
        const lines: string[] = []
        if (copied.length > 0) lines.push(`✅ 已安装: ${copied.join(', ')}`)
        if (skipped.length > 0) lines.push(`⏭ 已存在/跳过: ${skipped.join(', ')}`)
        if (errors.length > 0) lines.push(`❌ 失败:\n${errors.map(e => `  • ${e}`).join('\n')}`)
        if (copied.length > 0) {
          lines.push('⚠ 需重开会话才生效:会话内热加载新技能会打碎前缀缓存,成本可达几十倍。')
          const installed = countInstalledSkills(ctx.agent.cwd)
          if (installed >= RECOMMENDED_MAX_SKILLS) {
            lines.push(`⚠ 已安装 ${installed} 个,超过建议上限 ${RECOMMENDED_MAX_SKILLS}。${SKILL_RESTRAINT_NOTICE}`)
          }
        }
        pushStatic(createLogEntry({ type: 'system', content: lines.join('\n') || '无变更。' }))
        setIsStreaming(false)
        return true
      }

      if (!sub || sub === 'list' || sub === 'ls') {
        if (allSkills.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No skills found in .rivet/skills/.\nInstall one with:\n  /skill install <name>\nor copy manually:\n  cp -r ~/.claude/skills/<name> .rivet/skills/<name>\nor list it under skills.importFromClaude in config.' }))
        } else {
          const lines = [...allSkills]
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(s => {
              const size = s.body.length > 1024 ? `${(s.body.length / 1024).toFixed(1)}KB` : `${s.body.length}B`
              const desc = (s.description || '(no description)').replace(/\s+/g, ' ').slice(0, 120)
              return `  ${sourceTag(s.source)} ${s.name} (${size}) — ${desc}`
            })
          const draftCount = listSkillDrafts(ctx.agent.cwd).length
          const draftHint = draftCount > 0 ? `\n📝 ${draftCount} 个自动蒸馏草稿待审核 — /skill review` : ''
          pushStatic(createLogEntry({ type: 'system', content: `Skills (${allSkills.length}):\n${lines.join('\n')}\n\nUse /skill <name> to load a skill's full instructions into the conversation.${draftHint}` }))
        }
        setIsStreaming(false)
        return true
      }

      // /skill <name> — load the FULL body into the conversation and immediately
      // invoke it as the current prompt. The slash handler just acknowledges the
      // load; the actual body is expanded by resolveAppPromptInput so the agent
      // sees the skill instructions as the user message and responds in this turn.
      const skill = skillRegistry.get(parts[1]!) ?? allSkills.find(s => s.name.toLowerCase() === sub)
      if (!skill) {
        pushStatic(createLogEntry({ type: 'system', content: `Skill "${parts[1]}" not found.\nUse /skill list to see available skills.` }))
        setIsStreaming(false)
        return true
      }

      const sizeKb = (skill.body.length / 1024).toFixed(1)
      const taskHint = parts.slice(2).join(' ').trim()
      pushStatic(createLogEntry({ type: 'system', content: `✅ Loaded skill: ${skill.name} (${sizeKb}KB from ${skill.source ?? 'rivet'})\nThe full skill instructions are now in the conversation.${taskHint ? `\nUser task: ${taskHint}` : ''}` }))

      // Remember that this skill was invoked so the prompt engine can re-inject
      // its instructions into the dynamic appendix after context compaction.
      ctx.agent.markSkillInvoked?.(skill.name)

      // Fall through to the agent pipeline. resolveAppPromptInput will expand
      // `/skill <name> [...]` into the skill body so the agent responds now.
      return false
    },
  },
  {
    name: '/sensorium',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const snapshot = ctx.agent.getCognitiveSnapshot?.()
      if (!snapshot) {
        pushStatic(createLogEntry({ type: 'system', content: 'Sensorium not available yet. Send a message first to build cognitive state.' }))
        setIsStreaming(false)
        return true
      }
      const s = snapshot
      const sensoriumLines = [
        '🧠 Sensorium — 天枢 3D 自感知',
        '',
        `  任务状态: ${s.contractStatus ?? 'idle'}`,
        `  目标: ${s.objective ?? '(none)'}`,
        `  涉及文件: ${s.scopeFileCount}`,
        `  可执行任务: ${s.isActionableTask ? 'yes' : 'no'}`,
        `  验证缺口: ${s.hasVerificationGap ? 'WARNING: yes' : 'OK: no'}`,
        `  交付状态: ${s.deliveryStatus}`,
        '',
        '这些信号驱动 Immune 系统、Sycophancy Trap、Doom Loop 防护等自适应行为。',
        '详细诊断: /debug [prompt|fingerprint|cache|context-payload]',
      ]
      pushStatic(createLogEntry({ type: 'system', content: sensoriumLines.join('\n') }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/index',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // Rebuild codebase index from MeridianDB
      const indexer = ctx.agent.getIndexer?.()
      if (!indexer) {
        pushStatic(createLogEntry({ type: 'system', content: '⚠ MeridianIndexer not available. Index requires better-sqlite3.' }))
        setIsStreaming(false)
        return true
      }
      const db = indexer.getDb()
      const cwd = ctx.agent.cwd ?? process.cwd()

      // Read main.ts and headless.ts for CLI extraction
      let mainTsSource = ''
      let headlessSource: string | null = null
      const mainTsPath = 'src/main.ts'
      const headlessPath = 'src/headless.ts'
      try {
        mainTsSource = readFileSync(join(cwd, mainTsPath), 'utf-8')
      } catch { /* not found */ }
      try {
        headlessSource = readFileSync(join(cwd, headlessPath), 'utf-8')
      } catch { /* not found */ }

      const result = fullRebuild(db, mainTsSource, headlessSource, mainTsPath, headlessPath, cwd)
      const indexBlock = generateCodebaseIndexBlock(db, getHeadSha())

      pushStatic(createLogEntry({ type: 'system', content: `📚 Codebase Index Rebuilt\n\n${result}\n\nIndex will be injected into agent context on next turn.` }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/dream',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      // Show dream status — memory distillation runs automatically at session end
      const dir = knowledgeDir()
      const memPath = join(dir, 'project-memory.md')
      const hasMemory = existsSync(memPath)
      const size = hasMemory ? readFileSync(memPath, 'utf-8').length : 0
      const entries = hasMemory
        ? (readFileSync(memPath, 'utf-8').match(/^### /gm) ?? []).length
        : 0

      pushStatic(createLogEntry({ type: 'system', content:
        `🌙 Dream — 记忆蒸馏\n\n` +
        `  状态: ${hasMemory ? 'active' : 'empty'}\n` +
        `  条目: ${entries} curated memories\n` +
        `  大小: ${(size / 1024).toFixed(1)} KB\n` +
        `  路径: .rivet/knowledge/project-memory.md\n\n` +
        `Dream 在会话结束时自动运行，从决策中提取：\n` +
        `  • convergence_insight — 收敛洞察\n` +
        `  • architectural_invariant — 架构不变量\n` +
        `  • selection_rule — 选择规则\n` +
        `  • conceptual_reframe — 概念重构\n` +
        `  • reusable_design_pattern — 可复用设计模式\n\n` +
        `记忆不注入提示词，通过 recall 工具按需检索。`
      }))
      setIsStreaming(false)
      return true
    },
  },
  {
    name: '/diagram',
    immediate: true,
    handler(ctx) {
      const { parts, pushStatic, setIsStreaming } = ctx
      const cmd = parts[0]!.toLowerCase()
      const arg = (parts[1] ?? '').toLowerCase()
      if (!arg || arg === 'list') {
        pushStatic(createLogEntry({ type: 'system', content:
          `${formatDiagramList()}\n\n用法：/diagram <type> — 生成骨架并写入 docs/diagrams/<type>.md\n形状语义已内建（{{六边形}}=LLM·[[子程序]]=Agent·[(圆柱)]=存储·{菱形}=决策·(圆角)=输入）。`
        }))
        setIsStreaming(false)
        return true
      }
      if (!isDiagramType(arg)) {
        pushStatic(createLogEntry({ type: 'system', content:
          `未知图型 "${arg}"。\n${formatDiagramList()}`
        }))
        setIsStreaming(false)
        return true
      }
      const cwd = ctx.agent.cwd
      const outDir = join(cwd, 'docs', 'diagrams')
      const outPath = join(outDir, `${arg}.md`)
      let writeNote: string
      try {
        mkdirSync(outDir, { recursive: true })
        writeFileSync(outPath, buildDiagramDoc(arg), 'utf-8')
        writeNote = `已写入 docs/diagrams/${arg}.md — 在 VSCode/GitHub/Obsidian 打开查看渲染。`
      } catch (e) {
        writeNote = `（写入失败：${e instanceof Error ? e.message : String(e)}；骨架见下方，可手动保存）`
      }
      pushStatic(createLogEntry({ type: 'system', content:
        `📐 ${arg} 骨架已生成\n\n${writeNote}\n\n${renderDiagramBlock(arg)}\n\n替换节点文字即可。终端里显示为源码，渲染在外部查看器。`
      }))
      setIsStreaming(false)
      return true
    },
  },
]

export async function handleSlashCommand(ctx: SlashHandlerContext): Promise<boolean> {
  const cmd = ctx.parts[0]!.toLowerCase()
  const command = TUI_SLASH_COMMANDS.find(c => c.name === cmd)
  if (!command) return false
  return await command.handler(ctx)
}

export function registerTuiSlashCommands(app: TuiApp, ctx: BootstrapContext): void {
  const autoSafeRef: MutableRefLike<boolean> = { current: true }
  const verboseRef: MutableRefLike<boolean> = { current: false }
  const rollbackTokenRef: MutableRefLike<string | null> = { current: null }
  let cacheHitRate = 0

  const allProviders: Record<string, { models: Array<{ id: string; alias: string }> }> = {}
  for (const [name, prov] of Object.entries(ctx.config.provider.providers)) {
    allProviders[name] = { models: prov.models.map(m => ({ id: m.id, alias: m.alias ?? m.id })) }
  }

  function buildHandlerContext(input: string): SlashHandlerContext {
    const trimmed = input.trim()
    const parts = trimmed.split(/\s+/)
    const metrics = app.getMetrics()
    const maxTokens = metrics?.maxTokens && metrics.maxTokens > 0
      ? metrics.maxTokens
      : (ctx.provider.models[0]?.contextWindow ?? 128000)
    const cost = metrics?.cost ?? 0

    return {
      parts,
      agent: ctx.agent,
      session: ctx.session,
      persist: ctx.persist,
      model: app.getModelInfo().modelName,
      maxTokens,
      availableModels: ctx.provider.models.map(m => ({ id: m.id, alias: m.alias ?? m.id })),
      onModelSwitch: (modelId: string) => {
        try { ctx.agent.abort() } catch {}
        const res = switchAgentRuntime(ctx, modelId)
        if (res.ok && res.modelName) {
          app.setModelInfo(res.modelName, res.contextWindow)
        }
        return { ok: res.ok, error: res.error }
      },
      onSessionSwitch: (targetId: string) => {
        try { ctx.agent.abort() } catch {}
        const res = switchAgentSession(ctx, targetId)
        if (res.ok) {
          app.setStreamingState(false)
          // 切换后恢复目标、todo 列表与 side panel 状态，保持会话连续性。
          try {
            const restoredGoal = restoreGoalTracker(getSessionDir(ctx.cwd), targetId, {
              maxJudgeRuns: ctx.config.agent.goal?.judge?.maxRuns,
            })
            if (restoredGoal) {
              ctx.agent.setGoalTracker(restoredGoal)
              ctx.refs.goalTrackerRef.current = restoredGoal
            } else {
              ctx.refs.goalTrackerRef.current = null
            }
          } catch { /* goal restore best-effort */ }
          try {
            loadTodos(targetId, ctx.cwd)
            setTodoSession(targetId, ctx.cwd)
            setPlanSession(targetId)
          } catch { /* todo/plan restore best-effort */ }
          try {
            const meta = ctx.persist.loadMetadata()
            if (meta?.sidePanelOpen) app.setSidePanelOpen(true)
            else app.setSidePanelOpen(false)
          } catch { /* panel restore best-effort */ }
        }
        return res
      },
      allProviders,
      currentProvider: ctx.provider.name,
      currentSessionId: ctx.sessionId,
      cost,
      cacheHitRate: metrics?.cacheHitRate ?? cacheHitRate,
      autoSafeRef,
      verboseRef,
      setVerbose: (v: boolean) => { verboseRef.current = v },
      setAutoSafe: (v: boolean) => { autoSafeRef.current = v },
      rollbackTokenRef,
      setCockpitPanel: () => {},
      pushStatic: (entry) => { app.commitStatic(entry.content, { isError: entry.isError }) },
      setIsStreaming: (v: boolean) => { app.setStreamingState(v) },
      setCacheHitRate: (v: number) => { cacheHitRate = v },
      setSummaryState: () => {},
      mcpManagerRef: { current: ctx.refs.mcpManager },
      claimStoreRef: { current: ctx.claimStore },
      banditState: ctx.refs.banditState ?? undefined,
      onDomainChange: (domainName: string | undefined) => {
        app.setSessionStarDomain(domainName)
      },
      runReview: ctx.refs.coordinator
        ? (() => {
            const reviewDeps = createCoordinatorReviewDeps(ctx.refs.coordinator!, {
              parentTurnId: 'slash-review',
              reviewDepth: 0,
            })
            return (change: ChangeSet, mode: ReviewMode, focus?: string) =>
              routeReviewWorkflow(change, reviewDeps, { mode, focusHint: focus })
          })()
        : undefined,
      submitToAgent: (prompt: string) => { app.submitText(prompt) },
      goalTrackerRef: ctx.refs.goalTrackerRef,
      surfacePush: (id: string) => { app.activateOverlay(id) },
      surfacePop: () => { app.deactivateOverlay() },
      setReasoningEffort: (effort) => { ctx.agent.setReasoningEffort(effort) },
      reasoningEffort: ctx.agent.getReasoningEffort() ?? ctx.agent.config.reasoningEffort,
    }
  }

  function getHandler(name: string) {
    return TUI_SLASH_COMMANDS.find(c => c.name === name)?.handler
  }

  function register(name: string, command: Omit<SlashCommand, "name">) {
    app.registerSlashCommand({ name, ...command })
  }

  // Register all switch-case commands using the shared handler context adapter.
  for (const cmd of TUI_SLASH_COMMANDS) {
    app.registerSlashCommand({
      name: cmd.name,
      description: cmd.description,
      immediate: cmd.immediate,
      handler: async ({ app, input, trimmed }) => cmd.handler(buildHandlerContext(trimmed)),
    })
  }

  // TUI-specific overrides that need the app handle or resolve ecosystem workflows.
  register("/clear", {
    description: "Clear screen",
    immediate: true,
    handler: () => {
      process.stdout.write('\x1B[2J\x1B[H')
      app.setStreamingState(false)
      return true
    },
  })

  register("/exit", {
    description: "Exit Rivet",
    immediate: true,
    handler: () => {
      app.commitStatic('Session saved. Goodbye!')
      ctx.shutdown()
      return true
    },
  })

  register("/quit", {
    description: "Exit Rivet",
    immediate: true,
    handler: () => {
      app.commitStatic('Session saved. Goodbye!')
      ctx.shutdown()
      return true
    },
  })

  register("/update", {
    description: "Check and install the latest Rivet release",
    immediate: true,
    handler: async () => {
      if (app.busy) {
        app.commitStatic('⚠️  Cannot update while the agent is running.')
        return true
      }

      const root = detectInstallRoot()
      if (!root) {
        app.commitStatic('⚠️  Cannot detect Rivet install root.')
        return true
      }

      app.commitStatic('Checking for updates...')
      const check = await checkForUpdate(root, { bypassCache: true })
      if (!check) {
        app.commitStatic('⚠️  Could not check for updates right now.')
        return true
      }

      if (!check.hasUpdate) {
        app.commitStatic(`Rivet is up to date (${check.current}).`)
        return true
      }

      app.commitStatic(formatUpdateBanner(check.current, check.latest))
      app.commitStatic(`Install source: ${check.installType}`)

      // Windows 全局安装：进程存活时 npm 无法覆盖被占用的原生模块
      // （better_sqlite3.node）→ "另一个程序正在使用此文件"。改为分离式更新器：
      // 等本进程退出释放文件锁后再装、再拉起。
      if (process.platform === 'win32' && check.installType === 'global') {
        const scheduled = spawnWindowsSelfUpdate(root, 'latest', true, ctx.sessionId)
        if (!scheduled) {
          app.commitStatic('❌ 无法启动后台更新器，请手动执行：npm install -g tianshu-tui@latest')
          return true
        }
        app.commitStatic('✅ 更新已安排：天枢将退出以释放文件占用，安装完成后会自动重新打开。')
        app.commitStatic('   （若未自动打开，请重新运行 rivet；安装约需数十秒）')
        setTimeout(() => {
          ctx.shutdown()
          app.dispose()
          process.exit(0)
        }, 400)
        return true
      }

      const result = await runUpdate(root, 'latest', (line) => app.commitStatic(line))
      if (result.skipped) {
        app.commitStatic(`ℹ️  ${result.message}`)
        return true
      }
      if (!result.ok) {
        app.commitStatic(`❌ ${result.message}`)
        return true
      }

      app.commitStatic('✅ Update complete. Restarting...')
      setTimeout(() => {
        ctx.shutdown()
        app.dispose()
        restartProcess(ctx.sessionId)
      }, 250)
      return true
    },
  })

  register("/starmap", {
    description: "Open starmap overlay",
    immediate: true,
    overlay: "starmap",
    handler: () => true,
  })

  register("/chronicle", {
    description: "Open chronicle overlay",
    immediate: true,
    overlay: "chronicle",
    handler: () => true,
  })

  register("/scroll", {
    description: "Open scrollback pager",
    immediate: true,
    overlay: "pager",
    handler: () => true,
  })

  register("/pager", {
    description: "Open scrollback pager",
    immediate: true,
    overlay: "pager",
    handler: () => true,
  })

  register("/rewind", {
    description: "Open rewind overlay",
    immediate: true,
    overlay: "rewind",
    handler: () => true,
  })

  register("/tasks", {
    description: "Open tasks overlay",
    immediate: true,
    overlay: "tasks",
    handler: () => true,
  })

  register("/enter", {
    description: "Resume a worker session (e.g. /enter wo_team:T1 continue fixing bug)",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const result = resolveEnterWorkerInput(app, trimmed)
      if (!result) return false
      if ('error' in result) {
        app.commitStatic(`⚠️  ${result.error}`)
        return true
      }
      app.submitText(result.prompt)
      return true
    },
  })

  register("/palette", {
    description: "Open command palette",
    immediate: true,
    overlay: "command-palette",
    handler: () => true,
  })

  register("/domain", {
    description: "Show or switch star domain",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      if (parts.length === 1) {
        app.activateOverlay("domain-picker")
        return true
      }
      const handler = getHandler("/domain")
      return handler ? handler(buildHandlerContext(trimmed)) : false
    },
  })

  register("/model", {
    description: "Show or switch model",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      if (parts.length === 1) {
        app.activateOverlay("model-picker")
        return true
      }
      const handler = getHandler("/model")
      return handler ? handler(buildHandlerContext(trimmed)) : false
    },
  })

  register("/connect", {
    description: "连接模型服务商（选内置或自定义，填写 API 密钥）",
    immediate: true,
    handler: ({ app }) => {
      app.startConnect()
      return true
    },
  })

  register("/theme", {
    description: "Show or switch color theme",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      if (parts.length === 1) {
        app.activateOverlay("theme-picker")
        return true
      }
      const handler = getHandler("/theme")
      return handler ? handler(buildHandlerContext(trimmed)) : false
    },
  })

  register("/cockpit", {
    description: "Toggle cockpit panel",
    immediate: true,
    handler: ({ app, input, trimmed }) => {
      const parts = trimmed.split(/\s+/)
      const arg = parts[1]?.toLowerCase() as Panel | "off" | undefined
      if (arg === "off") {
        app.deactivateOverlay()
        app.commitStatic('Cockpit panel collapsed.')
        app.setStreamingState(false)
        return true
      }
      if (arg && (PANELS as string[]).includes(arg)) {
        app.setCockpitPanel(arg as Panel)
        app.activateOverlay("cockpit")
        app.commitStatic(`Cockpit: ${PANEL_LABELS[arg as Panel]} panel. /cockpit off to collapse.`)
        app.setStreamingState(false)
        return true
      }
      const wasOpen = app.activeOverlayId() === "cockpit"
      if (wasOpen) {
        app.deactivateOverlay()
      } else {
        app.setCockpitPanel('summary')
        app.activateOverlay("cockpit")
      }
      app.commitStatic(wasOpen ? 'Cockpit panel collapsed.' : `Cockpit: ${PANEL_LABELS['summary']} panel. /cockpit off to collapse.`)
      app.setStreamingState(false)
      return true
    },
  })

  register("/vim", {
    description: "Toggle vim keybindings",
    immediate: true,
    handler: () => {
      const next = app.toggleVim()
      app.commitStatic(next
        ? 'Vim keybindings: on (Esc → normal mode, i/a → insert)'
        : 'Vim keybindings: off')
      app.setStreamingState(false)
      return true
    },
  })

  register("/auto", {
    description: "Toggle auto-approve",
    immediate: true,
    handler: () => {
      const next = !autoSafeRef.current
      autoSafeRef.current = next
      const mode = next ? "auto-safe" : "manual"
      ctx.agent.setApprovalMode(mode)
      app.setApprovalMode(mode)
      app.commitStatic(next
        ? 'Auto-approve: on (auto-safe — high-risk still requires approval)'
        : 'Auto-approve: off (manual — all mutating tools require approval)')
      app.setStreamingState(false)
      return true
    },
  })

  // /yes needs the same TUI state sync as /auto so worker pills / glance bar
  // reflect the real approval mode.
  register("/yes", {
    description: "YOLO 模式 — 一键跳过所有审批（再次输入关闭）",
    immediate: true,
    handler: ({ trimmed }) => {
      const parts = trimmed.split(/\s+/)
      const sub = parts[1]?.toLowerCase()
      const currentlyYolo = (ctx.agent.config.approvalMode ?? 'manual') === 'dangerously-skip-permissions'
      let enable: boolean
      if (sub === 'on') enable = true
      else if (sub === 'off') enable = false
      else enable = !currentlyYolo

      if (enable) {
        ctx.agent.setApprovalMode('dangerously-skip-permissions')
        autoSafeRef.current = false
        app.setApprovalMode('dangerously-skip-permissions')
        app.commitStatic('YES 模式：开启 — 跳过所有审批，不再弹确认。⚠️ 高风险操作也会直接执行，请谨慎。')
      } else {
        ctx.agent.setApprovalMode('auto-safe')
        autoSafeRef.current = true
        app.setApprovalMode('auto-safe')
        app.commitStatic('YES 模式：关闭 — 恢复 auto-safe（高风险操作仍会弹确认）。')
      }
      app.setStreamingState(false)
      return true
    },
  })

  // Ecosystem workflow commands: resolve to agent prompt and submit directly.
  // When the resolver has no mapping (e.g. empty /team or /plan), fall back to
  // the shared handler so usage hints are shown instead of being rejected.
  function registerWorkflow(name: string) {
    register(name, {
      handler: ({ app, input, trimmed }) => {
        const resolved = resolveAppPromptInput(trimmed, ctx.cwd)
        if (resolved !== null) {
          app.submitText(resolved.prompt)
          return true
        }
        const fallback = getHandler(name)
        return fallback ? fallback(buildHandlerContext(trimmed)) : false
      },
    })
  }
  registerWorkflow("/team")
  registerWorkflow("/council")
  registerWorkflow("/plan")
  registerWorkflow("/write-plan")
  registerWorkflow("/plan-close")
}
