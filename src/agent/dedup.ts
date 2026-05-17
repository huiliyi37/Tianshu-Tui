/**
 * Detect and strip intra-turn sentence repetition.
 * DeepSeek sometimes repeats a chunk (50+ chars) 2+ consecutive times.
 * Returns the deduplicated text.
 */
export function stripIntraTurnRepetition(text: string): string {
  if (text.length < 100) return text
  for (const size of [200, 100, 50]) {
    if (text.length < size * 2) continue
    let i = 0
    let result = ''
    while (i < text.length) {
      const chunk = text.slice(i, i + size)
      if (chunk.length < size) { result += text.slice(i); break }
      let reps = 1
      while (text.slice(i + size * reps, i + size * (reps + 1)) === chunk) reps++
      if (reps >= 2) {
        result += chunk
        i += size * reps
      } else {
        result += text[i]
        i++
      }
    }
    if (result.length < text.length) return result
  }
  return text
}
