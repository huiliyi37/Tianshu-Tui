/**
 * Workspace-scoped command sandbox.
 *
 * Goal: let the agent run shell commands full-throttle and unattended while a
 * kernel-level boundary — not a stream of approval prompts — prevents writes
 * outside the workspace. The boundary is the filesystem WRITE scope:
 *   - reads: broad (the agent needs to inspect the system)
 *   - writes: confined to cwd + temp + package caches
 *   - network: allowed (build/test/git need it)
 *
 * Backends (selected per platform):
 *   - macOS  → Seatbelt profile via `sandbox-exec` (built-in)
 *   - Linux  → bwrap (preferred) or firejail (read-only root + writable cwd)
 *   - WSL    → reuse the Linux backend
 *   - native Windows → no lightweight kernel FS scope reachable from pure Node;
 *     fail soft (run unsandboxed with a loud note) and rely on the B2 full
 *     rollback safety net. AppContainer/Job-Object wrapping is a future native
 *     helper.
 *
 * The pure functions here (profile/command builders, backend selection given
 * injected detectors) are unit-testable on any OS; the actual kernel
 * enforcement is exercised only on the matching platform.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeGrantedRoots } from './path-grants.js'

export type SandboxBackendKind =
  | 'seatbelt'
  | 'bwrap'
  | 'firejail'
  | 'none'

export interface SandboxContext {
  /** Workspace root — the only directory tree commands may write to. */
  cwd: string
  /** Override for tests. Defaults to process.platform. */
  platform?: NodeJS.Platform
  /** Override for tests. Defaults to process.env. */
  env?: NodeJS.ProcessEnv
  /** Override for tests. Probes whether a binary exists on PATH. */
  which?: (bin: string) => boolean
  /** Override for tests. Reads /proc/version for WSL detection. */
  readProcVersion?: () => string | null
}

export interface SandboxDecision {
  /** The (possibly wrapped) command to hand to the shell. */
  command: string
  /** True when a real kernel boundary is in effect. */
  sandboxed: boolean
  backend: SandboxBackendKind
  /** Human-readable explanation (shown in diagnostics / UI). */
  note?: string
}

/** Escape a string for embedding inside POSIX single quotes. */
export function shSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

/** Escape a path for embedding inside a Seatbelt double-quoted literal. */
function seatbeltQuote(path: string): string {
  return path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Default set of directories the sandbox permits writes to. The workspace cwd
 * plus the temp dir and the common package-manager caches so that
 * build/test/install workflows are not broken by the boundary.
 *
 * Extra roots can be appended via RIVET_SANDBOX_WRITABLE (path-list separated
 * by the platform delimiter — ':' on POSIX, ';' on Windows).
 */
export function defaultWritableRoots(ctx: { cwd: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }): string[] {
  const env = ctx.env ?? process.env
  const home = env.HOME || homedir()
  const tmp = env.TMPDIR || tmpdir()
  const roots = new Set<string>()

  roots.add(ctx.cwd)
  roots.add(tmp)
  roots.add('/tmp')
  roots.add('/private/tmp')
  roots.add('/var/folders') // macOS per-user temp lives here

  // Common package-manager / toolchain caches under HOME.
  for (const rel of [
    '.npm', '.cache', '.cargo', 'go', '.rustup', '.bun', '.deno',
    '.gradle', '.m2', '.pnpm-store', '.yarn', '.npm-cache',
    'Library/Caches',
  ]) {
    roots.add(join(home, rel))
  }

  const extra = env.RIVET_SANDBOX_WRITABLE
  if (extra) {
    // Path-list separator is platform-specific: ';' on Windows (where absolute
    // paths carry a drive-letter colon, e.g. C:\data), ':' on POSIX.
    const delim = (ctx.platform ?? process.platform) === 'win32' ? ';' : ':'
    for (const p of extra.split(delim)) {
      const trimmed = p.trim()
      if (trimmed) roots.add(trimmed)
    }
  }

  // User-approved out-of-workspace write grants (session or persisted). Recomputed
  // per command-wrap, so a grant approved mid-session takes effect on the next
  // bash call with no restart.
  for (const granted of writeGrantedRoots()) roots.add(granted)

  return [...roots]
}

/** Build a Seatbelt profile that allows everything except writes outside roots. */
export function buildSeatbeltProfile(writableRoots: string[]): string {
  const writeRules = writableRoots
    .map(root => `  (subpath "${seatbeltQuote(root)}")`)
    .join('\n')
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write*',
    writeRules,
    ')',
    // Character devices that virtually every command needs to write to.
    '(allow file-write-data',
    '  (literal "/dev/null")',
    '  (literal "/dev/zero")',
    '  (literal "/dev/stdout")',
    '  (literal "/dev/stderr")',
    '  (literal "/dev/tty")',
    '  (literal "/dev/dtracehelper")',
    ')',
  ].join('\n')
}

/** Wrap a command for macOS Seatbelt. */
export function buildSeatbeltCommand(command: string, writableRoots: string[]): string {
  const profile = buildSeatbeltProfile(writableRoots)
  return `sandbox-exec -p ${shSingleQuote(profile)} sh -c ${shSingleQuote(command)}`
}

/** Wrap a command for bubblewrap: read-only root, writable cwd + caches, network on. */
export function buildBwrapCommand(command: string, writableRoots: string[]): string {
  const binds = writableRoots
    .map(root => `--bind ${shSingleQuote(root)} ${shSingleQuote(root)}`)
    .join(' ')
  return [
    'bwrap',
    '--ro-bind / /',
    '--dev-bind /dev /dev',
    binds,
    '--',
    `sh -c ${shSingleQuote(command)}`,
  ].join(' ')
}

/** Wrap a command for firejail: read-only root with explicit writable roots. */
export function buildFirejailCommand(command: string, writableRoots: string[]): string {
  const writes = writableRoots
    .map(root => `--read-write=${shSingleQuote(root)}`)
    .join(' ')
  return [
    'firejail',
    '--quiet',
    '--noprofile',
    '--read-only=/',
    writes,
    '--',
    `sh -c ${shSingleQuote(command)}`,
  ].join(' ')
}

/** Detect whether the current Linux kernel is actually WSL. */
export function detectWsl(readProcVersion: () => string | null, env: NodeJS.ProcessEnv): boolean {
  if (env.WSL_DISTRO_NAME) return true
  const version = readProcVersion()
  if (!version) return false
  return /microsoft|wsl/i.test(version)
}

function defaultReadProcVersion(): string | null {
  try {
    if (existsSync('/proc/version')) return readFileSync('/proc/version', 'utf-8')
  } catch { /* ignore */ }
  return null
}

function defaultWhich(bin: string): boolean {
  try {
    execFileSync('which', [bin], { encoding: 'utf-8', timeout: 500 })
    return true
  } catch {
    return false
  }
}

/**
 * Choose the sandbox backend for the current platform. Pure given injected
 * detectors so tests can simulate any OS.
 */
export function selectSandboxBackend(ctx: SandboxContext): SandboxBackendKind {
  const platform = ctx.platform ?? process.platform
  const which = ctx.which ?? defaultWhich

  if (platform === 'darwin') {
    return which('sandbox-exec') ? 'seatbelt' : 'none'
  }

  // Linux and WSL share the same backend selection (bwrap > firejail).
  if (platform === 'linux') {
    if (which('bwrap')) return 'bwrap'
    if (which('firejail')) return 'firejail'
    return 'none'
  }

  // Native Windows (non-WSL): no pure-Node kernel FS scope.
  return 'none'
}

let _cachedActiveBackend: SandboxBackendKind | null = null

/**
 * Whether a real kernel write-boundary is in effect for the current process.
 * Cached because the backend cannot change mid-run. Used by the approval
 * cascade: when true, in-workspace bash writes are safe-by-construction
 * (boundary + rollback) and need not interrupt the user; when false we stay
 * fail-closed and keep requiring approval for write commands.
 */
export function isSandboxActive(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.RIVET_NO_SANDBOX === '1') return false
  if (_cachedActiveBackend === null) {
    _cachedActiveBackend = selectSandboxBackend({ cwd: process.cwd() })
  }
  return _cachedActiveBackend !== 'none'
}

/** Test-only: reset the cached backend probe. */
export function _resetSandboxBackendCache(): void {
  _cachedActiveBackend = null
}

export interface SandboxNotice {
  level: 'warn' | 'info'
  message: string
}

/**
 * Compute the startup notice about the command sandbox's protection level.
 * Pure (given injected detectors) so it is unit-testable on any OS.
 *
 * Returns:
 *   - a 'warn' when there is NO kernel write boundary (explicit RIVET_NO_SANDBOX,
 *     or no backend available) — with deliberately sterner wording on native
 *     Windows, where "no write protection + rollback as after-the-fact net"
 *     means a malicious/buggy command can write system dirs before any rollback,
 *     a strictly larger exposure window than mac/linux;
 *   - null when a real boundary (seatbelt/bwrap/firejail) is in effect (no noise).
 */
export function getSandboxStartupNotice(ctx: SandboxContext): SandboxNotice | null {
  const env = ctx.env ?? process.env
  const platform = ctx.platform ?? process.platform

  if (env.RIVET_NO_SANDBOX === '1') {
    const base = 'RIVET_NO_SANDBOX=1 — 命令沙箱已关闭，无工作区写边界；回滚是唯一安全网（且只能撤销文件改动，撤不了已发生的 API/DB/网络副作用）。'
    return {
      level: 'warn',
      message: platform === 'win32'
        ? base + ' 你在原生 Windows 上：命令可写系统目录，风险显著高于 mac/linux。'
        : base,
    }
  }

  const backend = selectSandboxBackend(ctx)
  if (backend !== 'none') return null

  if (platform === 'win32') {
    return {
      level: 'warn',
      message:
        '⚠️ 原生 Windows 无内核级写沙箱：命令可写工作区外/系统目录，B2 回滚仅是事后兜底（无法撤销已发生的系统写入或外部副作用）——暴露窗口明显大于 mac/linux。' +
        ' 强烈建议在 WSL 中运行（自动复用 Linux Landlock/bwrap 边界），或显式接受此风险。',
    }
  }

  const readProcVersion = ctx.readProcVersion ?? defaultReadProcVersion
  const isWsl = platform === 'linux' && detectWsl(readProcVersion, env)
  return {
    level: 'warn',
    message: isWsl
      ? 'WSL 检测到但未安装 bubblewrap：当前无写边界。`sudo apt install bubblewrap` 可获得真沙箱。'
      : '无可用沙箱后端：当前无写边界。Linux 装 bubblewrap，Windows 走 WSL。',
  }
}

let _emittedNoSandboxWarning = false

/**
 * Emit the no-sandbox warning at most once per process. Wired into startup so
 * the exposure is announced up-front rather than buried in tool output. The
 * logger defaults to console.error (stderr), matching the rest of bootstrap.
 */
export function maybeWarnNoSandbox(
  ctx: SandboxContext,
  log: (msg: string) => void = (m) => console.error(m),
): SandboxNotice | null {
  if (_emittedNoSandboxWarning) return null
  const notice = getSandboxStartupNotice(ctx)
  if (!notice) return null
  _emittedNoSandboxWarning = true
  log(`[sandbox] ${notice.message}`)
  return notice
}

/** Test-only: reset the one-time warning latch. */
export function _resetSandboxWarningLatch(): void {
  _emittedNoSandboxWarning = false
}

/** Test-only: force the cached backend so isSandboxActive() is deterministic. */
export function _setSandboxBackendForTest(kind: SandboxBackendKind): void {
  _cachedActiveBackend = kind
}

/**
 * Wrap a shell command in a workspace-scoped sandbox. Default-ON.
 * Opt out entirely with RIVET_NO_SANDBOX=1.
 */
export function wrapSandboxCommand(command: string, ctx: SandboxContext): SandboxDecision {
  const env = ctx.env ?? process.env
  const platform = ctx.platform ?? process.platform

  if (env.RIVET_NO_SANDBOX === '1') {
    return { command, sandboxed: false, backend: 'none', note: 'RIVET_NO_SANDBOX=1 — sandbox disabled' }
  }

  const backend = selectSandboxBackend(ctx)
  const writableRoots = defaultWritableRoots({ cwd: ctx.cwd, env, platform: ctx.platform })

  switch (backend) {
    case 'seatbelt':
      return {
        command: buildSeatbeltCommand(command, writableRoots),
        sandboxed: true,
        backend,
        note: 'macOS Seatbelt (writes confined to workspace + caches, network on)',
      }
    case 'bwrap':
      return {
        command: buildBwrapCommand(command, writableRoots),
        sandboxed: true,
        backend,
        note: 'bwrap (read-only root, writable workspace + caches, network on)',
      }
    case 'firejail':
      return {
        command: buildFirejailCommand(command, writableRoots),
        sandboxed: true,
        backend,
        note: 'firejail (read-only root, writable workspace + caches, network on)',
      }
    case 'none':
    default: {
      const readProcVersion = ctx.readProcVersion ?? defaultReadProcVersion
      const isWsl = platform === 'linux' && detectWsl(readProcVersion, env)
      const reason = platform === 'win32'
        ? 'native Windows has no lightweight kernel FS sandbox — relying on workspace rollback safety net'
        : isWsl
          ? 'WSL detected but bwrap/firejail not installed — install bubblewrap for a real boundary'
          : 'no sandbox backend available — install bubblewrap (Linux) or use WSL (Windows)'
      return { command, sandboxed: false, backend: 'none', note: reason }
    }
  }
}
