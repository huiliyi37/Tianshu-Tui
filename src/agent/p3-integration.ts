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

export class P3Integration {
  readonly miner: ToolPatternMiner
  readonly queue: ShadowQueue
  readonly idleSpec: IdleSpec
  readonly notebook: MistakeNotebook
  readonly planCache: PlanCache
  readonly nightcrawler: Nightcrawler
  readonly bandit: LinUCBBandit
  readonly jit: AgentJIT
  private lastTool: string | null = null

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

  // P3-E: Plan Cache
  recordPlan(taskDescription: string, steps: PlanStep[]) {
    return this.planCache.record(taskDescription, steps)
  }

  lookupPlan(taskDescription: string) {
    return this.planCache.lookup(taskDescription)
  }

  invalidatePlanCache(filePath: string) {
    return this.planCache.invalidate(filePath)
  }

  // P3-F: Background Agent
  submitBackground(description: string, prompt: string, opts?: { timeoutMs?: number; maxTurns?: number }) {
    return this.nightcrawler.submit(description, prompt, opts)
  }

  cancelBackground(id: string) {
    return this.nightcrawler.cancel(id)
  }

  getBackgroundTask(id: string) {
    return this.nightcrawler.getTask(id)
  }

  // P3-G: Online RL (LinUCB)
  recommendAction(context: number[]) {
    return this.bandit.shouldSuggest(context)
  }

  rewardAction(armId: string, context: number[], accepted: boolean) {
    if (accepted) this.bandit.accept(armId, context)
    else this.bandit.reject(armId, context)
  }

  // P3-H: Agent JIT
  async tryJIT(taskDescription: string) {
    const template = this.planCache.lookup(taskDescription)
    if (!template) return null
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

  getStats() {
    return {
      speculation: this.idleSpec.stats(),
      mistakeCount: this.notebook.size(),
      planCacheSize: this.planCache.size(),
      backgroundTasks: this.nightcrawler.stats(),
      bandit: this.bandit.getStats(),
      jitCompiled: this.jit.size(),
    }
  }
}

export function createP3Integration(config: P3Config = {}): P3Integration {
  return new P3Integration(config)
}
