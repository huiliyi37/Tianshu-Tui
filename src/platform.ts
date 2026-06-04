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
