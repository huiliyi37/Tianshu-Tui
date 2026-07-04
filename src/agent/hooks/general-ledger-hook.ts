/**
 * General-Ledger Hook（将星记账触发面）— postTool 检测带账本星 authority 的
 * delegate 完成，提醒主控核对是否有新战绩该记。
 *
 * 闭环缺口（G2）：record_general_finding 工具存在且 worker 也调得到（G1 已通电），
 * 但没有任何时机触发面——账本全靠模型自觉 = 会饿死。写回的最佳时机正是
 * 带账本星（瑶光记缺陷族/贪狼记能力族/天梁记锚点漂移族）的 worker 归来那一刻。
 *
 * 设计：
 *   - 只对「账本已存在于 .rivet/generals/ 的星」触发——账本尚未诞生的星不催账
 *     （首笔由模型在真正认出族的时刻主动创建，工具支持骨架生成）。
 *   - informational tier 填空位，不占 operational Top-N；每星每会话最多提醒一次
 *     （提醒是指路，不是鞭子——重复催账会稀释 operational 信号）。
 *   - 账本 I/O 失败静默跳过，永不影响 postTool 主路径。
 */

import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { readGeneralLedger, starToGeneralSlug } from '../general-ledger.js'

export interface GeneralLedgerHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

const DELEGATE_TOOLS = new Set(['delegate_task', 'delegate_batch'])

/** 从 delegate_task / delegate_batch 的输入中收集 authority 值。 */
export function collectAuthorities(input: Record<string, unknown> | undefined): string[] {
  if (!input) return []
  const out = new Set<string>()
  if (typeof input.authority === 'string' && input.authority) out.add(input.authority)
  const tasks = input.tasks
  if (Array.isArray(tasks)) {
    for (const t of tasks) {
      if (t && typeof t === 'object' && typeof (t as Record<string, unknown>).authority === 'string') {
        const a = (t as Record<string, unknown>).authority as string
        if (a) out.add(a)
      }
    }
  }
  return [...out]
}

export function createGeneralLedgerHook(
  deps: GeneralLedgerHookDeps,
): PostToolRuntimeHook & { resetRemindedStars: () => void } {
  /** 每星每会话最多提醒一次 */
  const remindedStars = new Set<string>()

  return {
    phase: 'postTool',
    name: 'general-ledger',
    resetRemindedStars() { remindedStars.clear() },
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      if (!DELEGATE_TOOLS.has(tool.name) || !tool.success) return

      const authorities = collectAuthorities(tool.input)
      if (authorities.length === 0) return

      // 过滤到「账本已存在」且「本会话未提醒过」的星
      const ledgerStars: string[] = []
      for (const authority of authorities) {
        try {
          const slug = starToGeneralSlug(authority)
          if (!slug || remindedStars.has(slug)) continue
          if (readGeneralLedger(ctx.snapshot.cwd, authority) === null) continue
          ledgerStars.push(authority)
          remindedStars.add(slug)
        } catch {
          // Ledger I/O is best-effort — never block postTool.
        }
      }
      if (ledgerStars.length === 0) return

      deps.advisoryBus.submit({
        key: 'general-ledger-writeback',
        priority: 0.4,
        category: 'star_domain',
        tier: 'informational',
        content: `【将星记账】带账本的将星（${ledgerStars.join('、')}）出战归来。核对 worker 报告：若认出了新的缺陷/能力族，用 record_general_finding 记一笔（同族复发用已有族名，recurrenceCount 会自增）；无新族则不必记。账本是跨会话记忆——这次不记，下个会话的将星就带不上这段战绩。`,
        ttl: 1,
      })
    },
  }
}
