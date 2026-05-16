import { writeFileSync, renameSync, unlinkSync, existsSync, mkdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'

/**
 * Atomically write a file: write to a temp file in the same directory,
 * then rename (which is atomic on POSIX and APFS). If the process crashes
 * mid-write, the original file is untouched.
 */
export function writeFileAtomicSync(filePath: string, data: string): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

  const suffix = randomUUID().slice(0, 8)
  const tmpPath = filePath + '.' + suffix + '.tmp'
  try {
    writeFileSync(tmpPath, data, 'utf-8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try { unlinkSync(tmpPath) } catch { /* ignore cleanup failure */ }
    throw err
  }
}
