import { ToolPatternMiner } from './tool-pattern-miner.js'
import { ShadowQueue } from './shadow-queue.js'
import { IdleSpec } from './idle-spec.js'
import { MistakeNotebook } from './mistake-notebook.js'
import { assessTrajectoryHealth, type HealthSignal } from './trajectory-health.js'
import { applyAgentDiet, type DietResult, type OaiMessage } from '../compact/agent-diet.js'

export interface P3Config {
  execute?: (tool: string, target: string) => Promise<string>
  speculativeEnabled?: boolean
}

export class P3Integration {
  readonly miner: ToolPatternMiner
  readonly queue: ShadowQueue
  readonly idleSpec: IdleSpec
  readonly notebook: MistakeNotebook
  private lastTool: string | null = null

  constructor(config: P3Config = {}) {
    this.miner = new ToolPatternMiner()
    this.queue = new ShadowQueue({
      execute: config.execute ?? (async () => ''),
      minProbability: 0.4,
    })
    this.idleSpec = new IdleSpec({ miner: this.miner, queue: this.queue })
    this.notebook = new MistakeNotebook()
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
    }
  }
}

export function createP3Integration(config: P3Config = {}): P3Integration {
  return new P3Integration(config)
}
