import { ToolPatternMiner } from './tool-pattern-miner.js'
import { ShadowQueue } from './shadow-queue.js'
import { IdleSpec } from './idle-spec.js'
import { MistakeNotebook } from './mistake-notebook.js'
import { assessTrajectoryHealth, type HealthSignal } from './trajectory-health.js'
import { applyAgentDiet, type DietResult, type OaiMessage } from '../compact/agent-diet.js'
import { PlanCache, type PlanStep, type PlanTemplate } from './plan-cache.js'
import { Nightcrawler, type BackgroundTask } from './nightcrawler.js'
import { LinUCBBandit } from './linucb-bandit.js'
import { AgentJIT } from './agent-jit.js'
import {
  computeEffortReward,
  buildEffortContext,
  isBanditGateOpen,
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
  readonly bandit: LinUCBBandit
  readonly effortBandit: LinUCBBandit
  readonly jit: AgentJIT
  private lastTool: string | null = null
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
    this.bandit = new LinUCBBandit({ dimension: 6 })
    this.bandit.addArm('flash')
    this.bandit.addArm('pro')
    this.bandit.addArm('concise')
    this.bandit.addArm('verbose')
    this.effortBandit = new LinUCBBandit({ dimension: 6, alpha: 1.2 })
    this.effortBandit.addArm('delta:-1')
    this.effortBandit.addArm('delta:0')
    this.effortBandit.addArm('delta:+1')
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

  recordPlan(taskDescription: string, steps: PlanStep[]) {
    return this.planCache.record(taskDescription, steps)
  }

  lookupPlan(taskDescription: string) {
    return this.planCache.lookup(taskDescription)
  }

  invalidatePlanCache(filePath: string) {
    return this.planCache.invalidate(filePath)
  }

  extractPlanSteps(toolHistory: Array<{ tool: string; target: string; status: string }>): PlanStep[] {
    return toolHistory
      .filter(e => e.status === 'success')
      .filter(e => e.tool !== 'deliver_task' && e.tool !== 'ask_user_question')
      .map(e => ({ tool: e.tool, target: e.target }))
  }

  /**
   * Track B2: Build a suggestion string from PlanCache lookup.
   * Only returns a short nudge, not auto-executed steps.
   * "曾有相似已成功任务，建议检查这些文件/步骤"
   */
  planCacheSuggest(taskDescription: string): string | null {
    const template = this.planCache.lookup(taskDescription)
    if (!template) return null
    const stepList = template.steps.slice(0, 5).map(s => `  - ${s.tool} → ${s.target}`).join('\n')
    return [
      '💡 PlanCache hit: a similar task was successfully completed before.',
      `   Keywords matched: ${template.keywords.slice(0, 5).join(', ')}`,
      '   Previous steps:',
      stepList,
      template.steps.length > 5 ? `   ... and ${template.steps.length - 5} more steps` : '',
      '   (Informational only — not auto-executed.)',
    ].filter(Boolean).join('\n')
  }

  // ─── PlanCache Serialization (Track B1) ───────────────────────────────

  serializePlanCache(): string {
    const entries = [...this.planCache.getEntries()] as [string, PlanTemplate][]
    return JSON.stringify(entries.map(([_, t]) => t))
  }

  importPlanCache(json: string): void {
    try {
      const templates = JSON.parse(json) as PlanTemplate[]
      for (const t of templates) {
        this.planCache.record(t.keywords.join(' '), t.steps)
      }
    } catch { /* malformed JSON — no-op */ }
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

  // ─── Online RL — Model/Style Bandit (P3-G) ────────────────────────────

  recommendAction(context: number[]) {
    return this.bandit.shouldSuggest(context)
  }

  rewardAction(armId: string, context: number[], accepted: boolean) {
    if (accepted) this.bandit.accept(armId, context)
    else this.bandit.reject(armId, context)
  }

  // ─── T2-02: Effort Bandit Shadow Telemetry ────────────────────────────

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

  completeEffortShadow(pendingRewardId: string, input: RewardInput): void {
    const record = this._effortShadowRecords.get(pendingRewardId)
    if (!record) return
    this._effortShadowRecords.delete(pendingRewardId)
    const reward = computeEffortReward(input)
    if (reward >= 0) {
      this.effortBandit.accept(record.recommendedArm, record.context)
    } else {
      this.effortBandit.reject(record.recommendedArm, record.context)
    }
  }

  recommendEffortDelta(context: number[]): { delta: number; armId: string } | null {
    const rec = this.effortBandit.shouldSuggest(context)
    if (!rec) return null
    const delta = rec.armId === 'delta:+1' ? 1 : rec.armId === 'delta:-1' ? -1 : 0
    return { delta, armId: rec.armId }
  }

  pendingEffortShadows(): number {
    return this._effortShadowRecords.size
  }

  // ─── Track A1: Consistency Gate ───────────────────────────────────────

  /** Check if the bandit has enough training and reward evidence to influence real decisions. */
  isEffortGateOpen(): boolean {
    return isBanditGateOpen(this.effortBandit.getStats())
  }

  // ─── Agent JIT (P3-H, T2-02 gated) ────────────────────────────────────

  async tryJIT(taskDescription: string) {
    const template = this.planCache.lookup(taskDescription)
    if (!template) return null
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
  return steps.every(s => JIT_READONLY_TOOLS.has(s.tool))
}

export function createP3Integration(config: P3Config = {}): P3Integration {
  return new P3Integration(config)
}
