/**
 * Runtime lean profile — single switch that expands into existing resource knobs.
 *
 * Resolution: `RIVET_LEAN=1|0` (env wins) → `runtime.lean` in project then user config.
 * Expansions (only when caller has not set an explicit value) live in the
 * respective resolvers: tool preset → minimal, prompt profile → lean,
 * maxWorkers → 1, embeddings off, Meridian startup backfill off, tighter
 * session pool, constellation/companion/dream hooks off.
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { userConfigPath } from './paths.js'

export const LEAN_MAX_LOADED_SESSIONS = 4
export const LEAN_IDLE_AGENT_TTL_MS = 10 * 60_000
export const DEFAULT_MAX_LOADED_SESSIONS = 16
export const DEFAULT_IDLE_AGENT_TTL_MS = 30 * 60_000
/** Disk cap for desktop events.jsonl (non-lean). */
export const DEFAULT_MAX_EVENTS_DISK_BYTES = 50 * 1024 * 1024
/** Tighter disk cap under lean. */
export const LEAN_MAX_EVENTS_DISK_BYTES = 10 * 1024 * 1024

export interface RuntimeLeanConfigSlice {
  lean?: boolean
  maxLoadedSessions?: number
  idleAgentTtlMs?: number
  maxEventsDiskBytes?: number
}

interface RuntimeSection {
  runtime?: RuntimeLeanConfigSlice
}

function findProjectConfigPath(startDir: string): string | undefined {
  let dir = resolve(startDir)
  for (let i = 0; i < 20; i++) {
    const candidate = join(dir, '.rivet-config.json')
    if (existsSync(candidate)) return candidate
    const parent = resolve(dir, '..')
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

function readRuntimeSection(path: string): RuntimeLeanConfigSlice | null {
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as RuntimeSection
    const section = raw.runtime
    if (!section || typeof section !== 'object') return null
    return section
  } catch {
    return null
  }
}

/** Effective lean flag. Env overrides config; project overrides user. */
export function isRuntimeLean(configLean?: boolean, cwd?: string): boolean {
  if (process.env.RIVET_LEAN === '1') return true
  if (process.env.RIVET_LEAN === '0') return false
  if (configLean === true) return true
  if (configLean === false) return false

  if (cwd) {
    const projectPath = findProjectConfigPath(cwd)
    if (projectPath) {
      const project = readRuntimeSection(projectPath)
      if (project?.lean === true) return true
      if (project?.lean === false) return false
    }
  }

  const user = readRuntimeSection(userConfigPath())
  return user?.lean === true
}

export interface SessionPoolOptions {
  maxLoadedSessions: number
  idleAgentTtlMs: number
  maxEventsDiskBytes: number
}

/** Resolve session residency / events disk caps from runtime config + lean. */
export function resolveSessionPoolOptions(
  runtime: RuntimeLeanConfigSlice | undefined,
  lean: boolean,
): SessionPoolOptions {
  return {
    maxLoadedSessions:
      runtime?.maxLoadedSessions
      ?? (lean ? LEAN_MAX_LOADED_SESSIONS : DEFAULT_MAX_LOADED_SESSIONS),
    idleAgentTtlMs:
      runtime?.idleAgentTtlMs
      ?? (lean ? LEAN_IDLE_AGENT_TTL_MS : DEFAULT_IDLE_AGENT_TTL_MS),
    maxEventsDiskBytes:
      runtime?.maxEventsDiskBytes
      ?? (lean ? LEAN_MAX_EVENTS_DISK_BYTES : DEFAULT_MAX_EVENTS_DISK_BYTES),
  }
}
