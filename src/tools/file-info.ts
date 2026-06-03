import { existsSync, statSync, lstatSync, readdirSync } from 'fs'
import { extname, basename, relative, resolve, join } from 'path'
import type { Tool, ToolCallParams } from './types.js'
import { validatePathSafe } from './path-validate.js'

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
      // Still check existence for external paths — just don't resolve contents
      const resolved = resolve(inputPath)
      if (existsSync(resolved)) {
        const rel = relative(params.cwd, resolved)
        return {
          content: `Path: ${rel}\nNote: outside project directory — use import_resource to bring it in.`,
          uiContent: `${rel} (outside project)`,
        }
      }
      return { content: `Error: ${validated.error}`, isError: true }
    }

    const absPath = validated.path

    if (!existsSync(absPath)) {
      return {
        content: `Path: ${relative(params.cwd, absPath)}\nExists: false`,
        uiContent: `${relative(params.cwd, absPath)} — does not exist`,
      }
    }

    const lstat = lstatSync(absPath)
    const relPath = relative(params.cwd, absPath)
    const ext = extname(absPath)
    const name = basename(absPath)

    const lines: string[] = [
      `Path: ${relPath}`,
      `Exists: true`,
      `Type: ${lstat.isDirectory() ? 'directory' : lstat.isSymbolicLink() ? 'symlink' : 'file'}`,
    ]

    if (lstat.isFile()) {
      lines.push(`Size: ${formatBytes(lstat.size)}`)
      if (ext) lines.push(`Extension: ${ext}`)
      lines.push(`Modified: ${lstat.mtime.toISOString()}`)
      lines.push(`Permissions: ${octalPermissions(lstat.mode)}`)

      // Detect if it's a text file vs binary (cheap heuristic)
      const isText = isLikelyTextFile(name, ext)
      lines.push(`Encoding: ${isText ? 'text' : 'binary'}`)
    } else if (lstat.isDirectory()) {
      const dirInfo = scanDirectory(absPath)
      lines.push(`Files: ${dirInfo.fileCount}`)
      lines.push(`Total size: ${formatBytes(dirInfo.totalSize)}`)
      lines.push(`Modified: ${lstat.mtime.toISOString()}`)
    } else if (lstat.isSymbolicLink()) {
      lines.push(`Modified: ${lstat.mtime.toISOString()}`)
      // Try to resolve the target
      try {
        const stat = statSync(absPath)
        lines.push(`Target type: ${stat.isDirectory() ? 'directory' : 'file'}`)
        lines.push(`Target size: ${formatBytes(stat.size)}`)
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

function octalPermissions(mode: number): string {
  return `0${(mode & 0o777).toString(8)}`
}

interface DirScanResult {
  fileCount: number
  totalSize: number
}

function scanDirectory(dir: string): DirScanResult {
  let fileCount = 0
  let totalSize = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory()) {
        const sub = scanDirectory(join(dir, entry.name))
        fileCount += sub.fileCount
        totalSize += sub.totalSize
      } else if (entry.isFile()) {
        fileCount++
        try {
          totalSize += statSync(join(dir, entry.name)).size
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
