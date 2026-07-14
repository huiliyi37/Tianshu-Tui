// Helpers for handling files dropped from the Tauri shell into the Composer.
// These operate on absolute file paths (rather than browser File objects) so
// text files can be referenced as @file: mentions instead of inlined content.

import { formatFileMention } from './mention-input'

/** Raster images supported by the vision pipeline (BMP is transcoded). */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp',
])

/** Text files that can be referenced as @file: mentions. */
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown',
  'json', 'jsonc', 'jsonl',
  'js', 'jsx', 'mjs', 'cjs',
  'ts', 'tsx', 'mts', 'cts',
  'vue', 'svelte',
  'css', 'scss', 'sass', 'less', 'styl',
  'html', 'htm', 'svg', 'xml',
  'yaml', 'yml', 'toml',
  'py', 'pyi', 'ipynb',
  'go', 'rs', 'java', 'kt', 'kts', 'scala', 'groovy',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hpp', 'hh',
  'swift', 'm', 'mm',
  'rb', 'erb', 'haml', 'slim',
  'php', 'phtml',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'sql', 'log', 'env', 'ini', 'cfg', 'conf', 'config',
  'dockerfile', 'makefile', 'rakefile', 'gemfile',
])

/** Compressed archives that cannot be attached. */
const ARCHIVE_EXTENSIONS = new Set([
  'zip', 'rar', '7z',
  'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'lz', 'lzma',
  'pkg', 'dmg', 'iso',
])

/** Binary/non-text files that are not images and not archives. */
const UNSUPPORTED_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'aac',
  'zipx', 'jar', 'war', 'ear',
])

function basename(name: string): string {
  return name.split(/[/\\]/).pop() ?? name
}

function extension(name: string): string {
  const lastDot = name.lastIndexOf('.')
  return lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : ''
}

function extFromPath(path: string): string {
  return extension(basename(path))
}

export type AttachmentKind = 'image' | 'text' | 'unsupported' | 'archive'

export function classifyAttachmentPath(path: string): AttachmentKind {
  const ext = extFromPath(path)
  if (IMAGE_EXTENSIONS.has(ext)) return 'image'
  if (ARCHIVE_EXTENSIONS.has(ext)) return 'archive'
  if (TEXT_EXTENSIONS.has(ext)) return 'text'
  if (UNSUPPORTED_EXTENSIONS.has(ext)) return 'unsupported'
  // Default to text for unknown extensions: the agent can attempt to read it,
  // and the user can see what was dropped. This matches @file: picker behavior.
  return 'text'
}

/** Convert an absolute dropped path into a project-relative path when possible,
 *  otherwise keep the absolute path so the agent can request_path_access it. */
export function makeFileMention(path: string, cwd: string): string {
  const normalizedPath = path.replace(/\\/g, '/')
  const normalizedCwd = cwd.replace(/\\/g, '/').replace(/\/$/, '')
  const rel = normalizedPath.startsWith(`${normalizedCwd}/`)
    ? normalizedPath.slice(normalizedCwd.length + 1)
    : normalizedPath
  return formatFileMention(rel)
}

export function attachmentBasename(path: string): string {
  return basename(path)
}
