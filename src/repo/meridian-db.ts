import Database from 'better-sqlite3'
import { join } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import type { ParseResult, MeridianSymbol, MeridianEdge } from './meridian-types.js'

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
`

export class MeridianDb {
  private db: Database.Database

  constructor(stateDir: string) {
    if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true })
    const dbPath = join(stateDir, 'meridian.db')
    this.db = new Database(dbPath)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('busy_timeout = 3000')
    this.db.exec(SCHEMA)
  }

  needsParse(filePath: string, contentHash: string): boolean {
    const row = this.db.prepare('SELECT content_hash FROM files WHERE path = ?').get(filePath) as { content_hash: string } | undefined
    return !row || row.content_hash !== contentHash
  }

  upsertFile(result: ParseResult): void {
    const tx = this.db.transaction(() => {
      this.db.prepare('DELETE FROM symbols WHERE file_path = ?').run(result.filePath)
      this.db.prepare('DELETE FROM edges WHERE source_id LIKE ?').run(`${result.filePath}:%`)
      this.db.prepare('INSERT OR REPLACE INTO files (path, content_hash) VALUES (?, ?)').run(result.filePath, result.contentHash)

      const insertSym = this.db.prepare('INSERT OR REPLACE INTO symbols (id, name, kind, file_path, line, exported, content_hash) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const s of result.symbols) {
        insertSym.run(s.id, s.name, s.kind, s.filePath, s.line, s.exported ? 1 : 0, s.contentHash)
      }

      const insertEdge = this.db.prepare('INSERT OR REPLACE INTO edges (source_id, target_id, kind, weight) VALUES (?, ?, ?, ?)')
      for (const e of result.edges) {
        insertEdge.run(e.sourceId, e.targetId, e.kind, e.weight)
      }

      for (const imp of result.imports) {
        const firstSymbol = result.symbols[0]
        if (firstSymbol) {
          insertEdge.run(firstSymbol.id, `${imp}:*:0`, 'imports', 1.0)
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
    }))
  }

  getEdgesTo(symbolId: string): MeridianEdge[] {
    return (this.db.prepare('SELECT * FROM edges WHERE target_id = ?').all(symbolId) as Array<Record<string, unknown>>).map(row => ({
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      kind: row.kind as MeridianEdge['kind'],
      weight: row.weight as number,
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

  close(): void {
    this.db.close()
  }
}
