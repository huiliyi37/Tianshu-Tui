/**
 * Runtime Self-Model — coding-agent 运行态的只读自描述。
 *
 * 这里借鉴 ESAWM 的 Self-Model / Perceptual Prioritizer，但只表达
 * 可观测的工程事实：worker 活跃度、文件范围、provider 健康、上下文压力
 * 与验证债。它不是意识模型，也不产生任何自动写入或自修改行为。
 *
 * 设计目标：
 * - 纯函数、确定性、无 I/O，便于 CLI/TUI/server 共用；
 * - 缺失数据显式降级为中性值，不把空虚真值当成健康；
 * - 事件优先级用于“先处理风险最高的运行态信号”，不直接改变用户意图。
 */

export type RuntimeHealth = 'healthy' | 'degraded' | 'blocked'
export type RuntimeAttention = 'normal' | 'elevated' | 'urgent'

export type RuntimeSignalKind =
  | 'shutdown'
  | 'worker_stalled'
  | 'file_scope_active'
  | 'worker_capacity'
  | 'provider_degraded'
  | 'context_pressure'
  | 'verification_debt'

export interface RuntimeCoordinatorSnapshot {
  activeWorkers: number
  maxWorkers: number
  pendingWorkers: number
  stalledWorkers: number
  inFlightFileScopes: number
  backgroundRunning: number
  activeClaims: number
  providerDegradation: number
  shuttingDown: boolean
}

export interface RuntimeSignalInput {
  kind: RuntimeSignalKind
  /** Unexpectedness of the observation (0–1). */
  surprise: number
  /** Impact on the current coding task (0–1). */
  relevance: number
  /** Approximate cost of investigating it (0–1, lower means cheaper). */
  cognitiveCost: number
  /** Safety/continuity risk (0–1). */
  risk?: number
  reason: string
}

export interface RuntimeSignal extends RuntimeSignalInput {
  score: number
  attention: RuntimeAttention
}

export interface RuntimeSelfModelInput {
  now?: number
  phase?: string
  turn?: number
  contextRatio?: number
  sensorium?: {
    pressure?: number
    confidence?: number
    stability?: number
  } | null
  coordinator?: Partial<RuntimeCoordinatorSnapshot> | null
  activeClaims?: number
  verificationDebt?: number
}

export interface RuntimeSelfModel {
  observedAt: number
  phase?: string
  turn?: number
  health: RuntimeHealth
  attention: RuntimeAttention
  activeWorkers: number
  maxWorkers: number
  pendingWorkers: number
  stalledWorkers: number
  inFlightFileScopes: number
  backgroundRunning: number
  activeClaims: number
  providerDegradation: number
  contextPressure: number
  verificationDebt: number
  confidence: number
  signals: RuntimeSignal[]
}

const SIGNAL_PRIORITY: Record<RuntimeSignalKind, { surprise: number; relevance: number; cost: number; risk: number }> = {
  shutdown: { surprise: 0.8, relevance: 1, cost: 0.1, risk: 1 },
  worker_stalled: { surprise: 0.9, relevance: 1, cost: 0.2, risk: 1 },
  file_scope_active: { surprise: 0.35, relevance: 0.75, cost: 0.2, risk: 0.65 },
  worker_capacity: { surprise: 0.45, relevance: 0.7, cost: 0.25, risk: 0.6 },
  provider_degraded: { surprise: 0.7, relevance: 0.85, cost: 0.3, risk: 0.85 },
  context_pressure: { surprise: 0.5, relevance: 0.8, cost: 0.25, risk: 0.75 },
  verification_debt: { surprise: 0.55, relevance: 0.95, cost: 0.35, risk: 0.9 },
}

function finite(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function clamp01(value: number | undefined, fallback = 0): number {
  return Math.max(0, Math.min(1, finite(value, fallback)))
}

function count(value: number | undefined): number {
  return Math.max(0, Math.trunc(finite(value, 0)))
}

function attentionFor(score: number): RuntimeAttention {
  if (score >= 0.75) return 'urgent'
  if (score >= 0.45) return 'elevated'
  return 'normal'
}

/**
 * Score one observation using the document's surprise × relevance ÷ cost idea,
 * with an explicit risk multiplier for coding-agent continuity and safety.
 */
export function scoreRuntimeSignal(input: RuntimeSignalInput): RuntimeSignal {
  const surprise = clamp01(input.surprise)
  const relevance = clamp01(input.relevance)
  const risk = clamp01(input.risk, 0.5)
  const cognitiveCost = Math.max(0.05, clamp01(input.cognitiveCost, 0.5))
  const score = Math.min(1, (surprise * relevance * (0.5 + 0.5 * risk)) / cognitiveCost)
  return {
    ...input,
    surprise,
    relevance,
    cognitiveCost,
    risk,
    score,
    attention: attentionFor(score),
  }
}

/** Stable priority ordering for the event/observation stream. */
export function prioritizeRuntimeSignals(inputs: readonly RuntimeSignalInput[]): RuntimeSignal[] {
  return inputs
    .map((input, index) => ({ signal: scoreRuntimeSignal(input), index }))
    .sort((a, b) => b.signal.score - a.signal.score || a.index - b.index)
    .map(({ signal }) => signal)
}

function defaultSignal(kind: RuntimeSignalKind, reason: string, intensity: number): RuntimeSignalInput {
  const base = SIGNAL_PRIORITY[kind]
  const scale = clamp01(intensity)
  return {
    kind,
    surprise: base.surprise * scale,
    relevance: base.relevance,
    cognitiveCost: base.cost,
    risk: base.risk * scale,
    reason,
  }
}

/**
 * Build a bounded, serializable self-model from existing runtime snapshots.
 * The result is descriptive only; callers decide whether to gate or route.
 */
export function buildRuntimeSelfModel(input: RuntimeSelfModelInput = {}): RuntimeSelfModel {
  const coordinator = input.coordinator ?? {}
  const activeWorkers = count(coordinator.activeWorkers)
  const maxWorkers = Math.max(activeWorkers, count(coordinator.maxWorkers))
  const pendingWorkers = count(coordinator.pendingWorkers)
  const stalledWorkers = count(coordinator.stalledWorkers)
  const inFlightFileScopes = count(coordinator.inFlightFileScopes)
  const backgroundRunning = count(coordinator.backgroundRunning)
  const activeClaims = count(input.activeClaims ?? coordinator.activeClaims)
  const providerDegradation = clamp01(coordinator.providerDegradation)
  const contextPressure = Math.max(clamp01(input.contextRatio), clamp01(input.sensorium?.pressure))
  const verificationDebt = clamp01(input.verificationDebt)
  const confidence = clamp01(input.sensorium?.confidence, 0.5)
  const signals: RuntimeSignalInput[] = []

  if (coordinator.shuttingDown === true) {
    signals.push(defaultSignal('shutdown', 'coordinator is shutting down; new work must not be admitted', 1))
  }
  if (stalledWorkers > 0) {
    signals.push(defaultSignal('worker_stalled', `${stalledWorkers} worker(s) have exceeded their silence tolerance`, Math.min(1, stalledWorkers / 2)))
  }
  if (inFlightFileScopes > 0) {
    signals.push(defaultSignal('file_scope_active', `${inFlightFileScopes} file scope(s) are currently reserved`, Math.min(1, inFlightFileScopes / 4)))
  }
  if (maxWorkers > 0 && activeWorkers / maxWorkers >= 0.8) {
    signals.push(defaultSignal('worker_capacity', `worker capacity is ${activeWorkers}/${maxWorkers}`, activeWorkers / maxWorkers))
  }
  if (providerDegradation > 0.15) {
    signals.push(defaultSignal('provider_degraded', `provider degradation is ${(providerDegradation * 100).toFixed(0)}%`, providerDegradation))
  }
  if (contextPressure > 0.65) {
    signals.push(defaultSignal('context_pressure', `context pressure is ${(contextPressure * 100).toFixed(0)}%`, contextPressure))
  }
  if (verificationDebt > 0.1) {
    signals.push(defaultSignal('verification_debt', `verification debt is ${(verificationDebt * 100).toFixed(0)}%`, verificationDebt))
  }

  const ranked = prioritizeRuntimeSignals(signals)
  const urgent = ranked.some(signal => signal.attention === 'urgent')
  const elevated = ranked.some(signal => signal.attention === 'elevated')
  const shuttingDown = coordinator.shuttingDown === true
  const health: RuntimeHealth = shuttingDown
    ? 'blocked'
    : (stalledWorkers > 0 || providerDegradation >= 0.5 || contextPressure >= 0.9 || verificationDebt >= 0.75)
      ? 'degraded'
      : 'healthy'

  return {
    observedAt: Math.max(0, Math.trunc(finite(input.now, Date.now()))),
    ...(typeof input.phase === 'string' && input.phase.length > 0 ? { phase: input.phase } : {}),
    ...(typeof input.turn === 'number' && Number.isFinite(input.turn) ? { turn: Math.max(0, Math.trunc(input.turn)) } : {}),
    health,
    attention: urgent ? 'urgent' : elevated ? 'elevated' : 'normal',
    activeWorkers,
    maxWorkers,
    pendingWorkers,
    stalledWorkers,
    inFlightFileScopes,
    backgroundRunning,
    activeClaims,
    providerDegradation,
    contextPressure,
    verificationDebt,
    confidence,
    signals: ranked,
  }
}
