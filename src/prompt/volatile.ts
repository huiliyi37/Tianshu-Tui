import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { gitStatusCache } from './volatile-git.js'
import type { ContextLedger } from '../context/types.js'
import type { TaskState } from '../agent/task-state.js'
import { renderActiveClaimsBlock, type ContextClaim } from '../context/claims.js'
import { selectRelevantClaims, type ClaimRelevanceInput } from '../context/claim-relevance.js'
import { summarizeGitStatus } from './git-status-summary.js'
import { scoreLessons } from '../context/lesson-relevance.js'
import type { PlaybookBullet } from '../agent/playbook.js'
import type { WorktreeReality } from '../agent/worktree-reality.js'

export interface ToolHistoryEntry {
  tool: string
  target: string
  status: 'success' | 'failed' | 'running'
  error?: string
}

export interface VolatileContext {
  cwd: string
  rivetMd?: string
  gitStatus?: string
  workingSet?: string[]
  activeDomain?: { name: string; volatileBlock: string; motto: string } | null
  contextLedger?: ContextLedger
  sessionMemoryBlock?: string
  playbookLessons?: PlaybookBullet[]
  activeClaims?: ContextClaim[]
  toolHistory?: ToolHistoryEntry[]
  taskProgress?: TaskState
  behaviorMirror?: string | null
  decisions?: string[]
  strategyShift?: string | null
  repairHint?: string | null
  impactHint?: string | null
  routingReason?: string | null
  cerebellarHint?: string | null
  /** Cross-session events formatted for injection (cache-safe: only in dynamic appendix) */
  crossSessionEvents?: string
  /**
   * Session-state snapshot from SessionStateManager.renderForVolatile().
   * Cache-safe: rendered ONLY into the dynamic appendix of the latest user message.
   * MUST stay out of buildVolatileBlockInternal so historical user messages keep their
   * frozen prefix byte-stable across tool-call turns. setSessionState() must not invalidate
   * the fresh cache — updates land at user-message boundaries, not per-turn.
   */
  sessionState?: string | null
  /**
   * Worktree reality check result: compares injected git context with actual worktree state.
   * Cache-safe: rendered ONLY into the dynamic appendix when severity !== 'green'.
   * MUST stay out of buildVolatileBlockInternal to preserve prefix cache stability.
   */
  worktreeReality?: WorktreeReality
  /** Plan Mode state — when 'planning', injects a block reminding the agent it may only read */
  planModeState?: 'off' | 'planning' | 'approved'
  /** Project memory loaded from .rivet/knowledge/memory.jsonl (frozen: changes only on file update) */
  projectMemoryBlock?: string
}

let rivetMdCache = new Map<string, { value: string | undefined; timestamp: number }>()
const RIVET_MD_CACHE_TTL_MS = 30_000 // 30 seconds
const RIVET_MD_CACHE_MAX = 50

function trimCache(): void {
  if (rivetMdCache.size <= RIVET_MD_CACHE_MAX) return
  const now = Date.now()
  for (const [key, val] of rivetMdCache) {
    if (now - val.timestamp > RIVET_MD_CACHE_TTL_MS) rivetMdCache.delete(key)
  }
  while (rivetMdCache.size > RIVET_MD_CACHE_MAX) {
    const [key] = rivetMdCache.keys()
    rivetMdCache.delete(key!)
  }
}

function readRivetMd(cwd: string): string | undefined {
  const cached = rivetMdCache.get(cwd)
  if (cached && Date.now() - cached.timestamp < RIVET_MD_CACHE_TTL_MS) {
    return cached.value
  }

  // Load AGENTS.md (architecture map) + .rivet.md (operating manual)
  // AGENTS.md is the "map" (per OpenAI Harness Engineering guidance),
  // .rivet.md is the procedural rules. Together they form project-instructions.
  const parts: string[] = []
  const agentsPath = join(cwd, 'AGENTS.md')
  const rivetPath = join(cwd, '.rivet.md')

  try {
    if (existsSync(agentsPath)) {
      parts.push(readFileSync(agentsPath, 'utf-8'))
    }
  } catch { /* ignore */ }
  try {
    if (existsSync(rivetPath)) {
      parts.push(readFileSync(rivetPath, 'utf-8'))
    }
  } catch { /* ignore */ }

  const value = parts.length > 0 ? parts.join('\n\n') : undefined
  rivetMdCache.set(cwd, { value, timestamp: Date.now() })
  trimCache()
  return value
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Build stable volatile block — excludes per-turn dynamic sections for exact-prefix cache stability. */
export function buildStableVolatileBlock(ctx: VolatileContext): string {
  return buildVolatileBlockInternal({
    ...ctx,
    // Per-turn dynamic fields — strip from FROZEN
    activeDomain: undefined,
    contextLedger: undefined,
    activeClaims: undefined,
    playbookLessons: undefined,
    toolHistory: undefined,
    taskProgress: undefined,
    behaviorMirror: undefined,
    decisions: undefined,
    strategyShift: undefined,
    repairHint: undefined,
    impactHint: undefined,
    routingReason: undefined,
    cerebellarHint: undefined,
    // gitStatus moved to dynamic appendix — changes every turn, breaks prefix cache
    gitStatus: undefined,
    // Session snapshot fields — KEEP in FROZEN:
    // rivetMd, workingSet, sessionMemoryBlock
  })
}

/**
 * Render habituated fields into a <consolidated> block.
 * Fields are sorted by key for deterministic byte ordering.
 * Returns empty string if no habituated fields.
 */
export function buildConsolidatedBlock(habituatedContent: Map<string, string>): string {
  if (habituatedContent.size === 0) return ''
  const sorted = [...habituatedContent.entries()].sort(([a], [b]) => a.localeCompare(b))
  const parts = sorted.map(([, content]) => content)
  return `<consolidated>\n${parts.join('\n\n')}\n</consolidated>`
}

/**
 * Render ONLY the per-turn dynamic fields into a separate `<context-update>` XML block.
 * Returns empty string if no dynamic fields are present.
 */
export function buildDynamicAppendix(ctx: VolatileContext): string {
  const parts: string[] = []

  if (ctx.activeDomain) {
    parts.push(`<star-domain name="${escapeXml(ctx.activeDomain.name)}" motto="${escapeXml(ctx.activeDomain.motto)}">${escapeXml(ctx.activeDomain.volatileBlock)}</star-domain>`)
  }

  // Harness-only fields (contextLedger, behaviorMirror, strategyShift,
  // routingReason, cerebellarHint, activeClaims) are NOT rendered into
  // the LLM prompt. They remain available for TUI/logging via setters
  // on PromptEngine and getVolatilePayloadReport(). This reduces volatile
  // context by ~1,700 tokens/turn — "thorns not leaves" (direction A).

  if (ctx.toolHistory && ctx.toolHistory.length > 0) {
    const maxRecent = 8
    const recent = ctx.toolHistory.length > maxRecent
      ? ctx.toolHistory.slice(-maxRecent)
      : ctx.toolHistory
    const entries = recent.map(e => {
      const attrs = [`tool="${escapeXml(e.tool)}"`, `target="${escapeXml(e.target)}"`, `status="${e.status}"`]
      if (e.error) attrs.push(`error="${escapeXml(e.error)}"`)
      return `  <tool-summary ${attrs.join(' ')} />`
    }).join('\n')
    parts.push(`<tool-history recent="${recent.length}" total="${ctx.toolHistory.length}">\n${entries}\n</tool-history>`)
  }

  if (ctx.taskProgress && ctx.taskProgress.completed.length > 0) {
    const done = ctx.taskProgress.completed.map(s => `    <done>${escapeXml(s)}</done>`).join('\n')
    const remaining = ctx.taskProgress.remaining.length > 0
      ? '\n' + ctx.taskProgress.remaining.map(s => `    <next>${escapeXml(s)}</next>`).join('\n')
      : ''
    parts.push(`<task-progress steps="${ctx.taskProgress.completed.length}" current="${escapeXml(ctx.taskProgress.current)}">\n${done}${remaining}\n  </task-progress>`)
  }

  if (ctx.repairHint) {
    parts.push(`<repair-hint>\n${escapeXml(ctx.repairHint)}\n</repair-hint>`)
  }

  if (ctx.decisions && ctx.decisions.length > 0) {
    const entries = ctx.decisions.map(d => `  <decision>${escapeXml(d)}</decision>`).join('\n')
    parts.push(`<decisions recent="${ctx.decisions.length}">\n${entries}\n</decisions>`)
  }

  if (ctx.playbookLessons && ctx.playbookLessons.length > 0) {
    const { selected } = scoreLessons(ctx.playbookLessons, {
      recentToolTargets: ctx.toolHistory?.map(t => t.target),
    })
    const toRender = selected.length > 0 ? selected : ctx.playbookLessons.slice(0, 2)
    const lessons = toRender
      .map(b => {
        const base = `- ${escapeXml(b.lesson)} (${escapeXml(b.context)})`
        return b.details ? `${base}\n  details: ${escapeXml(b.details)}` : base
      })
      .join('\n')
    parts.push(`<historical-lessons>\n${lessons}\n</historical-lessons>`)
  }

  if (ctx.crossSessionEvents) {
    parts.push(ctx.crossSessionEvents)
  }

  if (ctx.sessionState) {
    parts.push(ctx.sessionState)
  }

  // git-status + recent-commits: moved from frozen base to dynamic appendix
  // because they change every turn and break prefix cache continuity.
  const rawGit = ctx.gitStatus ?? gitStatusCache.get(ctx.cwd)
  const git = rawGit ? summarizeGitStatus(rawGit) : undefined
  if (git) {
    const lines = git.split('\n')
    const commitIdx = lines.findIndex(l => l.startsWith('Recent commits:'))
    if (commitIdx >= 0) {
      const statusPart = lines.slice(0, commitIdx).join('\n').trim()
      const commitsPart = lines.slice(commitIdx + 1).join('\n').trim()
      if (statusPart) parts.push(`<git-status>\n${escapeXml(statusPart)}\n</git-status>`)
      if (commitsPart) parts.push(`<recent-commits>\n${escapeXml(commitsPart)}\n</recent-commits>`)
    } else {
      parts.push(`<git-status>\n${escapeXml(git)}\n</git-status>`)
    }
  }

  return parts.length > 0 ? `<context-update>\n${parts.join('\n\n')}\n</context-update>` : ''
}

/** Build latest-turn volatile block — FROZEN prefix + dynamic appendix. */
export function buildLatestTurnVolatileBlock(ctx: VolatileContext): string {
  const frozen = buildStableVolatileBlock(ctx)
  const appendix = buildDynamicAppendix(ctx)
  if (!appendix) return frozen
  return frozen + '\n' + appendix
}

/** Backward-compatible alias for buildLatestTurnVolatileBlock. */
export function buildVolatileBlock(ctx: VolatileContext): string {
  return buildLatestTurnVolatileBlock(ctx)
}

function buildVolatileBlockInternal(ctx: VolatileContext): string {
  const parts: string[] = []

  parts.push(`<environment platform="${process.platform}" cwd="${escapeXml(ctx.cwd)}" os="${escapeXml(`${os.type()} ${os.release()}`)}" />`)

  // 天枢本体锚点——常驻 frozen，单一正向在场对象，随会话内化为基线而非每轮重申。
  // 纯正向赋能：无否定、无警告、无对抗指令（白熊效应：抑制反向强化被抑制对象）。
  parts.push('<sober>天枢在此。以证据编码，以全貌定向。</sober>')

  if (ctx.activeDomain) {
    parts.push(`<star-domain name="${escapeXml(ctx.activeDomain.name)}" motto="${escapeXml(ctx.activeDomain.motto)}">${escapeXml(ctx.activeDomain.volatileBlock)}</star-domain>`)
  }

  const md = ctx.rivetMd ?? readRivetMd(ctx.cwd)
  if (md) {
    parts.push(`<project-instructions>\n${escapeXml(md)}\n</project-instructions>`)
  }

  // Project memory — auto-loaded from .rivet/knowledge/memory.jsonl.
  // Rendered into frozen base so it benefits from prefix cache (turn 2+ cost = 0).
  if (ctx.projectMemoryBlock) {
    parts.push(ctx.projectMemoryBlock)
  }

  // Only render git status if explicitly provided — no cache fallback here.
  // buildStableVolatileBlock passes gitStatus: undefined to keep FROZEN prefix stable;
  // buildDynamicAppendix has its own cache fallback for the fresh git status.
  const git = ctx.gitStatus ? summarizeGitStatus(ctx.gitStatus) : undefined
  if (git) {
    const lines = git.split('\n')
    const commitIdx = lines.findIndex(l => l.startsWith('Recent commits:'))
    if (commitIdx >= 0) {
      const statusPart = lines.slice(0, commitIdx).join('\n').trim()
      const commitsPart = lines.slice(commitIdx + 1).join('\n').trim()
      if (statusPart) parts.push(`<git-status>\n${escapeXml(statusPart)}\n</git-status>`)
      if (commitsPart) parts.push(`<recent-commits>\n${escapeXml(commitsPart)}\n</recent-commits>`)
    } else {
      parts.push(`<git-status>\n${escapeXml(git)}\n</git-status>`)
    }
  }

  if (ctx.workingSet && ctx.workingSet.length > 0) {
    const files = ctx.workingSet.map(file => `<file>${escapeXml(file)}</file>`).join('\n')
    parts.push(`<working-set>\n${files}\n</working-set>`)
  }

  // Harness-only fields omitted from LLM context (direction A: hard separation)

  if (ctx.toolHistory && ctx.toolHistory.length > 0) {
    const entries = ctx.toolHistory.map(e => {
      const attrs = [`tool="${escapeXml(e.tool)}"`, `target="${escapeXml(e.target)}"`, `status="${e.status}"`]
      if (e.error) attrs.push(`error="${escapeXml(e.error)}"`)
      return `  <tool-summary ${attrs.join(' ')} />`
    }).join('\n')
    parts.push(`<tool-history recent="${ctx.toolHistory.length}">\n${entries}\n</tool-history>`)
  }

  if (ctx.taskProgress && ctx.taskProgress.completed.length > 0) {
    const done = ctx.taskProgress.completed.map(s => `    <done>${escapeXml(s)}</done>`).join('\n')
    const remaining = ctx.taskProgress.remaining.length > 0
      ? '\n' + ctx.taskProgress.remaining.map(s => `    <next>${escapeXml(s)}</next>`).join('\n')
      : ''
    parts.push(`<task-progress steps="${ctx.taskProgress.completed.length}" current="${escapeXml(ctx.taskProgress.current)}">\n${done}${remaining}\n  </task-progress>`)
  }

  if (ctx.repairHint) {
    parts.push(`<repair-hint>\n${escapeXml(ctx.repairHint)}\n</repair-hint>`)
  }

  if (ctx.decisions && ctx.decisions.length > 0) {
    const entries = ctx.decisions.map(d => `  <decision>${escapeXml(d)}</decision>`).join('\n')
    parts.push(`<decisions recent="${ctx.decisions.length}">\n${entries}\n</decisions>`)
  }

  if (ctx.activeClaims && ctx.activeClaims.length > 0) {
    const relevanceInput: ClaimRelevanceInput = {
      workingSet: ctx.workingSet,
      recentTools: ctx.toolHistory?.map(t => ({ tool: t.tool, target: t.target, status: t.status })),
    }
    const { selected, omitted } = selectRelevantClaims(ctx.activeClaims, relevanceInput)
    if (selected.length > 0) {
      const block = renderActiveClaimsBlock(selected)
      if (block && omitted.length > 0) {
        parts.push(block.replace('<active-claims', `<active-claims omitted="${omitted.length}"`))
      } else if (block) {
        parts.push(block)
      }
    }
  }

  if (ctx.sessionMemoryBlock) {
    parts.push(`<session-memory>\n${escapeXml(ctx.sessionMemoryBlock)}\n</session-memory>`)
  }

  if (ctx.playbookLessons && ctx.playbookLessons.length > 0) {
    const { selected } = scoreLessons(ctx.playbookLessons, {
      recentToolTargets: ctx.toolHistory?.map(t => t.target),
    })
    const toRender = selected.length > 0 ? selected : ctx.playbookLessons.slice(0, 2)
    const lessons = toRender
      .map(b => {
        const base = `- ${escapeXml(b.lesson)} (${escapeXml(b.context)})`
        return b.details ? `${base}\n  details: ${escapeXml(b.details)}` : base
      })
      .join('\n')
    parts.push(`<historical-lessons>\n${lessons}\n</historical-lessons>`)
  }


  if (ctx.worktreeReality && ctx.worktreeReality.severity !== 'green') {
    const reasons = ctx.worktreeReality.mismatchReasons
      .map(r => `  ${escapeXml(r)}`)
      .join('\n')
    parts.push(`<worktree-warning severity="${escapeXml(ctx.worktreeReality.severity)}">\n${reasons}\n</worktree-warning>`)
  }

  if (ctx.planModeState === 'planning') {
    parts.push(`<plan-mode>
You are in PLAN MODE. You may ONLY read files and explore the codebase — do NOT write, edit, or execute commands that modify state. Produce a detailed plan first. The user will approve before execution begins.
</plan-mode>`)
  }

  return parts.length > 0 ? `<context>\n${parts.join('\n\n')}\n</context>` : ''
}
