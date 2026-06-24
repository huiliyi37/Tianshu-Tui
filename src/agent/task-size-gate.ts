/**
 * Task Size Gate: classify objective text to prevent small tasks from
 * triggering heavy parallel orchestration (team_orchestrate).
 *
 * Inspired by OMC's task-size-detector — but adapted for Chinese + English
 * mixed input and with an escape hatch prefix.
 */

export type OrchestrationScale = 'small' | 'medium' | 'large'

export interface ScaleResult {
  scale: OrchestrationScale
  reason: string
  wordCount: number
  blocked: boolean
}

const SMALL_WORD_LIMIT = 10
// When word count is between SMALL_WORD_LIMIT and SMALL_SIGNAL_BOOST_LIMIT,
// a small-task signal confirms the task is genuinely small (not just terse).
const SMALL_SIGNAL_BOOST_LIMIT = 30

const ESCAPE_HATCH_RE = /^(force|quick|simple|tiny):\s*/i

const SMALL_TASK_SIGNALS: RegExp[] = [
  /\btypo\b/i,
  /\brename\b/i,
  /\bsingle\s+file\b/i,
  /\bone[\s-]liner?\b/i,
  /\bminor\s+(fix|change|update|tweak)\b/i,
  /\bspelling\b/i,
  /\bformat(ting)?\s+(this|the)\b/i,
  /\bquick\s+fix\b/i,
  /\bbump\s+version\b/i,
  /\badd\s+a?\s*comment\b/i,
  /\bwhitespace\b/i,
  /\bindentation\b/i,
]

const LARGE_TASK_SIGNALS: RegExp[] = [
  /\barchitect(ure|ural)?\b/i,
  /\brefactor\b/i,
  /\bmigrat(e|ion)\b/i,
  /\bcross[\s-]cutting\b/i,
  /\bentire\s+(codebase|project|system)\b/i,
  /\bmultiple\s+(files|modules|components)\b/i,
  /\bsystem[\s-]wide\b/i,
  /\bend[\s-]to[\s-]end\b/i,
  /\boverhaul\b/i,
  /\bcomprehensive\b/i,
]

/**
 * Count "words" in mixed Chinese/English text.
 * English words split on whitespace. Chinese characters counted in pairs
 * (2 chars = 1 word) so short Chinese phrases aren't under-counted.
 */
function countWords(text: string): number {
  const trimmed = text.trim()
  if (trimmed.length === 0) return 0
  // Extract CJK characters (common ranges) and non-CJK word segments
  const cjkChars = (trimmed.match(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g) ?? []).length
  const nonCjkText = trimmed.replace(/[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g, ' ')
  const nonCjkWords = nonCjkText.split(/\s+/).filter(w => w.length > 0).length
  return nonCjkWords + Math.ceil(cjkChars / 2)
}

/**
 * Classify an objective string into small/medium/large scale.
 * Returns blocked:true when the task is too small for team_orchestrate.
 */
export function classifyOrchestrationScale(text: string): ScaleResult {
  // Escape hatch — explicit bypass
  if (ESCAPE_HATCH_RE.test(text)) {
    return {
      scale: 'medium',
      reason: 'escape hatch prefix — gate bypassed',
      wordCount: countWords(text),
      blocked: false,
    }
  }

  const wordCount = countWords(text)
  const smallSignal = SMALL_TASK_SIGNALS.find(r => r.test(text))
  const largeSignal = LARGE_TASK_SIGNALS.find(r => r.test(text))

  // Large signal takes priority (unless escape hatch, already handled)
  if (largeSignal) {
    return {
      scale: 'large',
      reason: `large task signal: ${largeSignal.source}`,
      wordCount,
      blocked: false,
    }
  }

  // Small signal confirms smallness for terse-to-moderate text
  if (smallSignal && wordCount <= SMALL_SIGNAL_BOOST_LIMIT) {
    return {
      scale: 'small',
      reason: `Task appears small (${wordCount} words, signal: ${smallSignal.source}). Use inline execution instead of team_orchestrate.`,
      wordCount,
      blocked: true,
    }
  }

  // Very short text regardless of signals
  if (wordCount <= SMALL_WORD_LIMIT) {
    return {
      scale: 'small',
      reason: `Task appears small (${wordCount} words). Use inline execution instead of team_orchestrate.`,
      wordCount,
      blocked: true,
    }
  }

  return {
    scale: 'medium',
    reason: `${wordCount} words`,
    wordCount,
    blocked: false,
  }
}
