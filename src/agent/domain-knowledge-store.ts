/**
 * Domain Knowledge Store — per-domain experience accumulation (V3 Component B).
 *
 * Storage model: one JSONL file per domain under .rivet/knowledge/domains/<id>.jsonl
 * Reuses three paradigms:
 *   - StigmergyStore: exponential decay (computeCurrentStrength)
 *   - project-memory-writer: lock + atomic write + monotonic append
 *   - dream: high-gate distillation (only high-confidence + evidence)
 *
 * Design constraints (from spec §6):
 *   - Per-domain namespace isolation (no cross-domain pollution)
 *   - Lock + atomic write + monotonic append (canonical invariant)
 *   - Dedup by id (hash of domainId + canonical text) → reinforce on match
 *   - Grade: novice → journeyman → expert (by independent reinforcement count)
 *   - Decay lets stale lessons naturally age out
 *   - Write does not block return (debounced 200ms + flushSync on exit)
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomBytes, createHash } from 'node:crypto'
import { computeCurrentStrength } from '../context/stigmergy.js'
import type { StarDomainId } from './star-domain.js'

// ─── Types ──────────────────────────────────────────────────────

export type DomainLessonKind =
  | 'defect_pattern'     // tianquan/tianfu: codebase defect patterns
  | 'invariant'          // tianfu: must-hold invariants
  | 'adversarial_input'  // pojun: inputs that break things
  | 'selection_rule'     // tianquan: judgment/trade-off rules
  | 'reframe'            // tianxuan/tianji: blind-spot / perspective shift

export type DomainGrade = 'novice' | 'journeyman' | 'expert'

export interface DomainLesson {
  /** Dedup key: hash(domainId + canonical text) */
  id: string
  domainId: string
  kind: DomainLessonKind
  /** One reusable judgment, ≤200 chars */
  text: string
  /** file:line / command / counterexample */
  evidence: string
  /** 0-1, refreshed on reinforce, decays over time */
  strength: number
  /** Independent re-discovery count */
  reinforcement: number
  grade: DomainGrade
  depositedAt: number
  halfLifeMs: number
}

export interface DepositInput {
  domainId: string
  kind: DomainLessonKind
  text: string
  evidence: string
  halfLifeMs?: number
}

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_HALF_LIFE_MS = 604_800_000 // 7 days (same as stigmergy)
const PRUNE_THRESHOLD = 0.05
const MAX_PER_DOMAIN = 100
const MAX_TEXT_LENGTH = 200
const MAX_EVIDENCE_LENGTH = 300
const LOCK_RETRY_MAX_MS = 500
const LOCK_RETRY_INTERVAL_MS = 20
const LOCK_STALE_TTL_MS = 30_000
const DEBOUNCE_MS = 200
const DOMAIN_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/
const REDACTED = '[redacted]'

// Grade thresholds
const GRADE_THRESHOLDS: Array<{ min: number; grade: DomainGrade }> = [
  { min: 4, grade: 'expert' },
  { min: 2, grade: 'journeyman' },
  { min: 1, grade: 'novice' },
]

// ─── Helpers ────────────────────────────────────────────────────

function computeGrade(reinforcement: number): DomainGrade {
  for (const t of GRADE_THRESHOLDS) {
    if (reinforcement >= t.min) return t.grade
  }
  return 'novice'
}

function sanitizeDomainId(domainId: string): string | null {
  const trimmed = domainId.trim()
  return DOMAIN_ID_RE.test(trimmed) ? trimmed : null
}

function redactSecrets(text: string): string {
  return text
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*)[^\s,'\"]+/gi, `$1${REDACTED}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, 'sk-xxx')
}

function lessonId(domainId: string, text: string): string {
  const canonical = text.toLowerCase().replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(`${domainId}:${canonical}`).digest('hex').slice(0, 16)
}

interface LockHandle {
  acquired: boolean
  release: () => void
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function shouldBreakStaleLock(lockPath: string, now: number): boolean {
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim()
    const pid = Number.parseInt(raw, 10)
    if (!isProcessAlive(pid)) return true
  } catch {
    // Unreadable/malformed lock files should not permanently wedge writes;
    // the age check below still protects active freshly-created locks.
  }

  try {
    return now - statSync(lockPath).mtimeMs > LOCK_STALE_TTL_MS
  } catch {
    return true
  }
}

function acquireLock(lockPath: string): LockHandle {
  const start = Date.now()
  let staleChecked = false
  while (true) {
    try {
      const fd = openSync(lockPath, 'wx')
      try {
        writeFileSync(fd, String(process.pid), 'utf-8')
      } finally {
        closeSync(fd)
      }
      return { acquired: true, release: () => { try { unlinkSync(lockPath) } catch { /* already released */ } } }
    } catch {
      const now = Date.now()
      if (!staleChecked && shouldBreakStaleLock(lockPath, now)) {
        staleChecked = true
        try { unlinkSync(lockPath) } catch { /* raced with another lock owner */ }
        continue
      }
      if (now - start > LOCK_RETRY_MAX_MS) return { acquired: false, release: () => {} }
      const waitUntil = now + LOCK_RETRY_INTERVAL_MS
      while (Date.now() < waitUntil) { /* spin */ }
    }
  }
}

function mergeLessons(existing: DomainLesson[], incoming: DomainLesson[]): DomainLesson[] {
  const byId = new Map<string, DomainLesson>()
  for (const lesson of existing) byId.set(lesson.id, lesson)
  for (const lesson of incoming) {
    const prev = byId.get(lesson.id)
    if (!prev) {
      byId.set(lesson.id, lesson)
      continue
    }
    const reinforcement = Math.max(prev.reinforcement, lesson.reinforcement)
    byId.set(lesson.id, {
      ...prev,
      ...lesson,
      reinforcement,
      strength: Math.max(prev.strength, lesson.strength),
      grade: computeGrade(reinforcement),
      depositedAt: Math.max(prev.depositedAt, lesson.depositedAt),
    })
  }
  return [...byId.values()]
}

function atomicWrite(targetPath: string, content: string): void {
  const dir = dirname(targetPath)
  const tmpName = `.domain.${randomBytes(4).toString('hex')}.tmp`
  const tmpPath = join(dir, tmpName)
  try {
    writeFileSync(tmpPath, content, 'utf-8')
    renameSync(tmpPath, targetPath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore cleanup failure */ }
    throw err
  }
}

function parseLessons(raw: string): DomainLesson[] {
  return raw.split('\n')
    .filter(l => l.trim())
    .map(line => {
      try { return JSON.parse(line) as DomainLesson }
      catch { return null }
    })
    .filter((e): e is DomainLesson => e !== null && typeof e.id === 'string' && typeof e.text === 'string')
}

// ─── DomainKnowledgeStore ───────────────────────────────────────

export class DomainKnowledgeStore {
  private cache = new Map<string, DomainLesson[]>()
  private dirty = new Set<string>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private baseDir: string) {}

  // ── Core operations ──────────────────────────────────────────

  /** Deposit a lesson. If dedup key matches existing, reinforce instead. */
  deposit(input: DepositInput): void {
    const { kind, text, evidence, halfLifeMs } = input
    const domainId = sanitizeDomainId(input.domainId)
    if (!domainId) return
    const truncatedText = redactSecrets(text).slice(0, MAX_TEXT_LENGTH).trim()
    const truncatedEvidence = redactSecrets(evidence).slice(0, MAX_EVIDENCE_LENGTH).trim()
    if (!truncatedText) return

    const id = lessonId(domainId, truncatedText)
    const lessons = this.loadDomain(domainId)
    const existing = lessons.find(l => l.id === id)

    if (existing) {
      // Reinforce: bump count, refresh strength, maybe upgrade grade
      existing.reinforcement++
      existing.strength = Math.min(1, existing.strength + 0.2)
      existing.grade = computeGrade(existing.reinforcement)
      existing.evidence = truncatedEvidence || existing.evidence
      existing.depositedAt = Date.now()
    } else {
      lessons.push({
        id,
        domainId,
        kind,
        text: truncatedText,
        evidence: truncatedEvidence,
        strength: 0.5,
        reinforcement: 1,
        grade: 'novice',
        depositedAt: Date.now(),
        halfLifeMs: halfLifeMs ?? DEFAULT_HALF_LIFE_MS,
      })
    }

    const nextLessons = lessons.length > MAX_PER_DOMAIN
      ? this.compactLessons(lessons).kept
      : lessons
    this.cache.set(domainId, nextLessons)
    this.dirty.add(domainId)
    this.scheduleFlush()
  }

  /** Recall top-K lessons for a domain, sorted by grade×decay strength. */
  recall(domainId: string, topK = 8): DomainLesson[] {
    const safeDomainId = sanitizeDomainId(domainId)
    if (!safeDomainId) return []
    const lessons = this.loadDomain(safeDomainId)
    const now = Date.now()

    return lessons
      .map(l => ({
        ...l,
        currentStrength: computeCurrentStrength(l.strength, now - l.depositedAt, l.halfLifeMs),
      }))
      .sort((a, b) => {
        // Grade weight: expert=3, journeyman=2, novice=1
        const gw = (g: DomainGrade) => g === 'expert' ? 3 : g === 'journeyman' ? 2 : 1
        const scoreA = gw(a.grade) * a.currentStrength
        const scoreB = gw(b.grade) * b.currentStrength
        return scoreB - scoreA
      })
      .slice(0, topK)
  }

  /** Compact: dedup + cap per-domain + prune decayed. Returns number pruned. */
  compact(domainId: string): number {
    const safeDomainId = sanitizeDomainId(domainId)
    if (!safeDomainId) return 0
    const { kept, pruned } = this.compactLessons(this.loadDomain(safeDomainId))
    if (pruned > 0) {
      this.cache.set(safeDomainId, kept)
      this.dirty.add(safeDomainId)
      this.scheduleFlush()
    }
    return pruned
  }

  private compactLessons(lessons: DomainLesson[]): { kept: DomainLesson[]; pruned: number } {
    const now = Date.now()

    // Dedup by id (keep highest reinforcement)
    const byId = new Map<string, DomainLesson>()
    for (const l of lessons) {
      const existing = byId.get(l.id)
      if (!existing || l.reinforcement > existing.reinforcement) {
        byId.set(l.id, l)
      }
    }

    // Sort by grade×strength desc, cap
    const kept = [...byId.values()]
      .filter(l => computeCurrentStrength(l.strength, now - l.depositedAt, l.halfLifeMs) >= PRUNE_THRESHOLD)
      .sort((a, b) => {
        const gw = (g: DomainGrade) => g === 'expert' ? 3 : g === 'journeyman' ? 2 : 1
        return (gw(b.grade) * b.strength) - (gw(a.grade) * a.strength)
      })
      .slice(0, MAX_PER_DOMAIN)

    return { kept, pruned: lessons.length - kept.length }
  }

  // ── Persistence ──────────────────────────────────────────────

  private domainPath(domainId: string): string {
    const safeDomainId = sanitizeDomainId(domainId)
    if (!safeDomainId) throw new Error(`Invalid domain id: ${domainId}`)
    return join(this.baseDir, 'domains', `${safeDomainId}.jsonl`)
  }

  private lockPath(domainId: string): string {
    const safeDomainId = sanitizeDomainId(domainId)
    if (!safeDomainId) throw new Error(`Invalid domain id: ${domainId}`)
    return join(this.baseDir, 'domains', `${safeDomainId}.jsonl.lock`)
  }

  private loadDomain(domainId: string): DomainLesson[] {
    const cached = this.cache.get(domainId)
    if (cached) return cached

    const path = this.domainPath(domainId)
    try {
      const raw = readFileSync(path, 'utf-8')
      const lessons = parseLessons(raw)
      this.cache.set(domainId, lessons)
      return lessons
    } catch {
      this.cache.set(domainId, [])
      return []
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      try {
        this.flushDirty()
      } catch {
        // Keep background flush failures from crashing the process. Entries stay
        // dirty and flushSync() / the next deposit can retry with a fresh lock.
      }
    }, DEBOUNCE_MS)
  }

  private flushDirty(): void {
    const flushed = new Set<string>()
    for (const domainId of this.dirty) {
      const lessons = this.cache.get(domainId)
      if (!lessons) continue
      const path = this.domainPath(domainId)
      const lockPath = this.lockPath(domainId)
      try {
        mkdirSync(dirname(path), { recursive: true })
        const lock = acquireLock(lockPath)
        if (!lock.acquired) continue
        try {
          const diskLessons = existsSync(path) ? parseLessons(readFileSync(path, 'utf-8')) : []
          const merged = mergeLessons(diskLessons, lessons)
          const { kept } = this.compactLessons(merged)
          atomicWrite(path, kept.map(l => JSON.stringify(l)).join('\n') + '\n')
          this.cache.set(domainId, kept)
          flushed.add(domainId)
        } finally {
          lock.release()
        }
      } catch {
        // Writer-health gate: background or exit flush failures must not crash
        // the agent. Keep this domain dirty so a later flush can retry.
      }
    }
    for (const domainId of flushed) this.dirty.delete(domainId)
  }

  /** Force-flush pending writes. Call before process exit. */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    this.flushDirty()
  }

  /** List domain ids that have knowledge files on disk. */
  listDomainIds(): string[] {
    const dir = join(this.baseDir, 'domains')
    try {
      return readdirSync(dir)
        .filter(f => f.endsWith('.jsonl'))
        .map(f => f.replace('.jsonl', ''))
    } catch {
      return []
    }
  }
}
