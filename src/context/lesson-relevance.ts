/**
 * lesson-relevance.ts — Historical Lessons Relevance Gate
 *
 * Pure function module for scoring and selecting PlaybookBullet entries
 * based on query relevance, failure context, tool targets, and importance.
 *
 * No I/O, no side effects. Not wired to runtime — volatile.ts integration
 * is a separate follow-up task.
 */

import type { PlaybookBullet } from '../agent/playbook.js'

// ── Public types ────────────────────────────────────────────────────────

export interface LessonRelevanceInput {
  query?: string
  recentToolTargets?: string[]
  recentFailurePatterns?: string[]
  now?: number
  maxLessons?: number
}

export interface ScoredLesson {
  bullet: PlaybookBullet
  score: number
  reasons: string[]
}

export interface LessonRelevanceResult {
  selected: PlaybookBullet[]
  scored: ScoredLesson[]
  omitted: ScoredLesson[]
}

// ── Internal helpers ────────────────────────────────────────────────────

const DEFAULT_MAX_LESSONS = 2
const MIN_SCORE = 5

const SCORE_KEYWORD_HIT = 15
const SCORE_LESSON_HIT = 20
const SCORE_FAILURE_CONTEXT = 25
const SCORE_TOOL_TARGET = 15
const SCORE_IMPORTANCE_WEIGHT = 20
const PENALTY_DEAD_END_NO_FAILURE = -40

function normalizeToken(token: string): string {
  return token
    .trim()
    .toLowerCase()
    .replace(/^[-_*`"'\u201C\u201D\u2018\u2019()\[\]{}:：,，.。]+|[-_*`"'\u201C\u201D\u2018\u2019()\[\]{}:：,，.。]+$/g, '')
}

function tokenize(text: string): string[] {
  return text
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map(normalizeToken)
    .filter(t => t.length >= 2)
}

function isDeadEndBullet(bullet: PlaybookBullet): boolean {
  const combined = `${bullet.keywords.join(' ')} ${bullet.lesson} ${bullet.context}`.toLowerCase()
  return (
    combined.includes('dead-end') ||
    combined.includes('dead end') ||
    combined.includes('\u6B7B\u8DEF')
  )
}

// ── Public API ──────────────────────────────────────────────────────────

export function scoreLessons(
  playbook: PlaybookBullet[],
  input: LessonRelevanceInput = {},
): LessonRelevanceResult {
  const maxLessons = input.maxLessons ?? DEFAULT_MAX_LESSONS
  const queryTokens = input.query ? tokenize(input.query) : []
  const toolTargetTokens = (input.recentToolTargets ?? []).flatMap(t => tokenize(t))
  const failurePatterns = input.recentFailurePatterns ?? []

  const allScored: ScoredLesson[] = playbook.map(bullet => {
    let score = 0
    const reasons: string[] = []

    // ── Keyword match on query tokens ──
    if (queryTokens.length > 0) {
      const bulletKeywordsLower = bullet.keywords.map(k => k.toLowerCase())
      let matchedKeywordCount = 0
      for (const token of queryTokens) {
        if (bulletKeywordsLower.some(kw => kw.includes(token) || token.includes(kw))) {
          matchedKeywordCount++
        }
      }
      if (matchedKeywordCount > 0) {
        const bonus = SCORE_KEYWORD_HIT * matchedKeywordCount
        score += bonus
        reasons.push(`keyword match: +${bonus} (${matchedKeywordCount} tokens)`)
      }
    }

    // ── Lesson text match on query tokens ──
    if (queryTokens.length > 0) {
      const lessonLower = bullet.lesson.toLowerCase()
      const lessonHit = queryTokens.some(t => lessonLower.includes(t))
      if (lessonHit) {
        score += SCORE_LESSON_HIT
        reasons.push(`lesson text match: +${SCORE_LESSON_HIT}`)
      }
    }

    // ── Failure context match ──
    if (failurePatterns.length > 0) {
      const contextLower = bullet.context.toLowerCase()
      const lessonLower = bullet.lesson.toLowerCase()
      const combinedText = `${contextLower} ${lessonLower}`
      const hit = failurePatterns.some(p => combinedText.includes(p.toLowerCase()))
      if (hit) {
        score += SCORE_FAILURE_CONTEXT
        reasons.push(`failure context match: +${SCORE_FAILURE_CONTEXT}`)
      }
    }

    // ── Tool target match ──
    if (toolTargetTokens.length > 0) {
      const bulletKeywordsLower = bullet.keywords.map(k => k.toLowerCase())
      let matchedToolCount = 0
      for (const token of toolTargetTokens) {
        if (bulletKeywordsLower.some(kw => kw.includes(token) || token.includes(kw))) {
          matchedToolCount++
        }
      }
      if (matchedToolCount > 0) {
        const bonus = SCORE_TOOL_TARGET * matchedToolCount
        score += bonus
        reasons.push(`tool target match: +${bonus} (${matchedToolCount} tokens)`)
      }
    }

    // ── Importance ──
    const importanceBonus = Math.round(bullet.importance * SCORE_IMPORTANCE_WEIGHT)
    if (importanceBonus > 0) {
      score += importanceBonus
      reasons.push(`importance: +${importanceBonus} (${bullet.importance.toFixed(2)})`)
    }

    // ── Dead-end penalty ──
    if (isDeadEndBullet(bullet)) {
      const hasMatchingFailure = failurePatterns.length > 0 && failurePatterns.some(p => {
        const pLower = p.toLowerCase()
        const combined = `${bullet.keywords.join(' ')} ${bullet.lesson} ${bullet.context}`.toLowerCase()
        return combined.includes(pLower)
      })
      if (!hasMatchingFailure) {
        score += PENALTY_DEAD_END_NO_FAILURE
        reasons.push(`dead-end without matching failure: ${PENALTY_DEAD_END_NO_FAILURE}`)
      }
    }

    return { bullet, score, reasons }
  })

  // Sort by score descending
  allScored.sort((a, b) => b.score - a.score)

  // Split into selected (passing minScore, up to maxLessons) and omitted
  const passing = allScored.filter(s => s.score >= MIN_SCORE)
  const selected = passing.slice(0, maxLessons)
  const selectedSet = new Set(selected.map(s => s.bullet.id))
  const omitted = allScored.filter(s => !selectedSet.has(s.bullet.id))

  return {
    selected: selected.map(s => s.bullet),
    scored: allScored,
    omitted,
  }
}
