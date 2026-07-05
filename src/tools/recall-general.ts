import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import { listGenerals, readGeneralLedger, starToGeneralSlug } from '../agent/general-ledger.js'

interface RecallGeneralInput {
  star: string
}

const DEFINITION: ToolDefinition = {
  name: 'recall_general',
  description:
    "Pull a star general's battle ledger (跨会话战绩账本, .rivet/generals/<star>.md) on demand. 分工：recall_capsule 取方法论基因（封存的原则），recall_general 取战绩记忆（缺陷族/能力族 + 复发计数，持续生长）。出战验证/审查/勘探前召回账本，带着上次的记忆作业；发现新战绩用 record_general_finding 追加。",
  input_schema: {
    type: 'object',
    properties: {
      star: { type: 'string', description: 'Star name (中文或 slug)，e.g. 瑶光 / yaoguang / 贪狼 / tanlang / 天梁.' },
    },
    required: ['star'],
  },
}

/** recall_general: 按需把某将星的战绩账本全文拉进工具结果（cache-safe）。 */
export function createRecallGeneralTool(getCwd: () => string): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const input = params.input as unknown as RecallGeneralInput
      const cwd = getCwd() || params.cwd
      const star = (input.star ?? '').trim()
      if (!star) {
        return { content: 'recall_general: star is required.', isError: true }
      }

      if (starToGeneralSlug(star) === null) {
        return {
          content: `recall_general: unknown star "${star}". Ledgers on disk: ${listGenerals(cwd).join(', ') || '(none)'}.`,
          isError: true,
        }
      }
      const ledger = readGeneralLedger(cwd, star)
      if (!ledger) {
        return {
          content: `recall_general: no ledger yet for "${star}" (.rivet/generals/). Ledgers on disk: ${listGenerals(cwd).join(', ') || '(none)'}. 用 record_general_finding 记下第一条战绩即可创建。`,
          isError: true,
        }
      }

      return {
        content: ledger.content,
        uiContent: `recall general: ${star} (${ledger.slug}.md)`,
        isError: false,
      }
    },
    requiresApproval(): boolean { return false },
    isConcurrencySafe(): boolean { return true },
    isEnabled(): boolean { return true },
  }
}
