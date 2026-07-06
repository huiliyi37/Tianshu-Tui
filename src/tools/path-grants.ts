/**
 * Session-scoped out-of-workspace path grants.
 *
 * The two enforcement gates (file-tool `validatePathSafe` and the kernel bash
 * sandbox `defaultWritableRoots`) both default to "workspace only". This store
 * lets the agent — ONLY after an explicit user approval — widen that boundary
 * to a specific directory subtree, so authorized work outside the workspace
 * (writing a package to ~/Desktop, reading /tmp, touching the parent dir) is
 * possible without dropping the whole sandbox.
 *
 * Lifetime: grants live in-process (one session) by default. A grant may be
 * persisted per-workspace under ~/.rivet so a "remembered" path survives across
 * sessions of THAT workspace — never globally (a grant for project A must not
 * leak into project B).
 *
 * Security: a grant is a directory subtree. Containment checks canonicalize
 * symlinks on both sides so a granted path cannot be used to escape via a
 * symlinked child. `write` implies `read`.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { rivetHome } from '../config/paths.js'
import { expandHome } from '../platform.js'

export type GrantMode = 'read' | 'write'

export interface PathGrant {
  /** Canonicalized (realpath'd where possible) absolute directory root. */
  root: string
  mode: GrantMode
  grantedAt: number
  /** True when this grant was written through to the per-workspace store. */
  persisted?: boolean
}

const RIVET_DIR = rivetHome()

/** In-memory grants for the current process/session. */
let _grants: PathGrant[] = []

/**
 * Canonicalize a path: resolve symlinks where the path (or its nearest existing
 * ancestor) exists, so containment checks compare real paths. Falls back to a
 * plain resolve for not-yet-existing targets.
 */
function canonicalize(p: string): string {
  const abs = resolve(p)
  try {
    return realpathSync(abs)
  } catch {
    // Walk up to the nearest existing ancestor, canonicalize it, re-append tail.
    let current = abs
    const tail: string[] = []
    while (!existsSync(current)) {
      const parent = resolve(current, '..')
      if (parent === current) return abs // reached fs root
      tail.unshift(current.slice(parent.length + 1))
      current = parent
    }
    try {
      return join(realpathSync(current), ...tail)
    } catch {
      return abs
    }
  }
}

/**
 * Windows filesystems are case-insensitive: drive letters and path segments
 * arrive in mixed case (F:\ vs f:\, cmd vs Explorer casing), and realpath only
 * normalizes casing for path components that exist. Containment/dedup checks
 * must therefore fold case on win32 or grants silently fail to match.
 */
const CASE_INSENSITIVE_FS = process.platform === 'win32'

function foldCase(p: string): string {
  return CASE_INSENSITIVE_FS ? p.toLowerCase() : p
}

/**
 * True when `child` is the same as `root` or nested under it, using a
 * separator boundary so `/a/b` does NOT match `/a/bc`. Exposed with an
 * explicit case-sensitivity flag for unit testing win32 semantics on any host.
 */
export function isPathUnder(root: string, child: string, caseInsensitive: boolean = CASE_INSENSITIVE_FS): boolean {
  const r = caseInsensitive ? root.toLowerCase() : root
  const c = caseInsensitive ? child.toLowerCase() : child
  if (c === r) return true
  const prefix = r.endsWith(sep) ? r : r + sep
  return c.startsWith(prefix)
}

function isUnder(root: string, child: string): boolean {
  return isPathUnder(root, child)
}

/** Per-workspace persisted-grants file, keyed by a cwd slug (mirrors checkpoint.ts). */
function grantsFile(cwd: string): string {
  const slug = canonicalize(cwd).replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
  return join(RIVET_DIR, `path-grants-${slug}.json`)
}

/**
 * Grant access to a directory subtree. `root` is canonicalized. A write grant
 * supersedes a prior read grant on the same root. When `opts.persist` is set,
 * the grant is also written to the per-workspace store (requires opts.cwd).
 */
export function grantPath(root: string, mode: GrantMode, opts?: { persist?: boolean; cwd?: string }): PathGrant {
  const canonical = canonicalize(root)
  const persist = opts?.persist === true
  const existing = _grants.find(g => foldCase(g.root) === foldCase(canonical))
  let grant: PathGrant
  if (existing) {
    // Upgrade read → write; never downgrade.
    if (mode === 'write') existing.mode = 'write'
    if (persist) existing.persisted = true
    grant = existing
  } else {
    grant = { root: canonical, mode, grantedAt: Date.now(), ...(persist ? { persisted: true } : {}) }
    _grants.push(grant)
  }
  if (persist && opts?.cwd) persistGrants(opts.cwd)
  return grant
}

/** True if `absPath` is under any granted root (read or write satisfies read). */
export function isReadGranted(absPath: string): boolean {
  const target = canonicalize(absPath)
  return _grants.some(g => isUnder(g.root, target))
}

/** True if `absPath` is under any WRITE-granted root. */
export function isWriteGranted(absPath: string): boolean {
  const target = canonicalize(absPath)
  return _grants.some(g => g.mode === 'write' && isUnder(g.root, target))
}

/** All write-granted roots (consumed by the sandbox's writable-roots builder). */
export function writeGrantedRoots(): string[] {
  return _grants.filter(g => g.mode === 'write').map(g => g.root)
}

/** Snapshot of current grants. */
export function listGrants(): PathGrant[] {
  return _grants.map(g => ({ ...g }))
}

/** Write the currently-persisted grants to the per-workspace store. */
function persistGrants(cwd: string): void {
  try {
    mkdirSync(RIVET_DIR, { recursive: true })
    const toSave = _grants.filter(g => g.persisted)
    writeFileAtomicSync(grantsFile(cwd), JSON.stringify(toSave, null, 2))
  } catch {
    /* best-effort: a persistence failure must not break the grant itself */
  }
}

/**
 * Hydrate persisted grants for this workspace into the in-memory store at
 * startup. Re-canonicalizes each root (paths may have moved/symlinks changed)
 * and drops any whose root no longer exists.
 */
export function loadPersistedGrants(cwd: string): void {
  const file = grantsFile(cwd)
  if (!existsSync(file)) return
  let saved: PathGrant[]
  try {
    saved = JSON.parse(readFileSync(file, 'utf-8')) as PathGrant[]
  } catch {
    return
  }
  if (!Array.isArray(saved)) return
  for (const g of saved) {
    if (!g || typeof g.root !== 'string') continue
    if (!existsSync(g.root)) continue
    const mode: GrantMode = g.mode === 'write' ? 'write' : 'read'
    grantPath(g.root, mode, { persist: false })
    const stored = _grants.find(x => foldCase(x.root) === foldCase(canonicalize(g.root)))
    if (stored) stored.persisted = true
  }
}

/**
 * Apply the user's standing directory grants from config
 * (`permissions.additionalReadDirs` / `additionalWriteDirs`) at session start —
 * the Codex-style "give this folder to the agent" model. Session-scoped
 * in-memory grants (config is the durable source; nothing is written to the
 * per-workspace grant store). Non-existent entries are skipped fail-closed:
 * a typo'd config line must not open a subtree that later comes into being.
 */
export function applyConfiguredPathGrants(
  permissions: { additionalReadDirs?: string[]; additionalWriteDirs?: string[] } | undefined,
): void {
  if (!permissions) return
  const apply = (dirs: string[] | undefined, mode: GrantMode): void => {
    for (const raw of dirs ?? []) {
      const trimmed = raw.trim()
      if (!trimmed) continue
      const root = resolve(expandHome(trimmed))
      if (!existsSync(root)) continue
      grantPath(root, mode, { persist: false })
    }
  }
  apply(permissions.additionalReadDirs, 'read')
  apply(permissions.additionalWriteDirs, 'write')
}

/** Test-only: clear the in-memory grant store. */
export function _resetGrantsForTest(): void {
  _grants = []
}
