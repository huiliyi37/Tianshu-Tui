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
    description: 'Ask the user a question and wait for their typed response. Use this when you need clarifying information, preferences, or decisions from the user. Prefer A/B/C choices when possible.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask the user. Be clear and specific.' },
      },
      required: ['question'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const question = params.input.question as string
    // content: what the LLM sees (placeholder only — it already knows the question)
    // uiContent: what the user sees in the TUI (the actual question + prompt)
    return {
      content: '[Awaiting your response…]',
      uiContent: question,
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
