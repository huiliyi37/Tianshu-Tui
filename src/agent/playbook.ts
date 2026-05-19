import { createHash } from 'node:crypto'
import type { Sensorium } from './sensorium.js'
import type { VigorState } from './vigor.js'
import type { DoomLoopLevel } from './trace-store.js'

export interface PlaybookBullet {
  id: string
  createdAt: number
  keywords: string[]
  lesson: string
  context: string
  useCount: number
  lastUsedAt: number | null
  importance: number
  details?: string
}

export interface ExtractBulletsOptions {
  now?: number
  maxBullets?: number
}

export interface MatchBulletsOptions {
  now?: number
}

const SMOOTH_VARIABILITY_CEILING = 0.15
const REFLECT_VARIABILITY_THRESHOLD = 0.3
const LOW_STABILITY_THRESHOLD = 0.5
const DEFAULT_MAX_BULLETS = 3
const DEFAULT_CAPACITY = 50
const MONTH_MS = 30 * 24 * 60 * 60 * 1000

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function normalizeToken(token: string): string {
  return token.trim().toLowerCase().replace(/^[-_*`"'“”‘’()\[\]{}:：,，.。]+|[-_*`"'“”‘’()\[\]{}:：,，.。]+$/g, '')
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function hashId(input: string): string {
  return `pb_${createHash('sha256').update(input).digest('hex').slice(0, 12)}`
}

function stripMarkdown(line: string): string {
  return line
    .replace(/^\s*-\s*/, '')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim()
}

function lessonFromLine(line: string): string | null {
  const cleaned = stripMarkdown(line)
  if (!cleaned) return null
  const parts = cleaned.split(/:\s*/)
  const lesson = parts.length > 1 ? parts.slice(1).join(': ').trim() : cleaned
  return lesson || null
}

function sectionLines(report: string, heading: RegExp): string[] {
  const lines = report.split('\n')
  const start = lines.findIndex(line => heading.test(line.trim()))
  if (start === -1) return []
  const out: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break
    if (line.trim().startsWith('-')) out.push(line)
  }
  return out
}

export function extractKeywords(text: string, max = 8): string[] {
  const tokens = text
    .split(/[^\p{L}\p{N}_./-]+/u)
    .map(normalizeToken)
    .filter(token => token.length >= 2)
    .filter(token => !['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'after', 'before', '本次', '会话', '建议', '考虑'].includes(token))
  return unique(tokens).slice(0, max)
}

export function shouldReflect(vigor: VigorState, sensorium: Sensorium, doomLevel: DoomLoopLevel | string): boolean {
  if (vigor.variability < SMOOTH_VARIABILITY_CEILING) return false
  if (vigor.variability > REFLECT_VARIABILITY_THRESHOLD) return true
  if (sensorium.stability < LOW_STABILITY_THRESHOLD) return true
  if (doomLevel !== 'none') return true
  return false
}

export function extractBullets(report: string, options: ExtractBulletsOptions = {}): PlaybookBullet[] {
  const now = options.now ?? Date.now()
  const maxBullets = options.maxBullets ?? DEFAULT_MAX_BULLETS
  const rootCauseLines = sectionLines(report, /^##\s+3\.\s+根因判定/)
  const recommendationLines = sectionLines(report, /^##\s+4\.\s+寻址建议/)
  const allRawLines = [...rootCauseLines, ...recommendationLines]

  // Build lesson → raw line mapping for details
  const lessonToRaw = new Map<string, string>()
  for (const raw of allRawLines) {
    const lesson = lessonFromLine(raw)
    if (lesson && !lessonToRaw.has(lesson)) {
      lessonToRaw.set(lesson, stripMarkdown(raw))
    }
  }

  const candidates = allRawLines
    .map(lessonFromLine)
    .filter((lesson): lesson is string => Boolean(lesson && !lesson.includes('无需特别调整') && !lesson.includes('无明显故障模式')))

  return unique(candidates)
    .slice(0, maxBullets)
    .map((lesson) => {
      const keywords = extractKeywords(lesson)
      const context = rootCauseLines.some(line => line.includes(lesson)) ? 'root-cause' : 'recommendation'
      const rawDetail = lessonToRaw.get(lesson)
      // Use raw line as details if it's longer than the lesson (contains extra info)
      const details = rawDetail && rawDetail.length > lesson.length + 4
        ? rawDetail.slice(0, 200)
        : undefined
      return {
        id: hashId(`${lesson}:${context}`),
        createdAt: now,
        keywords,
        lesson,
        context,
        useCount: 0,
        lastUsedAt: null,
        importance: 0.6,
        ...(details ? { details } : {}),
      }
    })
}

function keywordOverlap(a: string[], b: string[]): number {
  const left = new Set(a)
  const right = new Set(b)
  const intersection = [...left].filter(k => right.has(k)).length
  const denominator = Math.max(1, Math.min(left.size, right.size))
  return intersection / denominator
}

function isSimilar(a: PlaybookBullet, b: PlaybookBullet): boolean {
  if (a.lesson.trim().toLowerCase() === b.lesson.trim().toLowerCase()) return true
  return keywordOverlap(a.keywords, b.keywords) >= 0.5
}

function mergeBullet(existing: PlaybookBullet, incoming: PlaybookBullet): PlaybookBullet {
  return {
    ...existing,
    keywords: unique([...existing.keywords, ...incoming.keywords]).slice(0, 12),
    context: existing.context === incoming.context ? existing.context : `${existing.context}; ${incoming.context}`.slice(0, 160),
    importance: clamp01(Math.max(existing.importance, incoming.importance) + 0.1),
  }
}

export function deduplicateBullets(existing: PlaybookBullet[], incoming: PlaybookBullet[]): PlaybookBullet[] {
  const merged = [...existing]
  for (const next of incoming) {
    const index = merged.findIndex(current => isSimilar(current, next))
    if (index >= 0) {
      merged[index] = mergeBullet(merged[index]!, next)
    } else {
      merged.push(next)
    }
  }
  return merged
}

function matchScore(bullet: PlaybookBullet, query: string[]): number {
  const normalized = unique(query.map(normalizeToken))
  if (normalized.length === 0) return 0
  const overlap = keywordOverlap(bullet.keywords, normalized)
  return overlap * 2 + bullet.importance + Math.min(0.5, bullet.useCount * 0.05)
}

export function matchBullets(
  playbook: PlaybookBullet[],
  keywords: string[],
  topK = 3,
  options: MatchBulletsOptions = {},
): PlaybookBullet[] {
  const now = options.now ?? Date.now()
  return playbook
    .map(b => ({ bullet: b, score: matchScore(b, keywords) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ bullet }) => ({
      ...bullet,
      useCount: bullet.useCount + 1,
      lastUsedAt: now,
      importance: clamp01(bullet.importance + 0.05),
    }))
}

export function decayImportance(playbook: PlaybookBullet[], now = Date.now()): PlaybookBullet[] {
  return playbook.map((bullet) => {
    const age = Math.max(0, now - bullet.createdAt)
    const agePenalty = Math.min(0.7, age / MONTH_MS * 0.2)
    const usageBoost = Math.min(0.6, bullet.useCount * 0.25)
    return {
      ...bullet,
      importance: clamp01(bullet.importance - agePenalty + usageBoost),
    }
  })
}

function isDeadEndBullet(bullet: PlaybookBullet): boolean {
  const text = `${bullet.keywords.join(' ')} ${bullet.lesson} ${bullet.context}`.toLowerCase()
  return text.includes('dead-end') || text.includes('dead end') || text.includes('死路')
}

export function enforceCapacity(playbook: PlaybookBullet[], max = DEFAULT_CAPACITY): PlaybookBullet[] {
  if (playbook.length <= max) return playbook

  const deadEnds = playbook.filter(isDeadEndBullet)
  const ordinary = playbook
    .filter(b => !isDeadEndBullet(b))
    .sort((a, b) => b.importance - a.importance || b.createdAt - a.createdAt)

  const reserved = deadEnds.slice(0, max)
  const remaining = Math.max(0, max - reserved.length)
  return [...reserved, ...ordinary.slice(0, remaining)]
}
