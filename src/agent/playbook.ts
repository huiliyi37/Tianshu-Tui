import { createHash } from 'node:crypto'
import type { Sensorium } from './sensorium.js'
import type { VigorState } from './vigor.js'
import type { DoomLoopLevel } from './trace-store.js'
import type { RetrospectFingerprint } from './retrospect-fingerprint.js'
import { fingerprintSimilarity } from './retrospect-fingerprint.js'
import type { FailureEntry, FailurePattern } from './failure-journal.js'

export type ExperienceSource = 'review-gate' | 'test-failure' | 'typecheck' | 'delivery-gate' | 'self-correction'

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
  bulletIds?: string[]
  source?: ExperienceSource
  errorSignal?: string
  fixApproach?: string
}

export interface ExtractBulletsOptions {
  now?: number
  maxBullets?: number
}

export interface MatchBulletsOptions {
  now?: number
  minImportance?: number
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

/**
 * retrospect.ts sections 3/4 emit a fixed set of canned template lines chosen
 * by metric thresholds (not session-specific content). Harvested verbatim they
 * become zero-signal "lessons" ("本次会话表现良好", "策略稳定性下降…") that get
 * injected into every prompt and inflate useCount without ever teaching
 * anything. Block these exact template right-hand sides at the gate; real
 * lessons enter via the remember/claim path, not this auto-harvest.
 */
const TEMPLATE_NOISE_FRAGMENTS = [
  '数据不足，无法判定',
  '无足够遥测数据',
  '验证反馈不足 + 策略振荡组合',
  '上下文压力、任务拆解粒度、工具输出截断策略',
  '策略稳定性下降（重复操作或振荡）',
  'doom loop 检测阈值、工具指纹哈希精度',
  '验证置信度下降（测试未覆盖修改范围）',
  '文件修改后未及时运行测试、测试覆盖率不足',
  '上下文压力过高',
  'compact 触发时机、工具输出长度、消息历史积累',
  '本次会话表现良好',
  '考虑在关键修改后手动运行测试验证',
  '检查 compact 策略是否及时触发',
  '检查 doom loop 检测阈值是否过于敏感',
]

function isTemplateNoise(lesson: string): boolean {
  return TEMPLATE_NOISE_FRAGMENTS.some(frag => lesson.includes(frag))
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
    .filter((lesson): lesson is string =>
      Boolean(lesson && !lesson.includes('无需特别调整') && !lesson.includes('无明显故障模式') && !isTemplateNoise(lesson)))

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
  const IMPORTANCE_BOOST = 0.15
  return {
    ...existing,
    keywords: unique([...existing.keywords, ...incoming.keywords]).slice(0, 12),
    context: existing.context === incoming.context ? existing.context : `${existing.context}; ${incoming.context}`.slice(0, 160),
    importance: clamp01(Math.max(existing.importance, incoming.importance) + IMPORTANCE_BOOST),
    source: incoming.source ?? existing.source,
    errorSignal: incoming.errorSignal ?? existing.errorSignal,
    fixApproach: incoming.fixApproach ?? existing.fixApproach,
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
  const minImportance = options.minImportance ?? 0
  return playbook
    .filter(b => b.importance >= minImportance)
    .map(b => ({ bullet: b, score: matchScore(b, keywords) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ bullet }) => bullet)
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

// ── REM: Cross-session pattern detection ───────────────────

const PATTERN_SIMILARITY_THRESHOLD = 0.5
const MIN_SESSIONS_FOR_PATTERN = 2

/**
 * 从跨 session 的 retrospect 指纹中检测重复出现的模式。
 *
 * 逻辑：
 * 1. 找到与当前 fingerprint 的 rootCauseKeywords 重叠度 ≥ 0.5 的历史 session
 * 2. 如果已有对应的 PatternBullet：增加 importance（跨 session 强化）
 * 3. 如果没有且匹配 session 数 ≥ 2：创建新的 PatternBullet
 *
 * @param currentFingerprint 当前 session 的指纹
 * @param historicalFingerprints 历史指纹（按时间倒序）
 * @param existingBullets 现有的 PlaybookBullet（包括 NREM 和 REM）
 * @returns 新创建或强化的 PatternBullet[]
 */
export function detectCrossSessionPatterns(
  currentFingerprint: RetrospectFingerprint,
  historicalFingerprints: RetrospectFingerprint[],
  existingBullets: PlaybookBullet[],
): PlaybookBullet[] {
  // Step 1: 找到相似的历史 session
  const similarSessions = historicalFingerprints.filter(
    fp => fingerprintSimilarity(currentFingerprint, fp) >= PATTERN_SIMILARITY_THRESHOLD,
  )

  if (similarSessions.length < MIN_SESSIONS_FOR_PATTERN) {
    return [] // 不够形成模式
  }

  const patternBullets: PlaybookBullet[] = []
  const now = Date.now()

  // Step 2: 检查是否已有对应的 PatternBullet
  const existingPatterns = existingBullets.filter(b => b.context.startsWith('pattern:'))

  for (const historical of similarSessions) {
    // 检查是否已有与该历史 session 相关的 PatternBullet
    const relatedPattern = existingPatterns.find(b =>
      b.bulletIds?.some(id => historical.bulletIds.includes(id)),
    )

    if (relatedPattern) {
      // 已有模式：增加 importance（跨 session 强化）
      patternBullets.push({
        ...relatedPattern,
        importance: clamp01(relatedPattern.importance + 0.15),
        useCount: relatedPattern.useCount + 1,
        lastUsedAt: now,
      })
    } else {
      // 没有已有模式：从相似 session 中提取共同根因关键词
      const sharedKeywords = currentFingerprint.rootCauseKeywords.filter(k =>
        historical.rootCauseKeywords.includes(k),
      )

      if (sharedKeywords.length >= 2) {
        const recommendations = unique([
          ...historical.recommendationKeywords,
          ...currentFingerprint.recommendationKeywords,
        ]).slice(0, 6)
        const rootCauses = sharedKeywords.slice(0, 4).join('、')
        const advice = recommendations.length > 0
          ? `建议关注：${recommendations.join('、')}`
          : '尚无具体建议，需进一步诊断'
        const lesson = `${rootCauses} 跨 ${similarSessions.length + 1} session 重复出现。${advice}`
        patternBullets.push({
          id: hashId(`pattern:${sharedKeywords.join(':')}`),
          createdAt: now,
          keywords: [...sharedKeywords, ...recommendations.slice(0, 3)],
          lesson,
          context: 'pattern:recurring',
          useCount: 1,
          lastUsedAt: now,
          importance: 0.7,
          details: `相似 session: ${historical.sessionId} (${similarSessions.length} 个匹配)`,
        })
      }
    }
  }

  return patternBullets
}

/**
 * 抑制长时间未重现的模式。
 *
 * 连续 3+ session 未重现的 pattern → context 标记为 'pattern:suppressed'
 * suppressed 状态的 bullet 的 importance 加速衰减
 *
 * @param bullets 现有的 PlaybookBullet[]
 * @param recentFingerprints 最近的 fingerprint（用于检查是否重现）
 * @param staleThreshold 未重现的 session 数阈值（默认 3）
 * @returns 更新后的 PlaybookBullet[]
 */
export function suppressStalePatterns(
  bullets: PlaybookBullet[],
  recentFingerprints: RetrospectFingerprint[],
  staleThreshold = 3,
): PlaybookBullet[] {
  if (recentFingerprints.length < staleThreshold) {
    return bullets // 不够判断是否 stale
  }

  const recentSessions = recentFingerprints.slice(0, staleThreshold)

  return bullets.map(bullet => {
    // 只处理 pattern bullets
    if (!bullet.context.startsWith('pattern:')) return bullet
    if (bullet.context === 'pattern:suppressed') return bullet // 已经 suppressed

    // 检查该 pattern 是否在最近 N 个 session 中出现过
    const appearedRecently = recentSessions.some(fp =>
      fp.bulletIds.includes(bullet.id) ||
      fp.rootCauseKeywords.some(k => bullet.keywords.includes(k)),
    )

    if (!appearedRecently) {
      // 未重现：标记为 suppressed，加速衰减
      return {
        ...bullet,
        context: 'pattern:suppressed',
        importance: clamp01(bullet.importance * 0.5), // 加速衰减
      }
    }

    return bullet
  })
}

/**
 * 判断是否应该运行 REM 模式检测。
 *
 * 三级门控：
 * - 'full': shouldReflect 通过 → 完整 reflect + 模式检测
 * - 'light': shouldReflect 未通过，但 sessionCount ≥ 3 → 只做指纹存储 + 模式检测
 * - 'skip': shouldReflect 未通过且 sessionCount < 3 → 完全跳过
 */
export function shouldRunREM(
  vigor: VigorState,
  sensorium: Sensorium,
  doomLevel: DoomLoopLevel | string,
  sessionCount: number,
): 'full' | 'light' | 'skip' {
  // shouldReflect 通过 → 完整模式
  if (shouldReflect(vigor, sensorium, doomLevel)) {
    return 'full'
  }

  // 有足够的历史 session → 轻量模式
  if (sessionCount >= MIN_SESSIONS_FOR_PATTERN) {
    return 'light'
  }

  return 'skip'
}

const DEFENSIVE_WORDS = ['小心', '注意', '确保', '别忘了', 'be careful', 'make sure', 'don\'t forget']

function isDefensiveLesson(lesson: string): boolean {
  const lower = lesson.toLowerCase()
  return DEFENSIVE_WORDS.some(w => lower.includes(w))
}

function classifySource(entry: FailureEntry): ExperienceSource {
  const err = entry.error.toLowerCase()
  if (err.includes('ts2') || err.includes('tsc') || err.includes('type error')) return 'typecheck'
  if (err.includes('test') || err.includes('assert')) return 'test-failure'
  if (err.includes('review') || err.includes('finding')) return 'review-gate'
  if (err.includes('delivery') || err.includes('gate')) return 'delivery-gate'
  return 'self-correction'
}

/**
 * Distill FailureJournal entries into diagnostic PlaybookBullets.
 *
 * Only entries with detected patterns (anchoring/rework) or repeated
 * error classes (2+ occurrences) are distilled. Single-occurrence
 * failures are noise and not worth persisting.
 *
 * Output is diagnostic ("when X, root cause is likely Y") not defensive
 * ("be careful with X"). Defensive lessons are filtered out.
 */
export function distillFromFailures(
  entries: FailureEntry[],
  patterns: FailurePattern[],
  options: { now?: number } = {},
): PlaybookBullet[] {
  const now = options.now ?? Date.now()
  if (entries.length === 0) return []

  const bullets: PlaybookBullet[] = []
  const seen = new Set<string>()

  for (const pattern of patterns) {
    const representative = pattern.evidence[0]
    if (!representative) continue

    const lesson = `当 ${representative.error}（在 ${representative.target ?? '未知文件'}），${pattern.suggestion}`
    if (isDefensiveLesson(lesson)) continue

    const id = hashId(lesson)
    if (seen.has(id)) continue
    seen.add(id)

    bullets.push({
      id,
      createdAt: now,
      keywords: extractKeywords(`${representative.error} ${representative.target ?? ''} ${representative.context}`, 10),
      lesson,
      context: pattern.type,
      useCount: 0,
      lastUsedAt: null,
      importance: 0.6,
      source: classifySource(representative),
      errorSignal: representative.error,
      fixApproach: representative.hypothesis,
    })
  }

  const byError = new Map<string, FailureEntry[]>()
  for (const entry of entries) {
    const key = entry.error.slice(0, 80)
    const list = byError.get(key) ?? []
    list.push(entry)
    byError.set(key, list)
  }

  for (const [errorKey, group] of byError) {
    if (group.length < 2) continue
    const first = group[0]!

    const lesson = `当 ${errorKey}（出现 ${group.length} 次），根因大概率是 ${first.hypothesis ?? first.context}。检查 ${first.target ?? '相关文件'}。`
    if (isDefensiveLesson(lesson)) continue

    const id = hashId(lesson)
    if (seen.has(id)) continue
    seen.add(id)

    bullets.push({
      id,
      createdAt: now,
      keywords: extractKeywords(`${errorKey} ${first.target ?? ''} ${first.context}`, 10),
      lesson,
      context: 'recurring-error',
      useCount: 0,
      lastUsedAt: null,
      importance: 0.6,
      source: classifySource(first),
      errorSignal: errorKey,
      fixApproach: first.hypothesis,
    })
  }

  return bullets
}
