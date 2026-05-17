import type { AgentLoop } from '../agent/loop.js'
import type { SessionContext } from '../agent/context.js'
import { SessionPersist } from '../agent/session-persist.js'
import { microCompact, estimateTokens } from '../compact/micro.js'
import { rollbackToCheckpoint, getRollbackPreview } from '../agent/checkpoint.js'
import { runResumePreflight } from '../context/resume-preflight.js'
import { resolveCustomCommand } from '../commands/loader.js'
import { getTheme, setTheme, getActiveThemeName, type ThemeName } from './theme.js'
import { PhaseTracker } from './phase-tracker.js'
import { createLogEntry, type LogEntry } from './log-state.js'
import { getPaletteCommands } from './command-palette.js'
import { openInEditor } from './external-editor.js'
import { projectCacheTelemetry } from './cache-telemetry.js'
import { PANEL_LABELS, type Panel } from './cockpit/types.js'
import type { SummaryState } from './summary-bar.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimStatus } from '../context/claims.js'
import { loadProjectRules } from '../context/rules-loader.js'
import { exportDurableClaims, importClaims } from '../context/claim-export.js'
import { join } from 'node:path'
import { homedir } from 'node:os'

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
  cockpitPanelRef: React.MutableRefObject<Panel | null>
  setCockpitPanel: (v: Panel | null | ((prev: Panel | null) => Panel | null)) => void
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

export function resolveAppPromptInput(input: string, cwd: string): string {
  if (!input.startsWith('/')) return input
  return resolveCustomCommand(cwd, input) ?? input
}

export function handleSlashCommand(ctx: SlashHandlerContext): boolean {
  const { parts, pushStatic, setIsStreaming } = ctx
  const cmd = parts[0]!.toLowerCase()

  switch (cmd) {
    case '/help':
      pushStatic(createLogEntry({ type: 'system', content: `Available commands:
/help — Show this help
/exit — Exit Rivet
/quit — Exit
/compact — Compact conversation context
/model [name|list] — Show or switch model
/verbose — Toggle verbose tool output
/effort [off|low|medium|high|max] — Set reasoning effort (max = always full reasoning)
/debug [prompt|fingerprint|cache|mcp] — Debug prefix cache, prompt, and MCP connections
/clear — Clear screen (visual only)
/sessions — List all saved sessions
/resume <number> — Restore a saved session
/memory [text] — Show or save session memory entries
/rollback — Preview changes since last checkpoint (/rollback confirm to execute)
/context — Show context ledger health, tokens, rounds, and compact events
/evidence — Show last turn evidence summary
/mcp — Show MCP server status
/auto — Toggle auto-approve (current: ${ctx.autoSafeRef.current ? 'auto-safe' : 'manual'})
/theme [pastel|cyberpunk|list] — Switch color theme
/cockpit [summary|trace|verify|context|safety|model|off] — Toggle or switch cockpit panel
/interview <topic> — Start deep interview to clarify requirements before coding
Ctrl+C — Interrupt current turn (press twice to exit)` }))
      setIsStreaming(false)
      return true

    case '/exit':
    case '/quit':
      ctx.persist.compact(ctx.session.getMessages())
      pushStatic(createLogEntry({ type: 'system', content: 'Session saved. Goodbye!' }))
      process.emit('SIGINT')

    case '/compact':
      pushStatic(createLogEntry({ type: 'system', content: 'Compacting conversation...' }))
      { const msgs = ctx.session.getMessages()
        const { messages: compacted, truncated } = microCompact(msgs, ctx.maxTokens, estimateTokens(msgs))
        ctx.session.replaceMessages(compacted)
        ctx.session.recordCompactEvent({
          turn: ctx.session.getTurnCount(),
          tier: 1,
          reason: 'manual /compact command',
          beforeTokens: estimateTokens(msgs),
          afterTokens: estimateTokens(compacted),
          createdAt: Date.now(),
        })
        pushStatic(createLogEntry({ type: 'system', content: `Compacted: removed ${truncated} messages. ${compacted.length} remaining.` }))
        ctx.setSummaryState(prev => ({ ...prev, compactEvent: { beforeTokens: estimateTokens(msgs), afterTokens: estimateTokens(compacted) } }))
        setTimeout(() => ctx.setSummaryState(prev => ({ ...prev, compactEvent: null })), 5000)
      }
      setIsStreaming(false)
      ctx.setCacheHitRate(ctx.session.getCacheHitRate())
      return true

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

    case '/theme': {
      const raw = parts[1]?.toLowerCase()
      const validThemes: ThemeName[] = ['pastel', 'cyberpunk']
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
        const telemetry = projectCacheTelemetry(ctx.session, ctx.session.getTurnCount(), 'healthy')
        const totalCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens
        const latestLine = telemetry.latestHitRate === null
          ? 'latest turn: no current cache metrics'
          : `latest turn: ${(telemetry.latestHitRate * 100).toFixed(1)}%`
        pushStatic(createLogEntry({ type: 'system', content: `Cache:\n  status: ${telemetry.status}\n  hit rate: ${(telemetry.hitRate * 100).toFixed(1)}%\n  ${latestLine}\n  read tokens: ${usage.cache_read_input_tokens.toLocaleString()}\n  write tokens: ${usage.cache_creation_input_tokens.toLocaleString()}\n  total cached: ${totalCached.toLocaleString()}\n  input tokens: ${usage.input_tokens.toLocaleString()}\n  output tokens: ${usage.output_tokens.toLocaleString()}\n  estimated: ${ctx.session.getEstimatedTokens().toLocaleString()}\n  cost: ¥${ctx.cost.toFixed(4)}\n  saved: ¥${((usage.cache_read_input_tokens * 0.9) / 1_000_000).toFixed(4)} (cache discount)` }))
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
        pushStatic(createLogEntry({ type: 'system', content: 'Usage: /debug [prompt|fingerprint|cache|mcp]' }))
      }
      setIsStreaming(false)
      return true
    }

    case '/rollback':
      return false

    case '/clear':
      setIsStreaming(false)
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
      const rawMsgs = p.load()
      const preflight = runResumePreflight(rawMsgs)
      ctx.session.replaceMessages(preflight.messages)
      if (preflight.repaired) {
        p.compact(preflight.messages)
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

    case '/memory': {
      const text = parts.slice(1).join(' ').trim()
      if (!text) {
        const memory = ctx.persist.loadMemory()
        const content = memory.entries.length === 0
          ? 'Session memory is empty.'
          : memory.entries.map(entry => `- [${entry.source}] ${entry.text}`).join('\n')
        pushStatic(createLogEntry({ type: 'system', content }))
      } else {
        ctx.persist.appendMemory({ text, source: 'manual', createdAt: Date.now() })
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
        fh.rewind(target.messageId).then(restored => {
          pushStatic(createLogEntry({ type: 'system', content: `Undo complete. Restored files: ${restored.join(', ') || '(none)'}` }))
        }).catch(err => {
          pushStatic(createLogEntry({ type: 'system', content: `Undo failed: ${(err as Error).message}` }))
        })
      } else {
        const recent = snapshots.slice(-10).reverse()
        const lines = recent.map((s, i) => {
          const n = snapshots.length - i
          const files = Object.keys(s.trackedFileBackups).join(', ')
          return `  ${n}. [${s.messageId.slice(0, 8)}] ${files || '(no files)'}`
        })
        pushStatic(createLogEntry({ type: 'system', content: `Undo history (${snapshots.length} total):\n${lines.join('\n')}\n\nUse /undo <number> to revert.` }))
      }
      setIsStreaming(false)
      return true
    }

    case '/cockpit': {
      const subcmd = parts[1] as Panel | 'off' | undefined
      if (subcmd === 'off') {
        ctx.setCockpitPanel(null)
        pushStatic(createLogEntry({ type: 'system', content: 'Cockpit panel collapsed.' }))
      } else if (subcmd && subcmd in PANEL_LABELS) {
        ctx.setCockpitPanel(subcmd as Panel)
        pushStatic(createLogEntry({ type: 'system', content: `Cockpit: ${PANEL_LABELS[subcmd as Panel]} panel. /cockpit off to collapse.` }))
      } else {
        ctx.setCockpitPanel(prev => prev ? null : 'summary')
        pushStatic(createLogEntry({ type: 'system', content: ctx.cockpitPanelRef.current ? `Cockpit: ${PANEL_LABELS[ctx.cockpitPanelRef.current]} panel. /cockpit off to collapse.` : 'Cockpit panel collapsed.' }))
      }
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
  }

  return false
}
