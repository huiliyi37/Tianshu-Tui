import { relative } from 'node:path'

/** Convert platform-native path separators to POSIX-style separators for model/UI output. */
export function toPosixPath(filePath: string): string {
  return filePath.replaceAll('\\', '/')
}

/** path.relative wrapper for stable cross-platform tool output and glob/gitignore matching. */
export function relativePosix(from: string, to: string): string {
  return toPosixPath(relative(from, to))
}

/**
 * Canonical map-key form of a path — use whenever a path becomes a Map/Set key
 * or a string-match target (read-dedup tables, invalidation suffix matching).
 *
 * Windows 文件系统大小写不敏感且分隔符双轨：`D:\a`、`D:/a`、`d:/A` 是同一个
 * 文件，但作为字符串键是三个键——读缓存漏命中事小，跨会话 file_changed 失效
 * 事件因键不匹配而静默失效，就是 read-ref 缓存中毒的变种复发（OpenCode 同类
 * 教训：会话按路径键匹配，separator/大小写变体导致会话在侧栏消失）。
 * POSIX 原样返回（大小写敏感文件系统，不能 lowercase）。
 */
export function canonicalPathKey(filePath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return filePath
  return toPosixPath(filePath).toLowerCase()
}

/**
 * Translate Git Bash / Cygwin / WSL drive-prefixed POSIX paths to native
 * Windows form at the input boundary: `/c/x`、`/c:/x`、`/cygdrive/c/x`、
 * `/mnt/c/x` → `C:/x`。Windows 用户从 Git Bash 终端复制路径粘给 agent 是
 * 高频动作，不翻译就是 File not found。链式 replace 安全：每条只锚定行首，
 * 命中任意一条后结果不再以 '/' 开头，其余规则自然失配。非 win32 原样返回
 * （macOS/Linux 上 /mnt/c 可能是真实目录）。
 */
export function translateWindowsShellPath(inputPath: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return inputPath
  return inputPath
    .replace(/^\/([a-zA-Z]):(?=[\\/]|$)/, (_, d: string) => `${d.toUpperCase()}:`)
    .replace(/^\/(?:cygdrive|mnt)\/([a-zA-Z])(?=\/|$)/, (_, d: string) => `${d.toUpperCase()}:`)
    .replace(/^\/([a-zA-Z])(?=\/|$)/, (_, d: string) => `${d.toUpperCase()}:`)
}
