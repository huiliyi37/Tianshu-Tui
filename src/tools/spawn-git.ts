/**
 * Unified git spawning with resolved env + executable path discovery.
 *
 * Why this exists: GUI-launched desktop apps on Windows inherit a truncated PATH.
 * `getResolvedEnv` recovers the real PATH (registry / login shell), but callers
 * also need the git executable itself resolved — `git` as a bare command fails
 * when the git install dir isn't on even the resolved PATH (rare but possible).
 * This module provides sync/async/execFile wrappers that resolve the git path
 * AND layer the resolved env, so every git call site gets both fixes in one shot.
 *
 * Sync `resolveGitCommand` mirrors the path set from env-check.ts's async
 * `resolveGitExePath`, minus the `where git` step (sync constraint — that would
 * require an async child process). The `'git'` fallback + `getResolvedEnv` PATH
 * covers the vast majority of installs; hardcoded paths are defense-in-depth.
 */

import { spawn, spawnSync, execFile } from 'node:child_process'
import type { SpawnSyncOptions, SpawnOptions, ExecFileOptions } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { getResolvedEnv } from './resolved-env.js'

/** Test/injection hooks for `resolveGitCommand` (production callers omit). */
export interface ResolveGitCommandDeps {
  platform?: NodeJS.Platform
  existsSync?: (path: string) => boolean
}

/**
 * Resolve the git executable path synchronously.
 *
 * Probe order:
 *   1. `RIVET_GIT_PATH` env override (seeded from `env.gitPath` on desktop)
 *   2. Windows: common install locations (Program Files / LOCALAPPDATA)
 *   3. Fallback `'git'` — resolved via `gitEnv`'s PATH
 */
export function resolveGitCommand(
  env?: NodeJS.ProcessEnv,
  deps?: ResolveGitCommandDeps,
): string {
  // Merge caller overrides on top of process.env so a partial opts.env
  // (e.g. from spawnGitSync without explicit env) never hides process-level
  // RIVET_GIT_PATH set by the desktop launcher.
  const effectiveEnv = { ...process.env, ...env }
  const platform = deps?.platform ?? process.platform
  const exists = deps?.existsSync ?? existsSync

  // 1. Explicit override
  const override = effectiveEnv['RIVET_GIT_PATH']
  if (override && exists(override)) return override

  // 2. Windows: probe common install locations
  if (platform === 'win32') {
    const candidates = [
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
    ]
    const localApp = effectiveEnv['LOCALAPPDATA']
    if (localApp) {
      candidates.push(join(localApp, 'Programs', 'Git', 'cmd', 'git.exe'))
    }
    for (const c of candidates) {
      if (exists(c)) return c
    }
  }

  // 3. Fallback — resolved PATH will find it in the vast majority of cases
  return 'git'
}

/** Resolved env for subprocess execution. Mirrors bash.ts / git.ts / run-tests.ts. */
export function gitEnv(cwd?: string): NodeJS.ProcessEnv {
  return getResolvedEnv(cwd)
}

/**
 * Synchronous git spawn. Always returns string stdout/stderr (encoding defaults
 * to 'utf-8'). In Node 24, `spawnSync`'s return type uses `string | Buffer |
 * NonSharedBuffer | null` for stdout/stderr — TS doesn't narrow on `encoding`,
 * so we default encoding to 'utf-8' and assert the return type to avoid every
 * caller needing `String(result.stdout)` coercion.
 */
export function spawnGitSync(
  args: string[],
  opts?: SpawnSyncOptions,
): Omit<ReturnType<typeof spawnSync>, 'stdout' | 'stderr'> & {
  stdout: string
  stderr: string
} {
  const cwd = typeof opts?.cwd === 'string' ? opts.cwd : undefined
  const command = resolveGitCommand(opts?.env)
  const env = { ...gitEnv(cwd), ...opts?.env }
  return spawnSync(command, args, {
    encoding: 'utf-8',
    ...opts,
    env,
    windowsHide: true,
  }) as Omit<ReturnType<typeof spawnSync>, 'stdout' | 'stderr'> & {
    stdout: string
    stderr: string
  }
}

/**
 * Async git spawn. Returns `ChildProcess` so callers can use `track()`,
 * `gracefulKill()`, `AbortSignal`, and pipe stdio as they do with bare `spawn`.
 * Same contract as `child_process.spawn`.
 */
export function spawnGit(
  args: string[],
  opts?: SpawnOptions,
): ReturnType<typeof spawn> {
  const cwd = typeof opts?.cwd === 'string' ? opts.cwd : undefined
  const command = resolveGitCommand(opts?.env)
  const env = { ...gitEnv(cwd), ...opts?.env }
  return spawn(command, args, { ...opts, env, windowsHide: true })
}

/**
 * `execFile` git wrapper — for callers that need the callback-style API
 * (e.g. `tool-pipeline.ts`). With callback: returns `ChildProcess` (same as
 * `execFile`). Without callback: returns `ChildProcess` with stdout/stderr
 * accessible via events.
 */
export function execFileGit(
  args: string[],
  opts?: ExecFileOptions,
  cb?: (error: Error | null, stdout: string, stderr: string) => void,
): ReturnType<typeof execFile> {
  const cwd = typeof opts?.cwd === 'string' ? opts.cwd : undefined
  const command = resolveGitCommand(opts?.env)
  const env = { ...gitEnv(cwd), ...opts?.env }
  const mergedOpts = { ...opts, encoding: 'utf-8' as const, env, windowsHide: true }
  if (cb) {
    return execFile(command, args, mergedOpts, cb)
  }
  return execFile(command, args, mergedOpts)
}
