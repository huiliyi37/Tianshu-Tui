import { readdirSync, statSync, existsSync } from 'fs'
import { join, basename } from 'path'
import type { Tool, ToolCallParams } from './types.js'

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage',
  '__pycache__', '.turbo', '.cache',
])
const DEFAULT_MAX_FILES = 200
const MAX_DEPTH = 4

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
  return name.endsWith('.test.ts') || name.endsWith('.test.tsx')
    || name.endsWith('.spec.ts') || name.endsWith('.spec.tsx')
    || name.endsWith('.test.js') || name.endsWith('.spec.js')
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
}

function buildTree(dir: string, depth: number, fileCount: { n: number }, maxFiles: number): TreeNode[] {
  if (depth > MAX_DEPTH) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }

  // Sort: directories first, then files; alphabetically within each group
  const entries: { name: string; isDir: boolean }[] = []
  for (const name of names) {
    // Skip hidden files/dirs except allowed ones
    if (name.startsWith('.') && name !== '.env.example' && name !== '.gitignore') continue
    const fullPath = join(dir, name)
    let s: ReturnType<typeof statSync>
    try {
      s = statSync(fullPath)
    } catch {
      continue
    }
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      entries.push({ name, isDir: true })
    } else if (s.isFile()) {
      entries.push({ name, isDir: false })
    }
  }

  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    return a.name.localeCompare(b.name)
  })

  const nodes: TreeNode[] = []
  for (const entry of entries) {
    if (entry.isDir) {
      const children = buildTree(join(dir, entry.name), depth + 1, fileCount, maxFiles)
      // Only include directory if it has contents
      if (children.length > 0) {
        // Check if directory itself should be annotated (e.g., __tests__)
        const annotation = entry.name === '__tests__' ? 'test' : undefined
        nodes.push({ name: entry.name, isDir: true, children, annotation })
      }
    } else {
      if (fileCount.n >= maxFiles) continue
      fileCount.n++
      const annotation = annotateFile(entry.name)
      nodes.push({ name: entry.name, isDir: false, annotation: annotation ?? undefined })
    }
  }
  return nodes
}

function formatTree(nodes: TreeNode[], prefix: string, isLast: boolean[]): string[] {
  const lines: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    const last = i === nodes.length - 1
    const connector = last ? '└── ' : '├── '
    const annotation = node.annotation ? ` [${node.annotation}]` : ''
    lines.push(`${prefix}${connector}${node.name}${annotation}`)

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
    description: `Return a condensed file tree showing project structure with key entry points and test files.

### Usage
- Use repo_map when entering a project to understand its file layout
- Shows directory tree (max depth 4) with important files annotated
- Excludes node_modules, .git, dist, build, .next, coverage

### Examples
Good: repo_map() — get project file tree
Good: repo_map(max_files=100) — smaller tree for large projects`,
    input_schema: {
      type: 'object',
      properties: {
        max_files: {
          type: 'integer',
          description: 'Max files to include (default: 200)',
        },
      },
    },
  },

  async execute(params: ToolCallParams) {
    const maxFiles = (params.input.max_files as number) || DEFAULT_MAX_FILES
    const root = params.cwd

    if (!existsSync(root)) {
      return { content: `Error: Directory not found: ${root}`, isError: true }
    }

    try {
      const stat = statSync(root)
      if (!stat.isDirectory()) {
        return { content: `Error: Not a directory: ${root}`, isError: true }
      }
    } catch {
      return { content: `Error: Cannot access path: ${root}`, isError: true }
    }

    const fileCount = { n: 0 }
    const tree = buildTree(root, 0, fileCount, maxFiles)
    const projectName = basename(root)

    const header = `${projectName}/`
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

    const truncated = fileCount.n >= maxFiles ? '\n... (truncated)' : ''
    const summary = `${fileCount.n} files in tree, ${dirCount} directories`

    return {
      content: `${header}\n${lines.join('\n')}${truncated}\n${summary}`,
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
