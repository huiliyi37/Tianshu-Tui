import { resolve, normalize, sep } from 'path'

/**
 * Validate that a file path resolves within the project directory.
 * Returns the resolved absolute path.
 * Throws if the path escapes the project root.
 */
export function validatePath(cwd: string, filePath: string): string {
  const resolved = resolve(cwd, filePath)
  const normalized = normalize(resolved)

  // Must be within cwd: either equals cwd exactly, or starts with cwd + separator
  if (normalized !== cwd && !normalized.startsWith(cwd + sep)) {
    throw new Error(`Path escapes project directory: ${filePath}`)
  }

  return normalized
}
