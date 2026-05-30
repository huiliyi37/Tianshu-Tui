import { spawn, execFileSync } from 'child_process'
import { DANGEROUS_BASH_PATTERNS } from '../agent/approval-risk.js'
import type { Tool, ToolCallParams } from './types.js'
import { track } from './process-tracker.js'
import { killProcessTree } from './process-kill.js'
import { persistRawOutput, buildModelOutput, buildUiOutput } from './output-store.js'
import { summarizeBashOutput } from '../artifact/summarize.js'
import { pruneThresholds } from '../compact/constants.js'
import { getToolArtifactThreshold } from './artifact-threshold.js'
import { debugLog } from '../utils/debug.js'

/**
 * Single-entry cache to avoid calling rtkRewrite twice for the same command.
 *
 * Intentionally trades freshness for gate/execute consistency: the cached
 * result guarantees requiresApproval() and execute() see the identical
 * rewrite, closing a TOCTOU window.  If rtk isn't installed or errors,
 * the fallback (result === command) is also cached — acceptable because
 * gate→execute runs within milliseconds on the same command.
 */
let _cachedCommand: string | undefined
let _cachedResult: string | undefined

function rtkRewrite(command: string): string {
  if (command === _cachedCommand && _cachedResult !== undefined) {
    return _cachedResult
  }
  let result: string
  try {
    result = execFileSync('rtk', ['rewrite', command], { timeout: 500, encoding: 'utf-8' }).trim()
  } catch {
    result = command
  }
  _cachedCommand = command
  _cachedResult = result
  return result
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
          // Skip artifact wrapping for output small enough that prune won't touch it.
          // Critical for bash: a `cat file.ts` or `sed -n '1,200p'` returns a few KB,
          // and wrapping that in [artifact:X] makes the model think the output was
          // truncated even though it has the whole thing in modelOutput. Tianshu's
          // post-mortem: every bash result became "[artifact:X] ... use read_section"
          // → the model started writing /tmp files just to escape the artifact loop.
          const artifactThreshold = getToolArtifactThreshold('bash', params.contextWindow)
          const wrapInArtifact = raw.length >= artifactThreshold

          if (!wrapInArtifact) {
            debugLog(`[artifact-skip] tool=bash cmd=${rawCommand.slice(0, 60)} raw=${raw.length} threshold=${artifactThreshold}`)
            const rawPath = await persistRawOutput(params.toolUseId, raw)
            return {
              content: buildModelOutput(raw || (isTimeout ? 'Command timed out' : `Exit code: ${code}`), meta),
              uiContent: buildUiOutput(raw, meta),
              rawPath,
              isError: exitCode !== 0,
            }
          }

          debugLog(`[artifact-wrap] tool=bash cmd=${rawCommand.slice(0, 60)} raw=${raw.length} threshold=${artifactThreshold}`)
          const { summary, sections } = summarizeBashOutput(raw, rawCommand, exitCode)
          const artifactId = await params.artifactStore.save({
            tool: 'bash',
            target: rawCommand,
            rawContent: raw,
            summary,
            sections,
          })
          const artifact = params.artifactStore.get(artifactId)
          // Even when wrapping, prepend the model-formatted output so the model
          // sees the head/tail directly — the [artifact:X] marker is a back-up
          // recovery path, not the only way to access content.
          const modelOutput = buildModelOutput(raw || (isTimeout ? 'Command timed out' : `Exit code: ${code}`), meta)
          return {
            content: `${modelOutput}\n\nUse read_section(artifactId="${artifactId}", section="L1-L500") to load full output if the head/tail above is not enough.\n[artifact:${artifactId}]`,
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
    const rawCommand = params.input.command as string
    const rewrittenCommand = rtkRewrite(rawCommand)
    // Check BOTH raw and rewritten commands.
    // rtkRewrite may expand aliases/macros into dangerous commands
    // that the raw form does not match.
    return DANGEROUS_BASH_PATTERNS.some(
      pattern => pattern.test(rawCommand) || pattern.test(rewrittenCommand),
    )
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
