import type { AnchorGraph } from './anchor-graph.js'

/**
 * HEARTH — 永明灯系统 · Anchor Invariants
 *
 * 5 条关系不变量，保护锚位拓扑不被意外破坏。
 * 纯函数，无副作用。返回违规列表，空列表 = 全部通过。
 */

export type InvariantId = 'INV-1' | 'INV-2' | 'INV-3' | 'INV-4' | 'INV-5'

export interface AnchorViolation {
  /** Which invariant was violated */
  invariant: InvariantId
  /** Human-readable description of the violation */
  message: string
  /** warning = non-fatal diagnostic; critical = fundamental anchor broken */
  severity: 'warning' | 'critical'
}

/**
 * Context for invariant checking that spans across turns or sessions.
 * All fields are optional — missing context means "first check" or "no history."
 */
export interface InvariantContext {
  /**
   * Graph hash from the previous check within this session.
   * `null` means this is the first check of the session — INV-5 is skipped.
   */
  prevGraphHash?: string | null

  /**
   * cycle_open hash from the previous session.
   * `null` means this is the first session — INV-4 is skipped.
   */
  prevCycleOpen?: string | null

  /**
   * cycle_close hash from the immediate previous session.
   * Used by INV-2 at startup time to verify cycle relay.
   * `null` means no previous session data — INV-2 is skipped.
   */
  prevSessionCycleClose?: string | null
}

// ─── Public API ───

/**
 * Check all 5 HEARTH invariants against the given anchor graph.
 *
 * INV-2 (cycle relay) is only checked when prevSessionCycleClose is provided,
 * which should happen once at session startup. In per-turn checks, omit it.
 *
 * Returns an empty array if all invariants hold.
 */
export function checkInvariants(
  graph: AnchorGraph,
  ctx: InvariantContext,
): AnchorViolation[] {
  const violations: AnchorViolation[] = []

  // ── INV-1: pole_structure XOR pole_void ≡ FULL_MASK ──
  // 乾坤对偶 — 结构（是）与虚空（不是）必须互补
  {
    const structure = graph.nodes.find(n => n.id === 'pole_structure')!
    const voidNode = graph.nodes.find(n => n.id === 'pole_void')!
    if (!isHexComplement(structure.hash, voidNode.hash)) {
      violations.push({
        invariant: 'INV-1',
        message:
          'pole_structure and pole_void are not complementary (XOR ≠ full mask). ' +
          'The void should be the bitwise complement of the structure.',
        severity: 'warning',
      })
    }
  }

  // ── INV-2: cycle_open.prevCycleClose ≡ prev_session.cycle_close ──
  // 既济未济首尾相接 — 接力火炬。仅在启动时校验。
  if (ctx.prevSessionCycleClose != null) {
    const cycleClose = graph.nodes.find(n => n.id === 'cycle_close')!
    if (cycleClose.hash !== ctx.prevSessionCycleClose) {
      violations.push({
        invariant: 'INV-2',
        message:
          `cycle_close (${cycleClose.hash.slice(0, 8)}…) does not match ` +
          `previous session's cycle_close (${ctx.prevSessionCycleClose.slice(0, 8)}…). ` +
          'Cycle relay may be broken.',
        severity: 'critical',
      })
    }
  }

  // ── INV-3: center_belief hash is non-empty ──
  // 中孚被其他 4 点环绕 — 信念必须存在
  {
    const belief = graph.nodes.find(n => n.id === 'center_belief')!
    if (!belief.hash || belief.hash.length === 0) {
      violations.push({
        invariant: 'INV-3',
        message:
          'center_belief hash is empty — the founding belief is not anchored. ' +
          'Without a center, the other 4 nodes have nothing to orbit.',
        severity: 'critical',
      })
    }
  }

  // ── INV-4: cycle_open changes per session ──
  // 反者道之动 — 扰动位的存在让循环成为螺旋
  if (ctx.prevCycleOpen != null) {
    const cycleOpen = graph.nodes.find(n => n.id === 'cycle_open')!
    if (cycleOpen.hash === ctx.prevCycleOpen) {
      violations.push({
        invariant: 'INV-4',
        message:
          'cycle_open unchanged across sessions. ' +
          'The perturbation position is stale — the spiral has become a dead loop.',
        severity: 'warning',
      })
    }
  }

  // ── INV-5: graph hash stable within session ──
  // 拓扑不变量 — 任何漂移触发警报
  if (ctx.prevGraphHash != null && ctx.prevGraphHash !== graph.graphHash) {
    violations.push({
      invariant: 'INV-5',
      message:
        `Anchor graph hash drifted within session: ` +
        `${ctx.prevGraphHash.slice(0, 8)}… → ${graph.graphHash.slice(0, 8)}…. ` +
        'The relationship topology has changed — anchors may have shifted.',
      severity: 'critical',
    })
  }

  return violations
}

// ─── Internal helpers ───

/**
 * Check if two hex strings of equal length are bitwise complements.
 * For each hex digit pair, XOR must equal 0xf (all bits set).
 *
 * Examples:
 *   isHexComplement('0'.repeat(64), 'f'.repeat(64)) → true
 *   isHexComplement('a', '5') → true  (0xa ^ 0x5 = 0xf)
 *   isHexComplement('a', 'a') → false (0xa ^ 0xa = 0x0)
 */
function isHexComplement(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i]!, 16) ^ parseInt(b[i]!, 16)
    if (xor !== 0xf) return false
  }
  return true
}
