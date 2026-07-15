/**
 * Negative Fact Detector — prevents the model from treating lossy (collapsed/
 * truncated) tool output as evidence for negative claims ("empty", "not found",
 * "0 results", etc.).
 *
 * Principle: 有损观测不能证明不存在。
 * A lossy observation cannot support a negative conclusion.
 */
// W1-A4: lossy marker list lives in lossy-markers.ts (single source of truth,
// shared with lossy-observation-hook).
import { isLossyObservation } from './lossy-markers.js'

/** Patterns that match negative claims in tool output */
const NEGATIVE_FACT_PATTERNS = [
  /\bempty\b/i,
  /\bnot found\b/i,
  /\bno matches\b/i,
  /\b0 results\b/i,
  /\b0 files\b/i,
  /\bnothing to commit\b/i,
  /\bno tests found\b/i,
  /\ball passed\b/i,
  /\bno errors\b/i,
  /\bunchanged\b/i,
  /\bnot modified\b/i,
  /\bnot detected\b/i,
  /\bno changes\b/i,
]

export interface NegativeFactDetection {
  /** The suspected negative pattern that was matched */
  matched: string
  /** Reason for suspicion */
  reason: string
}

/**
 * Check whether a tool result content contains lossy markers AND negative claims.
 * Returns detection info if both conditions are met, null otherwise.
 */
export function detectNegativeFactInLossyResult(content: string): NegativeFactDetection | null {
  // Step 1: is this observation lossy?
  if (!isLossyObservation(content)) return null

  // Step 2: does it contain a negative claim?
  for (const pattern of NEGATIVE_FACT_PATTERNS) {
    const match = content.match(pattern)
    if (match) {
      return {
        matched: match[0],
        reason: `lossy observation (collapsed/truncated) contains suspected negative fact: "${match[0]}" — must verify independently`,
      }
    }
  }

  return null
}

/**
 * Inject a VERIFICATION_REQUIRED marker before the content if a negative
 * fact is detected in a lossy observation. Returns the modified content
 * string, or the original if no detection.
 */
export function guardLossyToolResult(content: string): string {
  const detection = detectNegativeFactInLossyResult(content)
  if (!detection) return content

  const warning = [
    `[⚠ VERIFICATION_REQUIRED]`,
    detection.reason,
    `Recommended: use find / glob / os.scandir / git status for independent cross-verification.`,
    `Do NOT conclude absence/emptiness from this observation alone.`,
    `---`,
  ].join('\n')

  return warning + '\n' + content
}
