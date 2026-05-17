/**
 * Deterministic JSON serializer — sorted keys at every nesting level.
 * Guarantees byte-identical output for semantically identical objects,
 * which is critical for DeepSeek's exact-prefix cache matching.
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return JSON.stringify(value)
  if (typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return '[' + value.map(stableStringify).join(',') + ']'
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  const pairs = keys
    .filter(k => obj[k] !== undefined)
    .map(k => JSON.stringify(k) + ':' + stableStringify(obj[k]))
  return '{' + pairs.join(',') + '}'
}
