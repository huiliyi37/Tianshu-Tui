import { writeFileSync, readFileSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { getDefaultEditor } from '../platform.js'

export function getEditorCommand(): string {
  return process.env['VISUAL'] || process.env['EDITOR'] || getDefaultEditor()
}

/** 临时目录路径（外部创建后可清理） */
let tempDirPath: string | null = null

export function createTempFile(content: string): string {
  // WSL2: /tmp 是 tmpfs，WSL 重启后不会自动清理残留文件。
  // 创建目录时记录路径，便于 readAndCleanup 清理整个目录。
  const baseDir = tmpdir()
  const dir = mkdtempSync(join(baseDir, 'rivet-edit-'))
  tempDirPath = dir // 记录以便后续清理
  const path = join(dir, 'RIVET_INPUT.md')
  writeFileSync(path, content)
  return path
}

export function readAndCleanup(path: string): string {
  const content = readFileSync(path, 'utf-8')
  // 先删文件，再尝试清理整个临时目录（best effort）
  try { unlinkSync(path) } catch { /* best effort */ }
  if (tempDirPath) {
    try { rmSync(tempDirPath, { recursive: true, force: true }) } catch { /* best effort */ }
    tempDirPath = null
  }
  return content
}

export function openInEditor(initialContent: string): string | null {
  const path = createTempFile(initialContent)
  const editor = getEditorCommand()
  try {
    const result = spawnSync(editor, [path], { stdio: 'inherit' })
    if (result.status !== 0 && result.error) return null
  } finally {
    // 无论成功/失败都尝试读取文件（用户可能保存了内容后强制关闭编辑器）
    try {
      const content = readFileSync(path, 'utf-8')
      // 先删文件，再清理目录
      unlinkSync(path)
      if (tempDirPath) {
        try { rmSync(tempDirPath, { recursive: true, force: true }) } catch { /* best effort */ }
        tempDirPath = null
      }
      return content
    } catch {
      // 文件已删或读取失败
      if (tempDirPath) {
        try { rmSync(tempDirPath, { recursive: true, force: true }) } catch { /* best effort */ }
        tempDirPath = null
      }
      return null
    }
  }
}
