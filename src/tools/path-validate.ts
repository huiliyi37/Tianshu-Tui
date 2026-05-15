import { resolve, normalize } from 'path'

/**
 * Validate that a file path resolves within the project directory.
 * Returns the resolved absolute path.
 * Throws if the path escapes the project root.
 */
export function validatePath(cwd: string, filePath: string): string {
  const resolved = resolve(cwd, filePath)
  const normalized = normalize(resolved)

  // Must be within the project directory
  if (!normalized.startsWith(cwd)) {
    throw new Error(`Path escapes project directory: ${filePath}`)
  }

  return normalized
}
