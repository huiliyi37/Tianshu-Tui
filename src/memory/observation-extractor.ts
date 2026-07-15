/**
 * Observation extractor — pull structured facts from assistant output.
 *
 * Wave 1（知识重构）起本模块**只提取、不落盘**：提取结果作为候选素材
 * 进入会话级缓冲，由 postSession essence-gate（LLM 准入闸）统一裁决。
 * 历史教训：正则直写曾产出互相矛盾的规则（jest/vitest/node:test 并存）——
 * "任何提及"都会触发 FACT_PATTERNS，无互斥校验。
 *
 * Noise gates (post-2026-06-13):
 *   G1: Noise filters — reject code fragments, meta-cognition, file paths
 *   G2: Minimum length — ≥20 chars AND ≥5 words
 *
 * Extraction caps at 3 per round; constraint confidence
 * calibrated down to 0.7 (highest false-positive rate in practice).
 */

import type { Observation } from './observation-store.js'

// ── G1: Noise detection ───────────────────────────────────────────────────

const NOISE_PATTERNS: Array<{ re: RegExp; label: string }> = [
  { re: /`[^`]+`/, label: 'code-fragment' },              // backtick-wrapped code
  { re: /src\/\S+\.(ts|tsx|js|jsx|md|json)/, label: 'file-path' },  // source file reference
  { re: /:\d{1,4}(?::\d{1,4})?/, label: 'line-ref' },    // line:col references
  { re: /(?:被当成|这些不是|正则匹配|误抓|噪声|噪声|误匹配|false positive)/, label: 'meta-cognition' },
  { re: /(?:evidence|confidence|claimId|sessionId)[":]\s*[[{]/, label: 'json-fragment' },
  { re: /^.{0,3}$/, label: 'too-short' },                 // ≤3 chars
]

/** Check if captured text is likely noise — code fragments, meta-cognition, etc. */
function isNoiseFragment(text: string): boolean {
  const t = text.trim()
  for (const { re, label: _label } of NOISE_PATTERNS) {
    if (re.test(t)) return true
  }
  return false
}

// ── G2: Minimum content ────────────────────────────────────────────────────

function minWordCount(text: string, minWords: number): boolean {
  return text.trim().split(/\s+/).filter(Boolean).length >= minWords
}

// ── Pattern definitions ────────────────────────────────────────────────────

const FACT_PATTERNS: Array<{ re: RegExp; kind: Observation['kind']; confidence: number; noisy?: boolean }> = [
  { re: /(?:this project|本项目|仓库).{0,40}(?:uses?|使用|采用)\s+([^\n.]{5,80})/i, kind: 'fact', confidence: 0.85 },
  { re: /(?:decided|决定|选择|will use|采用)\s+([^\n.]{5,100})/i, kind: 'decision', confidence: 0.8, noisy: true },
  { re: /(?:don't|never|不要|禁止|must not)\s+([^\n.]{5,80})/i, kind: 'constraint', confidence: 0.7 },
  { re: /(?:prefer|偏好|习惯|convention)\s+([^\n.]{5,80})/i, kind: 'preference', confidence: 0.75 },
  { re: /(?:node:test|vitest|jest|eslint|prettier|tsc)/i, kind: 'fact', confidence: 0.85 },
]

const TEST_FRAMEWORK_RE = /\b(node:test|vitest|jest|mocha)\b/i
const LINT_RE = /\b(eslint|biome|prettier)\b/i

// ── Main extractor ─────────────────────────────────────────────────────────

const MAX_PER_ROUND = 3

export function extractObservations(
  text: string,
  sessionId?: string,
  _cwd?: string,
): Array<Omit<Observation, 'id' | 'ts'>> {
  const observations: Array<Omit<Observation, 'id' | 'ts'>> = []
  const seen = new Set<string>()

  for (const { re, kind, confidence, noisy } of FACT_PATTERNS) {
    const match = text.match(re)
    if (!match) continue
    const captured = (match[1] ?? match[0]).trim()

    // G1: Noise gate
    if (isNoiseFragment(captured)) continue

    // G2: Minimum content
    if (captured.length < 20 && !minWordCount(captured, 5)) continue

    // Round-internal dedup
    if (seen.has(captured.toLowerCase())) continue
    seen.add(captured.toLowerCase())

    // Decision-specific: penalize quoted text (likely citation, not declaration)
    let effectiveConfidence = confidence
    if (noisy && captured.includes('"')) {
      effectiveConfidence = Math.round(confidence * 0.5 * 100) / 100
      if (effectiveConfidence < 0.5) continue // too uncertain
    }

    observations.push({
      text: captured.slice(0, 200),  // cap at 200 chars
      kind,
      confidence: effectiveConfidence,
      source: 'auto',
      tags: ['extracted'],
      sessionId,
    })

    if (observations.length >= MAX_PER_ROUND) break
  }

  if (observations.length >= MAX_PER_ROUND) return observations

  // ── Framework detection (structured, high-confidence) ──

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

  if (LINT_RE.test(text) && observations.length < MAX_PER_ROUND) {
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

  return observations.slice(0, MAX_PER_ROUND)
}

