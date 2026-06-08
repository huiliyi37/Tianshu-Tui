import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import type { ParseResult, MeridianSymbol, MeridianEdge, EdgeConfidence } from './meridian-types.js'
import type { ModuleSummaryEntry, CliEntry } from './meridian-types.js'
import type { PhysarumEdgeState, PhysarumPredictionObservation } from './physarum-types.js'
import type { ImmuneMemory } from '../agent/immune-types.js'
import type { MistakeEntry } from '../agent/mistake-notebook.js'
import type { ToolPatternMinerSnapshot } from '../agent/tool-pattern-miner.js'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  indexed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS symbols (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  file_path TEXT NOT NULL,
  line INTEGER NOT NULL,
  exported INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

CREATE TABLE IF NOT EXISTS edges (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  confidence TEXT NOT NULL DEFAULT 'extracted',
  PRIMARY KEY(source_id, target_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target_id);

CREATE TABLE IF NOT EXISTS access_log (
  file_path TEXT NOT NULL,
  accessed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_access_file ON access_log(file_path);

CREATE TABLE IF NOT EXISTS co_edits (
  file_a TEXT NOT NULL,
  file_b TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  last_turn INTEGER NOT NULL,
  PRIMARY KEY(file_a, file_b)
);
CREATE INDEX IF NOT EXISTS idx_co_edits_a ON co_edits(file_a);
CREATE INDEX IF NOT EXISTS idx_co_edits_b ON co_edits(file_b);

CREATE TABLE IF NOT EXISTS physarum_edges (
  file_a TEXT NOT NULL,
  file_b TEXT NOT NULL,
  weight REAL NOT NULL,
  flow REAL NOT NULL DEFAULT 0,
  consolidated INTEGER NOT NULL DEFAULT 0,
  activation_count INTEGER NOT NULL DEFAULT 0,
  last_activated_turn INTEGER NOT NULL DEFAULT 0,
  direction REAL NOT NULL DEFAULT 0,
  PRIMARY KEY(file_a, file_b)
);

CREATE TABLE IF NOT EXISTS physarum_prediction_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_file TEXT NOT NULL,
  predicted_at_turn INTEGER NOT NULL,
  predictions_json TEXT NOT NULL,
  observed_file TEXT NOT NULL,
  observed_at_turn INTEGER NOT NULL,
  hit_rank INTEGER,
  lead_turns INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_physarum_prediction_source ON physarum_prediction_observations(source_file);
CREATE INDEX IF NOT EXISTS idx_physarum_prediction_observed ON physarum_prediction_observations(observed_file);

CREATE TABLE IF NOT EXISTS immune_memory (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  response_json TEXT NOT NULL,
  affinity_score REAL NOT NULL DEFAULT 0.5,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_immune_pattern ON immune_memory(pattern);

CREATE TABLE IF NOT EXISTS mistake_entries (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  error TEXT NOT NULL,
  context TEXT NOT NULL,
  resolution TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_mistake_error ON mistake_entries(error);

CREATE TABLE IF NOT EXISTS p3_state (
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY(kind, version)
);

CREATE TABLE IF NOT EXISTS sensorimotor_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_hash TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  success INTEGER NOT NULL,
  duration_ms INTEGER,
  turn INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sm_context ON sensorimotor_log(context_hash, tool_name);
CREATE INDEX IF NOT EXISTS idx_sm_tool ON sensorimotor_log(tool_name);

CREATE TABLE IF NOT EXISTS module_summaries (
  dir_path TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  key_exports_json TEXT NOT NULL DEFAULT '[]',
  file_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  content_hash TEXT NOT NULL DEFAULT '',
  verified_at_commit TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cli_entries (
  flag TEXT NOT NULL,
  handler TEXT NOT NULL,
  wired INTEGER NOT NULL DEFAULT 0,
  verified_at_commit TEXT,
  source_file TEXT NOT NULL,
  PRIMARY KEY(flag, source_file)
);
`

export class MeridianDb {
  private conn: any = null
  private readonly stateDir: string
  private _available = true

  constructor(stateDir: string) {
    this.stateDir = stateDir
  }

  private get db(): any {
    if (!this.conn) {
      if (!existsSync(this.stateDir)) mkdirSync(this.stateDir, { recursive: true })
      try {
        const require = createRequire(import.meta.url)
        const Database = require('better-sqlite3')
        if (!Database) throw new Error('better-sqlite3 not installed')
        const dbPath = join(this.stateDir, 'meridian.db')
        this.conn = new Database(dbPath)
        this.conn.pragma('journal_mode = WAL')
        this.conn.pragma('busy_timeout = 3000')
        this.conn.exec(SCHEMA)
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.warn(`⚠ better-sqlite3 not available. Code index (MeridianDb) disabled. Reason: ${reason}`)
        this._available = false
        this.conn = createNullDb()
      }
    }
    return this.conn
  }

  needsParse(filePath: string, contentHash: string): boolean {
    const row = this.db.prepare('SELECT content_hash FROM files WHERE path = ?').get(filePath) as { content_hash: string } | undefined
    return !row || row.content_hash !== contentHash
  }

  upsertFile(result: ParseResult): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('INSERT OR REPLACE INTO files (path, content_hash) VALUES (?, ?)').run(result.filePath, result.contentHash)
      this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(result.filePath)
      // Use GLOB instead of LIKE — LIKE treats _ as single-char wildcard,
      // causing mis-deletion of edges for similarly-named files (persistence #2).
      const escapedPath = result.filePath.replace(/[*?[]/g, '[$&]')
      this.db.prepare('DELETE FROM edges WHERE source_id GLOB ?').run(`${escapedPath}:*`)

      const insertSym = this.db.prepare('INSERT OR REPLACE INTO symbols (id, name, kind, file_path, line, exported, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const s of result.symbols) {
        insertSym.run(s.id, s.name, s.kind, s.filePath, s.line, s.exported ? 1 : 0, s.contentHash)
      }

      const insertEdge = this.db.prepare('INSERT OR REPLACE INTO edges (source_id, target_id, kind, weight, confidence) VALUES (?, ?, ?, ?, ?)')
      for (const e of result.edges) {
        insertEdge.run(e.sourceId, e.targetId, e.kind, e.weight, e.confidence ?? 'extracted')
      }

      for (const imp of result.imports) {
        const firstSymbol = result.symbols[0]
        if (firstSymbol) {
          insertEdge.run(firstSymbol.id, `${imp}:*:0`, 'imports', 1.0, 'extracted')
        }
      }
    })
    tx()
  }

  getSymbolsForFile(filePath: string): MeridianSymbol[] {
    return (this.db.prepare('SELECT * FROM symbols WHERE file_path = ?').all(filePath) as Array<Record<string, unknown>>).map(row => ({
      id: row.id as string,
      name: row.name as string,
      kind: row.kind as MeridianSymbol['kind'],
      filePath: row.file_path as string,
      line: row.line as number,
      exported: (row.exported as number) === 1,
      contentHash: row.content_hash as string,
    }))
  }

  getEdgesFrom(symbolId: string): MeridianEdge[] {
    return (this.db.prepare('SELECT * FROM edges WHERE source_id = ?').all(symbolId) as Array<Record<string, unknown>>).map(row => ({
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      kind: row.kind as MeridianEdge['kind'],
      weight: row.weight as number,
      confidence: (row.confidence as EdgeConfidence) ?? 'extracted',
    }))
  }

  getEdgesTo(symbolId: string): MeridianEdge[] {
    return (this.db.prepare('SELECT * FROM edges WHERE target_id = ?').all(symbolId) as Array<Record<string, unknown>>).map(row => ({
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      kind: row.kind as MeridianEdge['kind'],
      weight: row.weight as number,
      confidence: (row.confidence as EdgeConfidence) ?? 'extracted',
    }))
  }

  recordAccess(filePath: string): void {
    this.db.prepare('INSERT INTO access_log (file_path) VALUES (?)').run(filePath)
  }

  getAccessCount(filePath: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM access_log WHERE file_path = ?').get(filePath) as { cnt: number }
    return row.cnt
  }

  getNeighborIds(startId: string, maxHops: number): Set<string> {
    const visited = new Set<string>()
    let frontier = new Set([startId])
    for (let hop = 0; hop < maxHops; hop++) {
      const next = new Set<string>()
      for (const id of frontier) {
        const rows = this.db.prepare(
          'SELECT target_id as nid FROM edges WHERE source_id = ? UNION SELECT source_id as nid FROM edges WHERE target_id = ?',
        ).all(id, id) as Array<{ nid: string }>
        for (const r of rows) {
          if (!visited.has(r.nid) && r.nid !== startId) {
            visited.add(r.nid)
            next.add(r.nid)
          }
        }
      }
      frontier = next
    }
    return visited
  }

  getStats(): { files: number; symbols: number; edges: number } {
    const files = (this.db.prepare('SELECT COUNT(*) as cnt FROM files').get() as { cnt: number }).cnt
    const symbols = (this.db.prepare('SELECT COUNT(*) as cnt FROM symbols').get() as { cnt: number }).cnt
    const edges = (this.db.prepare('SELECT COUNT(*) as cnt FROM edges').get() as { cnt: number }).cnt
    return { files, symbols, edges }
  }

  recordCoEdit(fileA: string, fileB: string, turn: number): void {
    const [a, b] = fileA < fileB ? [fileA, fileB] : [fileB, fileA]
    this.db.prepare(`
      INSERT INTO co_edits (file_a, file_b, weight, last_turn)
      VALUES (?, ?, 1.0, ?)
      ON CONFLICT(file_a, file_b) DO UPDATE SET
        weight = MIN(weight + 0.5, 5.0),
        last_turn = excluded.last_turn
    `).run(a, b, turn)
  }

  getCoEditNeighbors(filePath: string): Array<{ file: string; weight: number }> {
    return this.db.prepare(`
      SELECT file_b as file, weight FROM co_edits WHERE file_a = ?
      UNION ALL
      SELECT file_a as file, weight FROM co_edits WHERE file_b = ?
    `).all(filePath, filePath) as Array<{ file: string; weight: number }>
  }

  getAccessHeat(filePath: string, decayHalfLifeN = 10): number {
    const rows = this.db.prepare(
      'SELECT accessed_at FROM access_log WHERE file_path = ? ORDER BY rowid DESC LIMIT 20'
    ).all(filePath) as Array<{ accessed_at: string }>
    let heat = 0
    for (let i = 0; i < rows.length; i++) {
      heat += Math.pow(0.5, i / decayHalfLifeN)
    }
    return heat
  }

  /** Get files that depend on the given file (reverse edges: who imports/calls into this file) */
  getReverseDependents(filePath: string): Array<{ file: string; kind: string; weight: number }> {
    return this.db.prepare(`
      SELECT DISTINCT
        substr(e.source_id, 1, instr(e.source_id, ':') - 1) as file,
        e.kind,
        e.weight
      FROM edges e
      WHERE e.target_id LIKE ? || ':%'
        AND substr(e.source_id, 1, instr(e.source_id, ':') - 1) != ?
    `).all(filePath, filePath) as Array<{ file: string; kind: string; weight: number }>
  }

  /** Get test files associated with a source file via tested_by edges */
  getTestsFor(filePath: string): string[] {
    const rows = this.db.prepare(`
      SELECT DISTINCT substr(e.source_id, 1, instr(e.source_id, ':') - 1) as file
      FROM edges e
      WHERE e.target_id LIKE ? || ':%' AND e.kind = 'tested_by'
    `).all(filePath) as Array<{ file: string }>
    return rows.map(r => r.file)
  }

  /** Get all indexed file paths */
  getAllFiles(): string[] {
    return (this.db.prepare('SELECT path FROM files').all() as Array<{ path: string }>).map(r => r.path)
  }

  /** Insert or update a single edge */
  upsertEdge(sourceId: string, targetId: string, kind: string, weight: number, confidence: EdgeConfidence = 'extracted'): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO edges (source_id, target_id, kind, weight, confidence) VALUES (?, ?, ?, ?, ?)'
    ).run(sourceId, targetId, kind, weight, confidence)
  }

  // ─── Codebase index (module summaries + CLI entries) ────────────────

  upsertModuleSummary(entry: ModuleSummaryEntry): void {
    this.db.prepare(`INSERT OR REPLACE INTO module_summaries (dir_path, summary, key_exports_json, file_count, status, content_hash, verified_at_commit, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`).run(
      entry.dirPath, entry.summary, JSON.stringify(entry.keyExports), entry.fileCount, entry.status, entry.contentHash, entry.verifiedAtCommit ?? null,
    )
  }

  getModuleSummaries(): ModuleSummaryEntry[] {
    const rows = this.db.prepare('SELECT * FROM module_summaries ORDER BY dir_path').all() as Array<Record<string, unknown>>
    return rows.map(r => ({
      dirPath: r.dir_path as string,
      summary: r.summary as string,
      keyExports: JSON.parse(r.key_exports_json as string) as string[],
      fileCount: r.file_count as number,
      status: r.status as string,
      contentHash: r.content_hash as string,
      verifiedAtCommit: (r.verified_at_commit as string | null) ?? undefined,
    }))
  }

  upsertCliEntry(entry: CliEntry): void {
    this.db.prepare(`INSERT OR REPLACE INTO cli_entries (flag, handler, wired, verified_at_commit, source_file)
      VALUES (?, ?, ?, ?, ?)`).run(
      entry.flag, entry.handler, entry.wired ? 1 : 0, entry.verifiedAtCommit ?? null, entry.sourceFile,
    )
  }

  getCliEntries(): CliEntry[] {
    const rows = this.db.prepare('SELECT * FROM cli_entries ORDER BY flag').all() as Array<Record<string, unknown>>
    return rows.map(r => ({
      flag: r.flag as string,
      handler: r.handler as string,
      wired: (r.wired as number) === 1,
      verifiedAtCommit: (r.verified_at_commit as string | null) ?? undefined,
      sourceFile: r.source_file as string,
    }))
  }

  // ─── Physarum persistence ───────────────────────────────────────────

  savePhysarumEdges(edges: PhysarumEdgeState[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM physarum_edges').run()
      const stmt = this.db.prepare(
        'INSERT INTO physarum_edges (file_a, file_b, weight, flow, consolidated, activation_count, last_activated_turn, direction) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      )
      for (const e of edges) {
        stmt.run(e.fileA, e.fileB, e.weight, e.flow, e.consolidated ? 1 : 0, e.activationCount, e.lastActivatedTurn, e.direction)
      }
    })
    tx()
  }

  loadPhysarumEdges(): PhysarumEdgeState[] {
    const rows = this.db.prepare('SELECT * FROM physarum_edges').all() as Array<Record<string, unknown>>
    return rows.map(r => ({
      fileA: r.file_a as string,
      fileB: r.file_b as string,
      weight: r.weight as number,
      flow: r.flow as number,
      consolidated: (r.consolidated as number) === 1,
      activationCount: r.activation_count as number,
      lastActivatedTurn: r.last_activated_turn as number,
      direction: r.direction as number,
    }))
  }

  recordPhysarumPredictionObservation(observation: PhysarumPredictionObservation): void {
    if (!this._available) return
    try {
      this.db.prepare(`
        INSERT INTO physarum_prediction_observations
          (source_file, predicted_at_turn, predictions_json, observed_file, observed_at_turn, hit_rank, lead_turns)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        observation.sourceFile,
        observation.predictedAtTurn,
        JSON.stringify(observation.predictions),
        observation.observedFile,
        observation.observedAtTurn,
        observation.hitRank,
        observation.leadTurns,
      )
    } catch {
      // Shadow telemetry must never affect tool execution.
    }
  }

  getPhysarumPredictionObservations(limit = 100): PhysarumPredictionObservation[] {
    if (!this._available) return []
    try {
      const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
      const rows = this.db.prepare(`
        SELECT * FROM physarum_prediction_observations
        ORDER BY id DESC
        LIMIT ${safeLimit}
      `).all() as Array<Record<string, unknown>>
      return rows.map(r => ({
        sourceFile: r.source_file as string,
        predictedAtTurn: r.predicted_at_turn as number,
        predictions: JSON.parse(r.predictions_json as string) as Array<{ file: string; score: number }>,
        observedFile: r.observed_file as string,
        observedAtTurn: r.observed_at_turn as number,
        hitRank: (r.hit_rank as number | null) ?? null,
        leadTurns: r.lead_turns as number,
      }))
    } catch {
      return []
    }
  }

  // ─── Immune memory persistence ───────────────────────────────────────

  saveImmuneMemories(memories: ImmuneMemory[]): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM immune_memory').run()
      const stmt = this.db.prepare(
        'INSERT INTO immune_memory (id, pattern, response_json, affinity_score, hit_count, last_hit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      for (const m of memories) {
        stmt.run(
          m.id,
          m.pattern,
          JSON.stringify(m.response),
          m.affinityScore,
          m.hitCount,
          m.lastHit,
          m.createdAt,
        )
      }
    })
    tx()
  }

  loadImmuneMemories(): ImmuneMemory[] {
    const rows = this.db.prepare('SELECT * FROM immune_memory').all() as Array<Record<string, unknown>>
    const result: ImmuneMemory[] = []
    for (const r of rows) {
      try {
        const response = JSON.parse(r.response_json as string)
        result.push({
          id: r.id as string,
          pattern: r.pattern as string,
          response,
          affinityScore: r.affinity_score as number,
          hitCount: r.hit_count as number,
          lastHit: r.last_hit as number,
          createdAt: r.created_at as number,
        })
      } catch {
        // Corrupt row — skip, don't fail the whole load
      }
    }
    return result
  }

  // ─── Mistake notebook persistence ────────────────────────────────────

  saveMistakeEntries(entries: MistakeEntry[]): void {
    const insert = this.db.prepare(
      'INSERT INTO mistake_entries (id, timestamp, error, context, resolution, tags_json) VALUES (?, ?, ?, ?, ?, ?)'
    )
    const tx = this.db.transaction((items: MistakeEntry[]) => {
      this.db.prepare('DELETE FROM mistake_entries').run()
      for (const e of items) {
        insert.run(e.id, e.timestamp, e.error, e.context, e.resolution, JSON.stringify(e.tags))
      }
    })
    tx(entries)
  }

  loadMistakeEntries(): MistakeEntry[] {
    const rows = this.db.prepare('SELECT * FROM mistake_entries').all() as Array<{
      id: string
      timestamp: string
      error: string
      context: string
      resolution: string
      tags_json: string
    }>
    const result: MistakeEntry[] = []
    for (const r of rows) {
      try {
        result.push({
          id: r.id,
          timestamp: r.timestamp,
          error: r.error,
          context: r.context,
          resolution: r.resolution,
          tags: JSON.parse(r.tags_json),
        })
      } catch {
        // Corrupt row — skip, don't fail the whole load
      }
    }
    return result
  }

  // ─── P3 state persistence ───────────────────────────────────────────

  saveToolPatternMinerSnapshot(snapshot: ToolPatternMinerSnapshot): void {
    if (!this._available) return
    this.db.prepare(`
      INSERT INTO p3_state (kind, version, json, updated_at)
      VALUES ('tool_pattern_miner', ?, ?, datetime('now'))
      ON CONFLICT(kind, version) DO UPDATE SET
        json = excluded.json,
        updated_at = excluded.updated_at
    `).run(snapshot.version, JSON.stringify(snapshot))
  }

  loadToolPatternMinerSnapshot(): ToolPatternMinerSnapshot | null {
    if (!this._available) return null
    const row = this.db.prepare(`
      SELECT json FROM p3_state
      WHERE kind = 'tool_pattern_miner' AND version = 1
    `).get() as { json: string } | undefined
    if (!row) return null
    const parsed = JSON.parse(row.json) as ToolPatternMinerSnapshot
    return parsed.version === 1 ? parsed : null
  }

  // ─── T2-02: Bandit state persistence ──────────────────────────────────

  saveBanditState(kind: string, json: string): void {
    if (!this._available) return
    try {
      this.db.prepare(`
        INSERT INTO p3_state (kind, version, json, updated_at)
        VALUES (?, 1, ?, datetime('now'))
        ON CONFLICT(kind, version) DO UPDATE SET
          json = excluded.json,
          updated_at = excluded.updated_at
      `).run(kind, json)
    } catch {
      // Bandit persistence is non-critical
    }
  }

  loadBanditState(kind: string): string | null {
    if (!this._available) return null
    try {
      const row = this.db.prepare(`
        SELECT json FROM p3_state
        WHERE kind = ? AND version = 1
      `).get(kind) as { json: string } | undefined
      return row?.json ?? null
    } catch {
      return null
    }
  }

  loadBanditStatesByPrefix(prefix: string, limit = 100): Array<{ kind: string; json: string; updatedAt: string }> {
    if (!this._available) return []
    try {
      const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit)))
      return this.db.prepare(`
        SELECT kind, json, updated_at as updatedAt FROM p3_state
        WHERE substr(kind, 1, length(?)) = ?
        ORDER BY updated_at DESC
        LIMIT ${safeLimit}
      `).all(prefix, prefix) as Array<{ kind: string; json: string; updatedAt: string }>
    } catch {
      return []
    }
  }

  // ─── Sensorimotor ─────────────────────────────────────────────────────

  /**
   * Record a sensorimotor experience: (context, tool, outcome).
   * Gracefully degrades when DB is unavailable.
   */
  recordSensorimotorExperience(
    contextHash: string,
    toolName: string,
    success: boolean,
    durationMs: number,
    turn: number,
  ): void {
    if (!this._available) return
    try {
      this.db.prepare(
        `INSERT INTO sensorimotor_log (context_hash, tool_name, success, duration_ms, turn)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(contextHash, toolName, success ? 1 : 0, durationMs, turn)
    } catch {
      // Non-critical logging — degrade silently
    }
  }

  /**
   * Get the success rate of a tool from recent sensorimotor history.
   * Returns null if no data exists.
   */
  getToolSuccessRate(toolName: string, recentWindow?: number): number | null {
    if (!this._available) return null
    try {
      const limit = recentWindow && recentWindow > 0 ? `LIMIT ${recentWindow}` : ''
      const rows = this.db.prepare(
        `SELECT success FROM sensorimotor_log
         WHERE tool_name = ?
         ORDER BY id DESC
         ${limit}`,
      ).all(toolName) as { success: number }[]
      if (rows.length === 0) return null
      const successes = rows.filter(r => r.success === 1).length
      return successes / rows.length
    } catch {
      return null
    }
  }

  close(): void {
    if (this.conn) { this.conn.close(); this.conn = null }
  }
}

/** No-op database proxy when better-sqlite3 is unavailable */
function createNullDb(): any {
  const noopStmt = { run: () => {}, all: () => [] as any[], get: () => undefined }
  return new Proxy(Object.create(null), {
    get: (_target: any, prop: string) => {
      if (prop === 'prepare') return () => noopStmt
      if (prop === 'exec') return () => {}
      if (prop === 'pragma') return () => {}
      if (prop === 'close') return () => {}
      if (prop === 'transaction') return (fn: any) => fn
      return () => {}
    },
  })
}

