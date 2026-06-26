import { readdir, stat } from 'node:fs/promises'
import { join, basename, resolve } from 'path'
import { relativePosix } from '../path-format.js'
import { classifyPath } from '../context/attention-filter.js'
import type { Tool, ToolCallParams } from './types.js'

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.turbo', '.cache',
])
const DEFAULT_MAX_FILES = 200
const DEFAULT_DEPTH = 4

const ENTRY_FILES = new Set([
  'main.ts', 'main.tsx', 'index.ts', 'index.tsx',
  'app.tsx', 'server.ts', 'server.js', 'main.js',
])
const CONFIG_FILES = new Set([
  'tsconfig.json', 'package.json', 'jsconfig.json',
  'vite.config.ts', 'vite.config.js', 'next.config.js', 'next.config.ts',
  'tailwind.config.ts', 'tailwind.config.js',
])

function isTestFile(name: string): boolean {
  return /\.(test|spec)\.(ts|tsx|js|jsx|mjs|cjs)$/.test(name)
}

function isDocFile(name: string): boolean {
  return name.endsWith('.md')
}

function isConfigFile(name: string): boolean {
  if (CONFIG_FILES.has(name)) return true
  if (name.endsWith('.config.ts') || name.endsWith('.config.js')
    || name.endsWith('.config.mjs') || name.endsWith('.config.cjs')) return true
  return false
}

function annotateFile(name: string): string | null {
  if (ENTRY_FILES.has(name)) return 'entry'
  if (isTestFile(name) || name === '__tests__') return 'test'
  if (isConfigFile(name)) return 'config'
  if (isDocFile(name)) return 'doc'
  return null
}

interface TreeNode {
  name: string
  isDir: boolean
  children?: TreeNode[]
  annotation?: string
  sizeBytes?: number
}

async function buildTree(dir: string, depth: number, fileCount: { n: number; total: number }, maxFiles: number, maxDepth: number, projectRoot: string, includeSilent: boolean): Promise<TreeNode[]> {
  if (depth > maxDepth) return []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }

  const entries: { name: string; isDir: boolean; sizeBytes?: number }[] = []
  for (const name of names) {
    const fullPath = join(dir, name)
    const relPath = relativePosix(projectRoot, fullPath)
    const verdict = classifyPath(relPath)
    if (!includeSilent && (name.startsWith('.') && name !== '.env.example' && name !== '.gitignore')) continue
    if (!includeSilent && verdict.silent) continue
    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(fullPath)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      if (!includeSilent && verdict.tier === 'L0_build') continue
      entries.push({ name, isDir: true })
    } else if (s.isFile()) {
      entries.push({ name, isDir: false, sizeBytes: s.size })
    }
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const nodes: TreeNode[] = []
  for (const entry of entries) {
    if (entry.isDir) {
      const children = await buildTree(join(dir, entry.name), depth + 1, fileCount, maxFiles, maxDepth, projectRoot, includeSilent)
      if (children.length > 0) {
        const annotation = entry.name === '__tests__' ? 'test' : undefined
        nodes.push({ name: entry.name, isDir: true, children, annotation })
      }
    } else {
      fileCount.total++
      if (fileCount.n >= maxFiles) continue
      fileCount.n++
      const annotation = annotateFile(entry.name)
      nodes.push({ name: entry.name, isDir: false, annotation: annotation ?? undefined, sizeBytes: entry.sizeBytes })
    }
  }
  return nodes
}

function formatSize(bytes: number | undefined): string {
  if (bytes === undefined) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

function formatTree(nodes: TreeNode[], prefix: string, isLast: boolean[]): string[] {
  const lines: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    const last = i === nodes.length - 1
    const connector = last ? '└── ' : '├── '
    const annotation = node.annotation ? ` [${node.annotation}]` : ''
    const size = !node.isDir ? ` ${formatSize(node.sizeBytes)}` : ''
    lines.push(`${prefix}${connector}${node.name}${annotation}${size}`)

    if (node.isDir && node.children && node.children.length > 0) {
      const childPrefix = prefix + (last ? '    ' : '│   ')
      lines.push(...formatTree(node.children, childPrefix, []))
    }
  }
  return lines
}

export const REPO_MAP_TOOL: Tool = {
  definition: {
    name: 'repo_map',
    description: `Return a condensed file tree with annotated entry points, test files, and config files.

For file tree use repo_map; for structural relationships (imports/calls, blast radius) use repo_graph.

Start shallow: repo_map({ depth: 2 }), then drill into areas: repo_map({ path: "src/agent/" }).`,
    input_schema: {
      type: 'object',
      properties: {
        max_files: {
          type: 'integer',
          description: 'Max files to include (default: 200)',
        },
        path: {
          type: 'string',
          description: 'Subdirectory to focus on (relative to project root). Default: project root.',
        },
        depth: {
          type: 'integer',
          description: 'Maximum directory depth (default: 4). Use 2 for a shallow overview.',
        },
      },
    },
  },

  async execute(params: ToolCallParams) {
    const maxFiles = (params.input.max_files as number) || DEFAULT_MAX_FILES
    const maxDepth = (params.input.depth as number | undefined) ?? DEFAULT_DEPTH
    const subPath = params.input.path as string | undefined

    let root = params.cwd

    // If a subdirectory is specified, resolve it relative to cwd
    if (subPath) {
      root = resolve(params.cwd, subPath)
      // Security: ensure resolved path is within cwd (trailing sep prevents prefix injection)
      const safeCwd = resolve(params.cwd) + '/'
      if (!root.startsWith(safeCwd) && root !== resolve(params.cwd)) {
        return { content: 'Error: path must be within the project directory', isError: true }
      }
    }

    let s: Awaited<ReturnType<typeof stat>>
    try {
      s = await stat(root)
    } catch {
      return { content: `Error: Directory not found: ${root}`, isError: true }
    }
    if (!s.isDirectory()) {
      return { content: `Error: Not a directory: ${root}`, isError: true }
    }

    const includeSilent = Boolean(subPath && classifyPath(relativePosix(params.cwd, root)).silent)
    const fileCount = { n: 0, total: 0 }
    const tree = await buildTree(root, 0, fileCount, maxFiles, maxDepth, params.cwd, includeSilent)

    // Header: show relative path when focused on subdirectory
    const displayRoot = subPath
      ? `${basename(params.cwd)}/${relativePosix(params.cwd, root)}/`
      : `${basename(root)}/`

    const header = displayRoot
    const lines = formatTree(tree, '', [])

    let dirCount = 0
    const countDirs = (nodes: TreeNode[]) => {
      for (const node of nodes) {
        if (node.isDir) {
          dirCount++
          if (node.children) countDirs(node.children)
        }
      }
    }
    countDirs(tree)

    const omitted = fileCount.total > maxFiles ? fileCount.total - maxFiles : 0
    const truncated = omitted > 0
      ? `\n... (truncated: ${omitted} files omitted; use repo_map({path: "..."}) or glob/grep for targeted ranges)`
      : ''
    const summary = `${fileCount.n} files in tree, ${dirCount} directories`

    return {
      content: `${header}\n${lines.join('\n')}${truncated}\n${summary}`,
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
