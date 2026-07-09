import { existsSync, statSync } from 'node:fs'
import { validatePathSafe } from '../tools/path-validate.js'

/** Tools whose orphan recovery can be grounded in on-disk file evidence. */
export const WRITE_TOOLS = new Set([
  'write_file', 'edit_file', 'hash_edit', 'apply_patch', 'multi_edit', 'notebook_edit',
])

export interface WriteEvidence {
  exists: boolean
  bytes: number
}

/** Sync probe: given a write-tool call, return disk evidence or undefined on skip/failure. */
export type WriteProbe = (toolName: string, args: unknown) => WriteEvidence | undefined

/** Default on; set RIVET_WRITE_PROBE=0 or false to disable disk evidence in recovery hints. */
export function isWriteProbeEnabled(): boolean {
  const v = process.env.RIVET_WRITE_PROBE
  return v !== '0' && v !== 'false'
}

/**
 * Parse the target path from tool arguments. Robust to arg-processor pointer
 * collapse — processors keep `file_path`/`path` at the top level.
 */
export function extractTargetPath(args: unknown): string | undefined {
  let obj: Record<string, unknown> | undefined
  if (typeof args === 'string') {
    try { obj = JSON.parse(args) as Record<string, unknown> } catch { return undefined }
  } else if (args && typeof args === 'object') {
    obj = args as Record<string, unknown>
  }
  if (!obj) return undefined
  const p = obj.file_path ?? obj.path ?? obj.notebook_path
  return typeof p === 'string' && p.length > 0 ? p : undefined
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

/** Build the synthetic tool-result body for a write-tool orphan (with optional disk evidence). */
export function formatWriteRecoveryContent(
  toolName: string | undefined,
  filePath: string | undefined,
  evidence?: WriteEvidence,
): string {
  if (!toolName || !WRITE_TOOLS.has(toolName)) {
    return '会话中断导致工具结果丢失——该工具可能已经成功执行。检查文件/缓冲区状态后再决定是否重试。'
  }

  const target = filePath ? `\`${filePath}\`` : '目标文件'

  if (evidence?.exists && evidence.bytes > 0) {
    return `会话中断导致工具结果丢失——磁盘证据：${target} 已存在（${formatBytes(evidence.bytes)}），写入很可能已生效。`
      + '直接继续下一步，切勿重写。'
  }

  if (evidence && !evidence.exists) {
    return `会话中断导致工具结果丢失——磁盘证据：${target} 当前不存在，写入未生效。可安全重试该写入。`
  }

  return `会话中断导致工具结果丢失——对 ${target} 的写入很可能已经成功执行，文件已保存到磁盘。`
    + `不要盲目重写：先 read_file ${target} 确认当前内容，若已包含目标改动直接继续下一步；仅当确实缺失时才补写。`
}

/** Factory: cwd-scoped probe using validatePathSafe + stat (never throws). */
export function createWriteEvidenceProbe(cwd: string): WriteProbe {
  if (!isWriteProbeEnabled()) return () => undefined

  return (toolName, args) => {
    if (!WRITE_TOOLS.has(toolName)) return undefined
    const rel = extractTargetPath(args)
    if (!rel) return undefined
    try {
      const validated = validatePathSafe(cwd, rel, 'read')
      if (!validated.ok) return undefined
      const abs = validated.path
      if (!existsSync(abs)) return { exists: false, bytes: 0 }
      const stat = statSync(abs)
      if (!stat.isFile()) return { exists: false, bytes: 0 }
      return { exists: true, bytes: stat.size }
    } catch {
      return undefined
    }
  }
}
