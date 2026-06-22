import path from 'node:path'

export type AttentionTier = 'L0_build' | 'L1_fragment' | 'L2_foreign' | 'L3_content'

export interface AttentionVerdict {
  tier: AttentionTier
  silent: boolean
  reason: string
}

const BUILD_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  'coverage',
])

const FOREIGN_DIRS = new Set([
  '.agents',
  '.codex',
  '.obsidian',
  '.claude',
  '.cursor',
  '.od-skills',
])

const FRAGMENT_EXTENSIONS = new Set([
  '.log',
  '.lock',
  '.pid',
  '.swp',
  '.tmp',
  '.map',
  '.tsbuildinfo',
])

const FRAGMENT_FILENAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
])

const RIVET_RUNTIME_DIRS = new Set([
  'sessions',
  'tasks',
  'plans',
  'cache-log',
  'sensorium',
  'prefix-diag',
  'playbook',
  'runtime',
  'tmp',
  'external',
])

function normalizeRelPath(relPath: string): string {
  return relPath
    .replaceAll('\\', '/')
    .replace(/^\.\//, '')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '')
}

function splitPath(relPath: string): string[] {
  const normalized = normalizeRelPath(relPath)
  if (!normalized || normalized === '.') return []
  return normalized.split('/').filter(Boolean)
}

function hasArchiveExtension(fileName: string): boolean {
  return /\.(?:zip|tgz|tar\.gz)$/i.test(fileName)
}

function hasSqliteSidecarName(fileName: string): boolean {
  return /^meridian\.db(?:-.+)?$/i.test(fileName) || /^meridian\.db(?:\.shm|\.wal)?$/i.test(fileName)
}

function verdict(tier: AttentionTier, reason: string): AttentionVerdict {
  return { tier, silent: tier !== 'L3_content', reason }
}

/**
 * Classify a repository-relative path by attention value.
 *
 * This is a pure structural classifier: it does not read git, .gitignore,
 * config, or file contents. Unknown paths fail toward content so real human
 * files remain visible unless they match a proven runtime/build/foreign shape.
 */
export function classifyPath(relPath: string): AttentionVerdict {
  const parts = splitPath(relPath)
  if (parts.length === 0) return verdict('L3_content', 'empty-path')

  const first = parts[0]!
  const fileName = parts[parts.length - 1]!
  const ext = path.posix.extname(fileName)

  if (BUILD_DIRS.has(first)) return verdict('L0_build', 'build-dir')
  if (FOREIGN_DIRS.has(first)) return verdict('L2_foreign', 'foreign-agent-dir')

  if (first === '.rivet') {
    const second = parts[1]
    if (second && RIVET_RUNTIME_DIRS.has(second)) return verdict('L1_fragment', 'rivet-runtime')
    if (parts.length === 2 && fileName.endsWith('.jsonl')) return verdict('L1_fragment', 'rivet-jsonl')
    if (hasSqliteSidecarName(fileName)) return verdict('L1_fragment', 'rivet-db')
  }

  if (FRAGMENT_FILENAMES.has(fileName)) return verdict('L1_fragment', 'os-noise')
  if (FRAGMENT_EXTENSIONS.has(ext)) return verdict('L1_fragment', 'fragment-ext')
  if (fileName.endsWith('.jsonl') && first === '.test-tmp') {
    return verdict('L1_fragment', 'runtime-jsonl')
  }
  if (hasArchiveExtension(fileName)) return verdict('L1_fragment', 'archive-artifact')
  if (first === '.test-tmp') return verdict('L1_fragment', 'test-runtime')

  return verdict('L3_content', 'content-default')
}
