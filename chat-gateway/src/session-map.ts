import Database from 'better-sqlite3'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ChatSession {
  id: number
  platform: 'feishu' | 'wechat'
  conversationId: string
  senderId: string
  sessionId: string
  title: string | null
  createdAt: number
  updatedAt: number
}

export class SessionMap {
  private db: Database.Database

  constructor(dbPath: string) {
    if (!existsSync(dirname(dbPath))) {
      mkdirSync(dirname(dbPath), { recursive: true })
    }
    this.db = new Database(dbPath)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        sender_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        title TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_session_unique
        ON chat_sessions(platform, conversation_id, sender_id);
      CREATE INDEX IF NOT EXISTS idx_session_lookup
        ON chat_sessions(platform, conversation_id);
    `)
  }

  async resolve(params: {
    platform: 'feishu' | 'wechat'
    conversationId: string
    senderId: string
    createSessionId: () => Promise<string>
    title?: string
  }): Promise<{ sessionId: string; created: boolean }> {
    const existing = this.db
      .prepare(
        `SELECT session_id FROM chat_sessions
         WHERE platform = ? AND conversation_id = ? AND sender_id = ?`
      )
      .get(params.platform, params.conversationId, params.senderId) as
      | { session_id: string }
      | undefined

    if (existing) {
      this.db
        .prepare(
          `UPDATE chat_sessions SET updated_at = unixepoch() WHERE session_id = ?`
        )
        .run(existing.session_id)
      return { sessionId: existing.session_id, created: false }
    }

    const sessionId = await params.createSessionId()
    this.db
      .prepare(
        `INSERT INTO chat_sessions
         (platform, conversation_id, sender_id, session_id, title)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        params.platform,
        params.conversationId,
        params.senderId,
        sessionId,
        params.title ?? null
      )
    return { sessionId, created: true }
  }

  findBySessionId(sessionId: string): ChatSession | undefined {
    return this.db
      .prepare(`SELECT * FROM chat_sessions WHERE session_id = ?`)
      .get(sessionId) as ChatSession | undefined
  }

  close(): void {
    this.db.close()
  }
}
