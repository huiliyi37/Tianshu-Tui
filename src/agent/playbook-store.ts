import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writeFileAtomicSync } from '../fs-atomic.js'
import {
  decayImportance,
  deduplicateBullets,
  enforceCapacity,
  matchBullets,
  type PlaybookBullet,
  type ExperienceSource,
} from './playbook.js'

export interface PlaybookStoreOptions {
  capacity?: number
  now?: () => number
}

const DEFAULT_PLAYBOOK_CAPACITY = 50

const playbookBulletSchema = z.object({
  id: z.string().min(1),
  createdAt: z.number(),
  keywords: z.array(z.string()),
  lesson: z.string().min(1),
  context: z.string().min(1),
  useCount: z.number().int().min(0),
  lastUsedAt: z.number().nullable(),
  importance: z.number().min(0).max(1),
  details: z.string().optional(),
  bulletIds: z.array(z.string()).optional(),
  source: z.enum(['review-gate', 'test-failure', 'typecheck', 'delivery-gate', 'self-correction'] satisfies [ExperienceSource, ...ExperienceSource[]]).optional(),
  errorSignal: z.string().optional(),
  fixApproach: z.string().optional(),
}) satisfies z.ZodType<PlaybookBullet>

export function playbookPathForCwd(cwd: string): string {
  return join(cwd, '.rivet', 'playbook.jsonl')
}

export class PlaybookStore {
  private readonly filePath: string
  private readonly capacity: number
  private readonly now: () => number

  constructor(cwdOrFilePath: string, options: PlaybookStoreOptions = {}) {
    this.filePath = cwdOrFilePath.endsWith('.jsonl')
      ? cwdOrFilePath
      : playbookPathForCwd(cwdOrFilePath)
    this.capacity = options.capacity ?? DEFAULT_PLAYBOOK_CAPACITY
    this.now = options.now ?? Date.now
  }

  load(): PlaybookBullet[] {
    if (!existsSync(this.filePath)) return []
    const raw = readFileSync(this.filePath, 'utf-8')
    const bullets: PlaybookBullet[] = []
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as unknown
        const bullet = playbookBulletSchema.parse(parsed)
        bullets.push(bullet)
      } catch {
        // Ignore malformed historical lines; one corrupt lesson should not break startup.
      }
    }
    return bullets
  }

  save(bullets: PlaybookBullet[]): void {
    const lines = bullets.map(bullet => JSON.stringify(playbookBulletSchema.parse(bullet)))
    writeFileAtomicSync(this.filePath, lines.length > 0 ? `${lines.join('\n')}\n` : '')
  }

  addBullets(incoming: PlaybookBullet[]): void {
    const existing = decayImportance(this.load(), this.now())
    const merged = deduplicateBullets(existing, incoming)
    this.save(enforceCapacity(merged, this.capacity))
  }

  query(keywords: string[], topK = 3, options: { minImportance?: number } = {}): PlaybookBullet[] {
    const playbook = this.load()
    return matchBullets(playbook, keywords, topK, { minImportance: options.minImportance })
  }

  recordUsage(ids: string[]): void {
    const idSet = new Set(ids)
    if (idSet.size === 0) return
    const now = this.now()
    const playbook = this.load()
    this.save(playbook.map(b => idSet.has(b.id)
      ? {
          ...b,
          useCount: b.useCount + 1,
          lastUsedAt: now,
          importance: Math.min(1, b.importance + 0.05),
        }
      : b))
  }
}
