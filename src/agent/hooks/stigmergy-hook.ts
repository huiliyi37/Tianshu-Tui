import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import type { PheromoneDeposit, PheromoneQueryResult } from '../../context/stigmergy.js'
import { detectVirtue, virtueToPheromoneDeposit } from '../virtue-signals.js'
import type { VirtueContext, VirtueSignal } from '../virtue-signals.js'

export interface StigmergyRuntimeHookDeps {
  deposit: (deposit: PheromoneDeposit) => Promise<void>
  query: () => Promise<PheromoneQueryResult[]>
  getEvidenceState: () => { verifications: Array<{ status: string }> }
  setLoadedPheromones: (pheromones: PheromoneQueryResult[]) => void
  /** Accumulate stance evidence so it survives compaction. */
  recordStance?: (signal: VirtueSignal) => void
  /** Publish cross-session event to SQLite events table */
  publishEvent?: (input: { eventType: string; filePath?: string; detail?: string; priority?: number }) => void
  /** Current session ID for event attribution */
  sessionId?: string
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

      // ── 美德信号（阳面）：五常映射 → positive pheromone ──
      // 万物负阴而抱阳。CVM 的 trap（阴）需要 virtue（阳）来平衡。
      // 检测到美德时 deposit positive pheromone，让信任随积累而增长。
      const virtueCtx: VirtueContext = {
        toolName: tool.name,
        toolTarget: tool.target,
        toolSuccess: tool.success,
        // 仁：ask_user_question 默认视为质疑（除非明显是确认性提问）
        agreedWithUser: tool.name === 'ask_user_question' ? false : undefined,
        // 义：run_tests 在 agent 主动调用时默认视为 proactive
        userRequested: tool.name === 'run_tests' ? false : undefined,
        confidence: ctx.snapshot.vigor?.tonic ?? 0.6,
        recentToolCalls: ctx.snapshot.recentToolHistory.map(h => ({
          tool: h.tool,
          target: h.target,
          status: h.status,
        })),
        // 礼：写操作经过审批门即视为 boundary-respect
        approvalRequired: (tool.name === 'write_file' || tool.name === 'edit_file') ? true : undefined,
      }

      const virtueSignal = detectVirtue(virtueCtx)
      if (virtueSignal) {
        deps.recordStance?.(virtueSignal)
        deposits.push(virtueToPheromoneDeposit(
          virtueSignal,
          tool.target ?? 'virtue-signal',
        ))
      }

      for (const deposit of deposits) {
        await deps.deposit(deposit)
      }

      // Publish cross-session event for file modifications
      if (deps.publishEvent && deps.sessionId) {
        if ((tool.name === 'write_file' || tool.name === 'edit_file') && tool.target && tool.success) {
          try {
            deps.publishEvent({
              eventType: 'file_changed',
              filePath: tool.target,
              detail: `Modified by session ${deps.sessionId.slice(0, 8)}`,
              priority: 0,
            })
          } catch { /* cross-session events are best-effort */ }
        }
      }

      const pheromones = await deps.query()
      deps.setLoadedPheromones(pheromones)
    },
  }
}
