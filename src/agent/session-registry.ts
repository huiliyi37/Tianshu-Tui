import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

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
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  claim_type TEXT NOT NULL CHECK(claim_type IN ('exclusive','shared_read')),
  acquired_at TEXT NOT NULL,
  PRIMARY KEY(session_id, file_path)
);

CREATE INDEX IF NOT EXISTS idx_claims_file ON claims(file_path, claim_type);
CREATE INDEX IF NOT EXISTS idx_sessions_pid ON sessions(pid);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  file_path TEXT,
  detail TEXT,
  priority INTEGER DEFAULT 0,
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
`

export class SessionRegistry {
  private db: any

  static async create(stateDir: string): Promise<SessionRegistry> {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    const { default: Database } = await import('better-sqlite3')
    const dbPath = join(stateDir, 'registry.db')
    const db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('busy_timeout = 3000')
    db.pragma('foreign_keys = ON')
    db.exec(SCHEMA)
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

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
}
