import { spawnSync } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'

export interface ScopedCommitInput {
  cwd: string
  files: string[]
  message: string
}

export interface ScopedCommitResult {
  ok: boolean
  output: string
}

export function commitScopedFiles(input: ScopedCommitInput): ScopedCommitResult {
  if (!input.message.trim()) return { ok: false, output: 'Commit message is required.' }

  const files = normalizeFiles(input.cwd, input.files)
  if (files.length === 0) return { ok: false, output: 'No owned files to commit.' }

  const add = runGit(input.cwd, ['add', '--', ...files])
  if (!add.ok) return add

  return runGit(input.cwd, ['commit', '-m', input.message, '--only', '--', ...files])
}

function normalizeFiles(cwd: string, files: string[]): string[] {
  const normalized = files
    .map(file => {
      const resolved = resolve(cwd, file)
      const rel = relative(cwd, resolved)
      if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
      return rel
    })
    .filter((file): file is string => file !== null)
  return [...new Set(normalized)].sort((a, b) => a.localeCompare(b))
}

function runGit(cwd: string, args: string[]): ScopedCommitResult {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) return { ok: false, output: output || `git ${args[0] ?? 'command'} failed` }
  return { ok: true, output }
}
