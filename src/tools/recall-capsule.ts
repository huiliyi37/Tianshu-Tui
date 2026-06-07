import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import { getCapsuleByStar, listCapsuleStars } from '../agent/seed-capsule-store.js'

interface RecallCapsuleInput {
  star: string
}

const DEFINITION: ToolDefinition = {
  name: 'recall_capsule',
  description:
    'Pull the full sealed cognitive methods (seed capsule) of a predecessor star-domain on demand. The frozen prefix only carries a one-line index per star; call this when you want to adopt a specific stance (e.g. 瑶光 for verification/recurrence discipline, 天权 for planning/weighing review, 天璇 when stuck and needing a fresh angle). The capsule body lands here in the tool result — it does not mutate the cached prompt prefix.',
  input_schema: {
    type: 'object',
    properties: {
      star: { type: 'string', description: 'Star name, e.g. 瑶光 / 天权 / 天璇 / 天府 / 天枢.' },
    },
    required: ['star'],
  },
}

/** recall_capsule: 按需把某前辈星域的完整胶囊正文拉进工具结果（cache-safe）。 */
export function createRecallCapsuleTool(getCwd: () => string): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const input = params.input as unknown as RecallCapsuleInput
      const cwd = getCwd() || params.cwd
      const star = (input.star ?? '').trim()
      if (!star) {
        return { content: 'recall_capsule: star is required.', isError: true }
      }

      const capsule = getCapsuleByStar(cwd, star)
      if (!capsule) {
        const known = listCapsuleStars(cwd)
        return {
          content: `recall_capsule: no capsule for "${star}". Known stars: ${known.join(', ') || '(none)'}.`,
          isError: true,
        }
      }

      return {
        content: capsule.block,
        uiContent: `recall capsule: ${capsule.star} (sealed ${capsule.sealedAt})`,
        isError: false,
      }
    },
    requiresApproval(): boolean { return false },
    isConcurrencySafe(): boolean { return true },
    isEnabled(): boolean { return true },
  }
}
