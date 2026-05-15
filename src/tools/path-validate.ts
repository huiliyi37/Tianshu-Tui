import { isAbsolute, relative, resolve } from 'path'

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

  return { ok: true, path: resolved }
}

export function validatePath(cwd: string, filePath: string): string {
  const result = validatePathSafe(cwd, filePath)
  if (!result.ok) throw new Error(result.error)
  return result.path
}
