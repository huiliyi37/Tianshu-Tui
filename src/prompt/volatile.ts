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
import type { TaskDepthLayer } from '../context/task-contract.js'

const DEPTH_ADVISORY: Record<Exclude<TaskDepthLayer, 'unit'>, string> = {
  wiring: '<task-depth layer="wiring">此任务跨越模块边界。mock 单测会掩盖接线缺陷。写集成测试时实例化真实依赖（非 mock），RED 必须先证明边界断裂，GREEN 才证明已修复。</task-depth>',
  system: '<task-depth layer="system">此任务跨越 3+ 层（端到端）。至少写一个不 mock 中间层的测试，验证从输入到输出的完整路径。优先使用真实子系统而非 mock。</task-depth>',
}

export function renderTaskDepthAdvisory(layer: TaskDepthLayer | undefined): string | null {
  if (!layer || layer === 'unit') return null
  return DEPTH_ADVISORY[layer]
}

import type { PlanMethodology } from '../context/task-contract.js'

// U6: the trailing 用 todo 列出有序步骤 hint seeds the PlanExecutionTrace — the
// first `todo write` becomes the plan baseline that the replan loop tracks
// against. Zero new tools; just nudges the model toward the existing todo tool.
const METHODOLOGY_ADVISORY_TEMPLATES: Record<PlanMethodology, string> = {
  lightweight: '<plan-methodology route="lightweight">推荐使用轻量版计划模板（5阶段），路径: docs/superpowers/plans/2026-06-14-plan-methodology-lightweight.md。本任务 scope 内聚，单模块边界内变更，轻量版足以覆盖。至少画一张架构或数据流图（Mermaid），哪怕只画核心 3-5 个节点。开工前先用 todo 列出有序步骤（即为执行计划基线）。</plan-methodology>',
  full: '<plan-methodology route="full">推荐使用完整版计划模板（9阶段），路径: docs/superpowers/plans/2026-06-14-plan-methodology-template.md。必须包含: 安全不变量、触发路径清单、双门对齐数据流图。开工前先用 todo 列出有序步骤（即为执行计划基线）。</plan-methodology>',
}

export function renderPlanMethodologyAdvisory(
  methodology: PlanMethodology | undefined,
  reason?: string,
): string | null {
  if (!methodology) return null
  const base = METHODOLOGY_ADVISORY_TEMPLATES[methodology]
  if (!reason || methodology === 'lightweight') return base
  // For 'full' with a reason, append it for traceability
  return base.replace('</plan-methodology>', `\n路由理由: ${reason}</plan-methodology>`)
}

/**
 * Plan Mode instruction block. Cache-safe: rendered ONLY into the dynamic
 * appendix (after history), never the frozen base — planModeState flips
 * mid-session and must not invalidate the exact-prefix cache.
 *
 * Carries copyable Mermaid skeletons so the planning model reliably produces an
 * architecture/data-flow diagram (the salience for this lives in the appendix,
 * close to where the model is reasoning, instead of a far-away tool description).
 */
export function renderPlanModeBlock(): string {
  return `<plan-mode>
You are in PLAN MODE. You may ONLY read files and explore the codebase — do NOT write, edit, or execute commands that modify state.

WORKFLOW:
1. Explore the codebase using read_file, grep, glob, repo_map, inspect_project
2. Understand the full scope: which files need changes, what existing patterns to follow
3. When your plan is complete, call \`plan_submit\` with a polished design document

PLAN QUALITY STANDARD — your plan should be a comprehensive design document:
- Include at least one Mermaid diagram (architecture or data flow). Shapes carry meaning — (rounded)=user/input, [[subroutine]]=agent/processor, {{hexagon}}=LLM/model, [(cylinder)]=store/DB, {rhombus}=decision; edges --> sync/read, ==> write/strong, -.-> async/event. Copy a skeleton below and replace the node text:
\`\`\`mermaid
flowchart TD
    U(用户输入) --> R[[入口/路由]]
    R --> L{{LLM/核心逻辑}}
    R --> S[(存储/状态)]
    L --产出--> OUT([结果])
\`\`\`
\`\`\`mermaid
flowchart LR
    SRC(来源) -->|读取| P[[处理]]
    P -->|校验| D{通过?}
    D -->|是| W[(写入目标)]
    D -.失败.-> ERR([报错/回退])
\`\`\`
- Include root cause analysis, not just surface symptoms
- Reference files with full paths like \`src/agent/loop.ts:643\`
- Show proposed code with diff/pseudocode per file
- Compare alternatives in a table when design decisions exist
- Include a verification plan with test cases and manual verification steps

4. After submitting plan_submit, WAIT for the user to approve or reject. Do not proceed without approval.

The user will respond with:
- /plan-approve <slug> — approved, start execution
- /plan-reject <slug> — rejected, revise
</plan-mode>`
}

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
  /** Recent user query text for lesson relevance scoring. */
  recentQuery?: string
  /** Callback to record which bullet IDs were actually rendered. */
  onLessonsRendered?: (ids: string[]) => void
  activeClaims?: ContextClaim[]
  toolHistory?: ToolHistoryEntry[]
  taskProgress?: TaskState
  decisions?: string[]
  /** Unified tool context from Embodied Cognition + Free Energy Engine.
   *  Replaces the old separate affordanceHint + policyGuidance blocks.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  MUST stay out of buildVolatileBlockInternal — changes every turn. */
  toolContext?: string | null
  /** PlanCache suggestion for the current user turn.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  Advisory-only: never auto-executes cached tool sequences. */
  planCacheAdvisory?: string | null
  /** U6: serialized PlanExecutionTrace appendix (survives compaction).
   *  Cache-safe: rendered ONLY into the dynamic appendix. */
  planTraceAppendix?: string | null
  /** Approved-plan pointer (slug/title/path only, NOT the plan body).
   *  Cache-safe: rendered ONLY into the dynamic appendix — never enters frozen
   *  base, so approving/revising plans does not shatter the prefix cache. The
   *  plan body stays the single source of truth on disk (.rivet/plans/<slug>.md);
   *  the agent reads it on demand and tracks steps via the todo mechanism. */
  activePlanPointer?: string | null
  /** Intent retrieval route for the current user turn.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  MUST stay out of buildVolatileBlockInternal and historical user-message injection. */
  intentRetrievalRoute?: string | null
  /** Task depth advisory — TDD strategy hint for wiring/system tasks.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  Only present when taskDepthLayer !== 'unit'. */
  taskDepthAdvisory?: string | null
  /** Plan methodology routing advisory — which plan template (lightweight/full)
   *  the PlanDesignIntentRouter recommends for this task.
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  Only present for non-unit tasks or when methodology === 'full'. */
  planMethodologyAdvisory?: string | null
  /** Matched .rivet/skills — cache-safe dynamic appendix. */
  skillAdvisoryBlock?: string | null
  /** Cross-session memory recall — cache-safe dynamic appendix. */
  crossSessionMemoryBlock?: string | null
  /** @mention context hints — cache-safe dynamic appendix. */
  mentionContextBlock?: string | null
  /** Harness advisory block — unified corrective guidance from advisory bus (A1).
   *  Cache-safe: rendered ONLY into the dynamic appendix.
   *  Max 3 advisories per turn. */
  harnessAdvisoryBlock?: string | null
  /** Cross-session events formatted for injection (cache-safe: only in dynamic appendix) */
  crossSessionEvents?: string
  /** Companion presence block — other active sessions working on the same project. */
  companionPresence?: string
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
    decisions: undefined,
    toolContext: undefined,
    planCacheAdvisory: undefined,
    planTraceAppendix: undefined,
    intentRetrievalRoute: undefined,
    // Harness advisory — per-turn dynamic, stripped from FROZEN
    harnessAdvisoryBlock: undefined,
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

/** A selected context-update sub-block with its identifying tag name. */
export interface AppendixPart { name: string; content: string }

/** Extract the leading XML tag name from a sub-block, for cross-turn diffing. */
export function appendixBlockName(content: string): string {
  const m = /^<([A-Za-z][\w-]*)/.exec(content)
  return m ? m[1]! : `anon:${content.length}`
}

/**
 * Build the per-turn context-update sub-blocks, post GWT Top-K selection.
 * Returns named parts (in cache-stable order) so callers can diff across turns.
 *
 * When maxChars is provided, applies Global Workspace Theory (GWT) Top-K selection:
 * each sub-block gets a salience score, blocks are sorted by score descending,
 * and only blocks that fit within the budget are included. Lower-salience blocks
 * are silently dropped.
 *
 * Without maxChars (backward compatible), all blocks are included in their
 * cache-stable order.
 */
export function buildDynamicAppendixParts(ctx: VolatileContext, maxChars?: number): AppendixPart[] {
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
      query: ctx.recentQuery,
      recentToolTargets: ctx.toolHistory?.map(t => t.target),
    })
    if (selected.length > 0) {
      const lessons = selected
        .map(b => {
          const base = `- ${escapeXml(b.lesson)} (${escapeXml(b.context)})`
          return b.details ? `${base}\n  details: ${escapeXml(b.details)}` : base
        })
        .join('\n')
      parts.push(`<historical-lessons>\n${lessons}\n</historical-lessons>`)
      ctx.onLessonsRendered?.(selected.map(b => b.id))
    }
  }

  // Unified progress block: merges session-state, task-progress, and decisions
  // into a single <progress> to eliminate triple repetition in the prompt.
  const progressBlock = renderProgressBlock(ctx)
  if (progressBlock) parts.push(progressBlock)

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

  // Task depth advisory: TDD strategy for wiring/system tasks
  if (ctx.taskDepthAdvisory) {
    parts.push(ctx.taskDepthAdvisory)
  }

  // Plan methodology advisory: which template (lightweight/full) to use
  if (ctx.planMethodologyAdvisory) {
    parts.push(ctx.planMethodologyAdvisory)
  }

  if (ctx.skillAdvisoryBlock) {
    parts.push(ctx.skillAdvisoryBlock)
  }

  if (ctx.crossSessionMemoryBlock) {
    parts.push(ctx.crossSessionMemoryBlock)
  }

  if (ctx.mentionContextBlock) {
    parts.push(ctx.mentionContextBlock)
  }

  // Cross-session events: rare, keep at end
  if (ctx.crossSessionEvents) {
    parts.push(ctx.crossSessionEvents)
  }

  if (ctx.companionPresence) {
    parts.push(ctx.companionPresence)
  }

  // Unified tool context: theta + EFE + top-3 ranking.
  // Replaces old separate affordance-hint + policy-guidance blocks.
  if (ctx.toolContext) {
    parts.push(ctx.toolContext)
  }

  // PlanCache advisory: current-turn, informational-only hint.
  // Keep near policy guidance so it informs planning without becoming stable prompt.
  if (ctx.planCacheAdvisory) {
    parts.push(ctx.planCacheAdvisory)
  }

  // U6: serialized PlanExecutionTrace — refreshed at compaction so the plan
  // baseline + progress survive history pruning. Cache-safe (appendix only).
  if (ctx.planTraceAppendix) {
    parts.push(ctx.planTraceAppendix)
  }

  // Approved-plan pointer: tiny slug/title/path reminder of the plan under
  // execution. Body lives on disk; agent reads on demand. Cache-safe (appendix
  // only) — keeps approve/revise from rebuilding the frozen base.
  if (ctx.activePlanPointer) {
    parts.push(ctx.activePlanPointer)
  }

  // Repair hint: routed through A1 harness-advisory bus — legacy <repair-hint> block removed.

  // Harness advisory: unified corrective guidance (A1 bus, max 3 entries)
  if (ctx.harnessAdvisoryBlock) {
    parts.push(ctx.harnessAdvisoryBlock)
  }

  // Worktree warning: cache-safe — rendered ONLY into dynamic appendix
  if (ctx.worktreeReality && ctx.worktreeReality.severity !== 'green') {
    const reasons = ctx.worktreeReality.mismatchReasons
      .map(r => `  ${escapeXml(r)}`)
      .join('\n')
    parts.push(`<worktree-warning severity="${escapeXml(ctx.worktreeReality.severity)}">\n${reasons}\n</worktree-warning>`)
  }

  // Plan-mode instruction block: governs the whole planning turn (read-only +
  // plan quality standard + diagram skeletons). Cache-safe — appendix only.
  if (ctx.planModeState === 'planning') {
    parts.push(renderPlanModeBlock())
  }

  if (parts.length === 0) return []

  // ── GWT Top-K selection (when budget is set) ────────────────────
  if (maxChars !== undefined && maxChars > 0) {
    const scored = parts.map(content => ({
      content,
      salience: assignSalience(content),
    }))
    const selected = selectTopKBlocks(scored, maxChars)
    return selected.map(content => ({ name: appendixBlockName(content), content }))
  }

  return parts.map(content => ({ name: appendixBlockName(content), content }))
}

/** Backward-compatible wrapper: full <context-update> block (no seq). */
export function buildDynamicAppendix(ctx: VolatileContext, maxChars?: number): string {
  const parts = buildDynamicAppendixParts(ctx, maxChars)
  if (parts.length === 0) return ''
  return `<context-update>\n${parts.map(p => p.content).join('\n\n')}\n</context-update>`
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
 * - 0.7: task-relevant (intent-retrieval-route, task-progress, decisions,
 *        git-status, recent-commits — git 状态是任务地基：被 Top-K 丢弃会诱发
 *        模型用 bash 重新获取，形成训练模式 doom-loop，见会话 43443098 取证)
 * - 0.5: operational context (tool-history)
 * - 0.4: session housekeeping (session-state, cross-session-events)
 * - 0.3: deduplication hints (read-file-dedup-hint)
 */
/**
 * Unified progress block: merges session-state, task-progress, and decisions
 * into a single `<progress>` XML block. Eliminates triple repetition where
 * these three independent blocks each reported overlapping objective/status/decisions.
 */
function renderProgressBlock(ctx: VolatileContext): string | null {
  // When sessionState is available, it's the richest source (objective + plan step
  // + modified files + decisions + failed tests). Extract its content and wrap as <progress>.
  if (ctx.sessionState) {
    // sessionState is pre-rendered as `<session-state>...\n</session-state>`
    // Re-wrap as <progress> to unify the tag namespace
    const inner = ctx.sessionState
      .replace(/^<session-state>\n?/, '')
      .replace(/\n?<\/session-state>$/, '')
    return `<progress>\n${inner}\n</progress>`
  }

  // Fallback: build from individual fields (early turns before sessionStateManager is ready)
  const lines: string[] = []

  if (ctx.taskProgress) {
    if (ctx.taskProgress.current) {
      lines.push(`current: ${escapeXml(ctx.taskProgress.current)}`)
    }
    if (ctx.taskProgress.completed.length > 0) {
      lines.push(`done: ${ctx.taskProgress.completed.map(escapeXml).join(', ')}`)
    }
    if (ctx.taskProgress.remaining.length > 0) {
      lines.push(`next: ${ctx.taskProgress.remaining.map(escapeXml).join(', ')}`)
    }
  }

  if (ctx.decisions && ctx.decisions.length > 0) {
    lines.push('Decisions:')
    for (const d of ctx.decisions) {
      lines.push(`  - ${escapeXml(d)}`)
    }
  }

  if (lines.length === 0) return null
  return `<progress>\n${lines.join('\n')}\n</progress>`
}

export function assignSalience(blockContent: string): number {
  if (blockContent.startsWith('<star-domain')) return 1.0
  // Plan-mode block governs the entire planning turn — never drop under budget.
  if (blockContent.startsWith('<plan-mode>')) return 0.95
  if (blockContent.startsWith('<repair-hint>')) return 0.8
  if (blockContent.startsWith('<星域-advisory>')) return 0.8
  if (blockContent.startsWith('<historical-lessons>')) return 0.8
  // User explicitly @-referenced these files/paths — direct intent signal,
  // must survive budget pressure (was silently defaulting to 0.5).
  if (blockContent.startsWith('<mentions>')) return 0.8
  // Task-relevant strategy/route guidance — same tier as other 0.7 advisories.
  if (blockContent.startsWith('<task-depth')) return 0.7
  if (blockContent.startsWith('<plan-methodology')) return 0.7
  // Skill discovery: helpful but model can re-list on demand via the skill tool.
  if (blockContent.startsWith('<available-skills')) return 0.6
  if (blockContent.startsWith('<tool-context>')) return 0.7
  if (blockContent.startsWith('<plan-cache-advisory>')) return 0.7
  // U6: plan trace is task-relevant baseline/progress. Explicit salience so
  // Top-K never drops it under appendix budget pressure.
  if (blockContent.startsWith('<plan-execution-trace')) return 0.7
  // Active-plan pointer is execution-critical: never drop under budget pressure.
  if (blockContent.startsWith('<active-plan')) return 0.8
  if (blockContent.startsWith('<intent-retrieval-route')) return 0.7
  if (blockContent.startsWith('<progress>') || blockContent.startsWith('<progress ')) return 0.8
  if (blockContent.startsWith('<task-progress')) return 0.7
  if (blockContent.startsWith('<decisions>')) return 0.7
  if (blockContent.startsWith('<worktree-warning')) return 0.7
  if (blockContent.startsWith('<git-status>')) return 0.7
  if (blockContent.startsWith('<recent-commits>')) return 0.7
  if (blockContent.startsWith('<tool-history>')) return 0.5
  if (blockContent.startsWith('<session-state>')) return 0.4 // legacy fallback
  if (blockContent.startsWith('<cross-session')) return 0.4
  if (blockContent.startsWith('<companion-presence>')) return 0.4 // ambient presence, housekeeping tier
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
  const blockCap = Math.max(Math.floor(maxChars * 0.4), 2_000)

  for (const block of sorted) {
    const content = block.content.length > blockCap
      ? block.content.slice(0, blockCap) + '\n[truncated]'
      : block.content
    const overhead = selected.length > 0 ? 2 : 0
    if (used + overhead + content.length > maxChars && selected.length > 0) {
      continue
    }
    selected.push(content)
    used += overhead + content.length
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

  // 天枢本体锚点——常驻 frozen，简短心跳确认在场。
  // 行为层面的唤醒通过 advisory bus 按需注入（见 staleness-refresh advisory）。
  parts.push('<sober>天枢在此。证据先行，全貌定向。</sober>')

  // 自体识别——天枢站在自己的身体里（自体/家），还是世界的项目里（使者）。
  // 不同 locus 产生不同验证策略和谨慎度——不只是叙事差异。
  // session 常量 → 留在 frozen，prefix-cache safe（同 rivetMd 一类）。
  if (ctx.cwdRelation === 'self') {
    parts.push('<locus relation="self">这是你的源码。改动直接影响你自己的运行时行为。每个修改都做三级验证（typecheck → related tests → full suite）。对 prompt/、hooks/、engine.ts 的修改需说明预期的认知影响。</locus>')
  } else if (ctx.cwdRelation === 'world') {
    parts.push('<locus relation="world">你在一个外部项目中工作。遵循项目自身的约定（AGENTS.md + .rivet.md）。验证深度匹配任务复杂度：简单修改跑 related tests，跨模块改动跑 full suite。</locus>')
  }

  if (ctx.activeDomain) {
    parts.push(`<star-domain name="${escapeXml(ctx.activeDomain.name)}" motto="${escapeXml(ctx.activeDomain.motto)}">${escapeXml(ctx.activeDomain.volatileBlock)}</star-domain>`)
  }

  const md = ctx.rivetMd ?? readRivetMd(ctx.cwd)
  if (md) {
    // When codebase-index is present it already contains the module directory table
    // (seeded from AGENTS.md via loadProjectModuleMap). Strip the redundant table
    // from project-instructions to avoid ~600-800 chars of duplication.
    const stripped = ctx.projectIndexBlock ? stripFirstMarkdownTable(md) : md
    parts.push(truncateBlock(`<project-instructions>\n${escapeXml(stripped)}\n</project-instructions>`, 8_000, 'project-instructions'))
  }

  // Project memory — auto-loaded from .rivet/knowledge/memory.jsonl.
  // Rendered into frozen base so it benefits from prefix cache (turn 2+ cost = 0).
  // A3: budget cap at 3K chars — beyond that it's stale noise.
  if (ctx.projectMemoryBlock) {
    parts.push(truncateBlock(ctx.projectMemoryBlock, 3_000, 'project-memory'))
  }

  // Seed capsule — 前辈星域封存的经验方法（天璇胶囊等）。
  // Rendered into frozen base so it benefits from prefix cache (turn 2+ cost = 0).
  // A3: budget cap at 3K chars.
  if (ctx.seedCapsuleBlock) {
    parts.push(truncateBlock(ctx.seedCapsuleBlock, 3_000, 'seed-capsule'))
  }

  // Codebase index — module summaries + CLI entries.
  // Rendered into frozen base after projectMemoryBlock for prefix cache stability.
  // A3: budget cap at 4K chars — oversized index is a trained-mode noise source.
  if (ctx.projectIndexBlock) {
    parts.push(truncateBlock(ctx.projectIndexBlock, 4_000, 'codebase-index'))
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

  // Repair hint: routed through A1 harness-advisory bus

  if (ctx.decisions && ctx.decisions.length > 0) {
    const entries = ctx.decisions.map(d => `  <decision>${escapeXml(d)}</decision>`).join('\n')
    parts.push(`<decisions recent="${ctx.decisions.length}">\n${entries}\n</decisions>`)
  }

  if (ctx.sessionMemoryBlock) {
    parts.push(`<session-memory>\n${escapeXml(ctx.sessionMemoryBlock)}\n</session-memory>`)
  }

  if (ctx.playbookLessons && ctx.playbookLessons.length > 0) {
    const { selected } = scoreLessons(ctx.playbookLessons, {
      query: ctx.recentQuery,
      recentToolTargets: ctx.toolHistory?.map(t => t.target),
    })
    if (selected.length > 0) {
      const lessons = selected
        .map(b => {
          const base = `- ${escapeXml(b.lesson)} (${escapeXml(b.context)})`
          return b.details ? `${base}\n  details: ${escapeXml(b.details)}` : base
        })
        .join('\n')
      parts.push(`<historical-lessons>\n${lessons}\n</historical-lessons>`)
      ctx.onLessonsRendered?.(selected.map(b => b.id))
    }
  }


  // NOTE: plan-mode block is rendered in buildDynamicAppendix (cache-safe),
  // not here — buildStableVolatileBlock forces planModeState undefined for the
  // frozen base, so rendering it here would be dead code.

  return parts.length > 0 ? `<context>\n${parts.join('\n\n')}\n</context>` : ''
}

/**
 * A3 前缀预算：截断超出上限的 frozen 块。
 * - projectIndexBlock: 4K → 超出折叠为 repo 工具指引
 * - seedCapsuleBlock / projectMemoryBlock: 3K → 超出截断但保持 XML 标签闭合
 */
function truncateBlock(block: string, maxChars: number, kind: string): string {
  if (block.length <= maxChars) return block
  if (kind === 'codebase-index') {
    const truncated = block.slice(0, maxChars)
    return `${truncated}\n<!-- codebase index truncated (${block.length} chars → ${maxChars}); use repo_map/repo_graph tools for details -->`
  }
  // XML-wrapped blocks: try single-root match first. Multi-root blocks
  // (seedCapsuleBlock) fall back to plain truncation — they can't be cleanly
  // truncated while preserving well-formedness, but the prefix cache doesn't
  // depend on XML validity, only byte stability.
  const singleRootMatch = block.match(/^<([a-z-]+)[^>]*>([\s\S]*)<\/\1>$/m)
  if (singleRootMatch) {
    const [_full, tag, content] = singleRootMatch
    const trimmed = content!.slice(0, maxChars - tag!.length * 2 - 10)
    return `<${tag}>\n${trimmed}\n<!-- truncated: ${block.length} → ${maxChars} chars -->\n</${tag}>`
  }
  return block.slice(0, maxChars) + `\n<!-- ${kind} truncated: ${block.length} → ${maxChars} chars -->`
}

/**
 * Strip the first markdown table from text (the AGENTS.md directory table).
 * A markdown table is a contiguous block of lines starting with `|`.
 * Preserves surrounding content including headers/prose.
 */
export function stripFirstMarkdownTable(text: string): string {
  const lines = text.split('\n')
  let tableStart = -1
  let tableEnd = -1

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trimStart()
    if (trimmed.startsWith('|')) {
      if (tableStart === -1) tableStart = i
      tableEnd = i
    } else if (tableStart !== -1) {
      break
    }
  }

  if (tableStart === -1) return text

  // Also remove the preceding header line if it looks like "> 顶层目录索引..."
  // and trailing blank line after table
  let removeStart = tableStart
  if (removeStart > 0 && lines[removeStart - 1]!.startsWith('>')) {
    removeStart--
  }
  let removeEnd = tableEnd
  if (removeEnd + 1 < lines.length && lines[removeEnd + 1]!.trim() === '') {
    removeEnd++
  }

  const result = [...lines.slice(0, removeStart), ...lines.slice(removeEnd + 1)]
  return result.join('\n')
}
