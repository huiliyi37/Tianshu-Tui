const HAN_RE = /\p{Script=Han}/u
const WORD_RE = /[\p{L}\p{N}_]+/gu
const LATIN_OR_NUMBER_RE = /[a-z0-9_]+/gi
const MAX_TERMS = 32

/**
 * Produce deterministic lexical recall terms for mixed-language queries.
 * Han text uses overlapping bigrams because `\W` treats every Chinese
 * character as punctuation in JavaScript's ASCII-oriented word classes.
 */
export function tokenizeRecallQuery(query: string): string[] {
  const terms = new Set<string>()
  const normalized = query.toLocaleLowerCase()

  for (const segment of normalized.match(WORD_RE) ?? []) {
    for (const token of segment.match(LATIN_OR_NUMBER_RE) ?? []) {
      if (token.length >= 3) terms.add(token)
    }

    const han = Array.from(segment).filter(char => HAN_RE.test(char))
    if (han.length === 1) {
      terms.add(han[0]!)
    } else {
      for (let index = 0; index < han.length - 1; index++) {
        terms.add(`${han[index]}${han[index + 1]}`)
      }
    }
  }

  return [...terms].slice(0, MAX_TERMS)
}
