import { spawn } from 'child_process'
import type { Tool, ToolCallParams } from './types.js'
import { track } from './process-tracker.js'
import { persistRawOutput, buildModelOutput, buildUiOutput } from './output-store.js'

const DANGEROUS_PATTERNS = ['git push', 'rm -rf', 'git reset --hard', 'sudo', 'chmod 777']

export const BASH_TOOL: Tool = {
  definition: {
    name: 'bash',
    description: `Execute shell commands for build, test, git, and system operations.

IMPORTANT: Do NOT use Bash for reading, searching, or editing files. Use the dedicated tools instead:
- read_file for reading files
- grep for searching file contents
- glob for finding files by pattern
- edit_file for search-and-replace edits
- write_file for creating new files

### Instructions
- Quote file paths containing spaces: cd "path with spaces/file.txt"
- Prefer absolute paths over cd when possible
- Chain independent commands with &&, not ;
- Use run_in_background for long operations (builds, tests, npm install)
- Timeout defaults to 120s; pass timeout parameter for longer commands

### Git Protocol
- NEVER skip hooks (--no-verify) unless user explicitly asks
- NEVER force push to main/master
- Create NEW commits rather than amending
- Use conventional commit format: type(scope): description
- Check git status before committing

### Examples
Good: \`npm test -- --grep "login"\`
Good: \`git add src/api/client.ts && git commit -m "fix: add retry logic to API client"\`
Bad: \`cat src/file.ts\` (use read_file instead)
Bad: \`echo "content" > file.ts\` (use write_file instead)`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: { type: 'integer', description: 'Timeout in ms (default 120000)' },
      },
      required: ['command'],
    },
  },

  async execute(params: ToolCallParams) {
    const command = params.input.command as string
    const timeout = (params.input.timeout as number) ?? 120_000
    const startTime = Date.now()

    return new Promise((resolve) => {
      const child = track(spawn('sh', ['-c', command], {
        cwd: params.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }))

      let stdout = ''
      let stderr = ''

      child.stdout!.on('data', (data: Buffer) => {
        const text = data.toString()
        stdout += text
        params.onOutput?.(text)
        if (stdout.length > 100_000) {
          stdout = stdout.slice(-80_000)
        }
      })

      child.stderr!.on('data', (data: Buffer) => {
        const text = data.toString()
        stderr += text
        params.onOutput?.(text)
        if (stderr.length > 100_000) {
          stderr = stderr.slice(-80_000)
        }
      })

      const buildResult = (code: number, isTimeout = false) => {
        const raw = stdout + (stderr ? '\n' + stderr : '')
        const durationMs = Date.now() - startTime
        const exitCode = isTimeout ? -1 : code
        const meta = { command, exitCode, durationMs }
        const rawPath = persistRawOutput(params.toolUseId, raw)

        return {
          content: buildModelOutput(raw || (isTimeout ? 'Command timed out' : `Exit code: ${code}`), meta),
          uiContent: buildUiOutput(raw, meta),
          rawPath,
          isError: exitCode !== 0,
        }
      }

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 3000)
        resolve(buildResult(0, true))
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(buildResult(code ?? 1))
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ content: err.message, isError: true })
      })
    })
  },

  requiresApproval(params: ToolCallParams): boolean {
    const command = (params.input.command as string).toLowerCase()
    return DANGEROUS_PATTERNS.some(d => command.includes(d))
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
