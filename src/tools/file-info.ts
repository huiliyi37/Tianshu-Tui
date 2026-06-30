import { stat, lstat, readdir } from 'node:fs/promises'
import { extname, basename, resolve, join } from 'path'
import type { Tool, ToolCallParams } from './types.js'
import { validatePathSafe } from './path-validate.js'
import { relativePosix } from '../path-format.js'

export const FILE_INFO_TOOL: Tool = {
  definition: {
    name: 'file_info',
    description:
      `Get metadata about a file or directory without reading its contents.` +
      `\n\nReturns: exists, type (file/directory/symlink), size, modified time, permissions, extension.` +
      `\nFor directories: also returns file count and total size.` +
      `\nUse this instead of bash stat/ls/file to check if a path exists or how large it is.` +
      `\nNo approval needed — read-only, no subprocess.`,
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'File or directory path (absolute or relative to cwd)',
        },
      },
      required: ['path'],
    },
  },

  async execute(params: ToolCallParams) {
    const inputPath = (params.input.path as string)?.trim()
    if (!inputPath) {
      return { content: 'Error: path is required', isError: true }
    }

    const validated = validatePathSafe(params.cwd, inputPath)
    if (!validated.ok) {
      const resolved = resolve(inputPath)
      try {
        await stat(resolved)
        const rel = relativePosix(params.cwd, resolved)
        return {
          content: `Path: ${rel}\nNote: outside project directory — use import_resource to bring it in.`,
          uiContent: `${rel} (outside project)`,
        }
      } catch {
        return { content: `Error: ${validated.error}`, isError: true }
      }
    }

    const absPath = validated.path

    let ls: Awaited<ReturnType<typeof lstat>>
    try {
      ls = await lstat(absPath)
    } catch {
      return {
        content: `Path: ${relativePosix(params.cwd, absPath)}\nExists: false`,
        uiContent: `${relativePosix(params.cwd, absPath)} — does not exist`,
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
      lines.push(`Files: ${dirInfo.fileCount}`)
      lines.push(`Total size: ${formatBytes(dirInfo.totalSize)}`)
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
}

async function scanDirectory(dir: string): Promise<DirScanResult> {
  let fileCount = 0
  let totalSize = 0
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        const sub = await scanDirectory(join(dir, entry.name))
        fileCount += sub.fileCount
        totalSize += sub.totalSize
      } else if (entry.isFile()) {
        fileCount++
        try {
          const s = await stat(join(dir, entry.name))
          totalSize += s.size
        } catch {
          // unreadable file — skip
        }
      }
    }
  } catch {
    // unreadable directory — return what we have
  }
  return { fileCount, totalSize }
}
