import type { Tool, ToolCallParams, ToolResult } from './types.js'

/**
 * AskUserQuestion tool — allows the model to ask the user a question.
 *
 * The tool emits the question and returns a placeholder result, then
 * the turn completes. The user's next message in the conversation
 * serves as the answer to the question.
 *
 * Usage:
 *  1. Model calls ask_user_question({ question: "..." }) — or the multi-question
 *     form ask_user_question({ questions: [{ prompt, options }] })
 *  2. Tool displays the question(s) as output
 *  3. Returns "{response placeholder}" — turn ends
 *  4. User types their answer as a new message
 *  5. Model processes the answer in the next turn
 *
 * The desktop client additionally renders a structured question card (the
 * server forwards the parsed questions over a `user_question` SSE event);
 * answers still return through the normal user-message channel, so the TUI
 * (plain text) and the desktop (card) share the same reply path.
 */

/** Structured question shape shared by the tool, server SSE and desktop card. */
export interface AskUserQuestionItem {
  /** Stable id for the card UI (auto-assigned q1..qN when omitted). */
  id: string
  prompt: string
  options: string[]
  allowMultiple: boolean
}

/**
 * Normalize raw tool input into the structured question list.
 * Accepts both the legacy single-question form ({ question, options,
 * allow_multiple }) and the multi-question form ({ questions: [...] }).
 * Returns [] when no valid question is present.
 */
export function parseAskUserQuestions(input: Record<string, unknown>): AskUserQuestionItem[] {
  const cleanOptions = (raw: unknown): string[] => Array.isArray(raw)
    ? raw.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
    : []

  if (Array.isArray(input.questions) && input.questions.length > 0) {
    const items: AskUserQuestionItem[] = []
    for (const raw of input.questions) {
      if (typeof raw !== 'object' || raw === null) continue
      const q = raw as Record<string, unknown>
      const prompt = typeof q.prompt === 'string' && q.prompt.trim()
        ? q.prompt.trim()
        : (typeof q.question === 'string' ? q.question.trim() : '')
      if (!prompt) continue
      items.push({
        id: typeof q.id === 'string' && q.id.trim() ? q.id.trim() : `q${items.length + 1}`,
        prompt,
        options: cleanOptions(q.options),
        allowMultiple: q.allow_multiple === true,
      })
    }
    return items
  }

  if (typeof input.question === 'string' && input.question.trim()) {
    return [{
      id: 'q1',
      prompt: input.question.trim(),
      options: cleanOptions(input.options),
      allowMultiple: input.allow_multiple === true,
    }]
  }

  return []
}

/** Render the questions as plain text for the TUI / uiContent channel. */
export function renderAskUserQuestionText(questions: AskUserQuestionItem[]): string {
  const blocks = questions.map((q, qi) => {
    const heading = questions.length > 1 ? `${qi + 1}. ${q.prompt}` : q.prompt
    if (q.options.length === 0) return heading
    const numbered = q.options.map((opt, i) => `  ${i + 1}. ${opt}`).join('\n')
    const hint = q.allowMultiple ? '\n\n(You can pick more than one.)' : ''
    return `${heading}\n\n${numbered}${hint}`
  })
  return blocks.join('\n\n')
}

export const ASK_USER_QUESTION_TOOL: Tool = {
  definition: {
    name: 'ask_user_question',
    description: `Ask the user one or more questions and wait for their typed response. Use when you need clarifying information, preferences, or a decision you cannot infer from context.

Single question: pass \`question\` (+ optional \`options\`). Multiple related questions (max 4): pass \`questions\` — the desktop renders them as one structured card the user pages through.

Provide \`options\` for a small set of mutually exclusive choices (the UI renders them as a numbered list the user can answer by number; the desktop card also offers a free-text "Other" entry). Omit \`options\` for open-ended questions.

Do NOT use this to bounce a decision back when the user asked for YOUR analysis, recommendation, or opinion — answer directly in that case. Prefer one question; address what you can determine first.`,
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
        questions: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Optional stable id for this question (auto-assigned when omitted).' },
              prompt: { type: 'string', description: 'The question text.' },
              options: { type: 'array', items: { type: 'string' }, description: 'Optional 2-4 short, mutually exclusive choices.' },
              allow_multiple: { type: 'boolean', description: 'Allow selecting more than one option (default: false).' },
            },
            required: ['prompt'],
          },
          description: 'Multi-question form (max 4). When present, takes precedence over the single-question fields.',
        },
      },
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const questions = parseAskUserQuestions(params.input)
    if (questions.length === 0) {
      return { content: 'Error: question (or questions[]) is required', isError: true }
    }

    // content: what the LLM sees. When options exist it MUST include the same
    // numbered rendering the user sees — the numbering lives only in uiContent
    // otherwise, so a bare "1" reply forces the model to guess the mapping
    // (session 91840816: user answered 1 = plan mode, model read it as
    // option 2 = execute directly).
    // uiContent: what the user sees (plain-text rendering; the desktop client
    //            additionally receives a structured user_question SSE for the card).
    const rendered = renderAskUserQuestionText(questions)
    const hasOptions = questions.some(q => q.options.length > 0)
    // Surface selectable questions to the TUI so it can open an arrow-key picker.
    const hasSelectable = questions.some(q => q.options.length > 0 && !q.allowMultiple)
    if (hasSelectable) {
      params.onAskUserQuestion?.({ questions })
    }
    const content = hasOptions
      ? `[Awaiting your response…]\n\nThe user was shown these numbered options:\n${rendered}\n\nA bare number in the reply refers to this numbering.`
      : '[Awaiting your response…]'
    return {
      content,
      uiContent: rendered,
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
