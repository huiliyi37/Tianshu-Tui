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
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { rivetHome } from '../config/paths.js'
import { expandHome } from '../platform.js'
import { debugLog } from '../utils/debug.js'
import { rawOutputDir } from './output-store.js'

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

/** Read the per-workspace store, tolerating a missing/corrupt file. */
function readPersistedFile(cwd: string): PathGrant[] {
  const file = grantsFile(cwd)
  if (!existsSync(file)) return []
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as PathGrant[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((g): g is PathGrant => !!g && typeof g.root === 'string')
  } catch {
    return []
  }
}

/**
 * The grants persisted for this workspace, as stored on disk. Display/revocation
 * surfaces read this rather than `listGrants()`: the in-memory store also holds
 * session-only grants and the dependency/runtime read grants, which the user
 * never authorized explicitly and must not be offered as revocable entries.
 */
export function listPersistedGrants(cwd: string): PathGrant[] {
  return readPersistedFile(cwd).map(g => ({
    root: g.root,
    mode: g.mode === 'write' ? 'write' : 'read',
    grantedAt: typeof g.grantedAt === 'number' ? g.grantedAt : 0,
    persisted: true,
  }))
}

/**
 * Revoke a grant by exact root. Both halves are required: dropping only the file
 * would leave the subtree writable for the rest of the session (a "revoked"
 * grant that still writes), and dropping only memory would resurrect it at the
 * next startup via `loadPersistedGrants`.
 *
 * Matching is exact, not containment — revoking `/a` must not silently remove a
 * separately-granted `/a/b` the user never asked about.
 *
 * The file is rewritten from its own contents rather than from memory: a peer
 * session may have persisted a grant after this process hydrated, and rewriting
 * from our (staler) memory would silently drop it.
 */
export function revokeGrant(root: string, opts: { cwd: string }): boolean {
  const canonical = canonicalize(root)
  const matches = (candidate: string): boolean => foldCase(canonicalize(candidate)) === foldCase(canonical)

  const hadInMemory = _grants.some(g => matches(g.root))
  if (hadInMemory) _grants = _grants.filter(g => !matches(g.root))

  const onDisk = readPersistedFile(opts.cwd)
  const kept = onDisk.filter(g => !matches(g.root))
  const removedFromDisk = kept.length < onDisk.length
  if (removedFromDisk) {
    try {
      mkdirSync(RIVET_DIR, { recursive: true })
      writeFileAtomicSync(grantsFile(opts.cwd), JSON.stringify(kept, null, 2))
    } catch {
      /* best-effort: the in-memory revocation already took effect this session */
    }
  }
  return hadInMemory || removedFromDisk
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

/**
 * Common third-party dependency / toolchain read-only cache directories
 * (relative to $HOME). Read-side counterpart of the writable roots enumerated
 * in `sandbox-profile.ts::defaultWritableRoots` and `sandbox-toolchain.ts` —
 * the same directories the bash sandbox already lets commands write to.
 *
 * Reading a project's dependency source (a HarmonyOS fork in `.pub-cache`, a
 * git-sourced package, a version-mismatched transitive dep) is a routine
 * diagnostic step. Without these read grants, `read_file` / `grep` on any path
 * under $HOME trips `validatePathSafe` → an approval `await` that has no
 * timeout, and the batch-time watchdog is disarmed (turn-orchestrator.ts:892),
 * so the session hangs until the user hits Ctrl+C — exactly the failure seen
 * in the kaiyang session reading `~/.pub-cache/git/.../*.dart`.
 *
 * Grants are READ-ONLY, session-scoped, never persisted: write still goes
 * through the normal approval/sandbox path, and nothing leaks across projects
 * or sessions. Non-existent entries are skipped fail-closed.
 */
const DEFAULT_DEPENDENCY_READ_DIRS = [
  '.npm', '.npm-cache', '.cache',
  '.cargo', '.rustup',
  '.gradle', '.m2',
  '.pub-cache',
  '.pnpm-store', '.yarn',
  '.bun', '.deno',
  '.cocoapods',
  '.gem', '.bundle',
  '.composer', '.config/composer',
  '.android',
  '.nuget',       // .NET NuGet packages
  '.nvm',         // Node Version Manager installations
  '.pyenv',       // Python version manager installs
  'go',
  // In-project node_modules / vendor / Pods already live under cwd and need no
  // grant; this list only covers $HOME-level global caches.
]

/**
 * Environment variable overrides for dependency cache directories.
 *
 * Each key matches a DEFAULT_DEPENDENCY_READ_DIRS entry. When the named
 * environment variable is set (non-empty), its value is used as the absolute
 * directory root instead of the default `$HOME/{key}` path. Absent or empty
 * env vars fall through to the default.
 *
 * Only well-known, user-facing env vars with a stable contract are listed
 * (e.g. CARGO_HOME, GRADLE_USER_HOME). Npm/yarn/pnpm use layered config
 * (npmrc, yarnrc) whose env-var surface is unreliable; they stay on defaults.
 *
 * See .rivet/knowledge/debug-t7-collapse-cache-cliff.md §4 — env var is the
 * write side (who sets), not the read side (who reads).
 */
const ENV_OVERRIDES: Record<string, string> = {
  '.cargo': 'CARGO_HOME',
  '.rustup': 'RUSTUP_HOME',
  '.gradle': 'GRADLE_USER_HOME',
  '.pub-cache': 'PUB_CACHE',
  '.gem': 'GEM_HOME',
}

export function applyDefaultDependencyReadGrants(): void {
  const home = homedir()
  const granted: string[] = []
  const skipped: string[] = []
  for (const rel of DEFAULT_DEPENDENCY_READ_DIRS) {
    const envVar = ENV_OVERRIDES[rel]
    const root = envVar && process.env[envVar]
      ? resolve(process.env[envVar])
      : resolve(join(home, rel))
    if (!existsSync(root)) {
      skipped.push(rel)
      continue
    }
    grantPath(root, 'read', { persist: false })
    granted.push(rel)
  }
  debugLog(`dep read grants: ${granted.length} granted` +
    (granted.length ? ` (${granted.join(', ')})` : '') +
    (skipped.length ? `; ${skipped.length} skipped (${skipped.join(', ')})` : ''))
}

/**
 * Read grants for directories Rivet itself writes outside the workspace and
 * then tells the model to read back.
 *
 * `$TMPDIR/rivet-raw` holds the full output of tools whose result was truncated
 * for the model, and the truncation footer says verbatim:
 * `full output: read_file <rawPath> — 不要重跑命令`. Without a grant that
 * `read_file` fails `validatePathSafe` ("Path outside project directory"), so
 * the model can neither recover the output nor re-run the command — a closed
 * dead end (9 occurrences across 4 sessions on 2026-07-27/28).
 *
 * Unlike the dependency caches above these roots are NOT existence-gated: the
 * raw dir is created lazily on the first truncated output, so at session start
 * it usually does not exist yet and an `existsSync` skip would make the grant
 * never take effect. Skipping fail-closed is right for user-configured paths
 * (a typo must not open a subtree) but wrong here — the path is ours, derived
 * from code rather than input, and it only ever contains output this agent
 * itself produced.
 *
 * Read-only, session-scoped, never persisted.
 */
export function applyRivetRuntimeReadGrants(): void {
  const roots = [rawOutputDir()]
  for (const root of roots) {
    grantPath(root, 'read', { persist: false })
  }
  debugLog(`rivet runtime read grants: ${roots.join(', ')}`)
}

/** Test-only: clear the in-memory grant store. */
export function _resetGrantsForTest(): void {
  _grants = []
}
