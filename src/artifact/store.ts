import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync, rmSync, createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import { join } from 'node:path'
import type { Artifact, ArtifactSection } from './types.js'

/**
 * Hard cap on how many lines a single ranged read may return. Guards against a
 * recall pulling a giant span back into context in one shot. Callers (and the
 * model) should page with successive ranges instead.
 */
export const MAX_RANGE_LINES = 5000

export interface SaveArtifactInput {
  tool: string
  target: string
  rawContent: string
  summary: string
  sections: ArtifactSection[]
}

export interface ArtifactStoreOptions {
  now?: () => number
  idGenerator?: () => string
}

export interface ArtifactIntegrityError {
  artifactId: string
  rawPath: string
  expectedSha256: string
  actualSha256: string
}

export class ArtifactCorruptionError extends Error {
  readonly artifactId: string
  readonly rawPath: string
  readonly expectedSha256: string
  readonly actualSha256: string

  constructor(details: ArtifactIntegrityError) {
    super(`Artifact ${details.artifactId} raw content is corrupted; re-read source`)
    this.name = 'ArtifactCorruptionError'
    this.artifactId = details.artifactId
    this.rawPath = details.rawPath
    this.expectedSha256 = details.expectedSha256
    this.actualSha256 = details.actualSha256
  }
}

export class ArtifactStore {
  private readonly artifacts = new Map<string, Artifact>()
  private readonly dir: string
  private readonly sessionId: string
  private readonly now: () => number
  private readonly idGenerator: () => string

  constructor(baseDir: string, sessionId: string, options: ArtifactStoreOptions = {}) {
    this.dir = join(baseDir, sessionId)
    this.sessionId = sessionId
    this.now = options.now ?? Date.now
    this.idGenerator = options.idGenerator ?? (() => randomUUID().slice(0, 8))
    this.loadIndex()
  }

  async save(input: SaveArtifactInput): Promise<string> {
    await mkdir(this.dir, { recursive: true })

    const id = this.nextArtifactId(input.tool)
    const rawPath = join(this.dir, `${safeArtifactFileStem(id)}.raw`)
    await writeFile(rawPath, input.rawContent, 'utf-8')

    const artifact: Artifact = {
      id,
      tool: input.tool,
      target: input.target,
      sessionId: this.sessionId,
      createdAt: this.now(),
      summary: input.summary,
      sections: input.sections,
      rawPath,
      charCount: input.rawContent.length,
      lineCount: lineCount(input.rawContent),
      sha256: sha256(input.rawContent),
    }

    this.artifacts.set(id, artifact)
    await appendFile(this.indexPath(), `${JSON.stringify(artifact)}\n`, 'utf-8')
    return id
  }

  get(id: string): Artifact | null {
    return this.artifacts.get(id) ?? null
  }

  listByTarget(target: string): Artifact[] {
    return [...this.artifacts.values()].filter((artifact) => artifact.target === target)
  }

  list(): Artifact[] {
    return [...this.artifacts.values()]
  }

  async readRaw(id: string): Promise<string | null> {
    const artifact = this.artifacts.get(id)
    if (!artifact) return null
    const raw = await readFile(artifact.rawPath, 'utf-8')
    this.assertIntegrity(artifact, raw)
    return raw
  }

  async readLines(id: string, startLine: number, endLine: number): Promise<string | null> {
    const raw = await this.readRaw(id)
    if (raw === null) return null
    const start = Math.max(1, Math.trunc(startLine))
    const end = Math.max(start, Math.trunc(endLine))
    return raw.split('\n').slice(start - 1, end).join('\n')
  }

  /**
   * Stream a line range out of an artifact WITHOUT loading the whole file into
   * memory. This is the recall path for large `compact-history` archives, which
   * routinely exceed the in-memory `readRaw` ceiling on long threads — the exact
   * sessions this archival feature targets.
   *
   * Trade-off: a streamed range read cannot verify the file-level SHA-256 (that
   * needs the full bytes), so integrity is NOT checked here. Cold archives favor
   * readability over the corruption guard that `readRaw`/`readLines` keep.
   *
   * @returns the joined lines for [start, end] (1-based, inclusive), the total
   *          line count, and whether the request hit the MAX_RANGE_LINES cap;
   *          null when the artifact is unknown.
   */
  async readLineRange(
    id: string,
    startLine: number,
    endLine: number,
  ): Promise<{ content: string; totalLines: number; capped: boolean } | null> {
    const artifact = this.artifacts.get(id)
    if (!artifact) return null

    const start = Math.max(1, Math.trunc(startLine))
    const requestedEnd = Math.max(start, Math.trunc(endLine))
    const capped = requestedEnd - start + 1 > MAX_RANGE_LINES
    const end = capped ? start + MAX_RANGE_LINES - 1 : requestedEnd

    const collected: string[] = []
    let lineNo = 0

    const stream = createReadStream(artifact.rawPath, { encoding: 'utf-8' })
    const rl = createInterface({ input: stream, crlfDelay: Infinity })
    try {
      for await (const line of rl) {
        lineNo++
        if (lineNo >= start && lineNo <= end) collected.push(line)
        // Stop once past the window — no need to scan the rest of a multi-MB
        // file. (totalLines is therefore a lower bound on the success path; it
        // is exact only when the range is empty / out of range, since then we
        // read to EOF without ever passing `end`.)
        if (lineNo > end) break
      }
    } finally {
      rl.close()
      stream.destroy()
    }

    return { content: collected.join('\n'), totalLines: lineNo, capped }
  }

  private nextArtifactId(tool: string): string {
    const safeTool = tool.trim().length > 0 ? tool.trim() : 'artifact'
    let id = `${safeTool}:${this.idGenerator()}`
    while (this.artifacts.has(id)) {
      id = `${safeTool}:${this.idGenerator()}`
    }
    return id
  }

  private indexPath(): string {
    return join(this.dir, '_index.jsonl')
  }

  private loadIndex(): void {
    const indexPath = this.indexPath()
    if (!existsSync(indexPath)) return

    const lines = readFileSync(indexPath, 'utf-8').split('\n')
    for (const line of lines) {
      if (line.trim().length === 0) continue
      try {
        const artifact = JSON.parse(line) as Artifact
        if (isArtifactForSession(artifact, this.sessionId)) {
          this.artifacts.set(artifact.id, artifact)
        }
      } catch {
        // Ignore malformed historical records. The index is append-only; one bad line
        // must not make every other artifact unreadable after restart.
      }
    }
  }

  private assertIntegrity(artifact: Artifact, raw: string): void {
    const actualSha256 = sha256(raw)
    if (actualSha256 !== artifact.sha256) {
      throw new ArtifactCorruptionError({
        artifactId: artifact.id,
        rawPath: artifact.rawPath,
        expectedSha256: artifact.sha256,
        actualSha256,
      })
    }
  }
}

function isArtifactForSession(value: Artifact, sessionId: string): value is Artifact {
  return typeof value.id === 'string'
    && typeof value.tool === 'string'
    && typeof value.target === 'string'
    && value.sessionId === sessionId
    && typeof value.rawPath === 'string'
    && typeof value.summary === 'string'
    && typeof value.charCount === 'number'
    && typeof value.lineCount === 'number'
    && typeof value.sha256 === 'string'
    && Array.isArray(value.sections)
}

function safeArtifactFileStem(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-')
}

function lineCount(content: string): number {
  if (content.length === 0) return 0
  return content.split('\n').length
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

const ARTIFACT_SESSION_TTL_MS = 7 * 24 * 3_600_000 // 7 days
const MAX_ARTIFACT_SESSIONS = 50

/**
 * Clean up old artifact session directories that exceed the TTL or count limit.
 * Call once at startup to reclaim disk space from abandoned sessions.
 *
 * @param baseDir - the artifacts root directory (e.g. `.rivet/artifacts`)
 * @param activeSessionId - the current session ID (never deleted)
 * @returns number of session directories removed
 */
export function cleanupOldArtifactSessions(baseDir: string, activeSessionId: string): number {
  if (!existsSync(baseDir)) return 0

  let entries: string[]
  try {
    entries = readdirSync(baseDir)
  } catch {
    return 0
  }

  // Collect session dirs with their mtime
  const sessionDirs: Array<{ name: string; path: string; mtimeMs: number }> = []
  for (const entry of entries) {
    if (entry === activeSessionId) continue
    const fullPath = join(baseDir, entry)
    try {
      const st = statSync(fullPath)
      if (st.isDirectory()) {
        sessionDirs.push({ name: entry, path: fullPath, mtimeMs: st.mtimeMs })
      }
    } catch {
      // skip inaccessible entries
    }
  }

  // Sort by mtime ascending (oldest first)
  sessionDirs.sort((a, b) => a.mtimeMs - b.mtimeMs)

  const cutoff = Date.now() - ARTIFACT_SESSION_TTL_MS
  let cleaned = 0

  for (const dir of sessionDirs) {
    // Delete if older than TTL, or if remaining count still exceeds the limit
    if (dir.mtimeMs < cutoff || sessionDirs.length - cleaned > MAX_ARTIFACT_SESSIONS) {
      try {
        rmSync(dir.path, { recursive: true, force: true })
        cleaned++
      } catch {
        // skip if removal fails
      }
    }
  }

  return cleaned
}
