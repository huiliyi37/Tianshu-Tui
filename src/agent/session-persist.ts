import { appendFile } from 'fs/promises'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, readdirSync, statSync } from 'fs'
import { writeFileAtomicSync, writeFileAtomicAsync } from '../fs-atomic.js'
import { join } from 'path'
import { homedir } from 'os'
import type { ContentBlock, Message } from '../api/types.js'
import type { OaiAssistantMessage, OaiMessage, OaiToolCall, OaiToolMessage } from '../api/oai-types.js'
import { stableStringify } from '../api/stable-json.js'

function legacyMessageToOaiMessages(message: Message): OaiMessage[] {
  if (typeof message.content === 'string') {
    return [{ role: message.role, content: message.content }]
  }

  if (message.role === 'user') {
    const text = message.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const toolMessages: OaiToolMessage[] = message.content
      .filter((block): block is ContentBlock & { type: 'tool_result' } => block.type === 'tool_result')
      .map(block => ({ role: 'tool', tool_call_id: block.tool_use_id, content: block.content }))
    return [
      ...(text ? [{ role: 'user' as const, content: text }] : []),
      ...toolMessages,
    ]
  }

  const text = message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
  const reasoning = message.content
    .filter(block => block.type === 'thinking')
    .map(block => block.thinking)
    .join('')
  const toolCalls: OaiToolCall[] = message.content
    .filter((block): block is ContentBlock & { type: 'tool_use' } => block.type === 'tool_use')
    .map(block => ({
      id: block.id,
      type: 'function',
      function: { name: block.name, arguments: stableStringify(block.input) },
    }))

  const assistant: OaiAssistantMessage = {
    role: 'assistant',
    content: text || (toolCalls.length === 0 ? '' : null),
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
  return [assistant]
}
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
  return serializeSessionJsonValue(message, maxChars, () => ({
    role: message.role,
    content: truncateString(JSON.stringify(message), maxChars),
  }))
}

export function serializeOaiSessionMessage(message: OaiMessage, maxChars = MAX_SESSION_MESSAGE_JSON_CHARS): string {
  return serializeSessionJsonValue(message, maxChars, () => ({
    role: message.role,
    content: truncateString(JSON.stringify(message), maxChars),
    ...(message.role === 'tool' ? { tool_call_id: message.tool_call_id } : {}),
  } as OaiMessage))
}

function serializeSessionJsonValue<T>(message: T, maxChars: number, fallback: () => T): string {
  let json = JSON.stringify(message)
  if (json.length <= maxChars) return json

  const capped = capJsonValue(message, Math.max(1_000, Math.floor(maxChars * 0.8))) as T
  json = JSON.stringify(capped)
  if (json.length <= maxChars) return json

  return JSON.stringify(fallback())
}

function isOaiMessage(value: unknown): value is OaiMessage {
  if (!value || typeof value !== 'object') return false
  const msg = value as Record<string, unknown>
  if (msg.role === 'system') return typeof msg.content === 'string'
  if (msg.role === 'user') return typeof msg.content === 'string'
  if (msg.role === 'assistant') return typeof msg.content === 'string' || msg.content === null
  if (msg.role === 'tool') return typeof msg.tool_call_id === 'string' && typeof msg.content === 'string'
  return false
}

function parseSessionLine(line: string): unknown | null {
  const parsed = JSON.parse(line) as { type?: string }
  if (parsed.type === 'compact_start' || parsed.type === 'compact_end') {
    return null
  }
  return parsed
}

export class SessionPersist {
  private filePath: string
  private metadataPath: string
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

  /** Append an OpenAI-native message with checksum. */
  async appendOaiWithChecksum(message: OaiMessage): Promise<void> {
    const json = serializeOaiSessionMessage(message)
    const line = appendChecksum(json) + '\n'
    await appendFile(this.filePath, line)
  }

  /** Load messages in OpenAI-native format, migrating legacy rows on read. */
  loadOai(): OaiMessage[] {
    if (!existsSync(this.filePath)) return []
    const content = readFileSync(this.filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(Boolean)
    const { validLines } = verifyLines(lines)

    const messages: OaiMessage[] = []
    for (const line of validLines) {
      try {
        const parsed = parseSessionLine(line)
        if (!parsed) continue
        if (isOaiMessage(parsed)) {
          messages.push(parsed)
        } else {
          messages.push(...legacyMessageToOaiMessages(parsed as Message).map(message => JSON.parse(JSON.stringify(message)) as OaiMessage))
        }
      } catch { /* skip malformed rows */ }
    }
    // 压#7: Validate tool_call/tool_result pairing
    return this.repairOrphanToolCalls(messages)
  }

  /** 压#7: Remove orphan tool_use/tool_result pairs left by corrupted/missing lines. */
  private repairOrphanToolCalls(messages: OaiMessage[]): OaiMessage[] {
    const toolCallIds = new Set<string>()
    const toolResultIndices = new Map<string, number>()
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) { if (tc.id) toolCallIds.add(tc.id) }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResultIndices.set(msg.tool_call_id, i)
      }
    }
    const orphanResultIdx = new Set<number>()
    for (const [id, idx] of toolResultIndices) {
      if (!toolCallIds.has(id)) orphanResultIdx.add(idx)
    }

    // Pass 1: collect valid messages (strip orphan tool_calls, drop orphan results)
    const result: OaiMessage[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!
      // Drop orphan tool results
      if (orphanResultIdx.has(i)) continue
      // Strip orphan tool_calls from assistant messages
      if (msg.role === 'assistant' && msg.tool_calls) {
        const valid = msg.tool_calls.filter(tc => tc.id && toolResultIndices.has(tc.id))
        // Drop the message entirely if all tool_calls were orphan and content is empty
        if (valid.length === 0 && !msg.content) continue
        if (valid.length !== msg.tool_calls.length) {
          result.push({ ...msg, tool_calls: valid })
          continue
        }
      }
      result.push(msg)
    }
    return result
  }

  /** Compact the session file with the given messages (with checksums) */
  compact(messages: Message[]): void {
    const content = messages.map(m => appendChecksum(serializeSessionMessage(m))).join('\n') + '\n'
    writeFileAtomicSync(this.filePath, content)
  }

  /** Compact the session file with OAI-format messages */
  compactOai(messages: OaiMessage[]): void {
    const content = messages.map(m => appendChecksum(serializeOaiSessionMessage(m))).join('\n') + '\n'
    writeFileAtomicSync(this.filePath, content)
  }

  /** Async atomic compaction — avoids blocking the agent loop on full rewrites (S13). */
  async compactOaiAsync(messages: OaiMessage[]): Promise<void> {
    const content = messages.map(m => appendChecksum(serializeOaiSessionMessage(m))).join('\n') + '\n'
    await writeFileAtomicAsync(this.filePath, content)
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
        const parsed = parseSessionLine(line)
        if (!parsed) return null
        return parsed as Message
      } catch { return null }
    }).filter(Boolean) as Message[]
  }

  /**
   * 写入 compact 开始标记
   */

  /**
   * 写入 compact 结束标记
   */

  /**
   * 检测 incomplete compact
   * @returns 是否检测到 incomplete compact
   */




  /** Get the session file path */
  getPath(): string {
    return this.filePath
  }

  writeMetadata(metadata: SessionMetadata): void {
    writeFileAtomicSync(this.metadataPath, JSON.stringify(metadata, null, 2) + '\n')
  }

  /** Upsert specific metadata fields without overwriting others */
  updateMetadata(patch: Partial<SessionMetadata>): void {
    const existing = this.loadMetadata()
    const merged: SessionMetadata = {
      compactEvents: existing?.compactEvents ?? [],
      ...existing,
      ...patch,
      // These must win over ...existing/...patch — place them last:
      // - sessionId is authoritative from `this`
      // - createdAt is set once at creation and preserved thereafter
      // - updatedAt always advances to now (the whole point of the field;
      //   spreading ...existing after it would freeze it at creation time)
      sessionId: this.sessionId,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
      // Preserve nested objects by merging, not replacing
      tokenUsage: existing?.tokenUsage || patch.tokenUsage
        ? { prompt: 0, completion: 0, total: 0, ...existing?.tokenUsage, ...patch.tokenUsage }
        : undefined,
    }
    this.writeMetadata(merged)
  }

  /** Initialize metadata for a new session if not already present */
  initMetadata(init?: Partial<SessionMetadata>): void {
    if (existsSync(this.metadataPath)) return
    this.writeMetadata({
      sessionId: this.sessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      compactEvents: [],
      status: 'active',
      turnCount: 0,
      toolCallCount: 0,
      tokenUsage: { prompt: 0, completion: 0, total: 0 },
      ...init,
    })
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

  /** List sessions with metadata, sorted by updatedAt descending (most recent first) */
  static listSessionsWithMetadata(): Array<SessionMetadata & { id: string }> {
    const ids = SessionPersist.listSessions()
    const results: Array<SessionMetadata & { id: string }> = []
    for (const id of ids) {
      try {
        const p = new SessionPersist(id)
        const meta = p.loadMetadata()
        results.push({
          id,
          sessionId: id,
          createdAt: meta?.createdAt ?? 0,
          updatedAt: meta?.updatedAt ?? 0,
          compactEvents: meta?.compactEvents ?? [],
          ...meta,
        })
      } catch {
        // Skip corrupted sessions
      }
    }
    return results.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
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
    try { unlinkSync(join(dir, `${id}.memory.json`)) } catch { /* ignore */ }
    try { unlinkSync(join(dir, `${id}.claims.jsonl`)) } catch { /* ignore */ }
  }

  return toEvict
}
