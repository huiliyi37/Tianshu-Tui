import { mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { diffLines } from 'diff'
import { dirname, join } from 'node:path'

const MAX_SNAPSHOTS = 100

export interface FileBackup {
  backupFileName: string | null
  version: number
  timestamp: number
}

export interface FileSnapshot {
  messageId: string
  trackedFileBackups: Record<string, FileBackup>
  timestamp: number
}

export interface DiffStats {
  filesChanged: string[]
  insertions: number
  deletions: number
}

export class FileHistory {
  private snapshots: FileSnapshot[] = []
  private trackedFiles = new Set<string>()

  constructor(
    private backupDir: string,
    private sessionId: string,
  ) {}

  async trackEdit(filePath: string, messageId: string): Promise<void> {
    this.trackedFiles.add(filePath)

    const lastSnapshot = this.snapshots.at(-1)
    if (lastSnapshot?.messageId === messageId && lastSnapshot.trackedFileBackups[filePath]) {
      return
    }

    let version = 1
    for (const s of this.snapshots) {
      const b = s.trackedFileBackups[filePath]
      if (b && b.version >= version) version = b.version + 1
    }

    let backup: FileBackup
    try {
      const content = await readFile(filePath, 'utf-8')
      const fileNameHash = createHash('sha256').update(filePath).digest('hex').slice(0, 16)
      const backupFileName = `${fileNameHash}@v${version}`
      const backupPath = join(this.backupDir, this.sessionId, backupFileName)
      await mkdir(dirname(backupPath), { recursive: true })
      await writeFile(backupPath, content, 'utf-8')
      backup = { backupFileName, version, timestamp: Date.now() }
    } catch {
      backup = { backupFileName: null, version, timestamp: Date.now() }
    }

    if (lastSnapshot && lastSnapshot.messageId === messageId) {
      lastSnapshot.trackedFileBackups[filePath] = backup
    } else {
      const snapshot: FileSnapshot = {
        messageId,
        trackedFileBackups: { [filePath]: backup },
        timestamp: Date.now(),
      }
      this.snapshots.push(snapshot)
      if (this.snapshots.length > MAX_SNAPSHOTS) {
        const evicted = this.snapshots.slice(0, this.snapshots.length - MAX_SNAPSHOTS)
        this.snapshots = this.snapshots.slice(-MAX_SNAPSHOTS)
        for (const s of evicted) {
          for (const b of Object.values(s.trackedFileBackups)) {
            if (b.backupFileName) {
              try { await unlink(join(this.backupDir, this.sessionId, b.backupFileName)) } catch { /* already gone */ }
            }
          }
        }
      }
    }
  }

  async rewind(targetMessageId: string): Promise<string[]> {
    let targetSnapshot: FileSnapshot | undefined
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i]!.messageId === targetMessageId) {
        targetSnapshot = this.snapshots[i]
        break
      }
    }
    if (!targetSnapshot) {
      throw new Error(`Snapshot for ${targetMessageId} not found`)
    }

    const filesChanged: string[] = []
    for (const filePath of this.trackedFiles) {
      const targetBackup = targetSnapshot.trackedFileBackups[filePath]
      if (targetBackup === undefined) continue

      if (targetBackup.backupFileName === null) {
        try {
          await unlink(filePath)
          filesChanged.push(filePath)
        } catch { /* already gone */ }
        continue
      }

      const backupPath = join(this.backupDir, this.sessionId, targetBackup.backupFileName)
      try {
        const content = await readFile(backupPath, 'utf-8')
        await mkdir(dirname(filePath), { recursive: true })
        await writeFile(filePath, content, 'utf-8')
        filesChanged.push(filePath)
      } catch { /* backup missing, skip */ }
    }
    return filesChanged
  }

  async getDiffStats(targetMessageId: string): Promise<DiffStats | undefined> {
    let targetSnapshot: FileSnapshot | undefined
    for (let i = this.snapshots.length - 1; i >= 0; i--) {
      if (this.snapshots[i]!.messageId === targetMessageId) {
        targetSnapshot = this.snapshots[i]
        break
      }
    }
    if (!targetSnapshot) return undefined

    const filesChanged: string[] = []
    let insertions = 0
    let deletions = 0

    for (const filePath of this.trackedFiles) {
      const targetBackup = targetSnapshot.trackedFileBackups[filePath]
      if (targetBackup === undefined) continue

      let oldContent = ''
      if (targetBackup.backupFileName !== null) {
        try {
          oldContent = await readFile(join(this.backupDir, this.sessionId, targetBackup.backupFileName), 'utf-8')
        } catch { /* skip */ }
      }

      let newContent = ''
      try {
        newContent = await readFile(filePath, 'utf-8')
      } catch { /* file deleted */ }

      if (oldContent === newContent) continue
      filesChanged.push(filePath)

      const changes = diffLines(oldContent, newContent)
      for (const c of changes) {
        if (c.added) insertions += c.count ?? 0
        if (c.removed) deletions += c.count ?? 0
      }
    }

    return { filesChanged, insertions, deletions }
  }

  hasSnapshot(messageId: string): boolean {
    return this.snapshots.some(s => s.messageId === messageId)
  }

  getLatestSnapshotId(): string | undefined {
    return this.snapshots.at(-1)?.messageId
  }

  getAllSnapshots(): FileSnapshot[] {
    return this.snapshots
  }

  async cleanupOrphans(): Promise<number> {
    const sessionDir = join(this.backupDir, this.sessionId)
    let dirEntries: string[]
    try {
      dirEntries = await readdir(sessionDir)
    } catch {
      return 0
    }

    const referencedBackups = new Set<string>()
    for (const snapshot of this.snapshots) {
      for (const backup of Object.values(snapshot.trackedFileBackups)) {
        if (backup.backupFileName) {
          referencedBackups.add(backup.backupFileName)
        }
      }
    }

    let removed = 0
    for (const entry of dirEntries) {
      if (!referencedBackups.has(entry)) {
        try {
          await unlink(join(sessionDir, entry))
          removed++
        } catch {
          // File already gone or permission issue — skip
        }
      }
    }
    return removed
  }
}
