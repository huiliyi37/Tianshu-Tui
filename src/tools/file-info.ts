import { stat, lstat, readdir } from 'node:fs/promises'
import { extname, basename, resolve, join } from 'path'
import type { Tool, ToolCallParams } from './types.js'
import { validatePathSafe } from './path-validate.js'
import { relativePosix } from '../path-format.js'
import { isScanExcludedDir } from './scan-excludes.js'

export const FILE_INFO_TOOL: Tool = {
  definition: {
    name: 'file_info',
    description:
      `获取文件或目录的元数据，不读取其内容。` +
      `\n\n返回：exists、type（file/directory/symlink）、size、修改时间、permissions、扩展名。` +
      `\n目录额外返回：文件数量和总大小。` +
      `\n用本工具替代 bash stat/ls/file 来检查路径是否存在、体积多大。` +
      `\n无需审批——只读，不启动子进程。`,
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件或目录路径（绝对路径，或相对 cwd 的路径）',
        },
      },
      required: ['path'],
    },
  },

  async execute(params: ToolCallParams) {
    const inputPath = (params.input.path as string)?.trim()
    if (!inputPath) {
      return { content: '错误：path 参数必填', isError: true }
    }

    const validated = validatePathSafe(params.cwd, inputPath)
    if (!validated.ok) {
      const resolved = resolve(inputPath)
      try {
        await stat(resolved)
        const rel = relativePosix(params.cwd, resolved)
        return {
          content: `Path: ${rel}\n注意：位于项目目录外——需要读取时先用 import_resource 引入。`,
          uiContent: `${rel}（项目外）`,
        }
      } catch {
        return { content: `错误：${validated.error}`, isError: true }
      }
    }

    const absPath = validated.path

    let ls: Awaited<ReturnType<typeof lstat>>
    try {
      ls = await lstat(absPath)
    } catch {
      return {
        content: `Path: ${relativePosix(params.cwd, absPath)}\nExists: false（路径不存在）`,
        uiContent: `${relativePosix(params.cwd, absPath)} — 不存在`,
      }
    }

    const relPath = relativePosix(params.cwd, absPath)
    const ext = extname(absPath)
    const name = basename(absPath)

    const lines: string[] = [
      `Path: ${relPath}`,
      `Exists: true`,
      `Type: ${ls.isDirectory() ? 'directory' : ls.isSymbolicLink() ? 'symlink' : 'file'}`,
    ]

    if (ls.isFile()) {
      lines.push(`Size: ${formatBytes(ls.size)}`)
      if (ext) lines.push(`Extension: ${ext}`)
      lines.push(`Modified: ${ls.mtime.toISOString()}`)
      lines.push(`Permissions: ${formatPermissions(ls.mode)}`)

      const isText = isLikelyTextFile(name, ext)
      lines.push(`Encoding: ${isText ? 'text' : 'binary'}`)
    } else if (ls.isDirectory()) {
      const dirInfo = await scanDirectory(absPath)
      // A lower bound printed as an exact count is a wrong answer, not a
      // rounded one — say which it is.
      const approx = dirInfo.truncated ? '≥' : ''
      lines.push(`Files: ${approx}${dirInfo.fileCount}`)
      lines.push(`Total size: ${approx}${formatBytes(dirInfo.totalSize)}`)
      if (dirInfo.truncated) {
        lines.push('Note: partial tally — build/dependency subtrees skipped, or the file/depth cap was reached.')
      }
      lines.push(`Modified: ${ls.mtime.toISOString()}`)
    } else if (ls.isSymbolicLink()) {
      lines.push(`Modified: ${ls.mtime.toISOString()}`)
      try {
        const s = await stat(absPath)
        lines.push(`Target type: ${s.isDirectory() ? 'directory' : 'file'}`)
        lines.push(`Target size: ${formatBytes(s.size)}`)
      } catch {
        lines.push(`Target: broken symlink`)
      }
    }

    return { content: lines.join('\n') }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonl', '.json5',
  '.md', '.mdx', '.txt', '.rst', '.adoc',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.fish',
  '.css', '.scss', '.less', '.html', '.htm', '.svg',
  '.xml', '.csv', '.tsv',
  '.sql', '.graphql', '.proto',
  '.lock', '.log', '.patch', '.diff',
  '.env', '.gitignore', '.editorconfig',
])

const TEXT_FILENAMES = new Set([
  'makefile', 'dockerfile', 'license', 'readme', 'changelog',
  '.gitignore', '.npmrc', '.editorconfig', '.env',
])

function isLikelyTextFile(name: string, ext: string): boolean {
  if (ext && TEXT_EXTENSIONS.has(ext.toLowerCase())) return true
  if (TEXT_FILENAMES.has(name.toLowerCase())) return true
  return false
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const val = bytes / Math.pow(1024, i)
  return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

/** Human-readable permissions. POSIX octal (0755) where it is meaningful; on
 *  Windows the mode has no POSIX bits, so report the only real distinction —
 *  whether the file is writable — instead of a misleading octal string. */
export function formatPermissions(mode: number, platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return (mode & 0o200) ? 'read-write' : 'read-only'
  }
  return `0${(mode & 0o777).toString(8)}`
}

interface DirScanResult {
  fileCount: number
  totalSize: number
  /** A limit was hit — the numbers are lower bounds, not totals. */
  truncated: boolean
}

/**
 * Bounds for the recursive directory tally.
 *
 * Every file here costs a `stat`, so an unbounded walk turns one `file_info`
 * call into as many syscalls as the tree is deep and wide — pointing it at this
 * repo's `desktop/src-tauri/target/debug/deps` meant 19433 of them. A summary
 * does not need to be exact to be useful, but it does need to come back.
 */
const MAX_SCAN_FILES = 5_000
const MAX_SCAN_DEPTH = 12

async function scanDirectory(dir: string): Promise<DirScanResult> {
  let fileCount = 0
  let totalSize = 0
  let truncated = false

  async function walk(current: string, depth: number): Promise<void> {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return // unreadable directory — keep what we have
    }
    for (const entry of entries) {
      if (fileCount >= MAX_SCAN_FILES) {
        truncated = true
        return
      }
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        // Skipping the build/dependency trees is the difference between
        // summarising a project and summarising its compiler output. Callers
        // that genuinely want those pass them as the root, which still works —
        // this only prunes them when found *inside* another tree.
        if (isScanExcludedDir(entry.name) || depth >= MAX_SCAN_DEPTH) {
          truncated = true
          continue
        }
        await walk(join(current, entry.name), depth + 1)
      } else if (entry.isFile()) {
        fileCount++
        try {
          const s = await stat(join(current, entry.name))
          totalSize += s.size
        } catch {
          // unreadable file — counted, but its size is unknown
        }
      }
    }
  }

  await walk(dir, 0)
  return { fileCount, totalSize, truncated }
}
