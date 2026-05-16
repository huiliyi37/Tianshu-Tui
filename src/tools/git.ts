import { spawnSync } from 'node:child_process'
import type { Tool, ToolCallParams } from './types.js'

const ACTIONS = ['status', 'diff_summary', 'commit', 'log', 'stash'] as const
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

export const GIT_TOOL: Tool = {
  definition: {
    name: 'git',
    description: `Structured git operations. Actions:
- status: Show working tree status, current branch, and file changes
- diff_summary: Show diff stats for staged and unstaged changes
- commit: Stage all changes (including untracked files) and commit with a message
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
          const status = runGit(['status', '--porcelain'], cwd).trim()
          if (!status) {
            return { content: 'Nothing to commit. Working tree clean.' }
          }
          runGit(['add', '-A'], cwd)
          const result = spawnSync('git', ['commit', '-m', message], {
            cwd,
            encoding: 'utf-8',
            timeout: 10_000,
          })
          if (result.status !== 0) {
            return { content: `git commit failed: ${(result.stderr ?? '').trim()}`, isError: true }
          }
          return { content: result.stdout.trim() }
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
          runGit(['stash'], cwd)
          return { content: 'Saved working directory and index state.' }
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
