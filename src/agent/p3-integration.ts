import { ToolPatternMiner } from './tool-pattern-miner.js'
import { ShadowQueue } from './shadow-queue.js'
import { IdleSpec } from './idle-spec.js'
import { MistakeNotebook } from './mistake-notebook.js'
import { assessTrajectoryHealth, type HealthSignal } from './trajectory-health.js'
import { applyAgentDiet, type DietResult, type OaiMessage } from '../compact/agent-diet.js'
import { PlanCache, type PlanStep } from './plan-cache.js'
import { Nightcrawler, type BackgroundTask } from './nightcrawler.js'
import { LinUCBBandit } from './linucb-bandit.js'
import { AgentJIT } from './agent-jit.js'
import {
  computeEffortReward,
  buildEffortContext,
  type RewardInput,
  type EffortShadowRecord,
} from './p3-reward.js'

export type { EffortShadowRecord, RewardInput }

export interface P3Config {
  execute?: (tool: string, target: string) => Promise<string>
  speculativeEnabled?: boolean
  /** Background agent task executor */
  backgroundExecute?: (task: BackgroundTask) => Promise<string>
  /** JIT tool executor */
  jitExecute?: (tool: string, args: Record<string, unknown>) => Promise<{ result: string; isError: boolean }>
}

export interface PhysarumFilePredictionInput {
  afterToolName: string
  predictions: Array<{ file: string; score: number }>
}

function physarumScoreToProbability(score: number): number {
  if (!Number.isFinite(score) || score <= 0) return 0
  return Math.min(0.9, score / (score + 1))
}

/**
 * Build 6-dim context vector from runtime state.
 * Mirrors buildEffortContext from p3-reward.ts but takes raw values.
 */
function buildContext(params: {
  taskComplexity: number
  errorRate: number
  turnDepth: number
  fileCount: number
  isRepeat: boolean
  timeOfDay: number
}): number[] {
  return buildEffortContext(params)
}

export class P3Integration {
  readonly miner: ToolPatternMiner
  readonly queue: ShadowQueue
  readonly idleSpec: IdleSpec
  readonly notebook: MistakeNotebook
  readonly planCache: PlanCache
  readonly nightcrawler: Nightcrawler
  /** Original bandit: model/styling arms (flash/pro/concise/verbose) — kept for backward compat */
  readonly bandit: LinUCBBandit
  /** T2-02: Effort bandit with delta arms (-1/0/+1) for reasoning effort adjustment */
  readonly effortBandit: LinUCBBandit
  readonly jit: AgentJIT
  private lastTool: string | null = null
  /** T2-02: Pending shadow records awaiting reward */
  private _effortShadowRecords = new Map<string, EffortShadowRecord>()

  constructor(config: P3Config = {}) {
    this.miner = new ToolPatternMiner()
    this.queue = new ShadowQueue({
      execute: config.execute ?? (async () => ''),
      minProbability: 0.4,
    })
    this.idleSpec = new IdleSpec({ miner: this.miner, queue: this.queue })
    this.notebook = new MistakeNotebook()
    this.planCache = new PlanCache()
    this.nightcrawler = new Nightcrawler({
      execute: config.backgroundExecute ?? (async () => ''),
    })
    // P3-G: 6-dim context: [taskComplexity, errorRate, turnDepth, fileCount, isRepeat, timeOfDay]
    this.bandit = new LinUCBBandit({ dimension: 6 })
    this.bandit.addArm('flash')
    this.bandit.addArm('pro')
    this.bandit.addArm('concise')
    this.bandit.addArm('verbose')
    // T2-02: Effort bandit — separate instance with delta arms for reasoning effort
    this.effortBandit = new LinUCBBandit({ dimension: 6, alpha: 1.2 })
    this.effortBandit.addArm('delta:-1')
    this.effortBandit.addArm('delta:0')
    this.effortBandit.addArm('delta:+1')
    // P3-H: Agent JIT
    this.jit = new AgentJIT({
      executeTool: config.jitExecute ?? (async () => ({ result: '', isError: false })),
    })
  }

  onToolStart(toolName: string, currentTarget?: string): void {
    if (this.lastTool) {
      this.miner.record(this.lastTool, toolName, { targetPath: currentTarget })
    }
    this.idleSpec.onToolStart(toolName)
  }

  checkSpeculativeCache(toolName: string, target: string): string | undefined {
    return this.idleSpec.checkCache(toolName, target)
  }

  enqueuePhysarumFilePredictions(input: PhysarumFilePredictionInput): void {
    const toolPredictions = this.miner.predict(input.afterToolName, 0)
    const topToolPrediction = toolPredictions[0]
    if (topToolPrediction && topToolPrediction.tool !== 'read_file') return

    for (const prediction of input.predictions) {
      const probability = physarumScoreToProbability(prediction.score)
      this.queue.enqueue({
        tool: 'read_file',
        likelyTarget: prediction.file,
        probability: topToolPrediction
          ? Math.min(0.95, probability + topToolPrediction.probability * 0.2)
          : probability,
        source: topToolPrediction ? 'combined' : 'physarum-file',
      })
    }
  }

  onToolComplete(toolName: string, _target: string, _isError: boolean, _errorMsg?: string): void {
    this.lastTool = toolName
  }

  recordMistake(error: string, context: string, resolution: string, tags: string[] = []): void {
    this.notebook.record({
      timestamp: new Date().toISOString().slice(0, 10),
      error,
      context,
      resolution,
      tags,
    })
  }

  getMistakeHints(error: string, context: string): string {
    const entries = this.notebook.query(error, context, 3)
    if (entries.length === 0) return ''
    return MistakeNotebook.formatHints(entries)
  }

  dietMessages(messages: OaiMessage[]): DietResult {
    return applyAgentDiet(messages)
  }

  // ─── Plan Cache (P3-E, T2-02 augmented) ───────────────────────────────

  /**
   * Record a plan template. T2-02 gate: only structured PlanStep[] from
   * verified sources (successful task closure, approved plan).
   * Callers must NOT pass raw plan_submit Markdown content as steps.
   */
  recordPlan(taskDescription: string, steps: PlanStep[]) {
    return this.planCache.record(taskDescription, steps)
  }

  lookupPlan(taskDescription: string) {
    return this.planCache.lookup(taskDescription)
  }

  invalidatePlanCache(filePath: string) {
    return this.planCache.invalidate(filePath)
  }

  /**
   * T2-02: Extract PlanStep[] from successful tool history entries.
   * Filters out failed tools, write/edit tools, and environment-dependent tools.
   * Strips absolute paths to relative where possible.
   */
  extractPlanSteps(toolHistory: Array<{ tool: string; target: string; status: string }>): PlanStep[] {
    return toolHistory
      .filter(e => e.status === 'success')
      .filter(e => e.tool !== 'deliver_task' && e.tool !== 'ask_user_question')
      .map(e => ({ tool: e.tool, target: e.target }))
  }

  // ─── Background Agent (P3-F) ─────────────────────────────────────────

  submitBackground(description: string, prompt: string, opts?: { timeoutMs?: number; maxTurns?: number }) {
    return this.nightcrawler.submit(description, prompt, opts)
  }

  cancelBackground(id: string) {
    return this.nightcrawler.cancel(id)
  }

  getBackgroundTask(id: string) {
    return this.nightcrawler.getTask(id)
  }

  // ─── Online RL — Model/Style Bandit (P3-G, original) ──────────────────

  recommendAction(context: number[]) {
    return this.bandit.shouldSuggest(context)
  }

  rewardAction(armId: string, context: number[], accepted: boolean) {
    if (accepted) this.bandit.accept(armId, context)
    else this.bandit.reject(armId, context)
  }

  // ─── T2-02: Effort Bandit Shadow Telemetry ────────────────────────────

  /**
   * Shadow-recommend a reasoning effort delta. Does NOT change behavior.
   * Returns a record with a pendingRewardId that can later be resolved
   * via completeEffortShadow().
   *
   * @param context 6-dim context vector from buildContext()
   * @param ruleBaseline The effort the rule-based heuristic selected (e.g., 'medium')
   * @returns null if bandit declines to suggest (cold start < 10 pulls always suggests)
   */
  shadowRecommendEffort(
    context: number[],
    ruleBaseline: string,
  ): EffortShadowRecord | null {
    const rec = this.effortBandit.shouldSuggest(context)
    if (!rec) return null
    const record: EffortShadowRecord = {
      context,
      recommendedArm: rec.armId,
      ruleBaseline,
      pendingRewardId: `effort_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    }
    this._effortShadowRecords.set(record.pendingRewardId, record)
    return record
  }

  /**
   * Resolve a pending shadow record with a composite reward signal.
   * Updates the effort bandit with the computed reward.
   *
   * @param pendingRewardId From the shadowRecommendEffort record
   * @param input Task outcome signals
   */
  completeEffortShadow(pendingRewardId: string, input: RewardInput): void {
    const record = this._effortShadowRecords.get(pendingRewardId)
    if (!record) return
    this._effortShadowRecords.delete(pendingRewardId)
    const reward = computeEffortReward(input)
    // Map reward from [-1, 1] to [0, 1] for LinUCB update
    // accept/reject split at 0: reward > 0 → accept, reward < 0 → reject
    if (reward >= 0) {
      this.effortBandit.accept(record.recommendedArm, record.context)
    } else {
      this.effortBandit.reject(record.recommendedArm, record.context)
    }
  }

  /**
   * Get the bandit's recommended effort delta, if confidence threshold is met.
   * Only used in P3+ (after sufficient shadow data). Returns null if bandit
   * declines.
   */
  recommendEffortDelta(context: number[]): { delta: number; armId: string } | null {
    const rec = this.effortBandit.shouldSuggest(context)
    if (!rec) return null
    const delta = rec.armId === 'delta:+1' ? 1 : rec.armId === 'delta:-1' ? -1 : 0
    return { delta, armId: rec.armId }
  }

  /** Number of pending shadow records awaiting reward */
  pendingEffortShadows(): number {
    return this._effortShadowRecords.size
  }

  // ─── Agent JIT (P3-H, T2-02 gated) ────────────────────────────────────

  /**
   * T2-02 gated: tryJIT returns null for templates containing write tools.
   * Only read-only tool sequences are eligible for auto-replay.
   */
  async tryJIT(taskDescription: string) {
    const template = this.planCache.lookup(taskDescription)
    if (!template) return null
    // T2-02 P4 gate: block auto-execution of write/edit/deliver/bash tools
    if (!isJitAllowed(template.steps)) return null
    return this.jit.tryJIT(template)
  }

  invalidateJIT(filePath: string) {
    return this.jit.invalidateByPath(filePath)
  }

  assessHealth(
    recentEvents: Array<{ status: 'passed' | 'failed' | 'blocked'; turn: number }>,
    currentTurn: number,
    currentModel: 'flash' | 'pro',
  ): HealthSignal {
    return assessTrajectoryHealth({ recentEvents, currentTurn, currentModel })
  }

  // ─── Serialization for MeridianDb persistence ─────────────────────────

  serializeEffortBandit(): string {
    return this.effortBandit.serialize()
  }

  static deserializeEffortBandit(json: string): LinUCBBandit {
    return LinUCBBandit.deserialize(json, { dimension: 6, alpha: 1.2 })
  }

  serializeBandit(): string {
    return this.bandit.serialize()
  }

  static deserializeBandit(json: string): LinUCBBandit {
    return LinUCBBandit.deserialize(json, { dimension: 6 })
  }

  getStats() {
    return {
      speculation: this.idleSpec.stats(),
      mistakeCount: this.notebook.size(),
      planCacheSize: this.planCache.size(),
      backgroundTasks: this.nightcrawler.stats(),
      bandit: this.bandit.getStats(),
      effortBandit: this.effortBandit.getStats(),
      jitCompiled: this.jit.size(),
      pendingEffortShadows: this._effortShadowRecords.size,
    }
  }
}

/**
 * T2-02 P4 RED gate: Check if a PlanStep[] is safe for JIT auto-replay.
 *
 * Allowed (read-only):
 *   read_file, grep, glob, repo_graph, related_tests, lsp_find_references,
 *   lsp_goto_definition, repo_map, inspect_project
 *
 * Blocked (requires approval):
 *   edit_file, write_file, hash_edit, apply_patch, bash, run_tests,
 *   deliver_task, ask_user_question, delegate_task, delegate_batch
 */
const JIT_READONLY_TOOLS = new Set([
  'read_file', 'grep', 'glob', 'repo_graph', 'related_tests',
  'lsp_find_references', 'lsp_goto_definition', 'repo_map',
  'inspect_project', 'file_info',
])

const JIT_BLOCKED_TOOLS = new Set([
  'edit_file', 'write_file', 'hash_edit', 'apply_patch',
  'bash', 'run_tests', 'deliver_task', 'ask_user_question',
  'delegate_task', 'delegate_batch',
])

function isJitAllowed(steps: PlanStep[]): boolean {
  if (steps.length === 0) return false
  for (const step of steps) {
    if (JIT_BLOCKED_TOOLS.has(step.tool)) return false
  }
  // All steps must be known readonly tools
  return steps.every(s => JIT_READONLY_TOOLS.has(s.tool))
}

export function createP3Integration(config: P3Config = {}): P3Integration {
  return new P3Integration(config)
}
