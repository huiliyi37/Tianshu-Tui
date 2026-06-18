/**
 * Cognitive Capsule Router (CCR) — Phase 1
 *
 * Reads cognitive-mirror dimensions each turn and routes to the most
 * relevant star-domain principle via the advisory bus.
 *
 * Design: docs/design/2026-06-17-sr-intelligent-reminder.md
 * Supplement: docs/design/2026-06-18-sr-router-supplement.md
 */

import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import type { AdvisoryEntry } from '../advisory-bus.js'

interface AdvisoryBusLike {
  submit(entry: AdvisoryEntry): void
}
import type { EvidenceState } from '../evidence.js'
import type { Sensorium } from '../sensorium.js'
import type { VigorState } from '../vigor.js'

// ─── Principle Pools (Phase 1: hardcoded) ────────────────────────

interface Principle {
  key: string
  actionPrompt: string
}

const YAOGUANG_POOL: Principle[] = [
  { key: 'Y1', actionPrompt: '那行修复能复现原缺陷吗？先 RED→GREEN 再声称已验证' },
  { key: 'Y2', actionPrompt: '不要靠测试绿就判断完成——用原缺陷输入跑一次确认' },
  { key: 'Y5', actionPrompt: '你刚下的结论有没有 ground truth 能自检？' },
  { key: 'Y3', actionPrompt: '这个 bug 和上次的是同一族吗？查 git log 看同类修复' },
  { key: 'Y6', actionPrompt: '逐条核对 spec 的验收条件，不靠"看起来完成了"' },
]

const TIANXUAN_POOL: Principle[] = [
  { key: 'X1', actionPrompt: '去一个不相关的目录 glob，看你是否忽略了其他模块' },
  { key: 'X3', actionPrompt: '用一个不匹配现有方案的输入跑一次测试，看它会不会红' },
  { key: 'X4', actionPrompt: '别在同一个抽象层深挖——上一层或下一层可能有捷径' },
]

const TIANQUAN_POOL: Principle[] = [
  { key: 'Q1', actionPrompt: 'grep 调用方、读代码、理解数据流——再画架构图' },
  { key: 'Q2', actionPrompt: '每完成一个 task：typecheck + test + commit，不积攒' },
  { key: 'Q3', actionPrompt: '这条路走了三次都撞墙？换维度，别同方向硬推' },
]

const TIANFU_POOL: Principle[] = [
  { key: 'F1', actionPrompt: '不确定的假设不要默认通过——写断言让它 fail，再看' },
  { key: 'F2', actionPrompt: '不变更不破坏既有契约，改动前确认调用方' },
]

// ─── Rule Table ──────────────────────────────────────────────────

type StarDomain = '瑶光' | '天璇' | '天权' | '天府'

interface RouteRule {
  id: string
  star: StarDomain
  /** Evaluate condition against current state. Return true to match. */
  match: (s: RouteState) => boolean
  /** Advisory bus priority for the submitted entry. */
  busPriority: number
  pool: Principle[]
  /** Action prompt template (with {variables}). */
  promptTemplate: string
  /** When true, suppress if last tool is test-related (intent awareness). */
  suppressOnTestIntent?: boolean
}

interface RouteState {
  turn: number
  verificationCoverage: number
  filesModified: number
  freshness: number
  vigor: number
  complexity: number
  stability: number
  lastTool: string
  lastToolTarget: string
}

/**
 * Rule evaluation order matters: first match wins.
 * P3 before P1 — dual-deficit (verif + vigor both low → 天权 "switch direction")
 * precedes single-deficit (verif low only → 瑶光 "go verify").
 */
const RULES: RouteRule[] = [
  {
    id: 'P3',
    star: '天权',
    match: s => s.verificationCoverage < 0.3 && s.vigor < 0.3 && s.turn > 3,
    busPriority: 0.65,
    pool: TIANQUAN_POOL.filter(p => p.key === 'Q3'),
    promptTemplate: '【天权】检查点：改了 {files_modified} 个文件未验证，且执行能量在下降。如果同一方向第三次撞墙，换维度。',
    suppressOnTestIntent: true,
  },
  {
    id: 'P1',
    star: '瑶光',
    match: s => s.verificationCoverage < 0.3 && s.turn > 3,
    busPriority: 0.55,
    pool: YAOGUANG_POOL.filter(p => ['Y1', 'Y2', 'Y5'].includes(p.key)),
    promptTemplate: '【瑶光】改了 {files_modified} 个文件但还没验证（距上次验证 {turns_since_verify} 轮）。typecheck + 相关测试，跑通再继续。',
    suppressOnTestIntent: true,
  },
  {
    id: 'P2',
    star: '天璇',
    match: s => s.freshness < 0.25 && s.turn > 4,
    busPriority: 0.60,
    pool: TIANXUAN_POOL,
    promptTemplate: '【天璇】第 {turn} 轮，连续在同一路径上。去一个不相关的目录 glob 一下，或者上/下一层抽象找捷径。',
  },
  {
    id: 'P4',
    star: '天权',
    match: s => s.complexity > 0.7 && s.turn > 3,
    busPriority: 0.55,
    pool: TIANQUAN_POOL.filter(p => ['Q1', 'Q2'].includes(p.key)),
    promptTemplate: '【天权】复杂度高（改了 {files_modified} 文件）。先 grep 调用方和受影响文件，画出变更边界再动手。',
  },
  {
    id: 'P5',
    star: '瑶光',
    match: s => s.filesModified > 5 && s.verificationCoverage < 0.5,
    busPriority: 0.55,
    pool: YAOGUANG_POOL.filter(p => ['Y3', 'Y6'].includes(p.key)),
    promptTemplate: '【瑶光】大面积改动（{files_modified} 文件，验证覆盖 {verification_coverage}）。只交付已验证的部分，未验证的留到下轮。',
    suppressOnTestIntent: true,
  },
  {
    id: 'P6',
    star: '天府',
    match: s => s.stability < 0.2 && s.turn > 3,
    busPriority: 0.50,
    pool: TIANFU_POOL,
    promptTemplate: '【天府】第 {turn} 轮稳定性低。如果同一方向第三次撞墙，换维度而非硬推。改动前确认调用方。',
  },
]

// ─── Cooldown & Escalation Tracking ─────────────────────────────

interface CooldownState {
  lastTriggeredTurn: number
  lastTriggeredValue: number
  lastEscalationOverrideTurn: number
}

const ESCALATION_OVERRIDE_MIN_INTERVAL = 2

// ─── Template Rendering ─────────────────────────────────────────

function fillTemplate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const val = vars[key]
    return val !== undefined ? String(val) : match
  })
}

// ─── Principle Selection (anti-habituation) ─────────────────────

function selectPrinciple(pool: Principle[], lastUsedKeys: Set<string>): Principle {
  const unused = pool.filter(p => !lastUsedKeys.has(p.key))
  const candidates = unused.length > 0 ? unused : pool
  return candidates[Math.floor(Math.random() * candidates.length)]!
}

// ─── Test Intent Detection ──────────────────────────────────────

const TEST_TOOLS = new Set(['run_tests'])
const EDIT_TOOLS = new Set(['edit_file', 'write_file', 'hash_edit'])

function isTestIntent(lastTool: string, lastToolTarget: string): boolean {
  if (TEST_TOOLS.has(lastTool)) return true
  if (lastToolTarget.includes('test')) return true
  if (EDIT_TOOLS.has(lastTool)) return true
  return false
}

// ─── Main Hook ──────────────────────────────────────────────────

export interface CcrHookOptions {
  advisoryBus: AdvisoryBusLike
  wasConvergenceTriggered: () => boolean
  getEvidenceState: () => EvidenceState
}

export function createCcrHook(opts: CcrHookOptions): PreTurnRuntimeHook {
  const cooldowns = new Map<StarDomain, CooldownState>()
  const lastUsedPrinciples = new Map<StarDomain, Set<string>>()
  let lastVerifyTurn = 0

  function getCooldown(star: StarDomain): CooldownState {
    let c = cooldowns.get(star)
    if (!c) {
      c = { lastTriggeredTurn: -Infinity, lastTriggeredValue: 0, lastEscalationOverrideTurn: -Infinity }
      cooldowns.set(star, c)
    }
    return c
  }

  function getLastUsed(star: StarDomain): Set<string> {
    let s = lastUsedPrinciples.get(star)
    if (!s) {
      s = new Set()
      lastUsedPrinciples.set(star, s)
    }
    return s
  }

  function extractRouteState(
    sensorium: Sensorium,
    vigor: VigorState | null,
    evidence: EvidenceState,
    turn: number,
    recentToolHistory: ReadonlyArray<{ tool: string; target: string }>,
  ): RouteState {
    const last = recentToolHistory.length > 0
      ? recentToolHistory[recentToolHistory.length - 1]!
      : { tool: '', target: '' }
    return {
      turn,
      verificationCoverage: sensorium.confidence ?? 1.0,
      filesModified: evidence.filesModified.size,
      freshness: sensorium.freshness ?? 1.0,
      vigor: vigor?.vigor ?? 1.0,
      complexity: sensorium.complexity ?? 0.0,
      stability: sensorium.stability ?? 1.0,
      lastTool: last.tool,
      lastToolTarget: last.target,
    }
  }

  return {
    phase: 'preTurn',
    name: 'cognitive-capsule-router',
    run(ctx) {
      // Gate 1: convergence mutual exclusion
      if (opts.wasConvergenceTriggered()) return

      const { sensorium, vigor, turn, recentToolHistory } = ctx.snapshot
      if (!sensorium) return

      const evidence = opts.getEvidenceState()

      // Track verification transitions
      if (evidence.deliveryStatus === 'verified') {
        lastVerifyTurn = turn
      }

      const state = extractRouteState(sensorium, vigor, evidence, turn, recentToolHistory)

      // Evaluate rules — first match wins
      for (const rule of RULES) {
        if (!rule.match(state)) continue

        // Gate 2: test intent suppression
        if (rule.suppressOnTestIntent && isTestIntent(state.lastTool, state.lastToolTarget)) continue

        // Gate 3: star-domain cooldown
        const cooldownTurns = rule.star === '天权' ? (rule.id === 'P4' ? 6 : 4)
          : rule.star === '天璇' ? 4
          : rule.star === '天府' ? 5
          : 5 // 瑶光
        const cd = getCooldown(rule.star)
        const turnsElapsed = turn - cd.lastTriggeredTurn

        if (turnsElapsed < cooldownTurns) {
          // Check escalation override: value degraded to 50% of last trigger
          const currentDimValue = getDominantDimValue(rule, state)
          const degradedEnough = currentDimValue < cd.lastTriggeredValue * 0.5
          const escalationCooldownOk = (turn - cd.lastEscalationOverrideTurn) >= ESCALATION_OVERRIDE_MIN_INTERVAL

          if (!degradedEnough || !escalationCooldownOk) continue
          cd.lastEscalationOverrideTurn = turn
        }

        // Match! Build and submit advisory.
        const principle = selectPrinciple(rule.pool, getLastUsed(rule.star))
        const lastUsed = getLastUsed(rule.star)
        lastUsed.add(principle.key)
        if (lastUsed.size >= rule.pool.length) lastUsed.clear()

        const turnsSinceVerify = turn - lastVerifyTurn
        const content = fillTemplate(rule.promptTemplate, {
          files_modified: state.filesModified,
          turn: state.turn,
          turns_since_verify: turnsSinceVerify,
          last_tool: state.lastTool || '(none)',
          verification_coverage: (state.verificationCoverage * 100).toFixed(0) + '%',
        })

        const entry: AdvisoryEntry = {
          key: `ccr-${rule.star}-${rule.id}`,
          priority: rule.busPriority,
          category: 'discipline',
          content,
          ttl: 1,
        }

        opts.advisoryBus.submit(entry)

        // Update cooldown
        cd.lastTriggeredTurn = turn
        cd.lastTriggeredValue = getDominantDimValue(rule, state)

        return // first match wins — one reminder per turn
      }
    },
  }
}

/** Get the primary dimension value for cooldown escalation tracking. */
function getDominantDimValue(rule: RouteRule, state: RouteState): number {
  switch (rule.id) {
    case 'P1': case 'P3': case 'P5': return state.verificationCoverage
    case 'P2': return state.freshness
    case 'P4': return state.complexity
    case 'P6': return state.stability
    default: return 0
  }
}

// ─── Exports for testing ─────────────────────────────────────────

export { RULES as _RULES_FOR_TESTING }
export { fillTemplate as _fillTemplate }
export { isTestIntent as _isTestIntent }
