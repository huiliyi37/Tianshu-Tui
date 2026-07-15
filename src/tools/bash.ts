import { spawn, execFileSync } from 'child_process'
import { DANGEROUS_BASH_PATTERNS } from '../agent/approval-risk.js'
import type { Tool, ToolCallParams } from './types.js'
import { track } from './process-tracker.js'
import { killProcessTree } from './process-kill.js'
import { getShellCommand, getShellDiagnostics, WinStreamDecoder, rewriteWindowsNullRedirect, rewritePowershellNullRedirect } from '../platform.js'
import { wrapSandboxCommand as sandboxWrap } from './sandbox-profile.js'
import { persistRawOutput, buildModelOutput, buildUiOutput } from './output-store.js'
import { applyCommandFilter } from './command-filters.js'
import { denoiseWindowsError } from './powershell-filter.js'
import { summarizeBashOutput } from '../artifact/summarize.js'
import { getToolArtifactThreshold } from './artifact-threshold.js'
import { debugLog } from '../utils/debug.js'
import { loadConfig } from '../config/manager.js'
import { buildMirrorEnv, rewriteGitHubUrls } from './mirror-env.js'
import { buildNotFoundHint, extractMissingCommand } from './env-check.js'
import { getResolvedEnv } from './resolved-env.js'
import { OutputStreamBudget } from './output-stream-budget.js'

/** Success output inline threshold: commands that succeed with ≤ this many lines
 *  return full output to the model. Beyond this, only a header summary is returned
 *  (recoverable via the artifact reference in the same message). */
const SUCCESS_INLINE_LINES = 20

/** Bounded raw-spool cap: recovery content is complete up to this many bytes
 *  per stream. Beyond the cap the spool stops appending and the persisted raw
 *  carries an explicit `[raw capture capped …]` note — never a false
 *  "full output" claim. */
const RAW_SPOOL_CAP_BYTES = 8 * 1024 * 1024

/**
 * W1-A1: bounded raw spool. The in-memory model preview truncates stdout to a
 * 24KB tail once it crosses 32KB — that policy is unchanged. But persistence
 * (rawPath / ArtifactStore) used to consume the SAME truncated buffer, so the
 * head of large outputs was silently lost while the truncation note claimed
 * "full output at rawPath below". The spool captures the stream from the first
 * chunk, bounded at RAW_SPOOL_CAP_BYTES (head-retaining: appending stops at
 * the cap), so recovery is complete within the cap and honest beyond it.
 * Memory stays bounded — it never grows past the cap plus one chunk.
 */
class BoundedRawSpool {
  private chunks: string[] = []
  private bytes = 0
  capped = false

  append(text: string): void {
    if (this.capped || text.length === 0) return
    this.chunks.push(text)
    this.bytes += Buffer.byteLength(text)
    if (this.bytes >= RAW_SPOOL_CAP_BYTES) this.capped = true
  }

  content(): string {
    return this.chunks.join('')
  }
}

/** 一次性 flag：shell 降级警告只在 session 首次 bash 执行时注入一次。 */
let _shellFallbackWarned = false

/** Environment variable prefixes that should be preserved for child processes. */
const SAFE_ENV_PREFIXES = [
  'PATH', 'HOME', 'PWD', 'NODE_ENV', 'TERM', 'LANG', 'LC_', 'XDG_', 'EDITOR', 'VISUAL', 'PAGER', 'SHELL', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'COLOR', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR',
  // Windows-critical: without SystemRoot the child process cannot load system
  // DLLs, causing cmd.exe / powershell.exe to exit(0) with zero output.
  'COMSPEC', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'PUBLIC', 'HOMEDRIVE', 'ALLUSERSPROFILE', 'PROCESSOR_',
  // Toolchain vars: builds (maven/gradle/java/go/rust/android) and version
  // managers rely on these; stripping them broke `mvn`/`java` when launched from
  // a GUI with a minimal env. None contain sensitive keywords, so the KEY/TOKEN/
  // SECRET filter below still removes anything genuinely secret.
  'JAVA_HOME', 'JDK_HOME', 'JRE_HOME', 'CLASSPATH', 'JAVA_TOOL_OPTIONS',
  'MAVEN_', 'M2_', 'M2', 'GRADLE_', 'ANT_HOME',
  'GOPATH', 'GOROOT', 'GOBIN', 'GO111MODULE', 'GOFLAGS', 'GOPROXY',
  'CARGO_HOME', 'RUSTUP_HOME',
  'ANDROID_', 'NVM_DIR', 'PYENV', 'SDKMAN_DIR',
  'DOTNET_', 'PYTHONPATH', 'VIRTUAL_ENV', 'CONDA_',
  'PNPM_HOME', 'VOLTA_HOME', 'FNM_DIR', 'MISE_', 'ASDF_', 'RBENV_ROOT', 'GEM_',
  'NODE_PATH', 'NODE_OPTIONS', 'KUBECONFIG', 'DOCKER_HOST',
] as const

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

/** Windows command-not-found stderr fingerprints (PowerShell + cmd.exe). */
const WIN_NOT_FOUND_PATTERNS = [
  /is not recognized as the name of a cmdlet/i,      // PowerShell cmdlet/binary not found
  /is not recognized as an internal or external command/i, // cmd.exe
  /CommandNotFoundException/i,                        // PowerShell .NET exception id
  /ObjectNotFound:/i,                                 // PowerShell CategoryInfo for missing command
  /The term '[^']*' is not recognized/i,              // PowerShell long-form message
]

/** cmd.exe returns 9009 for an unrecognized command. */
const WIN_NOT_FOUND_EXIT = 9009

/**
 * Outcome of a finished shell command.
 *
 * `errorClass: 'environment'` marks "the host could not run this" (command not
 * found), which is NOT a competence failure — on Windows benign command-name
 * differences (`python` vs `py`, missing POSIX tools) constantly produce these,
 * and feeding them into momentum/doom/approval as failures makes the agent
 * timid (低信念 → 频繁意图审批). Such outcomes still set `isError` so the model
 * knows the command did not run, but downstream consumers can branch on the class.
 */
export function classifyBashOutcome(
  exitCode: number,
  stderr: string,
  isWindows: boolean,
): { isError: boolean; errorClass?: 'environment' | 'exec-failure' | 'timeout' } {
  // exitCode -1 is the sole product of the timeout path (isTimeout ? -1 : code).
  // Classify it distinctly from exec-failure: a slow command is not a dead-end.
  if (exitCode === -1) return { isError: true, errorClass: 'timeout' }
  if (isWindows) {
    // Windows-native not-found: cmd.exe 9009 / PowerShell "is not recognized".
    const winNotFound =
      exitCode === WIN_NOT_FOUND_EXIT ||
      ((exitCode === 1 || exitCode > 128) && WIN_NOT_FOUND_PATTERNS.some(p => p.test(stderr)))
    // Git Bash is our PREFERRED Windows shell, so on Windows the common case is a
    // POSIX-style not-found: exit 127 (`bash: py: command not found`) / 126 (not
    // executable). Without this, Git Bash command-not-found was misclassified as
    // 'exec-failure' → fed momentum/doom/approval as a competence failure → 低信念
    // → 模型畏手畏脚、把命令甩给用户手动跑。Treat it as 'environment' like POSIX.
    const posixNotFound = exitCode === 127 || exitCode === 126 || /command not found/i.test(stderr)
    if (winNotFound || posixNotFound) return { isError: true, errorClass: 'environment' }
    // Remaining exec-failure codes (signals / >128 without a not-found fingerprint);
    // otherwise fall through to POSIX semantics so non-zero domain results
    // (e.g. findstr no-match) stay benign.
    if (isExecFailure(exitCode)) return { isError: true, errorClass: 'exec-failure' }
    return { isError: false }
  }

  // POSIX: 127 (not found) / 126 (not executable) are environment-class; signals are exec-failure.
  if (exitCode === 127 || exitCode === 126) return { isError: true, errorClass: 'environment' }
  if (isExecFailure(exitCode)) return { isError: true, errorClass: 'exec-failure' }
  return { isError: false }
}

/**
 * Wrap a command in a workspace-scoped sandbox. Default-OFF.
 * Enable with RIVET_SANDBOX=1.
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

/**
 * Conservative allowlist of commands that should auto-background when the model
 * does not specify run_in_background. Two safe classes only:
 *   1. Non-terminating processes (dev servers / watchers) — blocking them stalls
 *      the whole loop until timeout for no benefit.
 *   2. Long installs — terminate eventually but tie up a turn; the model can
 *      `job(await)` when it actually needs them done.
 * Deliberately EXCLUDES build/test: the model usually depends on their result
 * synchronously, so silently backgrounding them would surprise it. It can still
 * opt in explicitly with run_in_background=true.
 */
const LONG_RUNNER_PATTERNS: RegExp[] = [
  // Package installs.
  /\b(npm|pnpm|yarn|bun)\s+(install|ci|add)\b/i,
  /\bnpm\s+i\b/i,
  // Dev servers / start / watch / serve scripts.
  /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|watch|serve|storybook)\b/i,
  // Common dev-server / watcher binaries.
  /\b(vite|nodemon|ng\s+serve|webpack(-dev-server|\s+serve)|rollup\s+.*-w\b|esbuild\s+.*--watch)\b/i,
  /\bnext\s+(dev|start)\b/i,
  // TypeScript watch mode.
  /\btsc\b[^&|;]*(--watch|\s-w\b)/i,
  // Docker / compose up (non -d foreground brings up services and blocks).
  /\bdocker(\s+compose|-compose)?\s+up\b/i,
]

/** True when the command matches a known long-running / non-terminating pattern. */
export function isLongRunner(command: string): boolean {
  return LONG_RUNNER_PATTERNS.some((p) => p.test(command))
}

export const BASH_TOOL: Tool = {
  definition: {
    name: 'bash',
    description: `Execute shell commands for build, test, git, and system operations.

Do NOT use for file reading/writing/searching — use dedicated tools (read_file, grep, glob, edit_file, write_file).

Chain independent commands with &&. Timeout defaults to 120s; pass timeout for longer commands.

Long-running / non-terminating commands (dev servers, watchers, installs) run in the BACKGROUND so they never block the loop: pass run_in_background=true, or let auto-detection handle known long-runners. A backgrounded command returns a job id immediately — use the \`job\` tool to await(pattern), read logs, or kill it. Pass run_in_background=false to force a command to stay in the foreground.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout: { type: 'integer', description: 'Timeout in ms (default 120000)' },
        run_in_background: { type: 'boolean', description: 'Run detached in the background and return a job id immediately (for dev servers, watchers, installs). Auto-enabled for known long-runners; set false to force foreground.' },
      },
      required: ['command'],
    },
  },

  async execute(params: ToolCallParams) {
    const rawCommand = params.input.command as string
    const rewritten = rtkRewrite(rawCommand, params.toolUseId)
    const mirrorConfig = loadConfig({ cwd: params.cwd }).mirrors
    const rewrittenWithMirrors = rewriteGitHubUrls(rewritten, mirrorConfig)
    const sandbox = wrapSandboxCommand(rewrittenWithMirrors, params.cwd)
    const command = sandbox.command
    const timeout = (params.input.timeout as number) ?? 120_000
    const startTime = Date.now()

    // Background path: explicit run_in_background=true, or auto-detected long-runner
    // (unless explicitly disabled). Requires a session job registry (server / TUI
    // with sessionId); otherwise falls through to normal foreground execution.
    const explicitBg = params.input.run_in_background
    const wantBackground = explicitBg === true || (explicitBg !== false && isLongRunner(rawCommand))
    if (wantBackground && params.jobs) {
      const mirrorEnv = buildMirrorEnv(mirrorConfig)
      const env = { ...sanitizeEnv(getResolvedEnv(params.cwd)), ...mirrorEnv }
      const snap = params.jobs.spawn({ command, rawCommand, cwd: params.cwd, env })
      const auto = explicitBg !== true
      const sandboxNote = sandbox.sandboxed && sandbox.note ? `\n${sandbox.note}` : ''
      const content =
        `[job:${snap.id}] ${auto ? '已自动转入后台' : '已在后台启动'}: ${rawCommand}\n` +
        `不阻塞当前轮次。用 job(action="await", id="${snap.id}", pattern="Ready|listening|compiled") 等待就绪/退出，` +
        `job(action="logs", id="${snap.id}") 看输出，job(action="kill", id="${snap.id}") 终止。${sandboxNote}`
      const shortCmd = rawCommand.length > 80 ? rawCommand.slice(0, 80) + '…' : rawCommand
      return Promise.resolve({
        content,
        uiContent: `▶ 后台任务 ${snap.id}: ${shortCmd}`,
        isError: false,
        command: rawCommand,
      })
    }

    return new Promise((resolve) => {
      const shell = getShellCommand()
      // Wrap by shell FAMILY (not fragile cmd-string matching): Git Bash needs
      // no encoding prefix (UTF-8 native) but must not emit literal `nul` files;
      // PowerShell needs UTF-8 console encoding; cmd needs no prefix (WinStreamDecoder
      // auto-detects GBK vs UTF-8 on the first chunk).
      let commandToRun = command
      if (shell.kind === 'bash') {
        commandToRun = rewriteWindowsNullRedirect(command)
      } else if (shell.kind === 'powershell') {
        // Normalize stray `2>nul`/`2>/dev/null` (bash/cmd habit) → `2>$null`
        // before prefixing the UTF-8 encoding setup.
        commandToRun = `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${rewritePowershellNullRedirect(command)}`
      } else if (shell.kind === 'cmd') {
        // NOTE: removed `chcp 65001 > nul &&` prefix — the `nul` device redirect
        // fails in sandboxed/WSL Windows environments (exit=1, empty stdout).
        // WinStreamDecoder already auto-detects GBK vs UTF-8 on the first chunk,
        // so the explicit chcp is unnecessary.
        commandToRun = command
      }

      const mirrorEnv = buildMirrorEnv(mirrorConfig)
      debugLog(`[bash-spawn] kind=${shell.kind} shell=${shell.cmd} args=${JSON.stringify(shell.args)} cwd=${params.cwd ?? process.cwd()}`)
      const child = track(spawn(shell.cmd, [...shell.args, commandToRun], {
        cwd: params.cwd,
        env: { ...sanitizeEnv(getResolvedEnv(params.cwd)), ...mirrorEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
        // detached: true breaks stdio pipes on Windows cmd.exe — the new
        // console created in detached mode doesn't connect back to the parent's
        // pipes, causing all commands to return exit=0 with empty output.
        detached: process.platform !== 'win32',
        // Hide the transient console window on Windows (no-op elsewhere) — also
        // avoids stdio handoff quirks in some Windows environments.
        windowsHide: true,
      }))

      let stdout = ''
      let stderr = ''
      let timedOut = false
      let stdoutTruncated = false
      let stderrTruncated = false
      let stdoutRawBytes = 0
      let stderrRawBytes = 0

      const stdoutDecoder = new WinStreamDecoder()
      const stderrDecoder = new WinStreamDecoder()
      const uiOutput = new OutputStreamBudget({
        emit: (text) => params.onOutput?.(text),
        maxVisible: 64 * 1024,
      })
      // W1-A1: capture the raw stream (arrival order, both streams) BEFORE the
      // in-memory preview truncation below — persistence must not consume the
      // tail-truncated preview buffer.
      const rawSpool = new BoundedRawSpool()

      child.stdout!.on('data', (data: Buffer) => {
        const text = stdoutDecoder.write(data)
        stdoutRawBytes += data.length
        rawSpool.append(text)
        stdout += text
        uiOutput.push(text)
        if (stdout.length > 32_000) {
          if (!stdoutTruncated) {
            stdoutTruncated = true
          }
          stdout = stdout.slice(-24_000)
        }
      })

      child.stderr!.on('data', (data: Buffer) => {
        const text = stderrDecoder.write(data)
        stderrRawBytes += data.length
        rawSpool.append(text)
        stderr += text
        uiOutput.push(text)
        if (stderr.length > 32_000) {
          stderrTruncated = true
          stderr = stderr.slice(-24_000)
        }
      })

      const buildResult = async (code: number, isTimeout = false) => {
        const stdoutTail = stdoutDecoder.end()
        const stderrTail = stderrDecoder.end()
        stdout += stdoutTail
        stderr += stderrTail
        rawSpool.append(stdoutTail)
        rawSpool.append(stderrTail)
        uiOutput.push(stdoutTail)
        uiOutput.push(stderrTail)
        uiOutput.flush()
        uiOutput.dispose()
        // Shell 降级一次性警告（session 首次）：Windows 上 Git Bash 缺失时 fallback 到
        // PowerShell/cmd，告诉模型/用户根因，避免"命令大面积失败但不知为什么"。
        let shellFallbackNote = ''
        if (!_shellFallbackWarned) {
          const diag = getShellDiagnostics()
          if (diag.fallbackReason) {
            _shellFallbackWarned = true
            shellFallbackNote = `⚠ ${diag.fallbackReason}\n` +
              `建议：安装 Git for Windows（https://git-scm.com）或设置 RIVET_GIT_BASH_PATH 指向 bash.exe。\n`
          }
        }
        const truncNote = stdoutTruncated
          ? `[stdout truncated: output exceeded 32KB (${stdoutRawBytes} bytes total), showing last 24KB — full output at rawPath below]\n`
          : ''
        const stderrNote = stderrTruncated
          ? `[stderr truncated: output exceeded 32KB, showing last 24KB]\n`
          : ''
        const raw = truncNote + stderrNote + stdout + (stderr ? '\n' + stderr : '')
        const totalRawBytes = stdoutRawBytes + stderrRawBytes
        // W1-A1: persistence consumes the spool (complete within the cap), not
        // the tail-truncated preview buffer. Beyond the cap we declare honestly.
        const capNote = rawSpool.capped
          ? `[raw capture capped at ${RAW_SPOOL_CAP_BYTES} bytes (stream total ${totalRawBytes} bytes) — content beyond the cap was NOT captured]\n`
          : ''
        const persistedRaw = capNote + rawSpool.content()
        // Persistence failure must degrade honestly (no rawPath, no silent loss
        // claim) instead of rejecting the whole tool call.
        const persistRawSafe = async (): Promise<string | undefined> => {
          try {
            return await persistRawOutput(params.toolUseId, persistedRaw)
          } catch (e) {
            debugLog(`[bash-raw-persist-failed] ${e instanceof Error ? e.message : String(e)}`)
            return undefined
          }
        }
        const totalRawLines = raw.split('\n').length - (truncNote ? truncNote.split('\n').length - 1 : 0) - (stderrNote ? stderrNote.split('\n').length - 1 : 0)
        const durationMs = Date.now() - startTime
        const exitCode = isTimeout ? -1 : code
        debugLog(`[bash-done] exit=${exitCode} stdoutBytes=${stdoutRawBytes} stderrBytes=${stderrRawBytes} durationMs=${durationMs}`)
        // When rtk rewrote the command (e.g. `ls` → `rtk ls`), surface the
        // EXECUTED command in the result header. Hiding the rewrite let a
        // filtered `rtk ls` "(empty)" result masquerade as native ls output —
        // the model concluded existing files were lost and rewrote them
        // (session 4df36bcd). The header must never claim a command ran when
        // a different one did.
        const headerCommand = rewritten !== rawCommand ? rewritten : rawCommand
        const meta = { command: headerCommand, exitCode, durationMs }
        const { isError, errorClass } = classifyBashOutcome(exitCode, stderr, process.platform === 'win32')
        // P1: Command-Aware filtering — apply before content construction so the
        // model sees a condensed, semantically-relevant version. Raw output is
        // still persisted for artifact recovery.
        const commandFiltered = applyCommandFilter(rawCommand, raw, code) ?? raw
        // Windows: strip PowerShell/cmd error noise (CategoryInfo/FullyQualifiedErrorId/
        // carets) and prepend a recovery hint for command-not-found so the wall of red
        // text neither pollutes context nor misleads the model into self-assessed failure.
        let filtered = process.platform === 'win32'
          ? denoiseWindowsError(commandFiltered, { exitCode, errorClass, command: rawCommand })
          : commandFiltered
        // POSIX / macOS / Linux: append install guidance for missing python/git/uv.
        if (errorClass === 'environment' && process.platform !== 'win32') {
          filtered += buildNotFoundHint(extractMissingCommand(filtered, rawCommand), process.platform)
        }
        const rereadWarn = checkBashReread(rawCommand, params.toolUseId)

        // Empty stdout on success must NOT be back-filled with a synthetic
        // "Exit code: 0" body. Doing so rendered as "lines=1 — output complete\n
        // Exit code: 0", which the model (especially on Windows, where it already
        // distrusts bash) misreads as "output was swallowed / bash is a no-op" —
        // the documented doom-loop trigger (writes & `… > file` redirects produce
        // no stdout, so this hit constantly). Pass empty through so buildModelOutput
        // emits the explicit "confirmed empty" marker instead. Failures/timeouts
        // keep a synthetic body so the reason is never blank.
        // environment 类失败（127/126/9009 = 命令缺失/不可执行）：给模型标准化简洁体，
        // 不把整墙红字灌进上下文（会污染前缀缓存、误导模型自判"代码出错"）。完整原文仍走
        // uiContent（buildUiOutput(filtered)），用户在 TUI 能看到全部。
        let modelBody: string
        if (errorClass === 'environment') {
          const missing = extractMissingCommand(filtered, rawCommand)
          const notFound = exitCode === 127 || exitCode === 9009
          const reason = notFound
            ? `command not found${missing ? `: ${missing}` : ''}`
            : exitCode === 126
              ? 'command found but not executable (permission denied)'
              : `environment error (exit ${exitCode})`
          const hint = buildNotFoundHint(missing, process.platform)
          modelBody = `环境/配置问题：${reason}。属环境/依赖缺失，非代码缺陷——请修复环境后重试，勿反复重跑相同命令。${hint}`
        } else {
          modelBody = filtered || (isTimeout ? 'Command timed out' : code === 0 ? '' : `Exit code: ${code}`)
        }

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
            const rawPath = await persistRawSafe()
            const baseContent = buildModelOutput(modelBody, { ...meta, rawPath })
            const prefix = shellFallbackNote + (rereadWarn ? rereadWarn + '\n' : '')
            return {
              content: prefix ? prefix + baseContent : baseContent,
              uiContent: buildUiOutput(filtered, meta),
              rawPath,
              isError,
              errorClass,
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
            rawContent: persistedRaw,
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
            : buildModelOutput(modelBody, meta)
          const baseContent = `${modelOutput}\n\nUse read_section(artifactId="${artifactId}", section="L1-L500") to load full output if the head/tail above is not enough.\n[artifact:${artifactId}]`
          const prefix = shellFallbackNote + (rereadWarn ? rereadWarn + '\n' : '')
          return {
            content: prefix ? prefix + baseContent : baseContent,
            uiContent: buildUiOutput(filtered, meta),
            rawPath: artifact?.rawPath,
            isError,
            errorClass,
            lossiness: (stdoutTruncated || stderrTruncated) ? 'truncated' as const : 'lossless' as const,
            rawBytes: totalRawBytes,
            rawLines: totalRawLines,
            exitCode,
            command: rawCommand,
          }
        }

        const rawPath = await persistRawSafe()
        const baseContent = buildModelOutput(modelBody, { ...meta, rawPath })
        return {
          content: rereadWarn ? rereadWarn + '\n' + baseContent : baseContent,
          uiContent: buildUiOutput(filtered, meta),
          rawPath,
          isError,
          errorClass,
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
        const stdoutTail = stdoutDecoder.end()
        const stderrTail = stderrDecoder.end()
        const finalStdout = stdout + stdoutTail
        const finalStderr = stderr + stderrTail
        uiOutput.push(stdoutTail)
        uiOutput.push(stderrTail)
        uiOutput.flush()
        uiOutput.dispose()
        const raw = finalStdout + (finalStderr ? '\n' + finalStderr : '')
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
        uiOutput.flush()
        uiOutput.dispose()
        // spawn ENOENT（shell 二进制找不到）走环境分级——给根因而非裸 err.message。
        const msg = err.message
        if ('code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          const diag = getShellDiagnostics()
          const hint = diag.fallbackReason
            ? `\n${diag.fallbackReason}\n建议：设置 RIVET_GIT_BASH_PATH 环境变量指向 bash.exe，或安装 Git for Windows。`
            : `\nShell 路径无效：${diag.cmd}。建议检查 shell 是否已安装。`
          resolve({
            content: `Shell 执行失败：找不到 shell 二进制 (${diag.cmd})。${hint}`,
            isError: true,
            errorClass: 'environment',
          })
          return
        }
        resolve({ content: msg, isError: true })
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
