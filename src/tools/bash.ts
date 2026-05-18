import { spawn, execFileSync } from 'child_process'
import type { Tool, ToolCallParams } from './types.js'
import { track } from './process-tracker.js'
import { killProcessTree } from './process-kill.js'
import { persistRawOutput, buildModelOutput, buildUiOutput } from './output-store.js'

function rtkRewrite(command: string): string {
  try {
    return execFileSync('rtk', ['rewrite', command], { timeout: 500, encoding: 'utf-8' }).trim()
  } catch {
    return command
  }
}

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+-/,                                    // rm -rf, rm -r, etc.
  /\bgit\s+push\b[^\n]*\s--force/,               // git push --force / --force-with-lease
  /\bgit\s+reset\s+--hard/,                       // git reset --hard
  /\bsudo\b/,                                     // sudo
  /\bchmod\s+(777|666)\b/,                        // chmod 777 / 666
  /\bkillall\b/,                                  // killall
  /\bpkill\b/,                                    // pkill (not pgrep)
  /\bcurl\b.*\|\s*(sh|bash|zsh|fish)\b/,         // curl | sh
  /\bwget\b.*\|\s*(sh|bash|zsh|fish)\b/,         // wget | sh
  /\beval\s+["']/,                                // eval "..."
  /\beval\s+\$/,                                  // eval $(...)
]

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
    const rawCommand = params.input.command as string
    const command = rtkRewrite(rawCommand)
    const timeout = (params.input.timeout as number) ?? 120_000
    const startTime = Date.now()

    return new Promise((resolve) => {
      const child = track(spawn('sh', ['-c', command], {
        cwd: params.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      }))

      let stdout = ''
      let stderr = ''
      let timedOut = false

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

      const buildResult = async (code: number, isTimeout = false) => {
        const raw = stdout + (stderr ? '\n' + stderr : '')
        const durationMs = Date.now() - startTime
        const exitCode = isTimeout ? -1 : code
        const meta = { command: rawCommand, exitCode, durationMs }
        const rawPath = await persistRawOutput(params.toolUseId, raw)

        return {
          content: buildModelOutput(raw || (isTimeout ? 'Command timed out' : `Exit code: ${code}`), meta),
          uiContent: buildUiOutput(raw, meta),
          rawPath,
          isError: exitCode !== 0,
        }
      }

      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null

      const finish = async (code: number, isTimeout = false, clearForceKill = true) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (clearForceKill && forceKillTimer) clearTimeout(forceKillTimer)
        resolve(await buildResult(code, isTimeout))
      }

      timer = setTimeout(() => {
        timedOut = true
        killProcessTree(child, 'SIGTERM')
        forceKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 3000)
        void finish(0, true, false)
      }, timeout)

      child.on('close', (code) => {
        void finish(code ?? 1, timedOut)
      })

      child.on('error', (err) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (forceKillTimer) clearTimeout(forceKillTimer)
        resolve({ content: err.message, isError: true })
      })
    })
  },

  requiresApproval(params: ToolCallParams): boolean {
    const command = params.input.command as string
    return DANGEROUS_PATTERNS.some(pattern => pattern.test(command))
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
