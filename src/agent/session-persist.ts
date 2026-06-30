import { appendFile } from 'fs/promises'
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, rmSync, readdirSync, statSync } from 'fs'
import { writeFileAtomicSync, writeFileAtomicAsync } from '../fs-atomic.js'
import { join, resolve } from 'path'
import { sessionsDir } from '../config/paths.js'
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

/** Re-export for backward compatibility — tests still import projectSlug from here. */
export { projectSlug } from '../config/paths.js'

export function getSessionDir(cwd: string): string {
  return sessionsDir(cwd)
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
  if (parsed.type === 'compact_start' || parsed.type === 'compact_end' || parsed.type === 'model_switch') {
    return null
  }
  return parsed
}

export class SessionPersist {
  private filePath: string
  private metadataPath: string
  private sessionId: string
  private cwd: string

  /** Public getter for testing file-path-dependent integrations. */
  getFilePath(): string {
    return this.filePath
  }

  constructor(sessionId: string, cwd: string) {
    assertValidSessionId(sessionId)
    this.cwd = cwd
    ensureDir(getSessionDir(cwd))
    this.sessionId = sessionId
    this.filePath = join(getSessionDir(cwd), `${sessionId}.jsonl`)
    this.metadataPath = join(getSessionDir(cwd), `${sessionId}.meta.json`)
  }

  getBackupDir(): string {
    const dir = join(getSessionDir(this.cwd), this.sessionId, 'backups')
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

  /**
   * Append a model-switch event to the session transcript.
   *
   * Written as a checksummed `type: 'model_switch'` line so it survives
   * checksum verification, but parseSessionLine skips it on replay (same
   * pattern as compact_start/compact_end) — it's an audit breadcrumb, not
   * part of the conversation history. Lets a session JSONL show exactly
   * when/what the model changed mid-session.
   */
  appendModelSwitch(event: { from?: string; to: string; provider?: string }): void {
    const line = appendChecksum(JSON.stringify({
      type: 'model_switch',
      t: Date.now(),
      from: event.from,
      to: event.to,
      provider: event.provider,
    })) + '\n'
    appendFileSync(this.filePath, line)
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
    SessionPersist.invalidateListCache()
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
    return loadSessionMemory(getSessionDir(this.cwd), this.sessionId)
  }

  appendMemory(input: { text: string; source: SessionMemoryEntry['source']; createdAt: number }): SessionMemoryState {
    return appendSessionMemory(getSessionDir(this.cwd), this.sessionId, input)
  }

  buildMemoryBlock(): string {
    return buildSessionMemoryBlock(this.loadMemory())
  }

  getSessionMemoryState(): LedgerSessionMemoryState | undefined {
    const memory = this.loadMemory()
    if (memory.entries.length === 0) return undefined
    const block = buildSessionMemoryBlock(memory)
    return {
      path: join(getSessionDir(this.cwd), `${this.sessionId}.memory.json`),
      lastSummarizedRoundIndex: -1,
      lastUpdatedAt: memory.entries[memory.entries.length - 1]?.createdAt ?? Date.now(),
      digest: block.length > 200 ? block.slice(0, 197) + '...' : block,
      stale: false,
      tokenEstimate: block.length,
    }
  }

  /** Create a claim store for the current session. */
  createClaimStore(): ContextClaimStore {
    return new ContextClaimStore(getSessionDir(this.cwd), this.sessionId)
  }

  /** Load durable claims from the most recent previous session. */
  loadPreviousDurableClaims(): ContextClaim[] {
    const sessions = SessionPersist.listSessions(this.cwd)
    const previous = sessions
      .filter(s => s !== this.sessionId)
      .sort()
      .pop()
    if (!previous) return []
    return ContextClaimStore.loadDurableClaims(getSessionDir(this.cwd), previous)
  }

  /** Inject durable claims from previous session into a claim store with confidence decay.
   *  A4: cross-session pollution gate — only inject claims that intersect with current
   *  project files AND were created within 7 days. */
  injectDurableClaims(store: ContextClaimStore, cwd?: string): void {
    const now = Date.now()
    const TTL_MS = 7 * 24 * 60 * 60 * 1000 // 7 days
    const durableClaims = this.loadPreviousDurableClaims()
    for (const claim of durableClaims) {
      // A4 TTL gate: skip claims older than 7 days
      if (now - claim.createdAt > TTL_MS) continue
      // A4 file intersection gate: skip claims whose evidence files don't
      // intersect with current project. Normalize relative paths with cwd.
      // Claims with no file evidence (conceptual/verification) always pass.
      if (cwd) {
        const fileEvidence = claim.evidence.filter(e => e.path)
        if (fileEvidence.length > 0) {
          const sep = cwd.endsWith('/') ? '' : '/'
          const cwdPrefix = cwd + sep
          const hasRelevantFile = fileEvidence.some(e => {
            const abs = resolve(cwd, e.path!)
            // P3: exact prefix boundary — /Users/a/proj must not match /Users/a/proj-backup
            return abs === cwd || abs.startsWith(cwdPrefix)
          })
          if (!hasRelevantFile) continue
        }
      }
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

  /** Write structured handoff text for this session. */
  writeHandoff(text: string): void {
    const handoffPath = join(getSessionDir(this.cwd), `${this.sessionId}.handoff.md`)
    writeFileAtomicSync(handoffPath, text)
  }

  /**
   * Load the most relevant previous session's handoff text.
   * Routes by domain if both sessions have a domain tag; otherwise falls back
   * to the most recently updated session. Returns null if none found.
   */
  static loadPrevHandoff(cwd: string, currentSessionId: string, currentDomain?: string): string | null {
    const sessions = SessionPersist.listSessionsWithMetadata(cwd)
      .filter(s => s.id !== currentSessionId)
    if (sessions.length === 0) return null

    // Prefer same-domain sessions; fall back to all
    let candidates = sessions
    if (currentDomain) {
      const sameDomain = sessions.filter(s => s.domain === currentDomain)
      if (sameDomain.length > 0) candidates = sameDomain
    }

    // listSessionsWithMetadata already sorts by updatedAt desc
    const prev = candidates[0]
    if (!prev) return null

    const handoffPath = join(getSessionDir(cwd), `${prev.id}.handoff.md`)
    if (!existsSync(handoffPath)) return null
    try {
      return readFileSync(handoffPath, 'utf-8')
    } catch {
      return null
    }
  }

  /** List all session files */
  static listSessions(cwd: string): string[] {
    const dir = getSessionDir(cwd)
    ensureDir(dir)
    try {
      return readdirSync(dir)
        .filter((f: string) => f.endsWith('.jsonl'))
        .map((f: string) => f.replace('.jsonl', ''))
    } catch {
      return []
    }
  }

  /**
   * Cache for listSessionsWithMetadata — avoids re-reading hundreds of session
   * meta files on every user boundary when cross-session handoff is requested.
   * TTL: 60s. Invalidated on write (saveMetadata / saveHandoff).
   * Keyed by cwd since sessions are per-project.
   */
  private static _listCache: Map<string, { ts: number; data: Array<SessionMetadata & { id: string }> }> = new Map()
  private static readonly LIST_CACHE_TTL_MS = 60_000

  static invalidateListCache(): void {
    SessionPersist._listCache.clear()
  }

  /** List sessions with metadata, sorted by updatedAt descending (most recent first) */
  static listSessionsWithMetadata(cwd: string): Array<SessionMetadata & { id: string }> {
    const now = Date.now()
    const cached = SessionPersist._listCache.get(cwd)
    if (cached && (now - cached.ts) < SessionPersist.LIST_CACHE_TTL_MS) {
      return cached.data
    }

    const ids = SessionPersist.listSessions(cwd)
    const results: Array<SessionMetadata & { id: string }> = []
    for (const id of ids) {
      try {
        const p = new SessionPersist(id, cwd)
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
    results.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    SessionPersist._listCache.set(cwd, { ts: now, data: results })
    return results
  }

  /**
   * Main user-facing sessions only: excludes worker sub-sessions (`worker-*`)
   * and non-transcript artifacts whose id carries a dotted suffix
   * (`<id>.claims`, `<id>.memory`, `<id>.snapshot`). Sorted by updatedAt desc.
   */
  static listMainSessions(cwd: string): Array<SessionMetadata & { id: string }> {
    return SessionPersist.listSessionsWithMetadata(cwd)
      .filter(s => !s.id.startsWith('worker-') && !s.id.includes('.'))
  }

  /**
   * Resolve a user-supplied session reference (full id or short prefix) to a
   * single full session id. Exact match wins; otherwise prefix-match across
   * main sessions. Returns the resolved id, an ambiguous candidate list, or
   * null when nothing matches. The id = log id = resume id are the same value.
   */
  static resolveSessionId(
    cwd: string,
    ref: string,
  ): { id: string } | { ambiguous: string[] } | null {
    const ref0 = ref.trim()
    if (!ref0) return null
    const sessions = SessionPersist.listMainSessions(cwd)
    const exact = sessions.find(s => s.id === ref0)
    if (exact) return { id: exact.id }
    const matches = sessions.filter(s => s.id.startsWith(ref0))
    if (matches.length === 1) return { id: matches[0]!.id }
    if (matches.length > 1) return { ambiguous: matches.map(s => s.id) }
    return null
  }

  /**
   * Render the session list for CLI `--list` and TUI `/sessions`. One row per
   * main session, numbered to match `listMainSessions` ordering so the index is
   * stable and aligned with prefix-based resume.
   */
  static formatSessionList(cwd: string, currentId?: string): string {
    const sessions = SessionPersist.listMainSessions(cwd)
    if (sessions.length === 0) return '没有历史会话。'
    return sessions.map((s, i) => {
      const marker = s.id === currentId ? '  ← 当前' : ''
      const when = formatRelativeTime(s.updatedAt ?? 0)
      const turns = s.turnCount ?? 0
      const model = s.model ?? '?'
      const domain = s.domain ? ` ${s.domain}` : ''
      const title = (s.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 50)
      return `${String(i + 1).padStart(2)}. ${s.id.slice(0, 8)}  ${when}  ${turns}轮  ${model}${domain}  ${title}${marker}`
    }).join('\n')
  }
}

/** Compact relative time for session lists, e.g. "刚刚" / "5分钟前" / "3天前". */
function formatRelativeTime(ts: number): string {
  if (!ts) return '未知'
  const diff = Date.now() - ts
  if (diff < 0) return '刚刚'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min}分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day}天前`
  const mon = Math.floor(day / 30)
  if (mon < 12) return `${mon}个月前`
  return `${Math.floor(mon / 12)}年前`
}

const MAX_SESSIONS = 50

export function evictOldSessions(keepSessionId: string, cwd: string): string[] {
  return evictOldSessionsInternal(getSessionDir(cwd), keepSessionId, MAX_SESSIONS)
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
    // Clean up same-name session directory (backups/, and any stray files).
    // Without this, getBackupDir() creates <id>/backups/ that evict never removes.
    try { rmSync(join(dir, id), { recursive: true, force: true }) } catch { /* ignore */ }
  }

  return toEvict
}
