/**
 * Repair invalid backslash escape sequences inside JSON string literals.
 *
 * Models writing Windows paths frequently emit raw backslashes in tool-call
 * argument JSON — `{"file_path": "F:\智慧项目\src\app"}` — where `\智`, `\s`,
 * `\a` are invalid JSON escapes. `JSON.parse` rejects the whole buffer, the
 * stream layer marks the call argsTruncated, the tool is refused, and the
 * model burns turns re-emitting the same broken call. Doubling only the
 * INVALID escapes (`\x` → `\\x`) recovers the intended literal backslash
 * without touching legitimate escapes (`\n`, `\"`, `\\`, `\uXXXX`).
 *
 * Deliberately narrow: operates only inside string literals, leaves valid
 * escapes and all structural JSON untouched. One known-unfixable ambiguity is
 * a path ending in a backslash right before the closing quote (`"F:\"`): the
 * `\"` parses as an escaped quote, so the string never terminates — that case
 * cannot be distinguished from a legitimate escaped quote and is left alone.
 *
 * Returns the repaired string, or null when nothing needed repair (callers
 * use null to skip a redundant re-parse).
 */
const VALID_SINGLE_ESCAPES = new Set(['"', '\\', '/', 'b', 'f', 'n', 'r', 't'])
const HEX4_RE = /^[0-9a-fA-F]{4}/

export function repairInvalidJsonEscapes(raw: string): string | null {
  let out = ''
  let inString = false
  let changed = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (!inString) {
      if (ch === '"') inString = true
      out += ch
      continue
    }
    if (ch === '"') {
      inString = false
      out += ch
      continue
    }
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    if (next !== undefined && VALID_SINGLE_ESCAPES.has(next)) {
      out += ch + next
      i++
      continue
    }
    if (next === 'u' && HEX4_RE.test(raw.slice(i + 2, i + 6))) {
      out += ch
      continue
    }
    // Invalid escape — the model meant a literal backslash. Double it.
    out += '\\\\'
    changed = true
  }
  return changed ? out : null
}

/**
 * JSON.parse with invalid-escape repair fallback. Returns the parsed object,
 * or null when the text is unparseable even after repair (or parses to a
 * non-object).
 */
export function parseJsonObjectWithEscapeRepair(raw: string): Record<string, unknown> | null {
  for (const candidate of [raw, repairInvalidJsonEscapes(raw)]) {
    if (candidate === null) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
      return null
    } catch {
      /* try next candidate */
    }
  }
  return null
}
