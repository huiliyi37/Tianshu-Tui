import { spawnSync } from 'node:child_process'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Tool, ToolCallParams } from './types.js'
import { auditCommitTagScope } from './commit-audit.js'
import { createWorkspaceGuard } from '../agent/workspace-guard.js'

const ACTIONS = ['status', 'diff_summary', 'commit', 'log', 'stash', 'stash_pop'] as const
type GitAction = (typeof ACTIONS)[number]

const MAX_OUTPUT = 50_000

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 })
  if (result.status !== 0) {
    throw new Error((result.stderr ?? '').trim() || `git exited with status ${result.status}`)
  }
  const output = result.stdout
  if (output.length > MAX_OUTPUT) {
    return output.slice(0, MAX_OUTPUT) + `\n\n[... truncated at ${MAX_OUTPUT} chars, total ${output.length}]`
  }
  return output
}

function normalizeProjectRelativePath(cwd: string, filePath: string): string | null {
  const resolved = resolve(cwd, filePath)
  const rel = relative(cwd, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

function getScopedCommitFiles(cwd: string, ownedFiles: string[] | undefined, sessionModifiedFiles: string[] | undefined): string[] {
  // B1: prefer ownedFiles (post-baseline) over sessionModifiedFiles (pre-baseline)
  const source = (ownedFiles?.length ? ownedFiles : sessionModifiedFiles) ?? []
  if (!source.length) return []
  const files = source
    .map(filePath => normalizeProjectRelativePath(cwd, filePath))
    .filter((filePath): filePath is string => filePath !== null)
  return [...new Set(files)].sort((a, b) => a.localeCompare(b))
}

function hasStagedChanges(cwd: string, pathspecs?: string[]): boolean {
  const args = ['diff', '--cached', '--quiet']
  if (pathspecs?.length) args.push('--', ...pathspecs)
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', timeout: 10_000 })
  if (result.status === 0) return false
  if (result.status === 1) return true
  throw new Error((result.stderr ?? '').trim() || `git diff exited with status ${result.status}`)
}

export const GIT_TOOL: Tool = {
  definition: {
    name: 'git',
    description: `Structured git operations. Actions:
- status: Show working tree status, current branch, and file changes
- diff_summary: Show diff stats for staged and unstaged changes
- commit: Commit only this session's modified files when available; otherwise commit already staged changes only
- log: Show recent commit history (default 20, configurable with maxCount)
- stash: Stash current working directory changes

For complex git operations (branch, merge, rebase, push, pull), use the bash tool instead.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'The git operation to perform',
        },
        message: {
          type: 'string',
          description: 'Commit message (required for commit action)',
        },
        maxCount: {
          type: 'number',
          description: 'Maximum number of log entries (default 20, for log action)',
        },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams) {
    const action = params.input.action as GitAction
    const cwd = params.cwd

    if (!ACTIONS.includes(action)) {
      return { content: `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`, isError: true }
    }

    try {
      switch (action) {
        case 'status': {
          const branch = runGit(['branch', '--show-current'], cwd).trim()
          const porcelain = runGit(['status', '--porcelain'], cwd).trim()
          const untracked = runGit(['ls-files', '--others', '--exclude-standard'], cwd).trim()
          const lines = [`Branch: ${branch}`]
          if (!porcelain) {
            lines.push('Status: clean')
          } else {
            lines.push('Changes:', porcelain)
          }
          if (untracked) {
            lines.push('Untracked:', untracked)
          }
          return { content: lines.join('\n') }
        }

        case 'diff_summary': {
          const staged = runGit(['diff', '--cached', '--stat'], cwd).trim()
          const unstaged = runGit(['diff', '--stat'], cwd).trim()
          const lines: string[] = []
          if (staged) lines.push('Staged:', staged)
          if (unstaged) lines.push('Unstaged:', unstaged)
          if (!staged && !unstaged) lines.push('No changes.')
          return { content: lines.join('\n') }
        }

        case 'commit': {
          const message = params.input.message as string
          if (!message) {
            return { content: 'Commit requires a "message" parameter.', isError: true }
          }

          const scopedFiles = getScopedCommitFiles(cwd, params.ownedFiles, params.sessionModifiedFiles)
          const commitArgs = ['commit', '-m', message]
          if (scopedFiles.length > 0) {
            runGit(['add', '--', ...scopedFiles], cwd)
            commitArgs.push('--only', '--', ...scopedFiles)
          } else if (!hasStagedChanges(cwd)) {
            return {
              content: 'No session-owned files were provided to git commit and no staged changes exist. Use deliver_task with commit=true for ownership-scoped delivery, or stage explicit files if you intentionally manage git manually.',
              isError: true,
            }
          }

          const result = spawnSync('git', commitArgs, {
            cwd,
            encoding: 'utf-8',
            timeout: 10_000,
          })
          if (result.status !== 0) {
            return { content: `git commit failed: ${(result.stderr ?? '').trim()}`, isError: true }
          }

          // Post-commit truth readback: show actual landed changes + audit tag scope
          const changed = runGit(['show', '--stat', '--format=', 'HEAD'], cwd).trim()
          const changedFiles = changed.split('\n').map(l => l.split('|')[0]!.trim()).filter(f => f && f.includes('/'))
          const audit = auditCommitTagScope(message, changedFiles)
          const body = `${result.stdout.trim()}\n\n--- actual changes (git show --stat) ---\n${changed}`
          return { content: audit.ok ? body : `${body}\n\n${audit.message}` }
        }

        case 'log': {
          const maxCount = Math.max(1, Math.min((params.input.maxCount as number) ?? 20, 100))
          const log = runGit(['log', `--max-count=${maxCount}`, '--oneline', '--decorate'], cwd).trim()
          return { content: log || 'No commits yet.' }
        }

        case 'stash': {
          const stashStatus = runGit(['status', '--porcelain'], cwd).trim()
          if (!stashStatus) {
            return { content: 'No changes to stash.' }
          }

          // B1: scope stash to owned files when available
          if (params.ownedFiles?.length) {
            const scoped = getScopedCommitFiles(cwd, params.ownedFiles, params.sessionModifiedFiles)
            if (scoped.length === 0) {
              return {
                content: 'No owned files to stash. External dirty files are present but excluded from stash scope.',
                isError: true,
              }
            }
            runGit(['stash', 'push', '--', ...scoped], cwd)
            return { content: `Stashed ${scoped.length} owned file(s): ${scoped.join(', ')}` }
          }

          runGit(['stash'], cwd)
          return { content: 'Saved working directory and index state.' }
        }

        case 'stash_pop': {
          const stashRef = (params.input.stashRef as string) || 'stash@{0}'
          const safety = await createWorkspaceGuard(cwd).checkStashSafety(stashRef)
          if (safety.blocked) {
            return { content: safety.reasons.join('\n'), isError: true }
          }
          runGit(['stash', 'pop', stashRef], cwd)
          return { content: `Popped ${stashRef} (safety-checked: no overwriting conflicts).` }
        }

        default:
          return { content: `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`, isError: true }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `git ${action} failed: ${message}`, isError: true }
    }
  },

  requiresApproval(params: ToolCallParams): boolean {
    return (params.input.action as string) === 'commit'
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
