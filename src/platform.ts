/**
 * Cross-platform abstraction layer for shell execution, process termination,
 * path resolution, and environment detection.
 *
 * All Windows-specific logic is isolated here. The rest of the codebase should
 * use these functions instead of platform-dependent Node.js APIs directly.
 */
import { homedir } from 'node:os'
import { spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { EditorPlatform, EditorEol } from './config/schema.js'
import { TextDecoder } from 'node:util'

/** Result of `getShellCommand()` — the command and args for spawning a shell. */
export interface ShellCommand {
  cmd: string
  /** Args to pass to the shell, WITHOUT the user command appended. */
  args: string[]
}

/** Build the full shell args by appending the user's command. */
export function buildShellArgs(shell: ShellCommand, command: string): string[] {
  return [...shell.args, command]
}

const isWin = process.platform === 'win32'

// ─── Target Conventions ────────────────────────────────────────────────────────
//
// The "target platform" governs file ARTIFACT conventions (line endings) and the
// system-prompt OS hint — NOT command execution. Execution (shell/sandbox/kill)
// always uses the real host `process.platform`, because you can't run PowerShell
// on a macOS host. Resolved once at startup from `editor.platform`/`editor.eol`
// via setTargetConventions(); reads before init safely fall back to the host.

/** Map an `editor.platform` enum value to a concrete NodeJS.Platform. */
function resolveTargetPlatform(platform: EditorPlatform): NodeJS.Platform {
  switch (platform) {
    case 'windows': return 'win32'
    case 'macos': return 'darwin'
    case 'linux': return 'linux'
    case 'auto':
    default: return process.platform
  }
}

let _targetPlatform: NodeJS.Platform = process.platform
let _targetEol: 'crlf' | 'lf' = process.platform === 'win32' ? 'crlf' : 'lf'

/**
 * Resolve and cache the target-OS conventions from config. Call once at startup
 * (after loadConfig) in every entry point (TUI main, server sidecar).
 */
export function setTargetConventions(platform: EditorPlatform, eol: EditorEol): void {
  _targetPlatform = resolveTargetPlatform(platform)
  _targetEol = eol === 'auto' ? (_targetPlatform === 'win32' ? 'crlf' : 'lf') : eol
}

/** The resolved target platform (drives EOL default + prompt OS hint). */
export function getTargetPlatform(): NodeJS.Platform {
  return _targetPlatform
}

/** The resolved default EOL for newly-created files. */
export function getTargetEol(): 'crlf' | 'lf' {
  return _targetEol
}

// ─── Shell ───────────────────────────────────────────────────────────────────

/** Cached shell command to avoid repeated spawnSync on every tool call. */
let _cachedShell: ShellCommand | null = null

/**
 * Detect the best available shell on the current platform.
 *
 * On Windows, prefers PowerShell (pwsh > powershell) for better
 * cross-platform command compatibility, falls back to cmd.exe (ComSpec).
 * On Unix, uses 'sh' (the POSIX shell).
 */
export function getShellCommand(): ShellCommand {
  if (_cachedShell) return _cachedShell

  if (isWin) {
    for (const cmd of ['pwsh.exe', 'powershell.exe']) {
      const result = spawnSync('where', [cmd], {
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 3000,
      })
      if (result.status === 0 && result.stdout.toString().trim()) {
        _cachedShell = { cmd, args: ['-NoProfile', '-Command'] }
        return _cachedShell
      }
    }
    const comSpec = process.env['ComSpec'] || 'cmd.exe'
    _cachedShell = { cmd: comSpec, args: ['/c'] }
    return _cachedShell
  }

  _cachedShell = { cmd: 'sh', args: ['-c'] }
  return _cachedShell
}

// ─── Process Termination ─────────────────────────────────────────────────────

/** Killable subset of ChildProcess used across the codebase. */
export type KillableChild = Pick<ChildProcess, 'pid' | 'kill'>

export function gracefulKill(child: KillableChild): void {
  if (!child.pid) return
  try {
    if (isWin) {
      spawnSync('taskkill', ['/PID', String(child.pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      })
    } else {
      child.kill('SIGTERM')
    }
  } catch { /* best-effort */ }
}

export function forceKill(child: KillableChild): void {
  if (!child.pid) return
  try {
    if (isWin) {
      spawnSync('taskkill', ['/F', '/PID', String(child.pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      })
    } else {
      child.kill('SIGKILL')
    }
  } catch { /* best-effort */ }
}

export function gracefulKillTree(child: KillableChild): void {
  if (!child.pid) return
  try {
    if (isWin) {
      spawnSync('taskkill', ['/T', '/PID', String(child.pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      })
    } else {
      process.kill(-child.pid, 'SIGTERM')
    }
  } catch {
    try {
      if (isWin) {
        spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 5000,
        })
      } else {
        child.kill('SIGTERM')
      }
    } catch { /* best-effort */ }
  }
}

export function forceKillTree(child: KillableChild): void {
  if (!child.pid) return
  try {
    if (isWin) {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 5000,
      })
    } else {
      process.kill(-child.pid, 'SIGKILL')
    }
  } catch {
    try {
      if (isWin) {
        spawnSync('taskkill', ['/F', '/PID', String(child.pid)], {
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: 5000,
        })
      } else {
        child.kill('SIGKILL')
      }
    } catch { /* best-effort */ }
  }
}

// ─── Path & Editor ───────────────────────────────────────────────────────────

export function expandHome(path: string): string {
  if (path.startsWith('~')) {
    return homedir() + path.slice(1)
  }
  return path
}

export function getDefaultEditor(): string {
  if (isWin) {
    return process.env['VISUAL'] || process.env['EDITOR'] || 'notepad'
  }
  return process.env['VISUAL'] || process.env['EDITOR'] || 'vi'
}

// ─── Encoding Decoder for Windows Mojibake Prevention ─────────────────────────

const isUtf8Buffer = typeof (Buffer as any).isUtf8 === 'function'
  ? (Buffer as any).isUtf8
  : (buf: Buffer) => {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(buf)
        return true
      } catch {
        return false
      }
    }

/**
 * Streaming decoder for Windows console output to prevent mojibake/gibberish (乱码).
 * Automatically detects whether stdout/stderr stream is encoded in UTF-8 or GBK/OEM code page
 * on the first chunk, and stream-decodes it without splitting multi-byte characters.
 */
export class WinStreamDecoder {
  private decoder: TextDecoder | null = null
  private isUtf8 = true
  private first = true

  write(chunk: Buffer): string {
    if (!isWin) {
      return chunk.toString('utf8')
    }

    if (this.first) {
      this.first = false
      this.isUtf8 = isUtf8Buffer(chunk)
      const encoding = this.isUtf8 ? 'utf-8' : 'gbk'
      this.decoder = new TextDecoder(encoding, { fatal: false })
    }

    if (this.decoder) {
      return this.decoder.decode(chunk, { stream: true })
    }
    return chunk.toString('utf8')
  }

  end(): string {
    if (this.decoder) {
      return this.decoder.decode()
    }
    return ''
  }
}
