import { spawnGit } from './spawn-git.js'
import { relative, resolve } from 'path'
import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { validatePathSafe } from './path-validate.js'
import { persistRawOutput, buildModelOutput, buildUiOutput } from './output-store.js'
import { track } from './process-tracker.js'
import { gracefulKill } from '../platform.js'

const MAX_LINES_PER_FILE = 200
const MAX_TOTAL_CHARS = 8000

export const DIFF_TOOL: Tool = {
  definition: {
    name: 'diff',
    description: `Show git diff for working tree changes.

### Usage
- Use diff to see what files have changed before committing
- Use diff before editing to understand current state
- Use diff after editing to verify changes are correct
- Results are truncated per file (200 lines max)

### Examples
Good: diff() — show all unstaged changes
Good: diff(staged=true) — show staged changes
Good: diff(path="src/api/client.ts") — show diff for one file`,
    input_schema: {
      type: 'object',
      properties: {
        staged: { type: 'boolean', description: 'Show staged changes (--cached)' },
        path: { type: 'string', description: 'Filter to specific file or directory' },
        context_lines: { type: 'integer', description: 'Lines of context (default: 3)' },
        current_task_only: { type: 'boolean', description: 'Show diff only for files owned by the current task (B1 ownership scope)' },
      },
    },
  },

  async execute(params: ToolCallParams): Promise<ToolResult> {
    const staged = (params.input.staged as boolean) ?? false
    const path = params.input.path as string | undefined
    const contextLines = (params.input.context_lines as number) ?? 3
    const startTime = Date.now()
    const currentTaskOnly = params.input.current_task_only === true

    const args = ['diff']
    if (staged) args.push('--cached')
    args.push(`-U${contextLines}`)

    // B1: current_task_only restricts diff to owned files
    if (currentTaskOnly && params.ownedFiles?.length) {
      const ownedPaths = params.ownedFiles
        .map(f => relative(params.cwd, resolve(params.cwd, f)))
        .filter(f => !f.startsWith('..'))
      if (ownedPaths.length === 0) {
        return { content: 'No owned files to diff.' }
      }
      args.push('--', ...ownedPaths)
    } else if (path) {
      const validated = validatePathSafe(params.cwd, path)
      if (!validated.ok) {
        return { content: `Error: ${validated.error}`, isError: true }
      }
      args.push('--', relative(params.cwd, validated.path))
    }

    return new Promise((resolve) => {
      const child = track(spawnGit(args, {
        cwd: params.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      }))

      let stdout = ''
      let stderr = ''

      child.stdout!.on('data', (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr!.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      const timer = setTimeout(async () => {
        gracefulKill(child)
        const rawPath = await persistRawOutput(params.toolUseId, 'git diff timed out')
        resolve({ content: 'Error: git diff timed out', rawPath, isError: true })
      }, 30_000)

      // 用户中止：协作式取消，kill git diff 子进程。
      const signal = params.abortSignal
      const onAbort = () => {
        clearTimeout(timer)
        gracefulKill(child)
        resolve({ content: 'Diff aborted by user.', isError: false })
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      child.on('close', async (code) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        if (stderr.trim()) {
          const rawPath = await persistRawOutput(params.toolUseId, stderr.trim())
          resolve({ content: `Error: ${stderr.trim()}`, rawPath, isError: true })
          return
        }
        if (!stdout.trim()) {
          resolve({ content: 'No changes.' })
          return
        }
        const durationMs = Date.now() - startTime
        const meta = { command: 'git diff', exitCode: code ?? 0, durationMs }
        const rawPath = await persistRawOutput(params.toolUseId, stdout)
        resolve({
          content: buildModelOutput(truncateDiff(stdout), { ...meta, rawPath }),
          uiContent: buildUiOutput(stdout, meta),
          rawPath,
        })
      })

      child.on('error', async (err) => {
        clearTimeout(timer)
        if (signal) signal.removeEventListener('abort', onAbort)
        const rawPath = await persistRawOutput(params.toolUseId, err.message)
        resolve({ content: `Error: ${err.message}`, rawPath, isError: true })
      })
    })
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}

function truncateDiff(output: string): string {
  const files = splitByFile(output)
  const truncated = files.map(file => {
    const lines = file.split('\n')
    if (lines.length <= MAX_LINES_PER_FILE) return file
    const head = lines.slice(0, MAX_LINES_PER_FILE).join('\n')
    return `${head}\n... (truncated, ${lines.length - MAX_LINES_PER_FILE} more lines)`
  })
  const result = truncated.join('\n')
  if (result.length <= MAX_TOTAL_CHARS) return result
  return result.slice(0, MAX_TOTAL_CHARS) + '\n... (truncated)'
}

function splitByFile(output: string): string[] {
  const files: string[] = []
  let current = ''
  for (const line of output.split('\n')) {
    if (line.startsWith('diff --git') && current) {
      files.push(current)
      current = line
    } else {
      current += (current ? '\n' : '') + line
    }
  }
  if (current) files.push(current)
  return files
}
