import { spawn, execFileSync } from 'child_process'
import { DANGEROUS_BASH_PATTERNS } from '../agent/approval-risk.js'
import type { Tool, ToolCallParams } from './types.js'
import { track } from './process-tracker.js'
import { killProcessTree } from './process-kill.js'
import { persistRawOutput, buildModelOutput, buildUiOutput } from './output-store.js'
import { summarizeBashOutput } from '../artifact/summarize.js'

function rtkRewrite(command: string): string {
  try {
    return execFileSync('rtk', ['rewrite', command], { timeout: 500, encoding: 'utf-8' }).trim()
  } catch {
    return command
  }
}

export const BASH_TOOL: Tool = {
  definition: {
    name: 'bash',
    description: `Execute shell commands for build, test, git, and system operations.

Do NOT use for file reading/writing/searching — use dedicated tools (read_file, grep, glob, edit_file, write_file).

Chain independent commands with &&. Use run_in_background for long operations.
Timeout defaults to 120s; pass timeout parameter for longer commands.`,
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
        if (stdout.length > 32_000) {
          stdout = stdout.slice(-24_000)
        }
      })

      child.stderr!.on('data', (data: Buffer) => {
        const text = data.toString()
        stderr += text
        params.onOutput?.(text)
        if (stderr.length > 32_000) {
          stderr = stderr.slice(-24_000)
        }
      })

      const buildResult = async (code: number, isTimeout = false) => {
        const raw = stdout + (stderr ? '\n' + stderr : '')
        const durationMs = Date.now() - startTime
        const exitCode = isTimeout ? -1 : code
        const meta = { command: rawCommand, exitCode, durationMs }

        // Use ArtifactStore if available (preferred); otherwise fall back to output-store.
        // Skip persistRawOutput in artifact mode — ArtifactStore owns raw persistence,
        // so we don't double-write to output-store/.
        if (params.artifactStore) {
          const { summary, sections } = summarizeBashOutput(raw, rawCommand, exitCode)
          const artifactId = await params.artifactStore.save({
            tool: 'bash',
            target: rawCommand,
            rawContent: raw,
            summary,
            sections,
          })
          const artifact = params.artifactStore.get(artifactId)
          return {
            content: `[artifact:${artifactId}] ${summary}\nUse read_section(artifactId="${artifactId}", section="L1-L200") to load details.`,
            uiContent: buildUiOutput(raw, meta),
            rawPath: artifact?.rawPath,
            isError: exitCode !== 0,
          }
        }

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
    return DANGEROUS_BASH_PATTERNS.some(pattern => pattern.test(command))
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
