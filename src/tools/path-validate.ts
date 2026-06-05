import { isAbsolute, relative, resolve } from 'path'
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
  const resolved = resolve(cwd, inputPath)
  const rel = relative(cwd, resolved)

  if (rel === '') {
    return { ok: true, path: resolved }
  }

  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `Path outside project directory: ${inputPath}` }
  }

  // Symlink traversal guard: resolve symlinks and verify the real path is
  // still within cwd. Without this, a symlink inside the project pointing
  // outside would bypass the string-based check above.
  if (existsSync(resolved)) {
    let real: string
    try {
      real = realpathSync(resolved)
    } catch {
      return { ok: false, error: `Cannot resolve path: ${inputPath}` }
    }
    const realRel = relative(cwd, real)
    if (realRel.startsWith('..') || isAbsolute(realRel)) {
      return { ok: false, error: `Symlink escapes project directory: ${inputPath} → ${realRel}` }
    }
  }

  return { ok: true, path: resolved }
}

export function validatePath(cwd: string, filePath: string): string {
  const result = validatePathSafe(cwd, filePath)
  if (!result.ok) throw new Error(result.error)
  return result.path
}
