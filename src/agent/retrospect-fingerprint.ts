/**
 * RetrospectFingerprint — 跨 session 模式检测的指纹基础设施。
 *
 * 每次 session 结束时，从 retrospect 报告中提取关键词和趋势，
 * 生成一个轻量级指纹用于跨 session 相似度比较。
 *
 * 设计文档：docs/superpowers/specs/2026-06-04-rem-playbook-reflect-design.md
 */

import type { PlaybookBullet } from './playbook.js'

// ─── Types ──────────────────────────────────────────────────────────

export interface RetrospectFingerprint {
  sessionId: string
  createdAt: number
  rootCauseKeywords: string[]
  recommendationKeywords: string[]
  stabilityTrend: 'stable' | 'falling' | 'rising'
  confidenceTrend: 'stable' | 'falling' | 'rising'
  maxPressure: number
  toolFailureRate: number
  bulletIds: string[]
}

// ─── Extraction ─────────────────────────────────────────────────────

const SECTION_HEADINGS = {
  rootCause: /^##\s+3\.\s+根因判定/,
  recommendation: /^##\s+4\.\s+寻址建议/,
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'after', 'before',
  '本次', '会话', '建议', '考虑', '系统', '用户', '可能', '问题',
])

function extractSectionText(report: string, heading: RegExp): string {
  const lines = report.split('\n')
  const start = lines.findIndex(line => heading.test(line.trim()))
  if (start === -1) return ''
  const section: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break
    section.push(line)
  }
  return section.join('\n')
}

/**
 * Detect if a character is CJK (Chinese/Japanese/Korean).
 */
function isCJKChar(ch: string): boolean {
  const cp = ch.codePointAt(0)!
  return (cp >= 0x4E00 && cp <= 0x9FFF) ||
         (cp >= 0x3400 && cp <= 0x4DBF) ||
         (cp >= 0x3000 && cp <= 0x303F) ||
         (cp >= 0xFF00 && cp <= 0xFFEF)
}

/**
 * Extract keywords with CJK-aware tokenization (hybrid bigram).
 * Pure CJK > 2 chars → bigram expand; 2-char CJK → keep; non-CJK → keep.
 */
function extractKeywords(text: string, max = 12): string[] {
  if (!text) return []
  const rawTokens = text
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map(t => t.trim())
    .filter(t => t.length >= 2)
    .filter(t => !STOP_WORDS.has(t.toLowerCase()))

  const expanded: string[] = []
  for (const token of rawTokens) {
    const chars = [...token]
    const allCJK = chars.every(ch => isCJKChar(ch))
    if (allCJK && chars.length > 2) {
      for (let i = 0; i < chars.length - 1; i++) {
        expanded.push(chars[i]! + chars[i + 1]!)
      }
    } else {
      expanded.push(token.toLowerCase())
    }
  }
  return [...new Set(expanded)].slice(0, max)
}

// ─── Build Fingerprint ──────────────────────────────────────────────

/**
 * 从 retrospect 报告中构建指纹。
 *
 * @param sessionId 当前 session ID
 * @param report Retrospect 报告文本（generateRetrospect 输出）
 * @param bullets 本次 session 提取的 PlaybookBullet[]
 * @param options 可选覆盖（用于测试）
 */
export function buildRetrospectFingerprint(
  sessionId: string,
  report: string,
  bullets: PlaybookBullet[],
  options?: {
    now?: number
    stabilityTrend?: 'stable' | 'falling' | 'rising'
    confidenceTrend?: 'stable' | 'falling' | 'rising'
    maxPressure?: number
    toolFailureRate?: number
  },
): RetrospectFingerprint {
  const now = options?.now ?? Date.now()

  const rootCauseText = extractSectionText(report, SECTION_HEADINGS.rootCause)
  const recommendationText = extractSectionText(report, SECTION_HEADINGS.recommendation)

  return {
    sessionId,
    createdAt: now,
    rootCauseKeywords: extractKeywords(rootCauseText),
    recommendationKeywords: extractKeywords(recommendationText),
    stabilityTrend: options?.stabilityTrend ?? 'stable',
    confidenceTrend: options?.confidenceTrend ?? 'stable',
    maxPressure: options?.maxPressure ?? 0.5,
    toolFailureRate: options?.toolFailureRate ?? 0,
    bulletIds: bullets.map(b => b.id),
  }
}

// ─── Similarity ─────────────────────────────────────────────────────

/**
 * 计算两个指纹的相似度（0-1）。
 *
 * 相似度基于关键词重叠度：
 * - rootCauseKeywords 重叠度 × 0.7
 * - recommendationKeywords 重叠度 × 0.3
 *
 * 趋势差异会略微降低相似度（惩罚因子 0.9）。
 */
export function fingerprintSimilarity(a: RetrospectFingerprint, b: RetrospectFingerprint): number {
  const rootOverlap = keywordOverlap(a.rootCauseKeywords, b.rootCauseKeywords)
  const recoOverlap = keywordOverlap(a.recommendationKeywords, b.recommendationKeywords)
  let similarity = rootOverlap * 0.7 + recoOverlap * 0.3

  // 趋势差异惩罚
  if (a.stabilityTrend !== b.stabilityTrend) similarity *= 0.9
  if (a.confidenceTrend !== b.confidenceTrend) similarity *= 0.9

  return similarity
}

function keywordOverlap(a: string[], b: string[]): number {
  const left = new Set(a)
  const right = new Set(b)
  if (left.size === 0 && right.size === 0) return 0 // no signal — not similar
  const intersection = [...left].filter(k => right.has(k)).length
  const denominator = Math.max(1, Math.min(left.size, right.size))
  return intersection / denominator
}

// ─── Serialization ──────────────────────────────────────────────────

/**
 * 序列化为 SQLite 存储格式（列名 → 值）。
 */
export function serializeFingerprint(fp: RetrospectFingerprint): {
  session_id: string
  created_at: number
  root_cause_keywords: string
  recommendation_keywords: string
  stability_trend: string
  confidence_trend: string
  max_pressure: number
  tool_failure_rate: number
  bullet_ids: string
} {
  return {
    session_id: fp.sessionId,
    created_at: fp.createdAt,
    root_cause_keywords: JSON.stringify(fp.rootCauseKeywords),
    recommendation_keywords: JSON.stringify(fp.recommendationKeywords),
    stability_trend: fp.stabilityTrend,
    confidence_trend: fp.confidenceTrend,
    max_pressure: fp.maxPressure,
    tool_failure_rate: fp.toolFailureRate,
    bullet_ids: JSON.stringify(fp.bulletIds),
  }
}

/**
 * 从 SQLite 行反序列化。
 */
export function deserializeFingerprint(row: {
  session_id: string
  created_at: number
  root_cause_keywords: string
  recommendation_keywords: string
  stability_trend: string
  confidence_trend: string
  max_pressure: number
  tool_failure_rate: number
  bullet_ids: string
}): RetrospectFingerprint {
  return {
    sessionId: row.session_id,
    createdAt: row.created_at,
    rootCauseKeywords: JSON.parse(row.root_cause_keywords) as string[],
    recommendationKeywords: JSON.parse(row.recommendation_keywords) as string[],
    stabilityTrend: row.stability_trend as RetrospectFingerprint['stabilityTrend'],
    confidenceTrend: row.confidence_trend as RetrospectFingerprint['confidenceTrend'],
    maxPressure: row.max_pressure,
    toolFailureRate: row.tool_failure_rate,
    bulletIds: JSON.parse(row.bullet_ids) as string[],
  }
}

// ─── Trend Validation ───────────────────────────────────────────────

const VALID_TRENDS = new Set(['stable', 'falling', 'rising'])

/** Validate a trend value from SQLite. Defensive fallback for schema migrations. */
export function validateTrend(value: string, fallback: 'stable' | 'falling' | 'rising'): 'stable' | 'falling' | 'rising' {
  if (VALID_TRENDS.has(value)) return value as 'stable' | 'falling' | 'rising'
  return fallback
}
