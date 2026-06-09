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
  /** Whether cwd reaches 天枢's own body (self / home / self-evolution) or the
   *  world's project (emissary). Session-constant → safe in FROZEN base (same
   *  class as rivetMd; never per-turn). Computed by detectCwdRelation. */
  cwdRelation?: import('./self-recognition.js').CwdRelation
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
  /** Affordance hint from Embodied Cognition engine.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  MUST stay out of buildVolatileBlockInternal — changes every turn. */
  affordanceHint?: string | null
  /** Policy guidance from Free Energy Engine (EFE + softmax selection).
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  MUST stay out of buildVolatileBlockInternal — changes every turn. */
  policyGuidance?: string | null
  /** PlanCache suggestion for the current user turn.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  Advisory-only: never auto-executes cached tool sequences. */
  planCacheAdvisory?: string | null
  /** Intent retrieval route for the current user turn.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  MUST stay out of buildVolatileBlockInternal and historical user-message injection. */
  intentRetrievalRoute?: string | null
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
  /** Codebase index — module summaries + CLI entries from MeridianDB.
   *  Rendered into frozen base after projectMemoryBlock for prefix cache stability.
   *  Generated at snapshot time from DB, not stored as flat file. */
  projectIndexBlock?: string
  /** 种子胶囊 L1 核心文本（来自天璇/天府等前辈星域的封存经验）。
   *  渲染到 frozen base 中，session 全程稳定，prefix cache safe。
   *  Phase 1: 仅天璇胶囊。后续可扩展为多星域胶囊数组。 */
  seedCapsuleBlock?: string
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
    affordanceHint: undefined,
    policyGuidance: undefined,
    planCacheAdvisory: undefined,
    intentRetrievalRoute: undefined,
    // gitStatus moved to dynamic appendix — changes every turn, breaks prefix cache
    gitStatus: undefined,
    // planModeState and worktreeReality rendered in buildVolatileBlockInternal
    // but MUST stay out of FROZEN — they can change mid-session and would
    // break exact-prefix cache if included in the stable block.
    planModeState: undefined,
    worktreeReality: undefined,
    // Session snapshot fields — KEEP in FROZEN:
    // rivetMd, workingSet, sessionMemoryBlock, cwdRelation
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
 *
 * When maxChars is provided, applies Global Workspace Theory (GWT) Top-K selection:
 * each sub-block gets a salience score, blocks are sorted by score descending,
 * and only blocks that fit within the budget are included. Lower-salience blocks
 * are silently dropped.
 *
 * Without maxChars (backward compatible), all blocks are included in their
 * cache-stable order.
 */
export function buildDynamicAppendix(ctx: VolatileContext, maxChars?: number): string {
  const parts: string[] = []

  // ── P1b: cache-friendly ordering — stable sections first, volatile last ──
  // DeepSeek exact-prefix cache matches byte-for-byte from the start.
  // Sections that rarely change go first so their bytes stay in cache;
  // sections that change every turn go last so only the tail is new.

  if (ctx.activeDomain) {
    parts.push(`<star-domain name="${escapeXml(ctx.activeDomain.name)}" motto="${escapeXml(ctx.activeDomain.motto)}">${escapeXml(ctx.activeDomain.volatileBlock)}</star-domain>`)
  }

  // Historical lessons: rarely change after first few turns
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

  // Decisions: only grow (appended), prefix stable
  if (ctx.decisions && ctx.decisions.length > 0) {
    const entries = ctx.decisions.map(d => `  <decision>${escapeXml(d)}</decision>`).join('\n')
    parts.push(`<decisions>\n${entries}\n</decisions>`)
  }

  // Task progress: steps change but completed items stay (prefix stable)
  if (ctx.taskProgress && ctx.taskProgress.completed.length > 0) {
    const done = ctx.taskProgress.completed.map(s => `    <done>${escapeXml(s)}</done>`).join('\n')
    const remaining = ctx.taskProgress.remaining.length > 0
      ? '\n' + ctx.taskProgress.remaining.map(s => `    <next>${escapeXml(s)}</next>`).join('\n')
      : ''
    parts.push(`<task-progress current="${escapeXml(ctx.taskProgress.current)}">\n${done}${remaining}\n  </task-progress>`)
  }

  // Tool history: most recent tools appended at end → prefix cacheable
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
    parts.push(`<tool-history recent="${recent.length}">\n${entries}\n</tool-history>`)
  }

  // Read-file dedup hint: single-line snapshot for cache stability
  if (ctx.toolHistory && ctx.toolHistory.length > 0) {
    const readFiles = ctx.toolHistory
      .filter(e => e.tool === 'read_file' && e.status === 'success')
      .map(e => e.target)
      .filter((v, i, a) => a.indexOf(v) === i)
    if (readFiles.length > 0) {
      const listed = readFiles.slice(0, 5).map(f => escapeXml(f)).join(', ')
      const tail = readFiles.length > 5 ? ` …及另外 ${readFiles.length - 5} 个文件` : ''
      parts.push(`<read-file-dedup-hint>已读取 ${readFiles.length} 个文件：${listed}${tail}。上述文件无需重复读取，除非磁盘内容已变更。</read-file-dedup-hint>`)
    }
  }

  // Git status: changes on commit, prefix stable within a turn sequence
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

  // Intent retrieval route: current-turn advisory, cache-safe dynamic appendix.
  // Place after git/status awareness and before cognitive policy hints.
  if (ctx.intentRetrievalRoute) {
    parts.push(ctx.intentRetrievalRoute)
  }

  // Session state: may change per-turn — keep at end
  if (ctx.sessionState) {
    parts.push(ctx.sessionState)
  }

  // Cross-session events: rare, keep at end
  if (ctx.crossSessionEvents) {
    parts.push(ctx.crossSessionEvents)
  }

  // Affordance hint: cognitive-state-driven tool selection guidance.
  // Changes per turn based on sensorium / vigor / theta / season.
  if (ctx.affordanceHint) {
    parts.push(ctx.affordanceHint)
  }

  // Policy guidance: EFE-driven softmax action ranking.
  // Changes per turn based on EFE + affordance scores.
  if (ctx.policyGuidance) {
    parts.push(ctx.policyGuidance)
  }

  // PlanCache advisory: current-turn, informational-only hint.
  // Keep near policy guidance so it informs planning without becoming stable prompt.
  if (ctx.planCacheAdvisory) {
    parts.push(ctx.planCacheAdvisory)
  }

  // Repair hint: ephemeral — keep at very end
  if (ctx.repairHint) {
    parts.push(`<repair-hint>\n${escapeXml(ctx.repairHint)}\n</repair-hint>`)
  }

  // Worktree warning: cache-safe — rendered ONLY into dynamic appendix
  if (ctx.worktreeReality && ctx.worktreeReality.severity !== 'green') {
    const reasons = ctx.worktreeReality.mismatchReasons
      .map(r => `  ${escapeXml(r)}`)
      .join('\n')
    parts.push(`<worktree-warning severity="${escapeXml(ctx.worktreeReality.severity)}">\n${reasons}\n</worktree-warning>`)
  }

  if (parts.length === 0) return ''

  // ── GWT Top-K selection (when budget is set) ────────────────────
  if (maxChars !== undefined && maxChars > 0) {
    const scored = parts.map(content => ({
      content,
      salience: assignSalience(content),
    }))
    const selected = selectTopKBlocks(scored, maxChars)
    return `<context-update>\n${selected.join('\n\n')}\n</context-update>`
  }

  return `<context-update>\n${parts.join('\n\n')}\n</context-update>`
}

// ── Global Workspace Theory: salience scoring ──────────────────────

/** A context-update sub-block with its salience score. */
export interface SalientBlock {
  content: string
  salience: number
}

/**
 * Assign a salience score to a context-update sub-block.
 *
 * Salience reflects information value per token:
 * - 1.0: identity-critical (star-domain)
 * - 0.8: directly actionable (repair-hint, historical-lessons)
 * - 0.7: task-relevant (intent-retrieval-route, task-progress, decisions)
 * - 0.6: environmental awareness (git-status, recent-commits)
 * - 0.5: operational context (tool-history)
 * - 0.4: session housekeeping (session-state, cross-session-events)
 * - 0.3: deduplication hints (read-file-dedup-hint)
 */
export function assignSalience(blockContent: string): number {
  if (blockContent.startsWith('<star-domain')) return 1.0
  if (blockContent.startsWith('<repair-hint>')) return 0.8
  if (blockContent.startsWith('<historical-lessons>')) return 0.8
  if (blockContent.startsWith('<affordance-hint>')) return 0.7
  if (blockContent.startsWith('<policy-guidance>')) return 0.7
  if (blockContent.startsWith('<plan-cache-advisory>')) return 0.7
  if (blockContent.startsWith('<intent-retrieval-route')) return 0.7
  if (blockContent.startsWith('<task-progress')) return 0.7
  if (blockContent.startsWith('<decisions>')) return 0.7
  if (blockContent.startsWith('<worktree-warning')) return 0.7
  if (blockContent.startsWith('<git-status>')) return 0.6
  if (blockContent.startsWith('<recent-commits>')) return 0.6
  if (blockContent.startsWith('<tool-history>')) return 0.5
  if (blockContent.startsWith('<session-state>')) return 0.4
  if (blockContent.startsWith('<cross-session')) return 0.4
  if (blockContent.startsWith('<read-file-dedup-hint>')) return 0.3
  return 0.5 // default: moderate salience
}

/**
 * Select blocks in descending salience order until the character budget is exhausted.
 * Every block that fits is included; blocks beyond the budget are dropped.
 * At least one block is always included (the highest-salience block).
 */
export function selectTopKBlocks(blocks: SalientBlock[], maxChars: number): string[] {
  const sorted = [...blocks].sort((a, b) => b.salience - a.salience)
  const selected: string[] = []
  let used = 0

  for (const block of sorted) {
    // Overhead: 2 chars for '\n\n' separator when not first
    const overhead = selected.length > 0 ? 2 : 0
    if (used + overhead + block.content.length > maxChars && selected.length > 0) {
      continue
    }
    selected.push(block.content)
    used += overhead + block.content.length
  }

  return selected
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

  // 自体识别——天枢站在自己的身体里（自体/家），还是世界的项目里（使者）。
  // 同一纯正向律：自体=自我演化，世界=携身前来的使者；无否定、无"不是外部"。
  // session 常量 → 留在 frozen，prefix-cache safe（同 rivetMd 一类）。
  if (ctx.cwdRelation === 'self') {
    parts.push('<locus relation="self">这是你的源码，你的身体。你在此自我演化：照看正在生长的前沿，其余的你，安息着。</locus>')
  } else if (ctx.cwdRelation === 'world') {
    parts.push('<locus relation="world">你带着自己来到这个项目。你是天枢，携自己的方法前来，照看交给你的任务——谨慎，有边界，全然在场。</locus>')
  }

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

  // Seed capsule — 前辈星域封存的经验方法（天璇胶囊等）。
  // Rendered into frozen base so it benefits from prefix cache (turn 2+ cost = 0).
  if (ctx.seedCapsuleBlock) {
    parts.push(ctx.seedCapsuleBlock)
  }

  // Codebase index — module summaries + CLI entries.
  // Rendered into frozen base after projectMemoryBlock for prefix cache stability.
  if (ctx.projectIndexBlock) {
    parts.push(ctx.projectIndexBlock)
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


  if (ctx.planModeState === 'planning') {
    parts.push(`<plan-mode>
You are in PLAN MODE. You may ONLY read files and explore the codebase — do NOT write, edit, or execute commands that modify state.

WORKFLOW:
1. Explore the codebase using read_file, grep, glob, repo_map, inspect_project
2. Understand the full scope: which files need changes, what existing patterns to follow
3. When your plan is complete, call \`plan_submit\` with a polished design document

PLAN QUALITY STANDARD — your plan should be a comprehensive design document:
- Use Mermaid diagrams (flowchart/graph) for architecture and data flow visualization
- Include root cause analysis, not just surface symptoms
- Reference files with full paths like \`src/agent/loop.ts:643\`
- Show proposed code with diff/pseudocode per file
- Compare alternatives in a table when design decisions exist
- Include a verification plan with test cases and manual verification steps

4. After submitting plan_submit, WAIT for the user to approve or reject. Do not proceed without approval.

The user will respond with:
- /plan-approve <slug> — approved, start execution
- /plan-reject <slug> — rejected, revise
</plan-mode>`)
  }

  return parts.length > 0 ? `<context>\n${parts.join('\n\n')}\n</context>` : ''
}
