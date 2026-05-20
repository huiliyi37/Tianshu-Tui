import { appendFile } from 'fs/promises'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { join } from 'path'
import { homedir } from 'os'
import type { Message } from '../api/types.js'
import type { SessionMetadata } from '../context/types.js'
import type { LedgerSessionMemoryState, ResumePreflightReport, SessionMemoryEntry, SessionMemoryState } from '../context/types.js'
import { runResumePreflight } from '../context/resume-preflight.js'
import { appendSessionMemory, buildSessionMemoryBlock, loadSessionMemory } from '../context/session-memory.js'
import { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaim } from '../context/claims.js'
import { assertValidSessionId } from '../validation.js'
import { appendChecksum, verifyAndExtract, verifyLines } from './checksum.js'

function getSessionDir(): string {
  return process.env.RIVET_SESSION_DIR ?? join(homedir(), '.rivet', 'sessions')
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export const MAX_SESSION_MESSAGE_JSON_CHARS = 100_000

function truncateString(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  const marker = `\n<session-message-truncated original_chars="${value.length}" kept_chars="${maxChars}" />`
  const keep = Math.max(0, maxChars - marker.length)
  return value.slice(0, keep) + marker
}

function capJsonValue(value: unknown, maxChars: number): unknown {
  if (typeof value === 'string') return truncateString(value, maxChars)
  if (Array.isArray(value)) return value.map(item => capJsonValue(item, maxChars))
  if (value && typeof value === 'object') {
    const capped: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      capped[key] = capJsonValue(child, maxChars)
    }
    return capped
  }
  return value
}

export function serializeSessionMessage(message: Message, maxChars = MAX_SESSION_MESSAGE_JSON_CHARS): string {
  let json = JSON.stringify(message)
  if (json.length <= maxChars) return json

  const capped = capJsonValue(message, Math.max(1_000, Math.floor(maxChars * 0.8))) as Message
  json = JSON.stringify(capped)
  if (json.length <= maxChars) return json

  return JSON.stringify({
    role: message.role,
    content: truncateString(json, maxChars),
  })
}

export class SessionPersist {
  private filePath: string
  private metadataPath: string
  private snapshotPath: string
  private sessionId: string

  /** Public getter for testing file-path-dependent integrations. */
  getFilePath(): string {
    return this.filePath
  }

  constructor(sessionId: string) {
    assertValidSessionId(sessionId)
    ensureDir(getSessionDir())
    this.sessionId = sessionId
    this.filePath = join(getSessionDir(), `${sessionId}.jsonl`)
    this.metadataPath = join(getSessionDir(), `${sessionId}.meta.json`)
    this.snapshotPath = join(getSessionDir(), `${sessionId}.snapshots.jsonl`)
  }

  getBackupDir(): string {
    const dir = join(getSessionDir(), this.sessionId, 'backups')
    ensureDir(dir)
    return dir
  }

  /** Append a single message to the session file */
  async append(message: Message): Promise<void> {
    const line = serializeSessionMessage(message) + '\n'
    await appendFile(this.filePath, line)
  }

  /** Load all messages from the session file (with checksum validation) */
  load(): Message[] {
    return this.loadWithChecksum()
  }

  /** Load messages repaired for resume, rolling back to the last safe snapshot when needed. */
  loadRecoverableMessages(): {
    messages: Message[]
    preflight: ResumePreflightReport
    usedSnapshot: boolean
    snapshotTurn?: number
    hadIncompleteCompact: boolean
  } {
    // 检测 incomplete compact
    const hadIncompleteCompact = this.detectIncompleteCompact()
    
    // 使用带校验和的 load
    const loaded = this.loadWithChecksum()
    const preflight = runResumePreflight(loaded)

    if (preflight.safe && !hadIncompleteCompact) {
      return { messages: preflight.messages, preflight, usedSnapshot: false, hadIncompleteCompact: false }
    }

    const snapshot = this.loadLastSnapshot()
    if (!snapshot) {
      return { messages: preflight.messages, preflight, usedSnapshot: false, hadIncompleteCompact }
    }

    const snapshotMessages = this.loadUpToTurn(snapshot.turn)
    const snapshotPreflight = runResumePreflight(snapshotMessages)

    return {
      messages: snapshotPreflight.messages,
      preflight: snapshotPreflight,
      usedSnapshot: true,
      snapshotTurn: snapshot.turn,
      hadIncompleteCompact,
    }
  }

  /** Compact the session file with the given messages (with checksums) */
  compact(messages: Message[]): void {
    const content = messages.map(m => appendChecksum(serializeSessionMessage(m))).join('\n') + '\n'
    writeFileAtomicSync(this.filePath, content)
  }

  /** Delete the session file */
  delete(): void {
    try { unlinkSync(this.filePath) } catch { /* ignore */ }
  }

  /**
   * 带校验和的 append
   */
  async appendWithChecksum(message: Message): Promise<void> {
    const json = serializeSessionMessage(message)
    const line = appendChecksum(json) + '\n'
    await appendFile(this.filePath, line)
  }

  /**
   * 带校验和的 load（向后兼容）
   */
  loadWithChecksum(): Message[] {
    if (!existsSync(this.filePath)) return []
    const content = readFileSync(this.filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    
    const { validLines, invalidCount, legacyCount } = verifyLines(lines)
    
    // 记录校验失败（可选：写入日志或返回统计）
    if (invalidCount > 0) {
      // 可以在这里添加日志记录
    }

    return validLines.map(line => {
      try {
        const parsed = JSON.parse(line) as Message & { type?: string }
        // 过滤掉 compact_start 和 compact_end 标记
        if (parsed.type === 'compact_start' || parsed.type === 'compact_end') {
          return null
        }
        return parsed as Message
      } catch { return null }
    }).filter(Boolean) as Message[]
  }

  /**
   * 写入 compact 开始标记
   */
  appendCompactStart(turn: number, messageCount: number): void {
    const marker = {
      type: 'compact_start',
      turn,
      messageCount,
      timestamp: Date.now(),
    }
    appendFileSync(this.filePath, appendChecksum(JSON.stringify(marker)) + '\n')
  }

  /**
   * 写入 compact 结束标记
   */
  appendCompactEnd(turn: number, messageCount: number): void {
    const marker = {
      type: 'compact_end',
      turn,
      messageCount,
      timestamp: Date.now(),
    }
    appendFileSync(this.filePath, appendChecksum(JSON.stringify(marker)) + '\n')
  }

  /**
   * 检测 incomplete compact
   * @returns 是否检测到 incomplete compact
   */
  detectIncompleteCompact(): boolean {
    if (!existsSync(this.filePath)) return false
    
    const content = readFileSync(this.filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    
    let hasCompactStart = false
    let hasCompactEnd = false
    
    // 从后向前扫描，找到最近的 compact 标记
    for (let i = lines.length - 1; i >= 0; i--) {
      const result = verifyAndExtract(lines[i] ?? '')
      if (!result.valid) continue
      
      try {
        const data = JSON.parse(result.json)
        if (data.type === 'compact_end') {
          hasCompactEnd = true
          break
        }
        if (data.type === 'compact_start') {
          hasCompactStart = true
          break
        }
      } catch {
        // ignore parse errors
      }
    }
    
    // 有 start 但没有 end = incomplete compact
    return hasCompactStart && !hasCompactEnd
  }

  appendTurnSnapshot(snapshot: { turn: number; timestamp: number; messageCount: number; estimatedTokens: number }): void {
    const line = JSON.stringify(snapshot) + '\n'
    try {
      appendFileSync(this.snapshotPath, line)
    } catch {
      // Ignore write failures — snapshots are best-effort
    }
  }

  loadLastSnapshot(): { turn: number; timestamp: number; messageCount: number; estimatedTokens: number } | null {
    if (!existsSync(this.snapshotPath)) return null
    try {
      const lines = readFileSync(this.snapshotPath, 'utf-8').trim().split('\n')
      for (let i = lines.length - 1; i >= 0; i--) {
        try { return JSON.parse(lines[i]!) } catch { continue }
      }
    } catch { /* ignore */ }
    return null
  }

  loadUpToTurn(turn: number): Message[] {
    const messages = this.load()
    let currentTurn = 0
    for (let i = 0; i < messages.length; i++) {
      if (messages[i]!.role === 'user' && typeof messages[i]!.content === 'string') {
        currentTurn++
        if (currentTurn === turn) return messages.slice(0, i + 1)
      }
    }
    return messages
  }

  /** Get the session file path */
  getPath(): string {
    return this.filePath
  }

  writeMetadata(metadata: SessionMetadata): void {
    writeFileAtomicSync(this.metadataPath, JSON.stringify(metadata, null, 2) + '\n')
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
    return loadSessionMemory(getSessionDir(), this.sessionId)
  }

  appendMemory(input: { text: string; source: SessionMemoryEntry['source']; createdAt: number }): SessionMemoryState {
    return appendSessionMemory(getSessionDir(), this.sessionId, input)
  }

  buildMemoryBlock(): string {
    return buildSessionMemoryBlock(this.loadMemory())
  }

  getSessionMemoryState(): LedgerSessionMemoryState | undefined {
    const memory = this.loadMemory()
    if (memory.entries.length === 0) return undefined
    const block = buildSessionMemoryBlock(memory)
    return {
      path: join(getSessionDir(), `${this.sessionId}.memory.json`),
      lastSummarizedRoundIndex: -1,
      lastUpdatedAt: memory.entries[memory.entries.length - 1]?.createdAt ?? Date.now(),
      digest: block.length > 200 ? block.slice(0, 197) + '...' : block,
      stale: false,
      tokenEstimate: block.length,
    }
  }

  /** Create a claim store for the current session. */
  createClaimStore(): ContextClaimStore {
    return new ContextClaimStore(getSessionDir(), this.sessionId)
  }

  /** Load durable claims from the most recent previous session. */
  loadPreviousDurableClaims(): ContextClaim[] {
    const sessions = SessionPersist.listSessions()
    const previous = sessions
      .filter(s => s !== this.sessionId)
      .sort()
      .pop()
    if (!previous) return []
    return ContextClaimStore.loadDurableClaims(getSessionDir(), previous)
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
    ensureDir(getSessionDir())
    try {
      return readdirSync(getSessionDir())
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => f.replace('.jsonl', ''))
    } catch {
      return []
    }
  }
}

const MAX_SESSIONS = 50

export function evictOldSessions(keepSessionId: string): string[] {
  return evictOldSessionsInternal(getSessionDir(), keepSessionId, MAX_SESSIONS)
}

export function evictOldSessionsInternal(dir: string, keepSessionId: string, limit: number): string[] {
  ensureDir(dir)
  let sessions: string[]
  try {
    sessions = readdirSync(dir)
      .filter((f: string) => f.endsWith('.jsonl'))
      .map((f: string) => f.replace('.jsonl', ''))
  } catch {
    return []
  }

  if (sessions.length <= limit) return []

  // Sort by mtime (oldest first) so eviction removes least-recently-used sessions.
  // UUIDs are not time-ordered — lexicographic sort would delete arbitrary sessions.
  const withMtime = sessions.map(id => {
    let mtime = 0
    try { mtime = statSync(join(dir, `${id}.jsonl`)).mtimeMs } catch { /* ignore */ }
    return { id, mtime }
  })
  withMtime.sort((a, b) => a.mtime - b.mtime)

  const toEvict = withMtime
    .filter(({ id }) => id !== keepSessionId)
    .slice(0, sessions.length - limit)
    .map(({ id }) => id)

  for (const id of toEvict) {
    try { unlinkSync(join(dir, `${id}.jsonl`)) } catch { /* ignore */ }
    try { unlinkSync(join(dir, `${id}.meta.json`)) } catch { /* ignore */ }
    try { unlinkSync(join(dir, `${id}.snapshots.jsonl`)) } catch { /* ignore */ }
    try { unlinkSync(join(dir, `${id}.memory.json`)) } catch { /* ignore */ }
    try { unlinkSync(join(dir, `${id}.claims.jsonl`)) } catch { /* ignore */ }
  }

  return toEvict
}
