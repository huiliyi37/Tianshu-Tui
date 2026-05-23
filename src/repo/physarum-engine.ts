/**
 * Physarum Topology Engine
 *
 * Manages adaptive edge evolution using Physarum conductance equations.
 * Integrates with MeridianDb for persistence.
 */

import type { MeridianDb } from './meridian-db.js'
import type {
  PhysarumEdgeState, PhysarumConfig, PhysarumStats,
  Criticality, AvalancheStats,
} from './physarum-types.js'
import { DEFAULT_PHYSARUM_CONFIG } from './physarum-types.js'

export class PhysarumEngine {
  private edges = new Map<string, PhysarumEdgeState>()
  private frozen = new Set<string>() // quarantined nodes
  private avalanches: AvalancheStats = { sizes: [], lastCheckedTurn: 0 }
  private turnPruneHistory: number[] = []
  private turnGrowthHistory: number[] = []
  private currentTurn = 0

  constructor(
    private db: MeridianDb,
    private config: PhysarumConfig = DEFAULT_PHYSARUM_CONFIG,
  ) {}

  private edgeKey(a: string, b: string): string {
    return a < b ? `${a}|${b}` : `${b}|${a}`
  }

  /** Record flow on an edge (called on file access/co-edit) */
  recordFlow(fileA: string, fileB: string, turn: number): void {
    this.currentTurn = turn
    const key = this.edgeKey(fileA, fileB)
    let edge = this.edges.get(key)
    if (!edge) {
      edge = {
        fileA: fileA < fileB ? fileA : fileB,
        fileB: fileA < fileB ? fileB : fileA,
        weight: 1.0, flow: 0, consolidated: false,
        activationCount: 0, lastActivatedTurn: turn, direction: 0,
      }
      this.edges.set(key, edge)
    }
    edge.flow++
    edge.activationCount++
    edge.lastActivatedTurn = turn

    // Hot path: immediate weight evolution
    this.evolveEdge(edge, turn)
  }

  /** STDP directional update */
  recordSequentialEdit(first: string, second: string, dtTurns: number): void {
    if (dtTurns <= 0 || dtTurns > this.config.stdpWindow) return
    const key = this.edgeKey(first, second)
    const edge = this.edges.get(key)
    if (!edge) return

    const delta = this.config.stdpPlus * Math.exp(-dtTurns / this.config.stdpWindow)
    // Direction: positive means first→second is the natural flow
    if (first < second) {
      edge.direction = Math.min(1, edge.direction + delta)
    } else {
      edge.direction = Math.max(-1, edge.direction - delta)
    }
  }

  /** Evolve a single edge (Physarum conductance equation) */
  private evolveEdge(edge: PhysarumEdgeState, turn: number): void {
    if (this.frozen.has(edge.fileA) || this.frozen.has(edge.fileB)) return

    // Growth: f(flow) = growthRate * flow^gamma
    const growth = this.config.growthRate * Math.pow(Math.max(edge.flow, 0), this.config.gamma)

    // Decay: exponential based on time since last activation
    const dt = turn - edge.lastActivatedTurn
    const tau = edge.consolidated ? this.config.tauLong : this.config.tauShort
    const decay = dt > 0 ? edge.weight * (1 - Math.exp(-dt / tau)) : 0

    edge.weight = Math.max(0, edge.weight + growth - decay)

    // Consolidation check (LTP → L-LTP)
    if (!edge.consolidated && edge.activationCount >= this.config.consolidationThreshold) {
      edge.consolidated = true
    }
  }

  /** Cold path: batch decay + prune all edges (call every N turns) */
  batchEvolve(turn: number): number {
    this.currentTurn = turn
    let pruned = 0

    for (const [key, edge] of this.edges) {
      this.evolveEdge(edge, turn)

      // Prune unconsolidated edges below threshold
      if (edge.weight < this.config.pruneThreshold && !edge.consolidated) {
        this.edges.delete(key)
        pruned++
      }

      // Reset flow counter for next window
      edge.flow = 0
    }

    // Homeostatic scaling per node
    this.applyHomeostaticScaling()

    this.turnPruneHistory.push(pruned)
    if (this.turnPruneHistory.length > 20) this.turnPruneHistory.shift()

    return pruned
  }

  /** Homeostatic scaling: cap total outgoing weight per node */
  private applyHomeostaticScaling(): void {
    const nodeWeights = new Map<string, number>()

    for (const edge of this.edges.values()) {
      nodeWeights.set(edge.fileA, (nodeWeights.get(edge.fileA) ?? 0) + edge.weight)
      nodeWeights.set(edge.fileB, (nodeWeights.get(edge.fileB) ?? 0) + edge.weight)
    }

    for (const [node, total] of nodeWeights) {
      if (total <= this.config.synapticBudget) continue
      const scale = this.config.synapticBudget / total
      for (const edge of this.edges.values()) {
        if (edge.fileA === node || edge.fileB === node) {
          edge.weight *= scale
        }
      }
    }
  }

  /** Ubiquity penalty: penalize nodes connected to too many others */
  applyUbiquityPenalty(): void {
    const totalNodes = new Set<string>()
    const nodeConnections = new Map<string, number>()

    for (const edge of this.edges.values()) {
      totalNodes.add(edge.fileA)
      totalNodes.add(edge.fileB)
      nodeConnections.set(edge.fileA, (nodeConnections.get(edge.fileA) ?? 0) + 1)
      nodeConnections.set(edge.fileB, (nodeConnections.get(edge.fileB) ?? 0) + 1)
    }

    const n = totalNodes.size
    if (n === 0) return

    for (const [node, connections] of nodeConnections) {
      const ratio = connections / n
      if (ratio <= this.config.ubiquityThreshold) continue
      const penalty = 1 / (1 + Math.log(ratio / this.config.ubiquityThreshold))
      for (const edge of this.edges.values()) {
        if (edge.fileA === node || edge.fileB === node) {
          edge.weight *= penalty
        }
      }
    }
  }

  /** Record spreading activation avalanche size for SOC monitoring */
  recordAvalanche(size: number, turn: number): void {
    this.avalanches.sizes.push(size)
    if (this.avalanches.sizes.length > 100) this.avalanches.sizes.shift()
    this.avalanches.lastCheckedTurn = turn
  }

  /** Check SOC criticality from avalanche distribution */
  getCriticality(): Criticality {
    if (this.avalanches.sizes.length < 10) return 'critical' // not enough data
    const sorted = [...this.avalanches.sizes].sort((a, b) => b - a)
    const median = sorted[Math.floor(sorted.length / 2)]!
    const max = sorted[0]!
    // Simple heuristic: if max >> median, supercritical; if max ≈ median, subcritical
    const ratio = max / Math.max(median, 1)
    if (ratio > 10) return 'supercritical'
    if (ratio < 2) return 'subcritical'
    return 'critical'
  }

  /** Get current stats for anomaly detection */
  getStats(): PhysarumStats {
    const avgPrune = this.turnPruneHistory.length > 0
      ? this.turnPruneHistory.reduce((a, b) => a + b, 0) / this.turnPruneHistory.length
      : 0
    const lastPrune = this.turnPruneHistory[this.turnPruneHistory.length - 1] ?? 0

    let maxGrowth = 0
    let totalGrowth = 0
    let count = 0
    for (const edge of this.edges.values()) {
      const growth = edge.flow * this.config.growthRate
      totalGrowth += growth
      count++
      if (growth > maxGrowth) maxGrowth = growth
    }

    return {
      prunedThisTurn: lastPrune,
      avgPruneRate: avgPrune,
      maxNodeGrowth: maxGrowth,
      avgGrowth: count > 0 ? totalGrowth / count : 0,
      criticality: this.getCriticality(),
    }
  }

  /** Detect graph anomaly (produces danger signal for immune system) */
  detectAnomaly(): { severity: number; source: string } | null {
    const stats = this.getStats()

    // Anomaly 1: sudden mass pruning
    if (stats.avgPruneRate > 0 && stats.prunedThisTurn > stats.avgPruneRate * 3) {
      return { severity: 0.7, source: 'mass_prune' }
    }

    // Anomaly 2: single node growth spike
    if (stats.avgGrowth > 0 && stats.maxNodeGrowth > stats.avgGrowth * 5) {
      return { severity: 0.8, source: 'growth_spike' }
    }

    // Anomaly 3: supercritical state
    if (stats.criticality === 'supercritical') {
      return { severity: 0.5, source: 'supercritical' }
    }

    return null
  }

  /** Freeze a node (quarantine — immune response) */
  freezeNode(file: string, _durationTurns: number): void {
    this.frozen.add(file)
  }

  unfreezeNode(file: string): void {
    this.frozen.delete(file)
  }

  /** Force prune specific edges (immune toxic response) */
  forcePrune(edges: Array<{ fileA: string; fileB: string }>): void {
    for (const { fileA, fileB } of edges) {
      this.edges.delete(this.edgeKey(fileA, fileB))
    }
  }

  /** Boost edges (immune healthy response) */
  boostEdges(files: string[], bonus: number): void {
    for (const edge of this.edges.values()) {
      if (files.includes(edge.fileA) || files.includes(edge.fileB)) {
        edge.weight += bonus
      }
    }
  }

  /** Get edge state (for testing/inspection) */
  getEdge(fileA: string, fileB: string): PhysarumEdgeState | undefined {
    return this.edges.get(this.edgeKey(fileA, fileB))
  }

  /** Get all edges for a file (for spreading activation integration) */
  getEdgesFor(file: string): PhysarumEdgeState[] {
    const result: PhysarumEdgeState[] = []
    for (const edge of this.edges.values()) {
      if (edge.fileA === file || edge.fileB === file) result.push(edge)
    }
    return result
  }

  /** Get top-K predicted next files based on STDP direction */
  predictNext(currentFile: string, k = 3): Array<{ file: string; score: number }> {
    const candidates: Array<{ file: string; score: number }> = []
    for (const edge of this.edges.values()) {
      if (edge.fileA === currentFile) {
        candidates.push({ file: edge.fileB, score: edge.weight * (1 + edge.direction) })
      } else if (edge.fileB === currentFile) {
        candidates.push({ file: edge.fileA, score: edge.weight * (1 - edge.direction) })
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    return candidates.slice(0, k)
  }

  edgeCount(): number { return this.edges.size }
}
