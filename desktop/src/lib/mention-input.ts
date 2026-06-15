// Pure helpers for @file mention editing in the composer (D2). Kept free of
// React/DOM so they can be unit-tested under node:test.

export interface MentionToken {
  /** Query text typed after '@' (a leading "file:" is stripped). */
  query: string
  /** Index of the '@' in the source text. */
  start: number
  /** Caret position (exclusive end of the token). */
  end: number
}

/**
 * Detect an active @-mention token at the caret. Triggers when an '@' precedes
 * the caret with no intervening whitespace, and the '@' is at string start or
 * preceded by whitespace. Returns null when the caret is not inside a mention.
 */
export function detectMention(text: string, caret: number): MentionToken | null {
  if (caret < 0 || caret > text.length) return null
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]!
    if (ch === '@') {
      const before = i === 0 ? '' : text[i - 1]!
      if (i !== 0 && !/\s/.test(before)) return null
      const raw = text.slice(i + 1, caret)
      if (/\s/.test(raw)) return null
      // Tolerate a user-typed "file:" prefix so re-editing a token still works.
      const query = raw.startsWith('file:') ? raw.slice('file:'.length) : raw
      return { query, start: i, end: caret }
    }
    if (/\s/.test(ch)) return null
    i--
  }
  return null
}

/**
 * Replace a detected mention token with a canonical `@file:<path>` reference
 * (the form the sidecar AgentLoop parses). Returns the new text and the caret
 * position just after the inserted token (with a trailing space).
 */
export function applyMention(text: string, token: MentionToken, path: string): { text: string; caret: number } {
  const insert = `@file:${path} `
  const next = text.slice(0, token.start) + insert + text.slice(token.end)
  return { text: next, caret: token.start + insert.length }
}
