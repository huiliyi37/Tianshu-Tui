import type { AgentLoop } from '../agent/loop.js'
import type { SessionContext } from '../agent/context.js'
import { SessionPersist } from '../agent/session-persist.js'
import { type StarDomainId } from '../agent/star-domain.js'
import { starDomainRegistry } from '../agent/star-domain-registry.js'
import { microCompactOai, estimateOaiTokens } from '../compact/micro.js'
import { rollbackToCheckpoint, getRollbackPreview } from '../agent/checkpoint.js'
import { runResumePreflightOai } from '../context/resume-preflight.js'
import { resolveCustomCommand } from '../commands/loader.js'
import { getTheme, setTheme, getActiveThemeName, type ThemeName } from './theme.js'
import { PhaseTracker } from './phase-tracker.js'
import { createLogEntry, type LogEntry } from './log-state.js'
import { getPaletteCommands } from './command-palette.js'
import { openInEditor } from './external-editor.js'
import { formatMissionStrip } from './mission.js'
import { PANEL_LABELS, type Panel } from './cockpit/types.js'
import type { SummaryState } from './summary-state.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimStatus } from '../context/claims.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { exportDurableClaims, importClaims } from '../context/claim-export.js'
import { resolveEcosystemWorkflowInput } from '../workflows/ecosystem-workflows.js'
import { formatVolatilePayloadReport } from '../context/payload-diagnostic.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { homedir } from 'node:os'
import { listPlans, approvePlan, rejectPlan } from '../plan/plan-store.js'
import { fullRebuild, generateCodebaseIndexBlock, getHeadSha } from '../repo/codebase-index.js'
import { isDiagramType, buildDiagramDoc, renderDiagramBlock, formatDiagramList } from './diagram-templates.js'

const HELP_TEXT = `Available commands:
/help — Show this help
/exit — Exit Rivet
/quit — Exit
/compact [status|llm] — Micro-compact context (/compact status for stats)
/model [name|list] — Show or switch model
/domain [list|<name>|auto|off] — Show or switch star domain personality
/verbose — Toggle verbose tool output
/auto — Toggle auto-approve
/theme [midnight|pastel|cyberpunk|observatory|starfield] — Switch color theme
/effort [off|low|medium|high|max] — Set reasoning effort
/undo [<number>|preview <number>] — Undo file changes with preview
/clear — Clear screen
/sessions — List all saved sessions
/resume <number> — Restore a saved session
/memory [text|add|search|forget] — Session memory entries
/mission — Show current task contract
/context [pin|claims|antibodies|conflicts|reload|export|import] — Context ledger
/verify — Show verification status
/evidence — Show last turn evidence summary
/debug [prompt|fingerprint|cache|context-payload|mcp] — Debug info
/mcp — Show MCP server status
/cockpit [summary|trace|verify|context|safety|model|off] — Toggle cockpit panel
/scroll — Browse session history in pager
/skill [list|<name>] — List or load Claude skills
/interview <topic> — Deep interview before coding
/plan <feature> — Create implementation plan
/plan close <file> --tasks <range|all> [--apply] — Close implementation plan tasks
/team <task|plan> — Run team-mode workflow through team_orchestrate
/team max <task> — Run team-mode max planning through team_orchestrate
/sensorium — Show 天枢 3D self-awareness state
/dream — Distill session decisions into project memory
/index — Rebuild codebase index (modules + CLI entries)
/diagram [list|<type>] — Generate a mermaid diagram skeleton (architecture|dataflow|sequence|flowchart|comparison|state)
Ctrl+C — Interrupt current turn (press twice to exit)`

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
  cost: number
  cacheHitRate: number
  autoSafeRef: React.MutableRefObject<boolean>
  verboseRef: React.MutableRefObject<boolean>
  setVerbose: (v: boolean) => void
  setAutoSafe: (v: boolean) => void
  rollbackTokenRef: React.MutableRefObject<string | null>
  setCockpitPanel: (v: Panel | ((prev: Panel) => Panel)) => void
  activeOverlay?: string | null
  surfacePush?: (id: string) => void
  surfacePop?: () => void
  pushStatic: (entry: LogEntry) => void
  setIsStreaming: (v: boolean) => void
  setCacheHitRate: (v: number) => void
  setSummaryState: (v: SummaryState | ((prev: SummaryState) => SummaryState)) => void
  mcpManagerRef: React.MutableRefObject<import('../mcp/manager.js').McpManager | null>
  claimStoreRef: React.MutableRefObject<ContextClaimStore | null>
  setReasoningEffort?: (effort: import('../agent/auto-reasoning.js').ReasoningEffort) => void
  reasoningEffort?: string
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

export function resolveAppPromptInput(input: string, cwd: string): string | null {
  if (!input.startsWith('/')) return input
  const workflow = resolveEcosystemWorkflowInput(input)
  if (workflow) return workflow.prompt
  const custom = resolveCustomCommand(cwd, input)
  if (custom) return custom
  // Unrecognized slash command — return null to signal "blocked"
  return null
}

export async function handleSlashCommand(ctx: SlashHandlerContext): Promise<boolean> {
  const { parts, pushStatic, setIsStreaming } = ctx
  const cmd = parts[0]!.toLowerCase()

  switch (cmd) {
    case '/help':
      pushStatic(createLogEntry({ type: 'system', content: HELP_TEXT }))
      setIsStreaming(false)
      return true

    case '/exit':
    case '/quit':
      ctx.persist.compactOai(ctx.session.getMessages())
      pushStatic(createLogEntry({ type: 'system', content: 'Session saved. Goodbye!' }))
      process.emit('SIGINT')
      return true

    case '/compact': {
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
    }

    case '/team': {
      if (!parts.slice(1).join(' ').trim()) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /team <task|docs/superpowers/plans/file.md>\n       /team max <task>' }))
        setIsStreaming(false)
        return true
      }
      return false
    }

    case '/model': {
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
    }

    case '/chat':
    case '/task': {
      pushStatic(createLogEntry({ type: 'system', content: '模式已由消息内容自动检测，无需手动切换。任务脚手架在有明确意图时自动开启。' }))
      setIsStreaming(false)
      return true
    }

    case '/mode': {
      pushStatic(createLogEntry({ type: 'system', content: '模式已由消息内容自动检测，无需手动切换。' }))
      setIsStreaming(false)
      return true
    }

    case '/domain': {
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
        ctx.agent.resetSessionDomain()
        pushStatic(createLogEntry({ type: 'system', content: '星域已重置为自动检测模式。下一次对话将根据输入内容自动匹配星域。' }))
      } else if (sub === 'off' || sub === 'none') {
        ctx.agent.setSessionDomain(null)
        pushStatic(createLogEntry({ type: 'system', content: '星域已关闭。本会话将不激活任何星域人格。' }))
      } else {
        // Try to match by id or Chinese name
        const allDomains = starDomainRegistry.list()
        const matched = allDomains.find(d => d.id === sub || d.name === parts[1] || d.id === parts[1]?.toLowerCase())
        if (matched) {
          const domain = { id: matched.id, name: matched.name, volatileBlock: matched.volatileBlock, motto: matched.motto }
          ctx.agent.setSessionDomain(domain)
          pushStatic(createLogEntry({ type: 'system', content: `星域切换: ${domain.name} (${domain.id})\n${domain.motto}\n\n${domain.volatileBlock}` }))
        } else {
          const validNames = allDomains.map(d => `${d.name}|${d.id}`).join(', ')
          pushStatic(createLogEntry({ type: 'system', content: `未知星域: "${parts[1]}"\n\n可用星域: ${validNames}\n\n使用 /domain list 查看所有星域。`, isError: true }))
        }
      }
      setIsStreaming(false)
      return true
    }

    case '/verbose': {
      const nextVerbose = !ctx.verboseRef.current
      ctx.setVerbose(nextVerbose)
      pushStatic(createLogEntry({ type: 'system', content: nextVerbose ? 'Verbose mode: on (show 200 lines)' : 'Verbose mode: off (show 20 lines)' }))
      setIsStreaming(false)
      return true
    }

    case '/auto': {
      const next = !ctx.autoSafeRef.current
      ctx.setAutoSafe(next)
      ctx.agent.setApprovalMode(next ? 'auto-safe' : 'manual')
      pushStatic(createLogEntry({ type: 'system', content: next ? 'Auto-approve: on (auto-safe — high-risk still requires approval)' : 'Auto-approve: off (manual — all mutating tools require approval)' }))
      setIsStreaming(false)
      return true
    }

    case '/plan-mode': {
      ctx.agent.enterPlanMode()
      pushStatic(createLogEntry({ type: 'system', content: '🔍 Plan Mode activated. Write operations are blocked. Explore the codebase and produce a plan.\n\nWhen ready, call `plan_submit` with your plan. Then:\n  /plan-list — list submitted plans\n  /plan-approve <slug> — approve and start execution\n  /plan-reject <slug> — reject with feedback' }))
      setIsStreaming(false)
      return true
    }

    case '/plan-list': {
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
    }

    case '/plan-approve': {
      const slug = parts[1]?.toLowerCase()
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

      // Inject plan context as session memory so agent can see it
      ctx.agent.updateSessionMemory(
        `<approved-plan slug="${slug}">\n${approved.content}\n</approved-plan>\n\nYou are now executing the approved plan above. Follow it step by step. Use /plan-list to review, call plan_close when done.`
      )
      ctx.agent.exitPlanMode()
      pushStatic(createLogEntry({ type: 'system', content: `✅ Plan approved: **${approved.title}** (\`${slug}\`)\n\nPlan content has been loaded into context. Plan Mode exited — execution may now begin.\n\nUse /plan-list to view all plans.` }))
      setIsStreaming(false)
      return true
    }

    case '/plan-reject': {
      const slug = parts[1]?.toLowerCase()
      if (!slug) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /plan-reject <slug>\n\nUse /plan-list to see available plans.', isError: true }))
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

      pushStatic(createLogEntry({ type: 'system', content: `❌ Plan rejected: **${rejected.title}** (\`${slug}\`)\n\nThe plan was marked REJECTED but kept on disk. Provide feedback and the agent can revise it in place.` }))
      setIsStreaming(false)
      return true
    }

    case '/theme': {
      const raw = parts[1]?.toLowerCase()
      const validThemes: ThemeName[] = ['midnight', 'pastel', 'cyberpunk', 'observatory', 'starfield']
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
    }

    case '/debug': {
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
    }

    case '/rollback':
      return false

    case '/clear':
      // Clear visual state — reset streaming text and thinking buffers
      setIsStreaming(false)
      pushStatic(createLogEntry({ type: 'system', content: 'Screen cleared.' }))
      return true

    case '/sessions': {
      const sessions = SessionPersist.listSessions()
      if (sessions.length === 0) {
        pushStatic(createLogEntry({ type: 'system', content: 'No saved sessions.' }))
      } else {
        const list = sessions.map((id, i) => {
          const marker = id === ctx.currentSessionId ? ' ← current' : ''
          return `${i + 1}. ${id.slice(0, 8)}...${marker}`
        }).join('\n')
        pushStatic(createLogEntry({ type: 'system', content: `Saved sessions:\n${list}\n\n/resume <number> to restore` }))
      }
      setIsStreaming(false)
      return true
    }

    case '/resume': {
      const sessions = SessionPersist.listSessions()
      const arg = parts[1]
      if (!arg || !/^\d+$/.test(arg)) {
        pushStatic(createLogEntry({ type: 'system', content: `Invalid session number. Use /sessions to see available sessions.` }))
        setIsStreaming(false)
        return true
      }
      const idx = parseInt(arg, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= sessions.length) {
        pushStatic(createLogEntry({ type: 'system', content: `Invalid session number. Use /sessions to see available sessions.` }))
        setIsStreaming(false)
        return true
      }
      const targetId = sessions[idx]!
      const p = new SessionPersist(targetId)
      const rawMsgs = p.loadOai()
      const preflight = runResumePreflightOai(rawMsgs)
      ctx.session.replaceMessages(preflight.messages)
      if (preflight.repaired) {
        p.compactOai(preflight.messages)
      }
      pushStatic(createLogEntry({ type: 'system', content: `Restored session ${targetId.slice(0, 8)}... (${preflight.messages.length} messages, apiSafe=${preflight.safe})` }))
      if (preflight.repaired) {
        pushStatic(createLogEntry({ type: 'system', content: `Resume preflight: repaired ${preflight.syntheticResultsInserted} orphan tool call(s).` }))
      }
      setIsStreaming(false)
      return true
    }

    case '/context': {
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
        const outPath = join(homedir(), '.rivet', 'exports', `${timestamp}.json`)
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

      pushStatic(createLogEntry({
        type: 'system',
        content: `Context: ${sections.compactionState}\nTokens: ${sections.estimatedTokens.toLocaleString()}/${sections.maxTokens.toLocaleString()} (${Math.round(sections.estimatedTokens / sections.maxTokens * 100)}%)\nRounds: ${ledger.rounds.length}\n${diagnostics}\n\nCompaction:\n${compactStr}${anchorLines}`,
      }))
      setIsStreaming(false)
      return true
    }

    case '/verify': {
      pushStatic(createLogEntry({ type: 'system', content: formatVerificationStatus(ctx.agent) }))
      setIsStreaming(false)
      return true
    }

    case '/memory': {
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
    }

    case '/mcp': {
      pushStatic(createLogEntry({ type: 'system', content: 'MCP status: use /debug mcp for detailed connection info, or check startup logs.' }))
      setIsStreaming(false)
      return true
    }

    case '/mission': {
      const snapshot = ctx.agent.getCognitiveSnapshot?.()
      const strip = formatMissionStrip(snapshot)
      pushStatic(createLogEntry({ type: 'system', content: strip ? `Mission\n\n${strip}` : 'Mission\n\nNo actionable task contract is active.' }))
      setIsStreaming(false)
      return true
    }

    case '/undo': {
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
    }

    case '/cockpit': {
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
    }

    case '/scroll': {
      ctx.surfacePush?.('pager')
      pushStatic(createLogEntry({ type: 'system', content: 'Scrollback pager opened. Press q or Esc to close.' }))
      setIsStreaming(false)
      return true
    }

    case '/effort': {
      const level = parts[1]?.toLowerCase() as 'off' | 'low' | 'medium' | 'high' | 'max' | undefined
      const valid: Array<'off' | 'low' | 'medium' | 'high' | 'max'> = ['off', 'low', 'medium', 'high', 'max']
      if (!level || !(valid as string[]).includes(level)) {
        const current = ctx.reasoningEffort ?? 'high'
        pushStatic(createLogEntry({ type: 'system', content: `Reasoning effort: ${current}\nUsage: /effort [off|low|medium|high|max]\n\nSet max for full reasoning on every turn.` }))
      } else {
        ctx.setReasoningEffort?.(level)
        pushStatic(createLogEntry({ type: 'system', content: `Reasoning effort set to: ${level}` }))
      }
      setIsStreaming(false)
      return true
    }

    case '/interview': {
      const topic = parts.slice(1).join(' ').trim()
      if (!topic) {
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /interview <topic>\nExample: /interview add a notification system' }))
        setIsStreaming(false)
        return true
      }
      return false
    }

    case '/plan':
    case '/write-plan': {
      const feature = parts.slice(1).join(' ').trim()
      if (!feature) {
        pushStatic(createLogEntry({ type: 'system', content: `Usage: ${cmd} <feature>\n       /plan close <docs/superpowers/plans/file.md> --tasks <1-7|all> [--apply]\nExample: ${cmd} add Context7 MCP preset` }))
        setIsStreaming(false)
        return true
      }
      return false
    }

    case '/skill': {
      const sub = parts[1]?.toLowerCase()
      const cwd = process.cwd()

      // Scan .claude/skills/*/SKILL.md in project + home
      const skillDirs = [
        { label: 'project', path: join(cwd, '.claude', 'skills') },
        { label: 'global', path: join(homedir(), '.claude', 'skills') },
      ]

      const skills: Array<{ name: string; path: string; source: string; desc: string; size: number }> = []
      for (const dir of skillDirs) {
        if (!existsSync(dir.path)) continue
        for (const entry of readdirSync(dir.path, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue
          const skillFile = join(dir.path, entry.name, 'SKILL.md')
          if (!existsSync(skillFile)) continue
          const content = readFileSync(skillFile, 'utf8')
          // Extract YAML front-matter description
          const descMatch = content.match(/^---\n([\s\S]*?\n)---/)?.[1] ?? ''
          const descLine = descMatch.split('\n').find(l => l.startsWith('description:') || l.startsWith('description:'))
          const desc = descLine
            ? descLine.replace(/^description:\s*(?:\|\s*)?/, '').replace(/^\s+/, '').slice(0, 120)
            : ''
          skills.push({
            name: entry.name,
            path: skillFile,
            source: dir.label,
            desc: desc || '(no description)',
            size: content.length,
          })
        }
      }

      if (!sub || sub === 'list' || sub === 'ls') {
        if (skills.length === 0) {
          pushStatic(createLogEntry({ type: 'system', content: 'No skills found.\nScanned:\n  .claude/skills/ (project)\n  ~/.claude/skills/ (global)' }))
        } else {
          const lines = skills.map(s => {
            const tag = s.source === 'global' ? '🌐' : '📁'
            const size = s.size > 1024 ? `${(s.size / 1024).toFixed(1)}KB` : `${s.size}B`
            return `  ${tag} ${s.name} (${size}) — ${s.desc}`
          })
          pushStatic(createLogEntry({ type: 'system', content: `Skills (${skills.length}):\n${lines.join('\n')}\n\nUse /skill <name> to load a skill into the conversation.` }))
        }
        setIsStreaming(false)
        return true
      }

      // /skill <name> — inject skill into conversation
      const skill = skills.find(s => s.name === sub || s.name === parts[1])
      if (!skill) {
        pushStatic(createLogEntry({ type: 'system', content: `Skill "${parts[1]}" not found.\nUse /skill list to see available skills.` }))
        setIsStreaming(false)
        return true
      }

      const skillContent = readFileSync(skill.path, 'utf8')
      // Inject as a user message with skill preamble — the agent will treat it as context
      pushStatic(createLogEntry({ type: 'system', content: `✅ Loaded skill: ${skill.name} (${(skill.size / 1024).toFixed(1)}KB from ${skill.source})\nThe skill prompt is now active for this conversation.` }))

      // Store the skill content so the next user message can reference it
      // We inject it as a slash command resolution that returns the skill body
      setIsStreaming(false)
      // Push the skill as the next prompt input by returning false with the skill content
      // Instead, add it to session as a system-pinned context via anchor
      ctx.agent.addAnchor('user_preference', `[Active Skill: ${skill.name}]\n${skillContent.slice(0, 8000)}`)
      return true
    }

    // ── 天枢独有命令 ──

    case '/sensorium': {
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
    }

    case '/index': {
      // Rebuild codebase index from MeridianDB
      const indexer = ctx.agent.getIndexer?.()
      if (!indexer) {
        pushStatic(createLogEntry({ type: 'system', content: '⚠ MeridianIndexer not available. Index requires better-sqlite3.' }))
        setIsStreaming(false)
        return true
      }
      const db = indexer.getDb()
      const cwd = ctx.agent.cwd ?? process.cwd()

      // Read main.tsx and headless.ts for CLI extraction
      let mainTsxSource = ''
      let headlessSource: string | null = null
      const mainTsxPath = 'src/main.tsx'
      const headlessPath = 'src/headless.ts'
      try {
        mainTsxSource = readFileSync(join(cwd, mainTsxPath), 'utf-8')
      } catch { /* not found */ }
      try {
        headlessSource = readFileSync(join(cwd, headlessPath), 'utf-8')
      } catch { /* not found */ }

      const result = fullRebuild(db, mainTsxSource, headlessSource, mainTsxPath, headlessPath, cwd)
      const indexBlock = generateCodebaseIndexBlock(db, getHeadSha())

      pushStatic(createLogEntry({ type: 'system', content: `📚 Codebase Index Rebuilt\n\n${result}\n\nIndex will be injected into agent context on next turn.` }))
      setIsStreaming(false)
      return true
    }

    case '/dream': {
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
    }

    case '/diagram': {
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
    }
  }

  return false
}
