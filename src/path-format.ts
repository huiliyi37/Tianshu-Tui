import { relative } from 'node:path'

/** Convert platform-native path separators to POSIX-style separators for model/UI output. */
export function toPosixPath(filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

/** path.relative wrapper for stable cross-platform tool output and glob/gitignore matching. */
export function relativePosix(from: string, to: string): string {
  return toPosixPath(relative(from, to))
}
