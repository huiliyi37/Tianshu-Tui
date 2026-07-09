// Composer slash commands (D3). The local menu covers desktop-actionable
// commands; anything else starting with '/' passes through to the server,
// where POST /prompt runs the full resolveAppPromptInput translation (same
// slash ecosystem as the TUI). The command list is built with action closures
// by the surface; filtering/detection are pure (unit-tested under node:test).

export interface ComposerCommand {
  /** Display name including the leading slash, e.g. '/rewind'. */
  name: string
  /** Short description shown on the right of the menu row. */
  desc: string
  /** Optional usage example shown under the name (e.g. '/plan <feature description>'). */
  example?: string
  /** Action to run when selected. */
  run: () => void
}

/**
 * Filter commands by a query (with or without the leading slash). Matches on
 * the command name or its description; empty query returns all. Pure.
 */
export function filterCommands(commands: ComposerCommand[], query: string): ComposerCommand[] {
  const q = query.trim().toLowerCase().replace(/^\//, '')
  if (!q) return [...commands]
  return commands.filter(
    (c) => c.name.slice(1).toLowerCase().includes(q) || c.desc.toLowerCase().includes(q),
  )
}

export interface SlashToken {
  /** Text typed after the leading '/'. */
  query: string
  start: number
  end: number
}

/**
 * Detect a slash command being typed: the input must start with '/' and contain
 * no whitespace yet (a single command token). Returns null otherwise. Pure.
 */
export function detectSlash(text: string, caret: number): SlashToken | null {
  if (!text.startsWith('/')) return null
  if (/\s/.test(text)) return null
  if (caret < 1 || caret > text.length) return null
  return { query: text.slice(1, caret), start: 0, end: text.length }
}

/** Available reasoning effort levels in cycle order. */
export const EFFORT_LEVELS = ['off', 'low', 'medium', 'high', 'max', 'auto'] as const

/** Return the next effort level in the cycle. Unknown/falsy values start at 'off'. */
export function nextEffortLevel(current?: string): string {
  const idx = current ? EFFORT_LEVELS.indexOf(current as typeof EFFORT_LEVELS[number]) : -1
  return EFFORT_LEVELS[(idx + 1) % EFFORT_LEVELS.length]!
}

