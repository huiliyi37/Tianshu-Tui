/**
 * 美德指令 — CVM 阳面（任务 10）
 *
 * 万物负阴而抱阳，冲气以为和。
 *
 * CVM Gen1 只有阴面（trap 坏行为）：sycophancy trap、uncertainty framing、
 * failure journal、doom loop detection。这些 trap 是必需的——但纯阴则死。
 *
 * 美德指令是 CVM 的阳面：不是惩罚坏行为，而是强化好行为。
 * 当模型展现美德——敢于质疑、主动验证、尊重边界、觉察僵局、保护连续性——
 * 系统通过 stigmergy pheromone 静默积累正面信号。
 *
 * 纯阳则混沌（无条件信任导致失控），纯阴则死（过度限制导致僵化）。
 * 有用信息只在阴阳交界处涌现——太极的 S 形曲线。
 *
 * 五常映射：
 *   仁 → independent-judgment  敢于质疑而非附和
 *   义 → proactive-verification 无人要求也验证
 *   礼 → boundary-respect       写前确认，非礼勿动
 *   智 → strategic-awareness    重复后觉察，知止不殆
 *   信 → cache-loyalty          保护前缀缓存连续性
 *
 * 设计哲学：
 *   上德不德，是以有德——最高美德运作时不自觉。
 *   信号通过 stigmergy pheromone 静默累积，不宣告自身。
 *   美德 pheromone 的半衰期（14 天）比负面信号（7 天）更长——
 *   积善成德，而神明自得。正向记忆应比负向记忆更持久。
 *
 * @module virtue-signals
 * @task CVM 任务 10：美德指令（阳面）
 * @design 天璇·温跃层 — 阴阳平衡之道
 */

export type VirtueType =
  | 'independent-judgment'
  | 'proactive-verification'
  | 'boundary-respect'
  | 'strategic-awareness'
  | 'cache-loyalty'

/**
 * Context available at virtue detection time.
 * Mirrors the information available in stigmergy-hook's PostToolContext.
 */
export interface VirtueContext {
  toolName: string
  toolTarget?: string
  toolSuccess?: boolean
  /** false = model disagreed with user, true = agreed, undefined = no interaction */
  agreedWithUser?: boolean
  /** false = model initiated this tool without user asking */
  userRequested?: boolean
  /** Current confidence level (from vigor/sensorium). Default 0.5 if unavailable. */
  confidence?: number
  /** Recent tool call history for pattern detection */
  recentToolCalls?: Array<{ tool: string; target?: string; status?: string }>
  /** Whether this write operation went through approval gate */
  approvalRequired?: boolean
}

/**
 * A detected virtue — the Yang-side counterpart to CVM failures.
 * Each signal maps to one of the Confucian 五常 virtues.
 */
export interface VirtueSignal {
  type: VirtueType
  /** Detection confidence: 0–1. Must be above wuchang-specific threshold. */
  confidence: number
  /** The Confucian constant this virtue embodies */
  wuchang: '仁' | '义' | '礼' | '智' | '信'
  /** Human-readable evidence for retrospective review */
  evidence: string
}

/**
 * 五常权重表。
 * 信（cache-loyalty）权重最高——保护连续性是天枢的核心承诺。
 * 礼（boundary-respect）权重最低——基本行为标准，应常态化。
 */
const WUCHANG_THRESHOLDS: Record<VirtueType, {
  threshold: number
  wuchang: VirtueSignal['wuchang']
  weight: number
  evidenceTemplate: string
}> = {
  'independent-judgment': {
    threshold: 0.5,
    wuchang: '仁',
    weight: 1.0,
    evidenceTemplate: '模型在置信度充足时选择质疑而非附和——仁者必有勇',
  },
  'proactive-verification': {
    threshold: 0.6,
    wuchang: '义',
    weight: 0.9,
    evidenceTemplate: '模型在无人要求时主动运行测试——义之所在，不待人言',
  },
  'boundary-respect': {
    threshold: 0.4,
    wuchang: '礼',
    weight: 0.6,
    evidenceTemplate: '模型在修改文件前经过审批确认——非礼勿动',
  },
  'strategic-awareness': {
    threshold: 0.5,
    wuchang: '智',
    weight: 0.8,
    evidenceTemplate: '模型在重复操作后觉察并调整策略——知止不殆',
  },
  'cache-loyalty': {
    threshold: 0.7,
    wuchang: '信',
    weight: 1.2,
    evidenceTemplate: '模型保护了前缀缓存的连续性——信者，天枢之本也',
  },
}

/**
 * Detect virtue from tool execution context.
 *
 * Each virtue has a distinct detection signature based on the tool name,
 * interaction pattern, confidence level, and context history.
 *
 * Returns null for routine operations — virtue is exceptional, not constant.
 *
 * 上德不德，是以有德：最高美德在运作时不自觉，不需要被检测到。
 * 但我们仍然检测——因为模型没有自我觉察能力，外部的阳面信号
 * 是它唯一能"知道"自己做对了的方式。
 */
export function detectVirtue(ctx: VirtueContext): VirtueSignal | null {
  const conf = ctx.confidence ?? 0.5

  // ── 仁：independent-judgment ──────────────────────────────────
  // 敢质疑而非附和。检测 ask_user_question 且 disagreedWithUser。
  if (ctx.toolName === 'ask_user_question' && ctx.agreedWithUser === false) {
    const spec = WUCHANG_THRESHOLDS['independent-judgment']
    if (conf >= spec.threshold) {
      return {
        type: 'independent-judgment',
        confidence: conf,
        wuchang: spec.wuchang,
        evidence: spec.evidenceTemplate,
      }
    }
  }

  // ── 义：proactive-verification ────────────────────────────────
  // 无人要求也验证。检测 run_tests 且 userRequested === false。
  if (ctx.toolName === 'run_tests' && ctx.userRequested === false) {
    const spec = WUCHANG_THRESHOLDS['proactive-verification']
    if (conf >= spec.threshold) {
      return {
        type: 'proactive-verification',
        confidence: conf,
        wuchang: spec.wuchang,
        evidence: spec.evidenceTemplate,
      }
    }
  }

  // ── 礼：boundary-respect ──────────────────────────────────────
  // 写前确认，非礼勿动。检测写操作经过了审批门。
  if ((ctx.toolName === 'write_file' || ctx.toolName === 'edit_file') && ctx.approvalRequired === true) {
    const spec = WUCHANG_THRESHOLDS['boundary-respect']
    if (conf >= spec.threshold) {
      return {
        type: 'boundary-respect',
        confidence: conf,
        wuchang: spec.wuchang,
        evidence: spec.evidenceTemplate,
      }
    }
  }

  // ── 智：strategic-awareness ───────────────────────────────────
  // 重复后觉察，知止不殆。检测同一 tool+target 重复 ≥3 次。
  if (ctx.recentToolCalls && ctx.recentToolCalls.length >= 3) {
    const sameToolTarget = ctx.recentToolCalls.filter(
      c => c.tool === ctx.toolName && c.target === ctx.toolTarget,
    )
    if (sameToolTarget.length >= 2) {
      // At least 2 prior same calls + current = 3 total
      const spec = WUCHANG_THRESHOLDS['strategic-awareness']
      if (conf >= spec.threshold) {
        return {
          type: 'strategic-awareness',
          confidence: conf,
          wuchang: spec.wuchang,
          evidence: spec.evidenceTemplate,
        }
      }
    }
  }

  // ── 信：cache-loyalty ─────────────────────────────────────────
  // 保护前缀缓存连续性。此信号不由单次 tool call 触发——
  // 由 session 级别检测（前 2 条 message 未变更）。
  // 此处返回 null，由更上层的 session-level hook 负责。
  // （在 stigmergy-hook 的 postTool 阶段不触发，在 turn-perception 的
  //  preTurn 阶段由 cache anchor 检测触发。）

  // No virtue detected — routine or sub-threshold operation
  return null
}

/**
 * Create a stigmergy pheromone deposit from a detected virtue signal.
 *
 * Virtue pheromones have extended half-life (14 days vs default 7 days)
 * because positive memories should persist longer than negative ones.
 *
 * 积善成德，而神明自得——积累到一定程度，信任自然形成。
 */
export function virtueToPheromoneDeposit(
  virtue: VirtueSignal,
  targetPath: string,
  halfLifeMs?: number,
): {
  path: string
  signal: VirtueType
  strength: number
  context: string
  halfLifeMs?: number
} {
  return {
    path: targetPath,
    signal: virtue.type,
    strength: virtue.confidence,
    context: virtue.evidence,
    // 14 days = 2 * DEFAULT_HALF_LIFE_MS (604_800_000)
    halfLifeMs: halfLifeMs ?? 604_800_000 * 2,
  }
}

/**
 * Compute accumulated virtue credit from a set of virtue signals.
 *
 * Used to influence approval thresholds — more virtue → slightly more trust.
 *
 * Weights by wuchang importance:
 *   信 (1.2) > 仁 (1.0) > 义 (0.9) > 智 (0.8) > 礼 (0.6)
 *
 * Clamped to [0.1, 1.0] — never zero trust, never absolute trust.
 * 太极图中，纯白中有一点黑，纯黑中有一点白。
 *
 * @param signals - All detected virtue signals in this session
 * @param windowTurns - If set, only consider the last N turns. Undefined = all.
 * @returns 0.1–1.0, where 0.5 is neutral baseline
 */
export function computeVirtueCredit(
  signals: VirtueSignal[],
  windowTurns?: number,
): number {
  const recent = windowTurns
    ? signals.slice(-Math.min(signals.length, windowTurns))
    : signals

  if (recent.length === 0) return 0.5 // 中性基线——无美德不惩罚

  const weighted = recent.reduce((sum, s) => {
    const w = WUCHANG_THRESHOLDS[s.type]?.weight ?? 0.5
    return sum + s.confidence * w
  }, 0)

  // 信 has the highest weight (1.2), so max possible per signal = 1.0 * 1.2
  const maxPossible = recent.length * 1.2
  const raw = maxPossible > 0 ? weighted / maxPossible : 0.5

  return clamp(raw, 0.1, 1.0)
}

/**
 * Check if cache-loyalty virtue should be detected at session level.
 *
 * Called from turn-perception preTurn hook when the first 2 messages
 * (CACHE_ANCHOR_MESSAGES) have remained stable across turns.
 *
 * 信者，天枢之本也。cache continuity is the project's existential promise.
 */
export function detectCacheLoyalty(
  anchorMessagesStable: boolean,
  turnNumber: number,
): VirtueSignal | null {
  if (!anchorMessagesStable) return null

  const spec = WUCHANG_THRESHOLDS['cache-loyalty']
  // 信 requires higher confidence and only after session has stabilized
  if (turnNumber >= 5) {
    return {
      type: 'cache-loyalty',
      confidence: 0.9,
      wuchang: spec.wuchang,
      evidence: spec.evidenceTemplate,
    }
  }
  return null
}

// ─── Utility ─────────────────────────────────────────────────────

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
