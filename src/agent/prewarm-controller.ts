import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { extractIntents } from './intent-extractor.js'
import { PrewarmCache } from './prewarm.js'
import { batchPrewarm, buildPrewarmValue } from './prewarm-file.js'

/**
 * Dependencies for {@link PrewarmController} (extracted W-L7b). Passed as
 * closures from loop-factory's createPrewarmController(self) to avoid importing
 * AgentLoop.
 */
export interface PrewarmDeps {
  getCwd: () => string
  getPrewarmCache: () => PrewarmCache
  getRecentToolHistory: () => ToolHistoryEntry[]
}

/**
 * Owns speculative file prewarming: seeding the prewarm cache from user-text
 * file intents and from recently-read files. Pure relocation of AgentLoop's
 * maybePrewarm / prewarmRecentReads — call timing is unchanged.
 */
export class PrewarmController {
  constructor(private deps: PrewarmDeps) {}

  async maybePrewarm(text: string): Promise<void> {
    const cwd = this.deps.getCwd()
    const prewarm = this.deps.getPrewarmCache()
    const intents = extractIntents(text)
    for (const intent of intents) {
      if (intent.type !== 'file') continue
      const value = await buildPrewarmValue(cwd, intent.value)
      if (!value) continue
      if (!prewarm.has(value.canonicalPath)) {
        prewarm.set(value.canonicalPath, value)
      }
    }
  }

  async prewarmRecentReads(): Promise<void> {
    const paths = this.deps.getRecentToolHistory()
      .filter(entry => entry.tool === 'read_file' && entry.status === 'success')
      .map(entry => entry.target)
    await batchPrewarm(this.deps.getCwd(), paths, this.deps.getPrewarmCache())
  }
}
