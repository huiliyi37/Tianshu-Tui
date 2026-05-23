import { ToolPatternMiner } from './tool-pattern-miner.js'
import { ShadowQueue } from './shadow-queue.js'
import { IdleSpec } from './idle-spec.js'
import { MistakeNotebook } from './mistake-notebook.js'
import { assessTrajectoryHealth, type HealthSignal } from './trajectory-health.js'
import { applyAgentDiet, type DietResult, type OaiMessage } from '../compact/agent-diet.js'
import { PlanCache, type PlanStep } from './plan-cache.js'
import { Nightcrawler, type BackgroundTask } from './nightcrawler.js'

export interface P3Config {
  execute?: (tool: string, target: string) => Promise<string>
  speculativeEnabled?: boolean
  /** Background agent task executor */
  backgroundExecute?: (task: BackgroundTask) => Promise<string>
}

export class P3Integration {
  readonly miner: ToolPatternMiner
  readonly queue: ShadowQueue
  readonly idleSpec: IdleSpec
  readonly notebook: MistakeNotebook
  readonly planCache: PlanCache
  readonly nightcrawler: Nightcrawler
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
  }

  onToolStart(toolName: string): void {
    if (this.lastTool) {
      this.miner.record(this.lastTool, toolName)
    }
    this.idleSpec.onToolStart(toolName)
  }

  checkSpeculativeCache(toolName: string, target: string): string | undefined {
    return this.idleSpec.checkCache(toolName, target)
  }

  onToolComplete(toolName: string, target: string, _isError: boolean, _errorMsg?: string): void {
    this.lastTool = toolName
    this.miner.record(toolName, toolName, { targetPath: target })
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
    }
  }
}

export function createP3Integration(config: P3Config = {}): P3Integration {
  return new P3Integration(config)
}
