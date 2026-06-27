// Composer slash commands (D3). Only desktop-actionable commands live here —
// agent prompt-template slashes (e.g. /goal) are intentionally out of scope so
// the menu never promises behavior the shell can't execute. The command list
// is built with action closures by the surface; filtering/detection are pure
// (unit-tested under node:test).

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

/**
 * Guard: is `input` a recognized slash command (or non-slash text)?
 * Returns false only for inputs that START with '/' but don't match any known
 * command name (exact or prefix-with-args). Non-slash input returns true —
 * the guard only protects against accidentally sending unknown `/...` tokens
 * to the agent, which would be misinterpreted as a literal request.
 * Mirrors TUI's resolveAppPromptInput returning null for unknown slashes.
 * Pure.
 */
export function isKnownSlashCommand(input: string, commands: ComposerCommand[]): boolean {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return true
  // Extract the command name (first token, no leading slash).
  const spaceIdx = trimmed.indexOf(' ')
  const inputName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)
  // Exact match on the full command name, or the input is a prefix of a
  // multi-word command (e.g. "/review" matches "/review max").
  return commands.some((c) => {
    if (c.name === inputName) return true
    // Multi-word command: "/review max" — input "/review" is a valid prefix.
    if (c.name.startsWith(`${inputName} `) && (spaceIdx === -1 || c.name.startsWith(trimmed.slice(0, Math.max(spaceIdx, c.name.length))))) return true
    // Input with args: "/rewind 5" matches command "/rewind".
    if (spaceIdx !== -1 && c.name === inputName) return true
    return false
  })
}
