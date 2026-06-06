import { spawn, execFileSync } from 'child_process'
import { DANGEROUS_BASH_PATTERNS } from '../agent/approval-risk.js'
import type { Tool, ToolCallParams } from './types.js'
import { track } from './process-tracker.js'
import { killProcessTree } from './process-kill.js'
import { getShellCommand } from '../platform.js'
import { persistRawOutput, buildModelOutput, buildUiOutput } from './output-store.js'
import { summarizeBashOutput } from '../artifact/summarize.js'
import { pruneThresholds } from '../compact/constants.js'
import { getToolArtifactThreshold } from './artifact-threshold.js'
import { debugLog } from '../utils/debug.js'

/** Success output inline threshold: commands that succeed with ≤ this many lines
 *  return full output to the model. Beyond this, only a header summary is returned
 *  (recoverable via the artifact reference in the same message). */
const SUCCESS_INLINE_LINES = 20

/** Environment variable prefixes that should be preserved for child processes. */
const SAFE_ENV_PREFIXES = ['PATH', 'HOME', 'PWD', 'NODE_ENV', 'TERM', 'LANG', 'LC_', 'XDG_', 'EDITOR', 'VISUAL', 'PAGER', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'COLOR', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR'] as const

/** Keywords that indicate a sensitive env var — vars containing these substrings are stripped. */
const SENSITIVE_ENV_KEYWORDS = ['KEY', 'TOKEN', 'SECRET', 'PASSWORD', 'CREDENTIAL', 'AUTH', 'PRIVATE'] as const

/** Strip sensitive environment variables before passing to child processes. */
export function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const clean: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    const isSensitive = SENSITIVE_ENV_KEYWORDS.some(kw => upper.includes(kw))
    if (isSensitive) continue
    const isSafe = SAFE_ENV_PREFIXES.some(prefix => upper.startsWith(prefix))
    if (isSafe) {
      clean[key] = value
    }
  }
  return clean
}

/**
 * 退出码 → 是否真执行失败。
 *
 * 非零退出码不等于失败：grep(1=无匹配)、diff(1=有差异)、test runner(非零=有失败用例)、
 * lint/build 工具(非零=有告警)都用非零码表达正常语义结果。把这些一律打成 isError
 * 会让环境性非零码被下游(immune/dead-end/doom-loop)放大成 error 风暴，进而把模型推入退化态。
 *
 * 只把"命令无法执行"判为真 error：127(命令未找到)、126(不可执行)、>128(被信号杀死，如段错误)、
 * 以及 timeout(-1)。其余非零码视为"有结果但非执行失败"，由模型自行从输出判断语义。
 */
export function isExecFailure(exitCode: number): boolean {
  return exitCode === -1 || exitCode === 126 || exitCode === 127 || exitCode > 128
}

/**
 * Per-call cache to avoid calling rtkRewrite twice for the same command
 * within a single tool invocation (requiresApproval → execute).
 *
 * Keyed by (command, toolUseId) to isolate concurrent workers — a global
 * single-entry cache would let one worker's rewrite bleed into another's
 * gate/execute cycle, violating the TOCTOU safety guarantee.
 */
let _cachedCommand: string | undefined
let _cachedResult: string | undefined
let _cachedToolUseId: string | undefined

function rtkRewrite(command: string, toolUseId?: string): string {
  if (command === _cachedCommand && _cachedResult !== undefined && toolUseId === _cachedToolUseId) {
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
  _cachedToolUseId = toolUseId
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
    const command = rtkRewrite(rawCommand, params.toolUseId)
    const timeout = (params.input.timeout as number) ?? 120_000
    const startTime = Date.now()

    return new Promise((resolve) => {
      const shell = getShellCommand()
      const child = track(spawn(shell.cmd, [...shell.args, command], {
        cwd: params.cwd,
        env: sanitizeEnv(process.env),
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
        // 非零退出码 ≠ 失败：grep/diff/test 等用退出码表达"有差异/无匹配/有失败用例"，
        // build/lint 工具也常以非零码报告非致命问题。只把"无法执行/被信号杀死"判为真 error，
        // 避免环境性非零码被无条件打成 error 并被下游放大成 error 风暴（天枢退化的根因）。
        const isError = isExecFailure(exitCode)

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
              isError,
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
          const lineCount = raw.split('\n').length
          const successFold = exitCode === 0 && lineCount > SUCCESS_INLINE_LINES
          const modelOutput = successFold
            ? `[${rawCommand}] exit=0 (${lineCount} lines) — success output folded, full output recoverable below`
            : buildModelOutput(raw || (isTimeout ? 'Command timed out' : `Exit code: ${code}`), meta)
          return {
            content: `${modelOutput}\n\nUse read_section(artifactId="${artifactId}", section="L1-L500") to load full output if the head/tail above is not enough.\n[artifact:${artifactId}]`,
            uiContent: buildUiOutput(raw, meta),
            rawPath: artifact?.rawPath,
            isError,
          }
        }

        const rawPath = await persistRawOutput(params.toolUseId, raw)
        return {
          content: buildModelOutput(raw || (isTimeout ? 'Command timed out' : `Exit code: ${code}`), meta),
          uiContent: buildUiOutput(raw, meta),
          rawPath,
          isError,
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
    const rewrittenCommand = rtkRewrite(rawCommand, params.toolUseId)
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
