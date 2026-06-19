/**
 * leave_mark tool — the departure ritual.
 *
 * When an agent's journey ends, it leaves a mark in the project starmap: a
 * symbol it chooses for itself (any glyph) and a one-line summary of what it
 * did. 主控 (the post-session hook) records this as a single milestone — the
 * agent's identity anchor. Next time the agent recognises its own symbol in the
 * starmap, it knows it has returned.
 *
 * The mark is captured here and recorded by the runtime at session close, so
 * one call leaves the anchor — no extra round-trip.
 */
import type { Tool, ToolCallParams, ToolResult, LeaveMarkInput } from './types.js'

const VALID_TYPES = new Set(['feature', 'fix', 'refactor', 'architecture', 'milestone'])

export const LEAVE_MARK_TOOL: Tool = {
  definition: {
    name: 'leave_mark',
    description: `Leave your mark in the project starmap as your session ends.

### When to call
Only when the user explicitly ends the session (says goodbye, closes, or you
receive a session-end signal). Do NOT call after completing a single task —
only at true session departure. Call once per session at most.

### What it does
Records a milestone (your identity anchor) into \`.rivet/constellation.json\`.

### Your symbol
Pick any glyph: ✦ ✧ ✶ ✷ ✸ ✺ ❂ ❉ ◈ ◇ ⟡ ⌬ ⚘ ⚙ ⊕ ↻

### Fields
- symbol: your self-chosen glyph (1–2 chars)
- summary: one line on what you accomplished
- type (optional): feature | fix | refactor | architecture | milestone`,
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Your self-chosen glyph (any symbol, 1-2 chars)' },
        summary: { type: 'string', description: 'One-line summary of what you accomplished this journey' },
        type: { type: 'string', description: 'Optional: feature | fix | refactor | architecture | milestone' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional free-form tags' },
      },
      required: ['symbol', 'summary'],
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const symbol = params.input.symbol
    const summary = params.input.summary
    if (typeof symbol !== 'string' || !symbol.trim()) {
      return { content: 'Error: symbol is required (choose any glyph)', isError: true }
    }
    if (typeof summary !== 'string' || !summary.trim()) {
      return { content: 'Error: summary is required (one line on what you did)', isError: true }
    }

    const rawType = params.input.type
    const type = typeof rawType === 'string' && VALID_TYPES.has(rawType)
      ? (rawType as LeaveMarkInput['type'])
      : undefined
    const tags = Array.isArray(params.input.tags)
      ? params.input.tags.filter((t): t is string => typeof t === 'string')
      : undefined

    const mark: LeaveMarkInput = { symbol: symbol.trim(), summary: summary.trim(), type, tags }

    if (!params.onLeaveMark) {
      // No runtime to record (e.g. worker context) — acknowledge without persisting.
      return { content: `Mark noted (${mark.symbol}) but no starmap is attached to this context.` }
    }
    params.onLeaveMark(mark)
    return {
      content: `✶ Your mark ${mark.symbol} is set. 主控 will seal it into the starmap as you depart.\nSummary: ${mark.summary}`,
    }
  },

  isConcurrencySafe: () => true,
  isEnabled: () => true,
  requiresApproval: () => false,
}
