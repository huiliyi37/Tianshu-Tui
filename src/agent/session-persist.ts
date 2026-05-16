import { appendFile } from 'fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { Message } from '../api/types.js'
import type { SessionMetadata } from '../context/types.js'
import type { LedgerSessionMemoryState, SessionMemoryEntry, SessionMemoryState } from '../context/types.js'
import { appendSessionMemory, buildSessionMemoryBlock, loadSessionMemory } from '../context/session-memory.js'
import { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaim } from '../context/claims.js'
import { assertValidSessionId } from '../validation.js'

const SESSION_DIR = join(homedir(), '.rivet', 'sessions')

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export class SessionPersist {
  private filePath: string
  private metadataPath: string
  private sessionId: string

  constructor(sessionId: string) {
    assertValidSessionId(sessionId)
    ensureDir(SESSION_DIR)
    this.sessionId = sessionId
    this.filePath = join(SESSION_DIR, `${sessionId}.jsonl`)
    this.metadataPath = join(SESSION_DIR, `${sessionId}.meta.json`)
  }

  getBackupDir(): string {
    const dir = join(SESSION_DIR, this.sessionId, 'backups')
    ensureDir(dir)
    return dir
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

  writeMetadata(metadata: SessionMetadata): void {
    writeFileSync(this.metadataPath, JSON.stringify(metadata, null, 2) + '\n')
  }

  loadMetadata(): SessionMetadata | undefined {
    if (!existsSync(this.metadataPath)) return undefined
    try {
      return JSON.parse(readFileSync(this.metadataPath, 'utf-8')) as SessionMetadata
    } catch {
      return undefined
    }
  }

  loadMemory(): SessionMemoryState {
    return loadSessionMemory(SESSION_DIR, this.sessionId)
  }

  appendMemory(input: { text: string; source: SessionMemoryEntry['source']; createdAt: number }): SessionMemoryState {
    return appendSessionMemory(SESSION_DIR, this.sessionId, input)
  }

  buildMemoryBlock(): string {
    return buildSessionMemoryBlock(this.loadMemory())
  }

  getSessionMemoryState(): LedgerSessionMemoryState | undefined {
    const memory = this.loadMemory()
    if (memory.entries.length === 0) return undefined
    const block = buildSessionMemoryBlock(memory)
    return {
      path: join(join(homedir(), '.rivet', 'sessions'), `${this.sessionId}.memory.json`),
      lastSummarizedRoundIndex: -1,
      lastUpdatedAt: memory.entries[memory.entries.length - 1]?.createdAt ?? Date.now(),
      digest: block.length > 200 ? block.slice(0, 197) + '...' : block,
      stale: false,
      tokenEstimate: block.length,
    }
  }

  /** Create a claim store for the current session. */
  createClaimStore(): ContextClaimStore {
    return new ContextClaimStore(SESSION_DIR, this.sessionId)
  }

  /** Load durable claims from the most recent previous session. */
  loadPreviousDurableClaims(): ContextClaim[] {
    const sessions = SessionPersist.listSessions()
    const previous = sessions
      .filter(s => s !== this.sessionId)
      .sort()
      .pop()
    if (!previous) return []
    return ContextClaimStore.loadDurableClaims(SESSION_DIR, previous)
  }

  /** Inject durable claims from previous session into a claim store with confidence decay. */
  injectDurableClaims(store: ContextClaimStore): void {
    const durableClaims = this.loadPreviousDurableClaims()
    for (const claim of durableClaims) {
      store.propose({
        kind: claim.kind,
        scope: claim.scope,
        text: claim.text,
        confidence: claim.confidence * 0.9,
        fitness: claim.fitness,
        source: { ...claim.source, eventId: `resume:${claim.id}` },
        evidence: claim.evidence,
        createdAt: Date.now(),
        tags: [...claim.tags, 'resumed'],
      })
    }
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
