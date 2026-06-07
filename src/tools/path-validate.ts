import { isAbsolute, relative, resolve, dirname, join, basename } from 'path'
import { realpathSync, existsSync } from 'fs'

export interface ValidatedPath {
  ok: true
  path: string
}

export interface InvalidPath {
  ok: false
  error: string
}

export type PathValidationResult = ValidatedPath | InvalidPath

export function validatePathSafe(cwd: string, inputPath: string): PathValidationResult {
  // Returned path stays original-cwd-based to preserve the existing contract
  // (callers compute relative labels / read via this path). Validation, however,
  // canonicalizes both sides: without resolving cwd, a cwd reached through a
  // symlink (macOS /var→/private/var temp dirs, symlinked home/mount/repo) makes
  // the realpath check compare a resolved file against an unresolved cwd and
  // reject every legitimate file as a "symlink escape".
  const resolved = resolve(cwd, inputPath)

  let realCwd: string
  try {
    realCwd = realpathSync(cwd)
  } catch {
    realCwd = resolve(cwd)
  }
  const realResolved = resolve(realCwd, inputPath)

  // Canonicalize the target (resolving symlinks in its existing ancestry) BEFORE
  // the containment check. An absolute inputPath reached through a symlinked root
  // (macOS /var→/private/var temp dirs, symlinked home/mount/repo) would otherwise
  // keep the unresolved prefix and compare against the realpath'd cwd, false-flagging
  // every legitimate in-project absolute path as an escape. For a not-yet-existing
  // file realpathSync throws, so we resolve the nearest existing ancestor instead —
  // this still catches a symlinked parent that escapes the project (e.g. ./evil ->
  // /etc, write evil/new).
  let real: string
  try {
    real = realpathSync(realResolved)
  } catch {
    real = resolveNearestExisting(realResolved, realCwd)
  }
  const rel = relative(realCwd, real)

  if (rel === '') {
    return { ok: true, path: resolved }
  }

  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `Path outside project directory: ${inputPath}` }
  }

  return { ok: true, path: resolved }
}

/**
 * Resolve the real path of `target` when it does not yet exist, by walking up to
 * the nearest existing ancestor, canonicalizing that, then re-appending the
 * non-existent tail. Lets new-file writes be validated while still resolving any
 * symlink in the existing portion of the path.
 */
function resolveNearestExisting(target: string, floor: string): string {
  const segments: string[] = []
  let current = target
  while (!existsSync(current)) {
    // Stop the walk at the project root (floor). Climbing above it would resolve
    // ancestors outside the project — e.g. on macOS /home is a synthetic symlink
    // to /System/Volumes/Data/home — and false-flag legitimate in-project paths
    // as escapes. floor (realCwd) is already canonicalized and validated above.
    if (current === floor) return join(floor, ...segments)
    segments.unshift(basename(current))
    const parent = dirname(current)
    if (parent === current) return target // reached fs root without finding existing
    current = parent
  }
  try {
    return join(realpathSync(current), ...segments)
  } catch {
    return target
  }
}

export function validatePath(cwd: string, filePath: string): string {
  const result = validatePathSafe(cwd, filePath)
  if (!result.ok) throw new Error(result.error)
  return result.path
}
