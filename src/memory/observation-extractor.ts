/**
 * Observation extractor — pull structured facts from assistant output.
 */

import { appendObservation, type Observation } from './observation-store.js'

const FACT_PATTERNS: Array<{ re: RegExp; kind: Observation['kind']; confidence: number }> = [
  { re: /(?:this project|本项目|仓库).{0,40}(?:uses?|使用|采用)\s+([^\n.]{5,80})/i, kind: 'fact', confidence: 0.85 },
  { re: /(?:decided|决定|选择|will use|采用)\s+([^\n.]{5,100})/i, kind: 'decision', confidence: 0.8 },
  { re: /(?:don't|never|不要|禁止|must not)\s+([^\n.]{5,80})/i, kind: 'constraint', confidence: 0.9 },
  { re: /(?:prefer|偏好|习惯|convention)\s+([^\n.]{5,80})/i, kind: 'preference', confidence: 0.75 },
  { re: /(?:node:test|vitest|jest|eslint|prettier|tsc)/i, kind: 'fact', confidence: 0.85 },
]

const TEST_FRAMEWORK_RE = /\b(node:test|vitest|jest|mocha)\b/i
const LINT_RE = /\b(eslint|biome|prettier)\b/i

export function extractObservations(text: string, sessionId?: string): Array<Omit<Observation, 'id' | 'ts'>> {
  const observations: Array<Omit<Observation, 'id' | 'ts'>> = []
  const seen = new Set<string>()

  for (const { re, kind, confidence } of FACT_PATTERNS) {
    const match = text.match(re)
    if (!match) continue
    const captured = (match[1] ?? match[0]).trim()
    if (captured.length < 5 || seen.has(captured.toLowerCase())) continue
    seen.add(captured.toLowerCase())
    observations.push({
      text: captured,
      kind,
      confidence,
      source: 'auto',
      tags: ['extracted'],
      sessionId,
    })
  }

  if (TEST_FRAMEWORK_RE.test(text)) {
    const fw = text.match(TEST_FRAMEWORK_RE)?.[0] ?? 'test framework'
    const key = `test:${fw}`
    if (!seen.has(key)) {
      seen.add(key)
      observations.push({
        text: `Project uses ${fw} for testing`,
        kind: 'fact',
        confidence: 0.9,
        source: 'auto',
        tags: ['testing', fw],
        sessionId,
      })
    }
  }

  if (LINT_RE.test(text)) {
    const tool = text.match(LINT_RE)?.[0] ?? 'linter'
    const key = `lint:${tool}`
    if (!seen.has(key)) {
      seen.add(key)
      observations.push({
        text: `Project uses ${tool} for linting/formatting`,
        kind: 'fact',
        confidence: 0.85,
        source: 'auto',
        tags: ['lint', tool],
        sessionId,
      })
    }
  }

  return observations.slice(0, 5)
}

export function persistExtractedObservations(
  cwd: string,
  text: string,
  sessionId?: string,
): Observation[] {
  const extracted = extractObservations(text, sessionId)
  return extracted.map(e => appendObservation(cwd, e))
}
