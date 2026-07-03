import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { gitStatusCache } from './volatile-git.js'
import { getTargetPlatform, getShellCommand, type ShellCommand } from '../platform.js'
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
  full: '<plan-methodology route="full">推荐使用基础计划模板（Superpowers writing-plans），路径: docs/superpowers/plans/2026-06-28-plan-methodology-base.md。这是所有计划的默认基础：零上下文假设、任务粒度 2-5 分钟、禁止占位符、TDD、探针先行、瑶光反证、频繁提交。强制要求：① 至少一张 Mermaid 图（架构/数据流/状态图）；② 每个任务 RED→GREEN；③ 复杂实现前先打 30 秒探针；④ 用真实输入复现原问题再验修复，不取信声称取 exit code。如果任务涉及安全/权限/沙箱/多 enforcement gate，在基础模板之上追加安全附录（安全不变量、触发路径清单、双门对齐数据流图）。开工前先用 todo 列出有序步骤（即为执行计划基线）。</plan-methodology>',
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
export function renderPlanModeBlock(activePlanFilePath?: string | null): string {
  const planFileLine = activePlanFilePath
    ? `\n活动计划文件: \`${activePlanFilePath}\` — 用 write_file / edit_file 增量写入计划正文（仅此文件可写）。`
    : ''

  return `<plan-mode>
你处于规划模式。只能读文件和探索代码库——禁止写、改、执行任何会修改状态的命令（活动计划文件除外）。${planFileLine}

工作流：
1. **识别关键问题** — 先列出 2-3 个对计划至关重要的问题。不确定代码结构时，用 \`delegate_task\`（profile=code_scout）并行调研；独立问题并行派多个 worker。
2. **外部调研** — 涉及外部库/协议/最佳实践时，用 \`web_search\` / \`web_fetch\` 核实，不凭训练记忆下结论。
3. **设计收敛** — 最多 2-3 个真正不同的方案；一个明显更优就只提一个。偏好/约束不明时用 \`ask_user_question\` 澄清。
4. **回读验证** — 写计划前重读关键文件核实理解。
5. **写入计划** — 将完整设计写入活动计划文件（write_file / edit_file），或成熟后用 \`plan action=submit\` 提交（可省略 plan 字段，从活动计划文件读取）。

收尾契约 — 每个 turn 必须以以下之一结束，禁止以纯文本收尾：
- \`ask_user_question\` — 澄清需求/偏好/约束
- \`plan action=submit\` — 计划已成熟，请求用户批准

计划质量标准——你的计划应该是一份完整的设计文档，禁止占位符：
- 至少包含一张 Mermaid 图（架构图或数据流图）。图形承载语义——(圆角)=用户/输入，[[子程序]]=agent/处理器，{{六边形}}=LLM/模型，[(圆柱)]=存储/DB，{菱形}=判断；边 --> 同步/读，==> 写/强，-.-> 异步/事件。复制下方骨架并替换节点文字：
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
- 包含根因分析，而非只描述表面症状
- 用完整路径引用文件，如 \`src/agent/loop.ts:643\`
- 每个文件给出提议代码（diff 或伪代码），不能只有文件路径或 "TODO"
- 存在设计决策时，用表格对比备选方案；多方案时在 submit 的 \`options\` 参数中列出供用户选择
- 包含验证计划：测试用例和人工验证步骤
- 自检：如果 plan 字段里出现 "TODO"、"FIXME"、"待补充"、"placeholder"、"TBD"、"[x]" 空白条目或仅标题无正文的章节，说明计划尚未打磨完成，继续探索并补充内容后再提交。

提交 \`plan\` 后，等待用户批准或驳回。未经批准不要继续推进。

用户会回复：
- /plan-approve <slug> [方案名] — 批准（可选指定方案），开始执行
- /plan-reject <slug> <反馈> — 驳回并给出修订意见，plan mode 保持激活
</plan-mode>`
}

/**
 * Phase 2B: output verbosity steering nudge.
 *
 * OPT-IN via RIVET_TERSE=1 (or ctx.tersenessEnabled) — OFF by default, so the
 * default session is byte-for-byte unchanged. Cache-safe: this is only ever
 * pushed into the DYNAMIC appendix, never the frozen base.
 *
 * Scope discipline: the nudge governs OUTPUT PROSE ONLY. It must never be read
 * as license to skip verification, tests, evidence, or the delivery-report
 * rigor mandated by AGENTS.md — that conflict is the classic terseness failure
 * mode, so it is called out explicitly in the prompt text.
 */
export function renderTersenessNudge(escalate = false): string {
  const strict = escalate
    ? ' 你似乎在重复工作或打转——本轮尤其简洁：一段短文，不复述上下文。'
    : ''
  return `<output-style>文字要精炼。跳过开场白、自我陈述和收尾总结。不要复述已展示的代码、文件内容或上下文——引用即可。直接给答案或动作。${strict} 本指令只约束输出文字——绝不因此削减验证、测试、取证或交付报告的严谨度。</output-style>`
}

export interface ToolHistoryEntry {
  tool: string
  target: string
  status: 'success' | 'failed' | 'running'
  /** Tool name + sorted-args hash for dedup (fingerprint granularity).
   *  edit_file(a.ts, "x", "y") and edit_file(a.ts, "y", "z") get different hashes. */
  argsHash?: string
  error?: string
  /** Failure classification — dead-end pheromone deposition uses this to exclude
   *  timeout/environment (non-semantic) failures from the dead-end signal. */
  errorClass?: import('../tools/types.js').ToolErrorClass
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
  /** Explicitly invoked .rivet/skills (full body) — cache-safe dynamic appendix. */
  invokedSkillsBlock?: string | null
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
  /** Active plan file path (relative) for incremental plan writing */
  activePlanFilePath?: string | null
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
  /** Phase 2B output verbosity steering — opt-in, OFF by default. When unset,
   *  falls back to the RIVET_TERSE=1 env flag. Cache-safe: rendered ONLY into the
   *  dynamic appendix, so a default session's frozen base stays byte-for-byte
   *  unchanged (engine-cache-stability tests pass without modification). */
  tersenessEnabled?: boolean
  /** When true, render a stricter terseness nudge (e.g. doom-loop / storm turns). */
  tersenessEscalate?: boolean
  /**
   * Cognitive projection (task-contract + verification gap + cognitive mirror +
   * uncertainty framing). Cache-safe: rendered ONLY into the dynamic appendix.
   * When appendixDelta is enabled, the projection participates in delta diff —
   * emitted only when changed, not every user-message boundary.
   */
  cognitiveProjection?: string | null
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

/**
 * Build stable volatile block — excludes per-turn dynamic sections for exact-prefix cache stability.
 *
 * This strip list is the SINGLE SOURCE OF TRUTH for what stays in the frozen
 * prefix vs. what is dynamic. buildVolatileBlockInternal must only render the
 * KEEP set (fields NOT stripped below); anything stripped here is rendered in
 * buildDynamicAppendixParts (and, for habituated constants, the <consolidated>
 * block). Re-adding a stripped field's rendering to buildVolatileBlockInternal
 * would be dead code (it is always undefined by the time the internal runs).
 */
export function buildStableVolatileBlock(ctx: VolatileContext): string {
  return buildVolatileBlockInternal({
    ...ctx,
    // activeDomain is a SESSION CONSTANT (bound once via bindSessionDomain),
    // so it is KEPT in FROZEN — folded into the stable prefix below. Mid-session
    // switches (rare: /domain, model switch) go through rebuildFrozenBase +
    // deferred volatileBlock swap at the next user boundary (engine.ts).
    // Per-turn dynamic fields — strip from FROZEN
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

  // ── Protected blocks: must render whole even under appendix budget pressure ──
  // Explicitly-invoked skill bodies are high-salience by user intent: they should
  // only disappear when the model marks them complete, not because another
  // appendix block consumed the budget.
  const protectedParts: string[] = []
  if (ctx.invokedSkillsBlock) {
    protectedParts.push(ctx.invokedSkillsBlock)
  }

  // Budget for ordinary appendix blocks is what's left after protected blocks.
  const protectedLen = protectedParts.reduce((sum, p) => sum + p.length, 0)
  const regularMaxChars = maxChars !== undefined && maxChars > 0
    ? Math.max(0, maxChars - protectedLen)
    : maxChars

  // ── P1b: cache-friendly ordering — stable sections first, volatile last ──
  // DeepSeek exact-prefix cache matches byte-for-byte from the start.
  // Sections that rarely change go first so their bytes stay in cache;
  // sections that change every turn go last so only the tail is new.

  // star-domain: NOT rendered in the appendix. As a session constant it is
  // folded into the frozen prefix (buildVolatileBlockInternal, after <locus>) —
  // provider-agnostic, in the exact-prefix cache from turn 1. Emitting it here
  // would duplicate the motto and break prefix stability.

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

  // Cognitive projection: task-contract + verification gap + cognitive mirror +
  // uncertainty framing. Rarely changes within a task (only on status transitions
  // or evidence updates). Under appendixDelta, emitted only when changed.
  if (ctx.cognitiveProjection) {
    parts.push(ctx.cognitiveProjection)
  }

  // Unified progress block: merges session-state, task-progress, and decisions
  // into a single <progress> to eliminate triple repetition in the prompt.
  // C3 fix: only dedup the objective when the projection ACTUALLY carries it.
  // The projection is non-empty in many cases without an objective (verification
  // gap / cognitive mirror / one-shot hints, or a non-actionable contract which
  // renders ''). Gating on mere non-emptiness silently dropped the objective from
  // both progress AND projection. Gate on the real <objective> marker instead.
  const projHasObjective = !!ctx.cognitiveProjection && ctx.cognitiveProjection.includes('<objective>')
  const progressBlock = renderProgressBlock(ctx, projHasObjective)
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
    // Only emit when there are enough files to dedup or the history is long
    // enough that re-reading becomes a real token-waste risk (C2: condition gate).
    if (readFiles.length > 5 || ctx.toolHistory.length > 8) {
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

  // invokedSkillsBlock is rendered once via protectedParts (above) — do not
  // push it again here or the activated skill body gets injected twice.

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

  // Companion presence is NOT rendered into the model context — it is ambient
  // cross-session metadata intended for the desktop sidecar UI, not the agent.
  // Injecting it into the prompt creates a false multi-agent coordination
  // signal and wastes context-window tokens with no task value. The heartbeat
  // hook still writes .rivet/presence.json for UI consumption.
  // (ctx.companionPresence rendering removed 2026-06-23)

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
    parts.push(renderPlanModeBlock(ctx.activePlanFilePath))
  }

  // Phase 2B: output verbosity steering (opt-in via RIVET_TERSE=1, off by default).
  // Cache-safe: dynamic appendix only — default sessions are byte-for-byte
  // unchanged. Escalates on doom-loop/storm turns when the caller signals it.
  const tersenessEnabled = ctx.tersenessEnabled ?? (process.env['RIVET_TERSE'] === '1')
  if (tersenessEnabled) {
    parts.push(renderTersenessNudge(ctx.tersenessEscalate ?? false))
  }

  const protectedResult = protectedParts.map(content => ({ name: appendixBlockName(content), content }))

  if (parts.length === 0) return protectedResult

  // ── GWT Top-K selection (when budget is set) ────────────────────
  if (regularMaxChars !== undefined && regularMaxChars > 0) {
    const scored = parts.map(content => ({
      content,
      salience: assignSalience(content),
    }))
    const selected = selectTopKBlocks(scored, regularMaxChars)
    return [...protectedResult, ...selected.map(content => ({ name: appendixBlockName(content), content }))]
  }

  return [...protectedResult, ...parts.map(content => ({ name: appendixBlockName(content), content }))]
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
function renderProgressBlock(ctx: VolatileContext, hasProjection?: boolean): string | null {
  // When sessionState is available, it's the richest source (objective + plan step
  // + modified files + decisions + failed tests). Extract its content and wrap as <progress>.
  if (ctx.sessionState) {
    // sessionState is pre-rendered as `<session-state>...\n</session-state>`
    // Re-wrap as <progress> to unify the tag namespace
    let inner = ctx.sessionState
      .replace(/^<session-state>\n?/, '')
      .replace(/\n?<\/session-state>$/, '')
    // C1+C3: when cognitive projection carries the objective, strip it from progress
    // to avoid duplicated objective lines (saves ~60-80 chars per boundary).
    if (hasProjection) {
      inner = inner.replace(/^Objective:.*\n?/m, '')
    }
    const trimmed = inner.trim()
    if (!trimmed) return null
    return `<progress>\n${trimmed}\n</progress>`
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
  // Dead path: star-domain is now folded into the frozen prefix, never the
  // appendix, so this case is not exercised by buildDynamicAppendixParts.
  // Kept for the assignSalience test contract and any future appendix-level
  // domain rendering — identity-critical, highest salience.
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
  if (blockContent.startsWith('<read-file-dedup-hint>')) return 0.3
  // Output-style nudge (Phase 2B): tiny + governs the whole reply's prose —
  // keep it above the drop line so budget pressure never silently removes it.
  if (blockContent.startsWith('<output-style>')) return 0.75
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

/**
 * Shell-syntax guidance keyed on the ACTUALLY-RESOLVED shell family, not on
 * `process.platform`. The previous code unconditionally told the model "shell is
 * PowerShell/cmd" on Windows — wrong when Git Bash is the active shell (our
 * preferred shell when present), which inverted the guidance and induced wrong
 * syntax. Mirrors Claude Code's approach: detect the real shell, tell the model
 * to use THAT shell's syntax. No translation layer.
 *
 * Returns the full `<shell-note>` element, or '' for plain POSIX `sh` (Unix host)
 * where no extra guidance is needed. Pure + exported for unit testing.
 *
 * `getShellCommand()` is resolved once and process-cached, so the chosen kind is
 * session-static → injecting this in the frozen block stays prefix-cache safe.
 */
export function windowsShellNote(kind: ShellCommand['kind']): string {
  switch (kind) {
    case 'bash':
      // Git Bash on a Windows host: POSIX commands work, but the host is Windows.
      return '<shell-note>shell 是 Git Bash（POSIX）：`ls`/`cat`/`grep`/`&&`/管道/`2>/dev/null` 均可用。运行在 Windows 宿主——路径用正斜杠或加引号（别用反斜杠，会被转义）；Python 可能是 `python` 或 `py`。非零退出码≠必然失败（很多工具用它表达正常结果）。</shell-note>'
    case 'powershell':
      return '<shell-note>shell 是 PowerShell。语法速查：环境变量 `$env:NAME`（不是 `$NAME`）；丢弃错误输出 `2>$null`（不是 `2>nul`/`2>/dev/null`）；PS 5.1 不支持 `&&` 串联——用 `;` 分隔，或上一条后判 `$LASTEXITCODE`；命令替换 `$(...)`；删除 `Remove-Item -Recurse -Force`；存在判断 `Test-Path`；列目录/读文件优先 cmdlet（`Get-ChildItem`/`Get-Content -Tail 20`），`ls`/`cat`/`rm`/`pwd` 是别名可用但参数走 cmdlet 风格；Python 用 `py`。非零退出码≠必然失败。命令报「is not recognized as ... cmdlet」= 此环境没有这个命令，应换用可用工具，不要重试同一条——这不是你的错，也不影响判断。</shell-note>'
    case 'cmd':
      return '<shell-note>shell 是 cmd.exe：列目录 `dir`、看文件 `type`、环境变量 `%VAR%`；`ls`/`cat` 不存在（用 `dir`/`type`）；现代 cmd 支持 `&&` 串联；丢弃输出 `2>nul`；Python 用 `py`。非零退出码≠必然失败。命令报「is not recognized」= 此环境没有这个命令，换用可用工具，不要重试同一条。</shell-note>'
    case 'sh':
    default:
      return ''
  }
}

function buildVolatileBlockInternal(ctx: VolatileContext): string {
  const parts: string[] = []

  // Target platform drives file-artifact conventions (path style, etc.). When it
  // differs from the real host, surface BOTH — and advise cross-platform commands,
  // since the shell still runs on the host. Session-static → prefix-cache safe.
  const targetPlatform = getTargetPlatform()
  const hostAttr = targetPlatform !== process.platform ? ` host="${process.platform}"` : ''
  parts.push(`<environment platform="${targetPlatform}"${hostAttr} cwd="${escapeXml(ctx.cwd)}" os="${escapeXml(`${os.type()} ${os.release()}`)}" />`)
  if (targetPlatform !== process.platform) {
    parts.push(`<platform-note>文件约定（换行/路径风格）按 ${targetPlatform} 生成；但 shell 命令在宿主 ${process.platform} 上执行——优先使用跨平台命令，避免目标平台专属语法在宿主机执行失败。</platform-note>`)
  }
  // Shell 原生指引：跟随真实解析出的 shell 族（Git Bash / PowerShell / cmd），
  // 而非一律按 PowerShell。装了 Git Bash 时实际跑 bash，给 PowerShell 指引会诱导
  // 模型发错语法。getShellCommand() 进程内缓存、会话内固定 → session-static，
  // 留在 frozen 前缀缓存安全。Unix(sh) 返回空，不注入。
  const shellNote = windowsShellNote(getShellCommand().kind)
  if (shellNote) {
    parts.push(shellNote)
  }

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

  // star-domain: session-constant identity, folded into the frozen prefix (next
  // to sober/locus) so it enters the exact-prefix cache from turn 1 — provider-
  // agnostic, no habituation warm-up. name/motto are registry constants (not user
  // input), rendered unescaped to match the established <star-domain name="..."> shape.
  if (ctx.activeDomain) {
    const d = ctx.activeDomain
    parts.push(`<star-domain name="${d.name}" motto="${d.motto}">${d.volatileBlock}</star-domain>`)
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

  if (ctx.workingSet && ctx.workingSet.length > 0) {
    const files = ctx.workingSet.map(file => `<file>${escapeXml(file)}</file>`).join('\n')
    parts.push(`<working-set>\n${files}\n</working-set>`)
  }

  if (ctx.sessionMemoryBlock) {
    parts.push(`<session-memory>\n${escapeXml(ctx.sessionMemoryBlock)}\n</session-memory>`)
  }

  // NOTE: activeDomain IS rendered here (above, after <locus>) — it is a session
  // constant KEPT in FROZEN. The remaining per-turn dynamic fields (gitStatus,
  // toolHistory, taskProgress, decisions, playbookLessons, planModeState,
  // worktreeReality, …) are NOT rendered here. buildStableVolatileBlock — the
  // sole caller — forces them undefined to keep the FROZEN prefix byte-stable;
  // they are rendered in buildDynamicAppendixParts (appendix) and, for habituated
  // session-constants like playbookLessons, in the <consolidated> block (see
  // engine.ts habituation). The single source of truth for what stays frozen vs.
  // dynamic is the strip list in buildStableVolatileBlock.

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
