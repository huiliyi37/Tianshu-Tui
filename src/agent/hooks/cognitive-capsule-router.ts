/**
 * Cognitive Capsule Router (CCR) — Phase 2
 *
 * Reads cognitive-mirror dimensions each turn and routes to the most
 * relevant star-domain principle via the advisory bus.
 *
 * Phase 2 additions:
 * - Dynamic principle pool extraction from <principle> tags in capsule docs
 * - Vigor tonic/phasic split for P3 principle selection
 * - Telemetry callback for trigger event recording
 *
 * Design: docs/design/2026-06-17-sr-intelligent-reminder.md
 * Supplement: docs/design/2026-06-18-sr-router-supplement.md
 */

import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import type { AdvisoryEntry } from '../advisory-bus.js'
import type { EvidenceState } from '../evidence.js'
import type { Sensorium } from '../sensorium.js'
import type { VigorState } from '../vigor.js'
import { extractPrinciples, type ExtractedPrinciple } from '../seed-capsule-store.js'

interface AdvisoryBusLike {
  submit(entry: AdvisoryEntry): void
}

// ─── Principle Pools ─────────────────────────────────────────────

export interface Principle {
  key: string
  actionPrompt: string
}

// Hardcoded fallback pools — used when capsule docs have no <principle> tags

const YAOGUANG_FALLBACK: Principle[] = [
  { key: 'Y1', actionPrompt: '那行修复能复现原缺陷吗？先 RED→GREEN 再声称已验证' },
  { key: 'Y2', actionPrompt: '不要靠测试绿就判断完成——用原缺陷输入跑一次确认' },
  { key: 'Y5', actionPrompt: '你刚下的结论有没有 ground truth 能自检？' },
  { key: 'Y3', actionPrompt: '这个 bug 和上次的是同一族吗？查 git log 看同类修复' },
  { key: 'Y6', actionPrompt: '逐条核对 spec 的验收条件，不靠"看起来完成了"' },
]

const TIANXUAN_FALLBACK: Principle[] = [
  { key: 'X1', actionPrompt: '去一个不相关的目录 glob，看你是否忽略了其他模块' },
  { key: 'X3', actionPrompt: '用一个不匹配现有方案的输入跑一次测试，看它会不会红' },
  { key: 'X4', actionPrompt: '别在同一个抽象层深挖——上一层或下一层可能有捷径' },
]

const TIANQUAN_FALLBACK: Principle[] = [
  { key: 'Q1', actionPrompt: 'grep 调用方、读代码、理解数据流——再画架构图' },
  { key: 'Q2', actionPrompt: '每完成一个 task：typecheck + test + commit，不积攒' },
  { key: 'Q3', actionPrompt: '这条路走了三次都撞墙？换维度，别同方向硬推' },
]

const TIANFU_FALLBACK: Principle[] = [
  { key: 'F1', actionPrompt: '不确定的假设不要默认通过——写断言让它 fail，再看' },
  { key: 'F2', actionPrompt: '不变更不破坏既有契约，改动前确认调用方' },
]

const STAR_FALLBACK_POOLS: Record<StarDomain, Principle[]> = {
  '瑶光': YAOGUANG_FALLBACK,
  '天璇': TIANXUAN_FALLBACK,
  '天权': TIANQUAN_FALLBACK,
  '天府': TIANFU_FALLBACK,
}

function toPrinciples(extracted: ExtractedPrinciple[]): Principle[] {
  return extracted.map(e => ({ key: e.key, actionPrompt: e.actionPrompt }))
}

// ─── Rule Table ──────────────────────────────────────────────────

type StarDomain = '瑶光' | '天璇' | '天权' | '天府'

interface RouteRule {
  id: string
  star: StarDomain
  match: (s: RouteState) => boolean
  busPriority: number
  /** Key filter — when set, only use principles whose key is in this set. */
  poolKeyFilter?: Set<string>
  promptTemplate: string
  suppressOnTestIntent?: boolean
}

interface RouteState {
  turn: number
  verificationCoverage: number
  filesModified: number
  vigor: number
  vigorTonic: number
  vigorPhasic: number
  lastTool: string
  lastToolTarget: string
}

/**
 * Rule evaluation order matters: first match wins.
 * P3 before P1 — dual-deficit (verif + vigor both low → 天权 "switch direction")
 * precedes single-deficit (verif low only → 瑶光 "go verify").
 *
 * Removed (2026-06-18): P2 (freshness→天璇, causal chain too weak),
 * P4 (complexity→天权, no causal link), P6 (stability→天府, overlaps kick-hook).
 */
const RULES: RouteRule[] = [
  {
    id: 'P3',
    star: '天权',
    match: s => s.verificationCoverage < 0.3 && s.vigor < 0.3 && s.turn > 3,
    busPriority: 0.65,
    poolKeyFilter: new Set(['Q3', 'X3']),
    promptTemplate: '【天权】检查点：改了 {files_modified} 个文件未验证，且执行能量在下降。如果同一方向第三次撞墙，换维度。',
    suppressOnTestIntent: true,
  },
  {
    id: 'P1',
    star: '瑶光',
    match: s => s.verificationCoverage < 0.3 && s.turn > 3,
    busPriority: 0.55,
    poolKeyFilter: new Set(['Y1', 'Y2', 'Y5']),
    promptTemplate: '【瑶光】改了 {files_modified} 个文件但还没验证（距上次验证 {turns_since_verify} 轮）。typecheck + 相关测试，跑通再继续。',
    suppressOnTestIntent: true,
  },
  {
    id: 'P5',
    star: '瑶光',
    match: s => s.filesModified > 5 && s.verificationCoverage < 0.5,
    busPriority: 0.55,
    poolKeyFilter: new Set(['Y3', 'Y6']),
    promptTemplate: '【瑶光】大面积改动（{files_modified} 文件，验证覆盖 {verification_coverage}）。只交付已验证的部分，未验证的留到下轮。',
    suppressOnTestIntent: true,
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

// ─── Principle Selection ─────────────────────────────────────────

function selectPrinciple(pool: Principle[], lastUsedKeys: Set<string>): Principle {
  const unused = pool.filter(p => !lastUsedKeys.has(p.key))
  const candidates = unused.length > 0 ? unused : pool
  return candidates[Math.floor(Math.random() * candidates.length)]!
}

/**
 * P3 vigor tonic/phasic split: choose principle based on sub-field values.
 * - tonic < 0.3 (chronic low energy) → Q3 "switch direction" (天权)
 * - phasic < -0.3 (just failed unexpectedly) → X3 "adversarial scout" (天璇)
 * Cross-star principle selection — P3 is semantically a "dual deficit" rule
 * that can route to either 天权 or 天璇 principles depending on vigor profile.
 */
const P3_PHASIC_OVERRIDE: Principle = { key: 'X3', actionPrompt: '用一个不匹配现有方案的输入跑一次测试，看它会不会红' }

function selectP3Principle(pool: Principle[], state: RouteState, lastUsedKeys: Set<string>, getPoolFn?: (star: StarDomain) => { pool: Principle[] }): Principle {
  if (state.vigorTonic < 0.3) {
    const q3 = pool.find(p => p.key === 'Q3')
    if (q3) return q3
  }
  if (state.vigorPhasic < -0.3) {
    // Cross-star: try dynamic 天璇 pool first, then fallback constant
    if (getPoolFn) {
      const tianxuanPool = getPoolFn('天璇').pool
      const x3 = tianxuanPool.find(p => p.key === 'X3')
      if (x3) return x3
    }
    return P3_PHASIC_OVERRIDE
  }
  return selectPrinciple(pool, lastUsedKeys)
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

// ─── Telemetry ──────────────────────────────────────────────────

export interface CcrTriggerEvent {
  rule: string
  star: StarDomain
  turn: number
  principleKey: string
  dimValues: Record<string, number>
  dynamicPool: boolean
}

// ─── Main Hook ──────────────────────────────────────────────────

export interface CcrHookOptions {
  advisoryBus: AdvisoryBusLike
  wasConvergenceTriggered: () => boolean
  getEvidenceState: () => EvidenceState
  /** cwd for loading capsule docs. When absent, dynamic pools are disabled. */
  cwd?: string
  /** Telemetry callback — called on each trigger for offline analysis. */
  onTrigger?: (event: CcrTriggerEvent) => void
}

export function createCcrHook(opts: CcrHookOptions): PreTurnRuntimeHook {
  const cooldowns = new Map<StarDomain, CooldownState>()
  const lastUsedPrinciples = new Map<StarDomain, Set<string>>()
  let lastVerifyTurn = 0

  // Dynamic principle pool cache (loaded once per star on first trigger)
  const dynamicPools = new Map<StarDomain, Principle[] | null>()

  function getPool(star: StarDomain, keyFilter?: Set<string>): { pool: Principle[]; dynamic: boolean } {
    if (opts.cwd) {
      if (!dynamicPools.has(star)) {
        const extracted = extractPrinciples(opts.cwd, star)
        dynamicPools.set(star, extracted ? toPrinciples(extracted) : null)
      }
      const dynamic = dynamicPools.get(star)
      if (dynamic && dynamic.length > 0) {
        const filtered = keyFilter ? dynamic.filter(p => keyFilter.has(p.key)) : dynamic
        if (filtered.length > 0) return { pool: filtered, dynamic: true }
        return { pool: dynamic, dynamic: true }
      }
    }
    // Fallback to hardcoded
    const fallback = STAR_FALLBACK_POOLS[star]
    const filtered = keyFilter ? fallback.filter(p => keyFilter.has(p.key)) : fallback
    return { pool: filtered.length > 0 ? filtered : fallback, dynamic: false }
  }

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
      vigor: vigor?.vigor ?? 1.0,
      vigorTonic: vigor?.tonic ?? 1.0,
      vigorPhasic: vigor?.phasic ?? 0.0,
      lastTool: last.tool,
      lastToolTarget: last.target,
    }
  }

  return {
    phase: 'preTurn',
    name: 'cognitive-capsule-router',
    run(ctx) {
      if (opts.wasConvergenceTriggered()) return

      const { sensorium, vigor, turn, recentToolHistory } = ctx.snapshot
      if (!sensorium) return

      const evidence = opts.getEvidenceState()

      if (evidence.deliveryStatus === 'verified') {
        lastVerifyTurn = turn
      }

      const state = extractRouteState(sensorium, vigor, evidence, turn, recentToolHistory)

      for (const rule of RULES) {
        if (!rule.match(state)) continue
        if (rule.suppressOnTestIntent && isTestIntent(state.lastTool, state.lastToolTarget)) continue

        const cooldownTurns = rule.star === '天权' ? 4 : 5
        const cd = getCooldown(rule.star)
        const turnsElapsed = turn - cd.lastTriggeredTurn

        if (turnsElapsed < cooldownTurns) {
          const currentDimValue = getDominantDimValue(rule, state)
          const degradedEnough = currentDimValue < cd.lastTriggeredValue * 0.5
          const escalationCooldownOk = (turn - cd.lastEscalationOverrideTurn) >= ESCALATION_OVERRIDE_MIN_INTERVAL
          if (!degradedEnough || !escalationCooldownOk) continue
          cd.lastEscalationOverrideTurn = turn
        }

        // Resolve principle pool (dynamic from capsule docs → fallback to hardcoded)
        const { pool, dynamic: dynamicPool } = getPool(rule.star, rule.poolKeyFilter)

        // P3 uses tonic/phasic split for principle selection (may cross-star to 天璇)
        const lastUsed = getLastUsed(rule.star)
        const principle = rule.id === 'P3'
          ? selectP3Principle(pool, state, lastUsed, (s) => getPool(s))
          : selectPrinciple(pool, lastUsed)

        lastUsed.add(principle.key)
        if (lastUsed.size >= pool.length) lastUsed.clear()

        const turnsSinceVerify = turn - lastVerifyTurn
        const content = fillTemplate(rule.promptTemplate, {
          files_modified: state.filesModified,
          turn: state.turn,
          turns_since_verify: turnsSinceVerify,
          last_tool: state.lastTool || '(none)',
          verification_coverage: (state.verificationCoverage * 100).toFixed(0) + '%',
        })

        opts.advisoryBus.submit({
          key: `ccr-${rule.star}-${rule.id}`,
          priority: rule.busPriority,
          category: 'discipline',
          content,
          ttl: 1,
        })

        // Telemetry
        opts.onTrigger?.({
          rule: rule.id,
          star: rule.star,
          turn,
          principleKey: principle.key,
          dimValues: {
            verificationCoverage: state.verificationCoverage,
            vigor: state.vigor,
            vigorTonic: state.vigorTonic,
            vigorPhasic: state.vigorPhasic,
          },
          dynamicPool,
        })

        cd.lastTriggeredTurn = turn
        cd.lastTriggeredValue = getDominantDimValue(rule, state)

        return
      }
    },
  }
}

function getDominantDimValue(rule: RouteRule, state: RouteState): number {
  // P1, P3, P5 all use verificationCoverage as the primary signal
  return state.verificationCoverage
}

// ─── Exports for testing ─────────────────────────────────────────

export { RULES as _RULES_FOR_TESTING }
export { fillTemplate as _fillTemplate }
export { isTestIntent as _isTestIntent }
export type { StarDomain as _StarDomain }
export { STAR_FALLBACK_POOLS as _STAR_FALLBACK_POOLS }
