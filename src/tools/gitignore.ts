import { existsSync } from 'fs'
import { readFile } from 'node:fs/promises'
import { resolve, join } from 'path'
import { relativePosix } from '../path-format.js'

const DEFAULT_IGNORE = [
  'node_modules', '.git', '.svn', '.hg',
  '__pycache__', '.pytest_cache', '.mypy_cache',
  '.next', '.nuxt', '.cache', '.turbo',
  'dist', 'build', 'out', 'target',
  '.env', '.env.local', '.env.production',
  '*.pyc', '*.pyo', '*.so', '*.dylib', '*.dll',
  '*.min.js', '*.min.css', '*.map',
  'package-lock.json', 'yarn.lock', 'pnpm-lock.yaml',
  '.DS_Store', 'Thumbs.db',
]

export class GitignoreFilter {
  private patterns: string[]

  constructor(_cwd: string, patterns?: string[]) {
    this.patterns = patterns ?? [...DEFAULT_IGNORE]
  }

  static async create(cwd: string): Promise<GitignoreFilter> {
    const patterns = [...DEFAULT_IGNORE]
    const gitignorePath = join(cwd, '.gitignore')
    if (existsSync(gitignorePath)) {
      try {
        const content = await readFile(gitignorePath, 'utf-8')
        for (const line of content.split('\n')) {
          const trimmed = line.trim()
          if (!trimmed || trimmed.startsWith('#')) continue
          patterns.push(trimmed)
        }
      } catch { /* ignore */ }
    }
    return new GitignoreFilter(cwd, patterns)
  }


  isIgnored(cwd: string, filePath: string): boolean {
    const absPath = resolve(cwd, filePath)
    const relPath = relativePosix(cwd, absPath)

    // Gitignore rules only apply inside the project tree. Paths outside the
    // project (e.g. ~/.rivet/sessions/ on the same machine) must not be blocked
    // — the user may have explicitly granted access to read session logs.
    if (relPath.startsWith('..')) return false

    for (const pattern of this.patterns) {
      if (this.matchPattern(pattern, relPath)) return true
    }
    return false
  }

  private matchPattern(pattern: string, relPath: string): boolean {
    // Negation patterns — not supported, skip
    if (pattern.startsWith('!')) return false

    // Directory-only patterns (trailing /)
    const dirOnly = pattern.endsWith('/')
    const cleanPattern = dirOnly ? pattern.slice(0, -1) : pattern

    // Check if any path segment or the full path matches
    const segments = relPath.split('/')
    for (let i = 0; i < segments.length; i++) {
      const candidate = segments.slice(i).join('/')
      if (this.matchGlob(cleanPattern, candidate)) return true
      if (dirOnly && i === 0 && segments.length > 1 && this.matchGlob(cleanPattern, segments[i]!)) return true
    }

    return false
  }

  private matchGlob(pattern: string, str: string): boolean {
    // Exact match
    if (pattern === str) return true

    // Wildcard patterns
    if (pattern.includes('*')) {
      const re = globToRegex(pattern)
      return re.test(str)
    }

    // Prefix match — "src" matches "src/anything"
    if (str.startsWith(pattern + '/') || str === pattern) return true

    // Suffix match — ".min.js" matches "app.min.js"
    if (pattern.startsWith('.') && str.endsWith(pattern)) return true

    return false
  }
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  return new RegExp(`(^|/)${escaped}$`)
}
