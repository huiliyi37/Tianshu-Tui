// File-type classification for the Composer attachment flow.
// Windows clipboard/drag often reports an empty MIME type, so every check
// falls back to the file extension.

/** Raster images supported by the vision pipeline (BMP is transcoded). */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp',
])

/** Text files that can be inlined into the Composer as code/content. */
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

/** Archives that cannot be inlined or previewed and should be rejected. */
const ARCHIVE_EXTENSIONS = new Set([
  'zip', 'rar', '7z',
  'tar', 'gz', 'tgz', 'bz2', 'tbz', 'tbz2', 'xz', 'txz', 'lz', 'lzma',
  'pkg', 'dmg', 'iso',
])

/** Binary/non-text files that are not images, not archives, and not safe to inline. */
const UNSUPPORTED_EXTENSIONS = new Set([
  'exe', 'dll', 'so', 'dylib', 'bin',
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'flac', 'aac',
  'zipx', 'jar', 'war', 'ear',
])

function extension(name: string): string {
  const lastDot = name.lastIndexOf('.')
  return lastDot > 0 ? name.slice(lastDot + 1).toLowerCase() : ''
}

/** Compressed archives (.zip, .rar, .tar.gz, etc.). */
export function isArchiveFile(file: { name: string }): boolean {
  const ext = extension(file.name)
  if (ARCHIVE_EXTENSIONS.has(ext)) return true
  // tar.* variants: name.tar.gz, name.tar.bz2, etc.
  const lower = file.name.toLowerCase()
  return /\.tar\.[a-z0-9]+$/.test(lower)
}

/** Raster images accepted by the vision attachment pipeline. */
export function isImageFile(file: { type: string; name: string }): boolean {
  if (file.type) {
    // Reject SVG: vector, not useful for vision, and rasterizing it through
    // canvas is risky (taint, scripts, sizing).
    if (file.type === 'image/svg+xml') return false
    if (file.type.startsWith('image/')) return true
  }
  return IMAGE_EXTENSIONS.has(extension(file.name))
}

const KNOWN_TEXT_FILENAMES = new Set([
  'dockerfile', 'makefile', 'rakefile', 'gemfile', 'gemfile.lock',
])

/** Plain-text files that can be inlined into the prompt as code/content. */
export function isTextFile(file: { type: string; name: string }): boolean {
  if (file.type) {
    if (file.type.startsWith('text/')) return true
    if (file.type === 'application/json') return true
    if (file.type === 'application/javascript') return true
    if (file.type === 'application/typescript') return true
  }
  const base = file.name.split(/[/\\]/).pop()?.toLowerCase() ?? ''
  if (KNOWN_TEXT_FILENAMES.has(base)) return true
  return TEXT_EXTENSIONS.has(extension(file.name))
}

/** Files that should be rejected outright (archives + other binaries). */
export function isUnsupportedFile(file: { type: string; name: string }): boolean {
  if (isImageFile(file)) return false
  if (isTextFile(file)) return false
  if (isArchiveFile(file)) return true
  const ext = extension(file.name)
  return ext === '' || UNSUPPORTED_EXTENSIONS.has(ext)
}

/** Human-friendly description of why a file is unsupported. */
export function describeUnsupportedFile(file: { name: string }): string {
  if (isArchiveFile(file)) {
    return `${file.name} 是压缩包，暂不支持，请解压后上传文件或图片`
  }
  return `${file.name} 暂不支持（仅支持图片或文本文件）`
}

/**
 * Build a concise error message for a list of unsupported files.
 * Prefers naming the first archive when present, since archives are the
 * most common user mistake.
 */
export function formatUnsupportedFiles(files: { name: string }[]): string {
  if (files.length === 0) return ''
  const first = files[0]!
  if (files.length === 1) return describeUnsupportedFile(first)
  const archives = files.filter(isArchiveFile)
  if (archives.length > 0) {
    const rest = files.length - archives.length
    if (rest === 0) {
      return `${archives[0]!.name} 等 ${archives.length} 个压缩包暂不支持，请解压后上传`
    }
    return `${archives[0]!.name} 等 ${files.length} 个文件暂不支持（压缩包请解压后上传）`
  }
  return `${first.name} 等 ${files.length} 个文件暂不支持（仅支持图片或文本文件）`
}
