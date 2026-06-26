import type { Tool, ToolCallParams, ToolResult } from './types.js'

/**
 * AskUserQuestion tool — allows the model to ask the user a question.
 *
 * The tool emits the question and returns a placeholder result, then
 * the turn completes. The user's next message in the conversation
 * serves as the answer to the question.
 *
 * Usage:
 *  1. Model calls ask_user_question({ question: "..." })
 *  2. Tool displays the question as output
 *  3. Returns "{response placeholder}" — turn ends
 *  4. User types their answer as a new message
 *  5. Model processes the answer in the next turn
 */

export const ASK_USER_QUESTION_TOOL: Tool = {
  definition: {
    name: 'ask_user_question',
    description: `Ask the user a question and wait for their typed response. Use when you need clarifying information, preferences, or a decision you cannot infer from context.

Provide \`options\` for a small set of mutually exclusive choices (the UI renders them as a numbered list the user can answer by number). Omit \`options\` for open-ended questions.

Do NOT use this to bounce a decision back when the user asked for YOUR analysis, recommendation, or opinion — answer directly in that case. Ask at most one question; address what you can determine first.`,
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user. Be clear and specific.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional 2-4 short, mutually exclusive choices. Omit for open-ended questions or when the user wants your analysis rather than a menu.',
        },
        allow_multiple: { type: 'boolean', description: 'Allow selecting more than one option (default: false).' },
      },
      required: ['question'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const question = params.input.question as string
    const rawOptions = params.input.options
    const options = Array.isArray(rawOptions)
      ? rawOptions.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
      : []
    const allowMultiple = params.input.allow_multiple === true

    // content: what the LLM sees (placeholder only — it already knows the question)
    // uiContent: what the user sees (the question, plus a numbered choice list when
    //            structured options are supplied). The user answers by number or text.
    let uiContent = question
    if (options.length > 0) {
      const numbered = options.map((opt, i) => `  ${i + 1}. ${opt}`).join('\n')
      const hint = allowMultiple ? '\n\n(You can pick more than one.)' : ''
      uiContent = `${question}\n\n${numbered}${hint}`
    }

    return {
      content: '[Awaiting your response…]',
      uiContent,
      endTurn: true,
    }
  },

  requiresApproval(): boolean {
    return false
  },

  isConcurrencySafe(): boolean {
    return true
  },

  isEnabled(): boolean {
    return true
  },
}
