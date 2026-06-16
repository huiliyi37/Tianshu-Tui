/**
 * File-backed durable store for desktop sessions (N1).
 *
 * Layout (one dir per session):
 *   <baseDir>/<id>/index.json   — latest SessionRecord snapshot
 *   <baseDir>/<id>/events.jsonl — append-only event log (one JSON per line)
 *
 * Robustness contract (asserted by tests):
 *  - A corrupt/partial trailing line in events.jsonl is dropped, never throws.
 *  - A missing/corrupt index.json is reconstructed from the event tail.
 *  - seq never regresses: events are sorted and the max seq wins.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type {
  PersistedSession,
  SessionEvent,
  SessionPersistenceAdapter,
  SessionRecord,
} from './session-manager.js'

export class FileSessionPersistence implements SessionPersistenceAdapter {
  constructor(private readonly baseDir: string) {}

  private dir(id: string): string {
    return join(this.baseDir, sanitize(id))
  }

  private ensureDir(id: string): string {
    const d = this.dir(id)
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    return d
  }

  saveRecord(record: SessionRecord): void {
    const d = this.ensureDir(record.id)
    const tmp = join(d, 'index.json.tmp')
    const final = join(d, 'index.json')
    // tmp + rename → readers never see a half-written index.json
    writeFileSync(tmp, JSON.stringify(record), 'utf8')
    renameSync(tmp, final)
  }

  appendEvent(sessionId: string, event: SessionEvent): void {
    const d = this.ensureDir(sessionId)
    appendFileSync(join(d, 'events.jsonl'), JSON.stringify(event) + '\n', 'utf8')
  }

  saveImage(sessionId: string, imgId: string, base64: string, mime: string): void {
    const d = join(this.ensureDir(sessionId), 'images')
    if (!existsSync(d)) mkdirSync(d, { recursive: true })
    const ext = extForMime(mime)
    writeFileSync(join(d, `${sanitize(imgId)}.${ext}`), Buffer.from(base64, 'base64'))
  }

  readImage(sessionId: string, imgId: string): { bytes: Buffer; mime: string } | undefined {
    const dir = join(this.dir(sessionId), 'images')
    const safe = sanitize(imgId)
    for (const [ext, mime] of EXT_MIME) {
      const file = join(dir, `${safe}.${ext}`)
      if (existsSync(file)) {
        try {
          return { bytes: readFileSync(file), mime }
        } catch {
          return undefined
        }
      }
    }
    return undefined
  }

  loadAll(): PersistedSession[] {
    if (!existsSync(this.baseDir)) return []
    const out: PersistedSession[] = []
    let entries: string[]
    try {
      entries = readdirSync(this.baseDir)
    } catch {
      return []
    }
    for (const id of entries) {
      const d = join(this.baseDir, id)
      const events = this.readEvents(d)
      const record = this.readRecord(d, id, events)
      if (record) out.push({ record, events })
    }
    return out
  }

  private readEvents(dir: string): SessionEvent[] {
    const file = join(dir, 'events.jsonl')
    if (!existsSync(file)) return []
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const events: SessionEvent[] = []
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as SessionEvent
        if (parsed && typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
          events.push(parsed)
        }
      } catch {
        // corrupt/partial line (e.g. crash mid-write) — drop it, keep the rest
      }
    }
    events.sort((a, b) => a.seq - b.seq)
    return events
  }

  private readRecord(dir: string, id: string, events: SessionEvent[]): SessionRecord | null {
    const file = join(dir, 'index.json')
    if (existsSync(file)) {
      try {
        const rec = JSON.parse(readFileSync(file, 'utf8')) as SessionRecord
        if (rec && typeof rec.id === 'string') return rec
      } catch {
        // fall through to reconstruction
      }
    }
    // No usable index.json — reconstruct a minimal record from the event tail
    // so a partially-written session is still listable rather than lost.
    if (events.length === 0) return null
    const last = events[events.length - 1]!
    const first = events[0]!
    return {
      id,
      status: 'aborted',
      createdAt: first.ts,
      updatedAt: last.ts,
      cwd: process.cwd(),
      lastSeq: last.seq,
      pendingApprovals: 0,
    }
  }
}

function sanitize(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** Provider-safe image MIMEs ↔ file extensions (single source of truth). */
const EXT_MIME: ReadonlyArray<readonly [string, string]> = [
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['webp', 'image/webp'],
  ['gif', 'image/gif'],
]

function extForMime(mime: string): string {
  const hit = EXT_MIME.find(([, m]) => m === mime)
  return hit ? hit[0] : 'png'
}
