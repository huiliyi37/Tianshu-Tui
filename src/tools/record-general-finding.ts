import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import { appendGeneralFinding } from '../agent/general-ledger.js'

interface RecordGeneralFindingInput {
  star: string
  family: string
  note: string
}

const DEFINITION: ToolDefinition = {
  name: 'record_general_finding',
  description:
    "Append a battle finding to a star general's ledger (.rivet/generals/<star>.md) — 将星跨会话战绩累积的写入闭环。同族（family slug 相同）复发则 recurrenceCount++ 并追加日期实例行，新族则新建条目。瑶光记缺陷族、贪狼记能力族。写之前先 recall_general 查同族是否已存在，复用既有 family slug 而非新造近义词。",
  input_schema: {
    type: 'object',
    properties: {
      star: { type: 'string', description: 'Star name (中文或 slug)，e.g. 瑶光 / yaoguang / 贪狼.' },
      family: { type: 'string', description: 'Family slug (kebab-case)，e.g. always-true-on-missing-field. 同族复发必须复用既有 slug.' },
      note: { type: 'string', description: '一行战绩描述（哪里发现/怎么处置/证据 commit）。' },
    },
    required: ['star', 'family', 'note'],
  },
}

/** record_general_finding: 追加式写将星账本（同族计数++，新族建段）。 */
export function createRecordGeneralFindingTool(getCwd: () => string): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const input = params.input as unknown as RecordGeneralFindingInput
      const cwd = getCwd() || params.cwd
      const star = (input.star ?? '').trim()
      const family = (input.family ?? '').trim()
      const note = (input.note ?? '').trim()
      if (!star || !family || !note) {
        return { content: 'record_general_finding: star, family and note are all required.', isError: true }
      }
      if (!/^[a-z0-9][a-z0-9-]*$/.test(family)) {
        return { content: `record_general_finding: family must be a kebab-case slug (got "${family}").`, isError: true }
      }

      const result = appendGeneralFinding(cwd, { star, family, note })
      if (!result) {
        return { content: `record_general_finding: unknown star "${star}".`, isError: true }
      }
      return {
        content: result.created
          ? `新族条目已建：${family}（${result.slug}.md，recurrenceCount: 1）。`
          : `同族复发已记：${family}（${result.slug}.md，recurrenceCount: ${result.recurrenceCount}）。`,
        uiContent: `general finding: ${result.slug}/${family} ×${result.recurrenceCount}`,
        isError: false,
      }
    },
    requiresApproval(): boolean { return false },
    isConcurrencySafe(): boolean { return false },
    isEnabled(): boolean { return true },
  }
}
