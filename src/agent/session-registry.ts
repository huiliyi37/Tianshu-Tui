import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { validateTrend } from './retrospect-fingerprint.js'

export interface SessionEntry {
  id: string
  pid: number
  role: 'coordinator' | 'worker' | 'standalone'
  taskDescription: string | null
  heartbeatAt: string
}

export interface ClaimEntry {
  sessionId: string
  claimType: 'exclusive' | 'shared_read'
  filePath: string
}

export interface EventInput {
  eventType: string
  filePath?: string
  detail?: string
  priority?: number
}

export interface EventRecord {
  id: number
  sessionId: string
  eventType: string
  filePath: string | null
  detail: string | null
  priority: number
  createdAt: string
}

export interface CycleRelayEntry {
  sessionId: string
  cycleOpen: string
  cycleClose: string | null
  generation: number
  createdAt: string
  closedAt: string | null
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  pid INTEGER NOT NULL,
  cwd TEXT NOT NULL,
  started_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('coordinator','worker','standalone')),
  task_description TEXT
);

CREATE TABLE IF NOT EXISTS claims (
  session_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK(claim_type IN ('exclusive','shared_read')),
  acquired_at TEXT NOT NULL,
  confidence_trend TEXT,
  detail TEXT,
  priority INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_claims_session ON claims(session_id);
CREATE INDEX IF NOT EXISTS idx_claims_file ON claims(file_path);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS cycle_relay (
  session_id TEXT PRIMARY KEY,
  cycle_open TEXT NOT NULL,
  cycle_close TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cycle_relay_closed ON cycle_relay(closed_at);

CREATE TABLE IF NOT EXISTS retrospect_fingerprints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  root_cause_keywords TEXT NOT NULL,
  recommendation_keywords TEXT NOT NULL,
  stability_trend TEXT NOT NULL CHECK(stability_trend IN ('stable','falling','rising')),
  confidence_trend TEXT NOT NULL CHECK(confidence_trend IN ('stable','falling','rising')),
  max_pressure REAL NOT NULL,
  tool_failure_rate REAL NOT NULL,
  bullet_ids TEXT NOT NULL DEFAULT '[]',
  UNIQUE(session_id)
);
CREATE INDEX IF NOT EXISTS idx_fingerprints_created ON retrospect_fingerprints(created_at);
`

export class SessionRegistry {
  private db: any

  static async create(stateDir: string): Promise<SessionRegistry> {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    let db: any
    try {
      const { createRequire } = require('node:module') as typeof import('node:module')
      const Database = createRequire(import.meta.url)('better-sqlite3')
      if (!Database) throw new Error('better-sqlite3 not installed')
      const dbPath = join(stateDir, 'registry.db')
      db = new Database(dbPath)
      db.pragma('journal_mode = WAL')
      db.pragma('busy_timeout = 3000')
      db.pragma('foreign_keys = ON')
      db.exec(SCHEMA)
    } catch (err) {
      // Distinguish "library missing" from "schema execution failed"
      if (err instanceof Error && err.message?.includes('better-sqlite3')) {
        console.warn('⚠ better-sqlite3 not available. Session registry disabled — running in memory-only mode.')
      } else {
        console.error('Session registry schema failed:', err)
      }
      db = createNullDb()
    }
    return new SessionRegistry(db)
  }

  private constructor(db: any) {
    this.db = db
  }

  register(sessionId: string, cwd: string, role: 'coordinator' | 'worker' | 'standalone' = 'standalone'): void {
    const now = new Date().toISOString()
    this.db.prepare(`
      INSERT INTO sessions (id, pid, cwd, started_at, heartbeat_at, role)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        pid = excluded.pid,
        cwd = excluded.cwd,
        heartbeat_at = excluded.heartbeat_at,
        role = excluded.role
    `).run(sessionId, process.pid, cwd, now, now, role)
  }

  heartbeat(sessionId: string): void {
    const now = new Date().toISOString()
    this.db.prepare('UPDATE sessions SET heartbeat_at = ? WHERE id = ?').run(now, sessionId)
  }

  unregister(sessionId: string): void {
    this.releaseAllClaims(sessionId)
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId)
  }

  updatePid(sessionId: string, pid: number): void {
    this.db.prepare('UPDATE sessions SET pid = ? WHERE id = ?').run(pid, sessionId)
  }

  listActive(): SessionEntry[] {
    return this.db.prepare('SELECT id, pid, role, task_description AS taskDescription, heartbeat_at AS heartbeatAt FROM sessions').all() as SessionEntry[]
  }

  detectCrashedSessions(): SessionEntry[] {
    const sessions = this.listActive()
    const crashed: SessionEntry[] = []
    for (const s of sessions) {
      if (!this.isProcessRunning(s.pid)) {
        crashed.push(s)
      }
    }
    // Reap crashed sessions (cascades to claims)
    if (crashed.length > 0) {
      const ids = crashed.map(s => s.id)
      const placeholders = ids.map(() => '?').join(',')
      this.db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids)
    }
    return crashed
  }

  acquireClaim(sessionId: string, filePath: string, claimType: 'exclusive' | 'shared_read'): boolean {
    // Check existing claims
    const existing = this.db.prepare(
      'SELECT session_id, claim_type FROM claims WHERE file_path = ?'
    ).all(filePath) as Array<{ session_id: string; claim_type: string }>

    for (const c of existing) {
      if (c.session_id === sessionId) return true // same session re-acquires
      if (c.claim_type === 'exclusive') return false // file exclusively locked by another
      if (claimType === 'exclusive') return false // want exclusive but shared_read exists
    }

    const now = new Date().toISOString()
    this.db.prepare(
      'INSERT OR REPLACE INTO claims (session_id, file_path, claim_type, acquired_at) VALUES (?, ?, ?, ?)'
    ).run(sessionId, filePath, claimType, now)
    return true
  }

  releaseClaim(sessionId: string, filePath: string): void {
    this.db.prepare('DELETE FROM claims WHERE session_id = ? AND file_path = ?').run(sessionId, filePath)
  }

  releaseAllClaims(sessionId: string): void {
    this.db.prepare('DELETE FROM claims WHERE session_id = ?').run(sessionId)
  }

  checkClaim(filePath: string): ClaimEntry | null {
    const row = this.db.prepare(
      'SELECT session_id AS sessionId, claim_type AS claimType, file_path AS filePath FROM claims WHERE file_path = ? LIMIT 1'
    ).get(filePath) as ClaimEntry | undefined
    return row ?? null
  }

  reapStaleClaims(): string[] {
    const sessions = this.listActive()
    const deadIds: string[] = []
    for (const s of sessions) {
      if (!this.isProcessRunning(s.pid)) {
        deadIds.push(s.id)
      }
    }
    if (deadIds.length === 0) return []

    // Collect files held by dead sessions
    const placeholders = deadIds.map(() => '?').join(',')
    const rows = this.db.prepare(
      `SELECT DISTINCT file_path FROM claims WHERE session_id IN (${placeholders})`
    ).all(...deadIds) as Array<{ file_path: string }>

    // Delete dead sessions (cascades to claims)
    this.db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...deadIds)

    return rows.map(r => r.file_path)
  }

  close(): void {
    this.db.close()
  }

  // ── Events (cross-session communication) ──────────────────

  publishEvent(sessionId: string, input: EventInput): void {
    this.db.prepare(`
      INSERT INTO events (session_id, event_type, file_path, detail, priority)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, input.eventType, input.filePath ?? null, input.detail ?? null, input.priority ?? 0)
  }

  consumeEvents(mySessionId: string, lastSeenId: number, limit = 50): EventRecord[] {
    return this.db.prepare(`
      SELECT id, session_id AS sessionId, event_type AS eventType,
             file_path AS filePath, detail, priority, created_at AS createdAt
      FROM events
      WHERE id > ? AND session_id != ?
      ORDER BY id ASC
      LIMIT ?
    `).all(lastSeenId, mySessionId, limit) as EventRecord[]
  }

  cleanupOldEvents(maxAgeMs: number): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString()
    const result = this.db.prepare('DELETE FROM events WHERE created_at < ?').run(cutoff)
    return result.changes
  }

  // ── Cycle relay (Songline substrate) ─────────────────────

  setCycleOpen(sessionId: string, cycleOpen: string, generation = 0): void {
    this.db.prepare(`
      INSERT INTO cycle_relay (session_id, cycle_open, generation)
      VALUES (?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        cycle_open = excluded.cycle_open,
        generation = excluded.generation
    `).run(sessionId, cycleOpen, generation)
  }

  setCycleClose(sessionId: string, cycleClose: string): void {
    this.db.prepare(`
      INSERT INTO cycle_relay (session_id, cycle_open, cycle_close, generation, closed_at)
      VALUES (?, ?, ?, 0, datetime('now'))
      ON CONFLICT(session_id) DO UPDATE SET
        cycle_close = excluded.cycle_close,
        generation = cycle_relay.generation + 1,
        closed_at = excluded.closed_at
    `).run(sessionId, cycleClose, cycleClose)
  }

  getCycleOpen(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT cycle_open AS cycleOpen FROM cycle_relay WHERE session_id = ?'
    ).get(sessionId) as { cycleOpen: string } | undefined
    return row?.cycleOpen ?? null
  }

  getCycleClose(sessionId: string): string | null {
    const row = this.db.prepare(
      'SELECT cycle_close AS cycleClose FROM cycle_relay WHERE session_id = ?'
    ).get(sessionId) as { cycleClose: string | null } | undefined
    return row?.cycleClose ?? null
  }

  getLastCycleClose(): string | null {
    const row = this.db.prepare(`
      SELECT cycle_close AS cycleClose
      FROM cycle_relay
      WHERE cycle_close IS NOT NULL
      ORDER BY closed_at DESC, created_at DESC
      LIMIT 1
    `).get() as { cycleClose: string } | undefined
    return row?.cycleClose ?? null
  }

  getCycleRelay(sessionId: string): CycleRelayEntry | null {
    const row = this.db.prepare(`
      SELECT session_id AS sessionId,
             cycle_open AS cycleOpen,
             cycle_close AS cycleClose,
             generation,
             created_at AS createdAt,
             closed_at AS closedAt
      FROM cycle_relay
      WHERE session_id = ?
    `).get(sessionId) as CycleRelayEntry | undefined
    return row ?? null
  }

  // ── Cross-session claims snapshot for prompt injection ──

  /**
   * Return all active claims grouped by file, excluding claims held by `mySessionId`.
   * Used for prompt injection so the LLM can see which files other sessions are working on.
   */
  getActiveClaims(excludeSessionId: string): Array<{ sessionId: string; filePath: string; claimType: string }> {
    const rows = this.db.prepare(`
      SELECT c.session_id AS sessionId, c.file_path AS filePath, c.claim_type AS claimType
      FROM claims c
      JOIN sessions s ON s.id = c.session_id
      WHERE c.session_id != ?
    `).all(excludeSessionId) as Array<{ sessionId: string; filePath: string; claimType: string }>
    return rows
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  // ── Retrospect Fingerprints (REM pattern detection) ──────

  /**
   * 存储 session 的 retrospect 指纹。
   * 如果该 session 已有指纹，会被覆盖（UPSERT）。
   */
  storeFingerprint(fp: {
    sessionId: string
    createdAt: number
    rootCauseKeywords: string[]
    recommendationKeywords: string[]
    stabilityTrend: 'stable' | 'falling' | 'rising'
    confidenceTrend: 'stable' | 'falling' | 'rising'
    maxPressure: number
    toolFailureRate: number
    bulletIds: string[]
  }): void {
    this.db.prepare(`
      INSERT INTO retrospect_fingerprints
        (session_id, created_at, root_cause_keywords, recommendation_keywords,
         stability_trend, confidence_trend, max_pressure, tool_failure_rate, bullet_ids)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        created_at = excluded.created_at,
        root_cause_keywords = excluded.root_cause_keywords,
        recommendation_keywords = excluded.recommendation_keywords,
        stability_trend = excluded.stability_trend,
        confidence_trend = excluded.confidence_trend,
        max_pressure = excluded.max_pressure,
        tool_failure_rate = excluded.tool_failure_rate,
        bullet_ids = excluded.bullet_ids
    `).run(
      fp.sessionId,
      fp.createdAt,
      JSON.stringify(fp.rootCauseKeywords),
      JSON.stringify(fp.recommendationKeywords),
      fp.stabilityTrend,
      fp.confidenceTrend,
      fp.maxPressure,
      fp.toolFailureRate,
      JSON.stringify(fp.bulletIds),
    )
  }

  /**
   * 加载历史指纹，按时间倒序。
   * @param limit 最多返回的指纹数量（默认 10）
   * @param excludeSessionId 排除的 session ID（通常是当前 session）
   */
  loadFingerprints(limit = 10, excludeSessionId?: string): Array<{
    sessionId: string
    createdAt: number
    rootCauseKeywords: string[]
    recommendationKeywords: string[]
    stabilityTrend: 'stable' | 'falling' | 'rising'
    confidenceTrend: 'stable' | 'falling' | 'rising'
    maxPressure: number
    toolFailureRate: number
    bulletIds: string[]
  }> {
    const query = excludeSessionId
      ? `SELECT session_id, created_at, root_cause_keywords, recommendation_keywords,
                stability_trend, confidence_trend, max_pressure, tool_failure_rate, bullet_ids
         FROM retrospect_fingerprints
         WHERE session_id != ?
         ORDER BY created_at DESC
         LIMIT ?`
      : `SELECT session_id, created_at, root_cause_keywords, recommendation_keywords,
                stability_trend, confidence_trend, max_pressure, tool_failure_rate, bullet_ids
         FROM retrospect_fingerprints
         ORDER BY created_at DESC
         LIMIT ?`

    const rows = excludeSessionId
      ? this.db.prepare(query).all(excludeSessionId, limit) as Array<Record<string, unknown>>
      : this.db.prepare(query).all(limit) as Array<Record<string, unknown>>

    return rows.map(row => ({
      sessionId: row.session_id as string,
      createdAt: row.created_at as number,
      rootCauseKeywords: JSON.parse(row.root_cause_keywords as string) as string[],
      recommendationKeywords: JSON.parse(row.recommendation_keywords as string) as string[],
      stabilityTrend: validateTrend(row.stability_trend as string, 'stable'),
      confidenceTrend: validateTrend(row.confidence_trend as string, 'stable'),
      maxPressure: row.max_pressure as number,
      toolFailureRate: row.tool_failure_rate as number,
      bulletIds: JSON.parse(row.bullet_ids as string) as string[],
    }))
  }

  /**
   * 清理旧指纹。
   * @param maxAgeMs 最大保留时间（毫秒）
   * @returns 删除的指纹数量
   */
  cleanupOldFingerprints(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs
    const result = this.db.prepare('DELETE FROM retrospect_fingerprints WHERE created_at < ?').run(cutoff)
    return result.changes
    return result.changes
  }
}

/**
 * Creates a no-op database proxy when better-sqlite3 is unavailable.
 * All method calls succeed silently — session features degrade gracefully.
 */
function createNullDb(): any {
  const noopStmt = { run: () => {}, all: () => [] as any[], get: () => undefined }
  return new Proxy(Object.create(null), {
    get: (_target, prop: string) => {
      if (prop === 'prepare') return () => noopStmt
      if (prop === 'exec') return () => {}
      if (prop === 'pragma') return () => {}
      if (prop === 'close') return () => {}
      return () => {}
    },
  })
}

