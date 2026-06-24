import { spawn, execFileSync } from 'child_process'
import { DANGEROUS_BASH_PATTERNS } from '../agent/approval-risk.js'
import type { Tool, ToolCallParams } from './types.js'
import { track } from './process-tracker.js'
import { killProcessTree } from './process-kill.js'
import { getShellCommand } from '../platform.js'
import { wrapSandboxCommand as sandboxWrap } from './sandbox-profile.js'
import { persistRawOutput, buildModelOutput, buildUiOutput } from './output-store.js'
import { applyCommandFilter } from './command-filters.js'
import { summarizeBashOutput } from '../artifact/summarize.js'
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
 * Wrap a command in a workspace-scoped sandbox. Default-ON (opt out with
 * RIVET_NO_SANDBOX=1). The actual backend/profile logic lives in
 * sandbox-profile.ts (pure + unit-testable per platform); this thin wrapper
 * threads the workspace cwd through so writes are confined to it.
 */
export function wrapSandboxCommand(command: string, cwd?: string): { command: string; sandboxed: boolean; note?: string } {
  const decision = sandboxWrap(command, { cwd: cwd ?? process.cwd() })
  return { command: decision.command, sandboxed: decision.sandboxed, note: decision.note }
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

// ── bash-level file read tracking ──
// Detects when the model repeats the same command on the same file, which burns
// context tokens without adding information. Keyed by verb+path+pattern to
// avoid false warnings when different commands access the same path (e.g.
// head vs tail, grep with different patterns).
const bashFileReads = new Map<string, { command: string; toolUseId: string; at: number }>()
const BASH_READ_PATTERNS = [
  /(?:^|[;&|]\s*)cat\s+['"]?([^'"\s;|&]+)['"]?/g,
  /(?:^|[;&|]\s*)grep\s+.*\s+['"]?([^'"\s;|&]+)['"]?\s*$/gm,
  /(?:^|[;&|]\s*)head\s+.*\s+['"]?([^'"\s;|&]+)['"]?/g,
  /(?:^|[;&|]\s*)tail\s+.*\s+['"]?([^'"\s;|&]+)['"]?/g,
]

/** Derive a command-verb + file-path signature for bash reread dedup. */
function bashReadKey(command: string, filePath: string): string {
  const verbMatch = command.match(/^\s*(cat|grep|head|tail)\b/)
  const verb = verbMatch ? verbMatch[1]! : 'other'
  if (verb === 'grep') {
    // Extract the search pattern: prefer quoted ("..." or '...'), then
    // fall back to the first non-flag token before the file path.
    const quoted = command.match(/grep\s+(?:-[a-zA-Z]+\s+)*(["'])([^"']+)\1/)
    if (quoted) {
      return `grep:${filePath}:${quoted[2]!}`
    }
    // Unquoted: take everything between flags and the file path
    const unquoted = command.match(/grep\s+(?:-[a-zA-Z]+\s+)*(\S+)\s+\S/)
    return `grep:${filePath}:${unquoted ? unquoted[1]! : ''}`
  }
  if (verb === 'head' || verb === 'tail') {
    // Include line count if specified
    const lineCount = command.match(/-\d+/)?.[0] ?? ''
    return `${verb}:${filePath}:${lineCount}`
  }
  return `${verb}:${filePath}`
}

export function checkBashReread(command: string, toolUseId: string): string | null {
  for (const pattern of BASH_READ_PATTERNS) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(command)) !== null) {
      const filePath = match[1]!
      if (filePath.startsWith('/tmp/') || filePath.startsWith('/dev/') || filePath === '-') continue
      const key = bashReadKey(command, filePath)
      const prior = bashFileReads.get(key)
      if (prior && prior.toolUseId !== toolUseId) {
        bashFileReads.set(key, { command: command.slice(0, 80), toolUseId, at: Date.now() })
        return `── bash-reread ──\n⚠ 已用相同的 bash 命令读取过该文件: ${prior.command}。重复读取浪费上下文。如需多次查询，先 cat > /tmp 一次，后续操作在 /tmp 上进行。\n── bash-reread ──`
      }
      bashFileReads.set(key, { command: command.slice(0, 80), toolUseId, at: Date.now() })
    }
  }
  return null
}
setInterval(() => { for (const [k, v] of bashFileReads) { if (Date.now() - v.at > 600_000) bashFileReads.delete(k) } }, 300_000).unref()

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
    const rewritten = rtkRewrite(rawCommand, params.toolUseId)
    const sandbox = wrapSandboxCommand(rewritten, params.cwd)
    const command = sandbox.command
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
      let stdoutTruncated = false
      let stderrTruncated = false
      let stdoutRawBytes = 0
      let stderrRawBytes = 0

      child.stdout!.on('data', (data: Buffer) => {
        const text = data.toString()
        stdoutRawBytes += data.length
        stdout += text
        params.onOutput?.(text)
        if (stdout.length > 32_000) {
          if (!stdoutTruncated) {
            stdoutTruncated = true
          }
          stdout = stdout.slice(-24_000)
        }
      })

      child.stderr!.on('data', (data: Buffer) => {
        const text = data.toString()
        stderrRawBytes += data.length
        stderr += text
        params.onOutput?.(text)
        if (stderr.length > 32_000) {
          stderrTruncated = true
          stderr = stderr.slice(-24_000)
        }
      })

      const buildResult = async (code: number, isTimeout = false) => {
        const truncNote = stdoutTruncated
          ? `[stdout truncated: output exceeded 32KB (${stdoutRawBytes} bytes total), showing last 24KB — full output at rawPath below]\n`
          : ''
        const stderrNote = stderrTruncated
          ? `[stderr truncated: output exceeded 32KB, showing last 24KB]\n`
          : ''
        const raw = truncNote + stderrNote + stdout + (stderr ? '\n' + stderr : '')
        const totalRawBytes = stdoutRawBytes + stderrRawBytes
        const totalRawLines = raw.split('\n').length - (truncNote ? truncNote.split('\n').length - 1 : 0) - (stderrNote ? stderrNote.split('\n').length - 1 : 0)
        // P1: Command-Aware filtering — apply before content construction so the
        // model sees a condensed, semantically-relevant version. Raw output is
        // still persisted for artifact recovery.
        const filtered = applyCommandFilter(rawCommand, raw, code) ?? raw
        const durationMs = Date.now() - startTime
        const exitCode = isTimeout ? -1 : code
        const meta = { command: rawCommand, exitCode, durationMs }
        const isError = isExecFailure(exitCode)
        const rereadWarn = checkBashReread(rawCommand, params.toolUseId)

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
          const wrapInArtifact = filtered.length >= artifactThreshold

          if (!wrapInArtifact) {
            debugLog(`[artifact-skip] tool=bash cmd=${rawCommand.slice(0, 60)} raw=${raw.length} threshold=${artifactThreshold}`)
            const rawPath = await persistRawOutput(params.toolUseId, raw)
            const baseContent = buildModelOutput(filtered || (isTimeout ? 'Command timed out' : `Exit code: ${code}`), { ...meta, rawPath })
            return {
              content: rereadWarn ? rereadWarn + '\n' + baseContent : baseContent,
              uiContent: buildUiOutput(filtered, meta),
              rawPath,
              isError,
              lossiness: (stdoutTruncated || stderrTruncated) ? 'truncated' as const : 'lossless' as const,
              rawBytes: totalRawBytes,
              rawLines: totalRawLines,
              exitCode,
              command: rawCommand,
            }
          }

          debugLog(`[artifact-wrap] tool=bash cmd=${rawCommand.slice(0, 60)} raw=${raw.length} threshold=${artifactThreshold}`)
          const { summary, sections } = summarizeBashOutput(filtered, rawCommand, exitCode)
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
          const lineCount = filtered.split('\n').length
          const successFold = exitCode === 0 && lineCount > SUCCESS_INLINE_LINES
          const modelOutput = successFold
            ? `[${rawCommand}] exit=0 (${lineCount} lines) — success output folded, full output recoverable below`
            : buildModelOutput(filtered || (isTimeout ? 'Command timed out' : `Exit code: ${code}`), meta)
          const baseContent = `${modelOutput}\n\nUse read_section(artifactId="${artifactId}", section="L1-L500") to load full output if the head/tail above is not enough.\n[artifact:${artifactId}]`
          return {
            content: rereadWarn ? rereadWarn + '\n' + baseContent : baseContent,
            uiContent: buildUiOutput(filtered, meta),
            rawPath: artifact?.rawPath,
            isError,
            lossiness: (stdoutTruncated || stderrTruncated) ? 'truncated' as const : 'lossless' as const,
            rawBytes: totalRawBytes,
            rawLines: totalRawLines,
            exitCode,
            command: rawCommand,
          }
        }

        const rawPath = await persistRawOutput(params.toolUseId, raw)
        const baseContent = buildModelOutput(filtered || (isTimeout ? 'Command timed out' : `Exit code: ${code}`), { ...meta, rawPath })
        return {
          content: rereadWarn ? rereadWarn + '\n' + baseContent : baseContent,
          uiContent: buildUiOutput(filtered, meta),
          rawPath,
          isError,
          lossiness: (stdoutTruncated || stderrTruncated) ? 'truncated' as const : 'lossless' as const,
          rawBytes: totalRawBytes,
          rawLines: totalRawLines,
          exitCode,
          command: rawCommand,
        }
      }

      let settled = false
      let timer: ReturnType<typeof setTimeout> | null = null
      let forceKillTimer: ReturnType<typeof setTimeout> | null = null

      const signal = params.abortSignal
      const cleanupAbort = () => {
        if (signal) signal.removeEventListener('abort', onAbort)
      }

      const finish = async (code: number, isTimeout = false, clearForceKill = true) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (clearForceKill && forceKillTimer) clearTimeout(forceKillTimer)
        cleanupAbort()
        resolve(await buildResult(code, isTimeout))
      }

      // 用户中止（Esc/Ctrl+C → AgentLoop.abort → pipeline abortSignal）：
      // 协作式取消——杀掉 detached 进程树（SIGTERM，3s 后 SIGKILL 兜底），立即 settle。
      // 没有这一步，bash 子进程会在 abort 后继续在后台运行（detached），是会话"假死"
      // 期间资源泄漏与副作用的来源。结果值本身可能被 withToolTimeout 的竞速丢弃，
      // 真正的目的是确保进程被杀。
      const onAbort = () => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        cleanupAbort()
        killProcessTree(child, 'SIGTERM')
        forceKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), 3000)
        const raw = stdout + (stderr ? '\n' + stderr : '')
        resolve({
          content: raw ? `[aborted] 命令被用户中止，部分输出:\n${raw.slice(-2000)}` : 'Command aborted by user.',
          uiContent: '⏹ aborted',
          isError: false,
        })
      }
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
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
        cleanupAbort()
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
