import { appendFile } from 'fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Message } from '../api/types.js'

const SESSION_DIR = join(homedir(), '.rivet', 'sessions')

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export class SessionPersist {
  private filePath: string

  constructor(sessionId: string) {
    ensureDir(SESSION_DIR)
    this.filePath = join(SESSION_DIR, `${sessionId}.jsonl`)
  }

  /** Append a single message to the session file */
  async append(message: Message): Promise<void> {
    const line = JSON.stringify(message) + '\n'
    await appendFile(this.filePath, line)
  }

  /** Load all messages from the session file */
  load(): Message[] {
    if (!existsSync(this.filePath)) return []
    const content = readFileSync(this.filePath, 'utf-8')
    return content.trim().split('\n').filter(Boolean).map(line => {
      try { return JSON.parse(line) as Message } catch { return null }
    }).filter(Boolean) as Message[]
  }

  /** Compact the session file with the given messages */
  compact(messages: Message[]): void {
    writeFileSync(
      this.filePath,
      messages.map(m => JSON.stringify(m)).join('\n') + '\n',
    )
  }

  /** Delete the session file */
  delete(): void {
    try { unlinkSync(this.filePath) } catch { /* ignore */ }
  }

  /** Get the session file path */
  getPath(): string {
    return this.filePath
  }

  /** List all session files */
  static listSessions(): string[] {
    ensureDir(SESSION_DIR)
    try {
      return readdirSync(SESSION_DIR)
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => f.replace('.jsonl', ''))
    } catch {
      return []
    }
  }
}
