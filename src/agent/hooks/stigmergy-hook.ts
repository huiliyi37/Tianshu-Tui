import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import type { PheromoneDeposit, PheromoneQueryResult } from '../../context/stigmergy.js'

export interface StigmergyRuntimeHookDeps {
  deposit: (deposit: PheromoneDeposit) => Promise<void>
  query: () => Promise<PheromoneQueryResult[]>
  getEvidenceState: () => { verifications: Array<{ status: string }> }
  setLoadedPheromones: (pheromones: PheromoneQueryResult[]) => void
}

export function createStigmergyRuntimeHook(deps: StigmergyRuntimeHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'stigmergy-runtime',
    async run(ctx, tool) {
      const deposits: PheromoneDeposit[] = []

      if (tool.name === 'read_file' && tool.target) {
        const readCount = ctx.snapshot.recentToolHistory.filter(
          h => h.tool === 'read_file' && h.target === tool.target,
        ).length
        const hasWrite = ctx.snapshot.recentToolHistory.some(
          h => (h.tool === 'write_file' || h.tool === 'edit_file') && h.target === tool.target,
        )
        if (readCount >= 3 && !hasWrite) {
          deposits.push({ path: tool.target, signal: 'entry-point', strength: 0.4 })
        }
      }

      if ((tool.name === 'write_file' || tool.name === 'edit_file') && tool.target) {
        const evidence = deps.getEvidenceState()
        const hasPassed = evidence.verifications.some(v => v.status === 'passed')
        const hasFailed = evidence.verifications.some(v => v.status === 'failed')
        if (hasPassed) {
          deposits.push({ path: tool.target, signal: 'well-tested', strength: 0.6 })
        }
        if (hasFailed) {
          deposits.push({ path: tool.target, signal: 'fragile', strength: 0.8 })
        }
      }

      if (tool.name === 'bash') {
        const bashErrors = ctx.snapshot.recentToolHistory.filter(
          h => h.tool === 'bash' && h.status === 'failed',
        ).length
        if (bashErrors >= 2) {
          deposits.push({ path: tool.target ?? 'bash-command', signal: 'dead-end', strength: 0.9 })
        }
      }

      for (const deposit of deposits) {
        await deps.deposit(deposit)
      }

      const pheromones = await deps.query()
      deps.setLoadedPheromones(pheromones)
    },
  }
}
