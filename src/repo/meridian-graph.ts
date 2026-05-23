import type { MeridianDb } from './meridian-db.js'
import type { RepoMapEntry, RepoMapResult } from './meridian-types.js'
import { CONFIDENCE_MULTIPLIER } from './meridian-types.js'
import type { MeridianBehavior } from './meridian-behavior.js'

export interface ActivationOptions {
  maxHops: number
  decay: number
  behavior?: MeridianBehavior
}

export interface RepoMapOptions extends ActivationOptions {
  maxTokens: number
}

export function spreadingActivation(
  db: MeridianDb,
  seedFile: string,
  opts: ActivationOptions,
): Map<string, number> {
  const scores = new Map<string, number>()
  scores.set(seedFile, 1.0)

  const seedSymbols = db.getSymbolsForFile(seedFile)
  let frontier = seedSymbols.map(s => s.id)

  for (let hop = 0; hop < opts.maxHops; hop++) {
    const decayFactor = Math.pow(opts.decay, hop + 1)
    const nextFrontier: string[] = []

    for (const symbolId of frontier) {
      const edges = db.getEdgesFrom(symbolId)
      for (const edge of edges) {
        const targetFile = edge.targetId.split(':')[0]!
        if (targetFile && !targetFile.includes('*')) {
          const confMult = CONFIDENCE_MULTIPLIER[edge.confidence ?? 'extracted']
          const addition = decayFactor * edge.weight * confMult
          const existing = scores.get(targetFile) ?? 0
          scores.set(targetFile, Math.max(existing, addition))
          nextFrontier.push(edge.targetId)
        }
      }
      // Also traverse reverse edges (who calls me)
      const reverseEdges = db.getEdgesTo(symbolId)
      for (const edge of reverseEdges) {
        const sourceFile = edge.sourceId.split(':')[0]!
        if (sourceFile && !sourceFile.includes('*')) {
          const confMult = CONFIDENCE_MULTIPLIER[edge.confidence ?? 'extracted']
          const addition = decayFactor * edge.weight * 0.7 * confMult // reverse edges slightly weaker
          const existing = scores.get(sourceFile) ?? 0
          scores.set(sourceFile, Math.max(existing, addition))
          nextFrontier.push(edge.sourceId)
        }
      }
    }
    frontier = nextFrontier
  }

  // P2: inject co-edit behavioral edges
  if (opts.behavior) {
    const coEdges = opts.behavior.getCoEditEdges(seedFile)
    for (const { targetFile, weight } of coEdges) {
      const existing = scores.get(targetFile) ?? 0
      scores.set(targetFile, Math.max(existing, weight))
    }
  }

  return scores
}

const TOKENS_PER_SYMBOL_LINE = 25

export function buildRepoMap(
  db: MeridianDb,
  seedFile: string,
  opts: RepoMapOptions,
): RepoMapResult {
  const scores = spreadingActivation(db, seedFile, opts)
  const stats = db.getStats()

  const entries: RepoMapEntry[] = []
  for (const [filePath, score] of scores) {
    const symbols = db.getSymbolsForFile(filePath)
    const boost = opts.behavior ? opts.behavior.getFileBoost(filePath) : 0
    entries.push({
      filePath,
      symbols: symbols.map(s => ({ name: s.name, kind: s.kind, line: s.line })),
      score: score + boost,
    })
  }

  entries.sort((a, b) => b.score - a.score)

  // Token budget: binary search on entry count
  let tokenCount = 0
  let cutoff = entries.length
  for (let i = 0; i < entries.length; i++) {
    const entryTokens = entries[i]!.symbols.length * TOKENS_PER_SYMBOL_LINE + 10
    if (tokenCount + entryTokens > opts.maxTokens) {
      cutoff = i
      break
    }
    tokenCount += entryTokens
  }

  return {
    entries: entries.slice(0, Math.max(cutoff, 1)), // always include at least seed
    totalSymbols: stats.symbols,
    graphSize: stats.files,
  }
}
