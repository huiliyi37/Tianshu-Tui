import { existsSync, statSync, symlinkSync, mkdirSync, cpSync, readFileSync, rmSync, lstatSync, readdirSync, writeFileSync } from 'fs'
import { basename, join, resolve, relative, extname } from 'path'
import { execFileSync } from 'child_process'
import type { Tool, ToolCallParams } from './types.js'
import { expandHome } from '../platform.js'

const IMPORT_DIR = '.rivet/external'
const PREVIEW_BYTES = 4000

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.jsonl', '.json5',
  '.md', '.mdx', '.txt', '.rst', '.adoc',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.scala', '.c', '.cpp', '.h', '.hpp',
  '.sh', '.bash', '.zsh', '.fish',
  '.css', '.scss', '.less', '.html', '.htm', '.svg',
  '.xml', '.csv', '.tsv',
  '.sql', '.graphql', '.proto',
  '.lock', '.log',
  '.patch', '.diff',
])

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico'])

function isTextFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) return true
  const name = basename(filePath).toLowerCase()
  return ['makefile', 'dockerfile', 'license', 'readme', 'changelog', '.gitignore', '.npmrc'].includes(name)
}

function isImageFile(filePath: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(filePath).toLowerCase())
}

/** Parse a GitHub URL into owner/repo and optional subpath. */
export function parseGitHubUrl(url: string): { owner: string; repo: string; subpath?: string; ref?: string } | null {
  const cleaned = url.replace(/^https?:\/\//, '').replace(/\.git$/, '')
  const match = cleaned.match(/^github\.com\/([^/]+)\/([^/]+?)(?:\/(tree|blob)\/([^/]+)(?:\/(.*))?)?$/)
  if (!match) return null
  const [, owner, repo, , ref, subpath] = match
  if (!owner || !repo) return null
  return { owner, repo, ref: ref ?? undefined, subpath: subpath || undefined }
}

function ensureImportDir(cwd: string): string {
  const dir = join(cwd, IMPORT_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

function simpleHash(str: string): number {
  let h = 0
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** Generate target name preserving file extension: `name-hash.ext` */
function importTargetName(source: string): string {
  const raw = basename(source).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 40)
  const ext = extname(raw)
  const base = ext ? raw.slice(0, -ext.length) : raw
  const hash = simpleHash(source).toString(36)
  return ext ? `${base}-${hash}${ext}` : `${raw}-${hash}`
}

function buildResult(
  source: string,
  localPath: string,
  cwd: string,
  stats: { type: 'file' | 'directory'; size?: number; files?: number },
): { content: string; uiContent: string } {
  const relPath = relative(cwd, localPath)
  let header = `Imported: ${source}\nLocal: ${relPath}\nType: ${stats.type}`
  if (stats.size !== undefined) header += `\nSize: ${(stats.size / 1024).toFixed(1)} KB`
  if (stats.files !== undefined) header += `\nFiles: ~${stats.files}`

  let preview = ''
  if (stats.type === 'file' && isTextFile(localPath)) {
    try {
      const content = readFileSync(localPath, 'utf-8')
      preview = content.length > PREVIEW_BYTES
        ? `\n\n── Preview (first ${PREVIEW_BYTES} chars) ──\n${content.slice(0, PREVIEW_BYTES)}\n... (${content.length} total chars)`
        : `\n\n── Content ──\n${content}`
    } catch { /* binary / unreadable */ }
  } else if (stats.type === 'file' && isImageFile(localPath)) {
    preview = '\n\n(Image file — imported but not viewable as text. Use file_info for metadata.)'
  }

  return {
    uiContent: header + preview,
    content: `${header}${preview}\n\nThis resource is now accessible at project-local path: ${relPath}\nUse read_file, grep, glob with this path.`,
  }
}

export const IMPORT_RESOURCE_TOOL: Tool = {
  definition: {
    name: 'import_resource',
    description:
      'Import external resources into the project workspace so other tools can access them.' +
      '\n\nSupports:' +
      '\n- Local file paths (absolute): /tmp/design.png, ~/Desktop/spec.pdf' +
      '\n- Local directories: /path/to/external/project' +
      '\n- GitHub repos: github.com/user/repo, https://github.com/user/repo' +
      '\n- HTTP/HTTPS URLs: downloads the content' +
      '\n\nAfter import, the resource is available at a project-local path under .rivet/external/.' +
      '\nOther tools (read_file, grep, glob) can then access it normally.' +
      '\nRequires approval since it accesses resources outside the project.',
    input_schema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description: 'The resource to import. Can be an absolute local path, a GitHub URL, or an HTTP/HTTPS URL.',
        },
        ref: {
          type: 'string',
          description: 'For GitHub repos: branch, tag, or commit to checkout. Defaults to the default branch.',
        },
      },
      required: ['source'],
    },
  },

  async execute(params: ToolCallParams) {
    const rawSource = (params.input.source as string)?.trim()
    if (!rawSource) return { content: 'Error: source is required', isError: true }

    const importDir = ensureImportDir(params.cwd)

    const gh = parseGitHubUrl(rawSource)
    if (gh) return handleGitHubImport(params.cwd, importDir, gh, params.input.ref as string | undefined)

    if (/^https?:\/\//i.test(rawSource)) return await handleUrlImport(params.cwd, importDir, rawSource)

    return handleLocalImport(params.cwd, importDir, rawSource)
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function handleLocalImport(cwd: string, importDir: string, source: string): { content: string; uiContent: string; isError?: boolean } {
  const expanded = expandHome(source)
  const resolved = resolve(expanded)

  if (!existsSync(resolved)) {
    return { content: `Error: path does not exist: ${resolved}`, isError: true, uiContent: `Not found: ${resolved}` }
  }

  const stat = lstatSync(resolved)
  const targetName = importTargetName(resolved)
  const targetPath = join(importDir, targetName)

  if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true })

  if (stat.isDirectory()) {
    symlinkSync(resolved, targetPath, 'junction')
    const result = buildResult(source, targetPath, cwd, { type: 'directory', files: countFiles(resolved, 3) })
    return { ...result, content: result.content + '\n\n(Linked as junction — no disk copy)' }
  }

  try {
    symlinkSync(resolved, targetPath, 'file')
  } catch {
    cpSync(resolved, targetPath, { force: true })
  }

  return buildResult(source, targetPath, cwd, { type: 'file', size: statSync(resolved).size })
}

function handleGitHubImport(
  cwd: string,
  importDir: string,
  gh: { owner: string; repo: string; ref?: string; subpath?: string },
  explicitRef?: string,
): { content: string; uiContent: string; isError?: boolean } {
  const ref = explicitRef ?? gh.ref
  const repoUrl = `https://github.com/${gh.owner}/${gh.repo}.git`
  const targetName = importTargetName(`${gh.owner}/${gh.repo}`)
  const targetPath = join(importDir, targetName)

  if (existsSync(join(targetPath, '.git'))) {
    try { execFileSync('git', ['pull', '--ff-only'], { cwd: targetPath, timeout: 30_000 }) } catch { /* offline */ }
  } else {
    if (existsSync(targetPath)) rmSync(targetPath, { recursive: true, force: true })
    try {
      const args = ['clone', '--depth', '1']
      if (ref) args.push('--branch', ref)
      args.push(repoUrl, targetPath)
      execFileSync('git', args, { timeout: 120_000 })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error cloning ${repoUrl}: ${msg}`, isError: true, uiContent: `Clone failed: ${gh.owner}/${gh.repo}` }
    }
  }

  if (ref && existsSync(join(targetPath, '.git'))) {
    try { execFileSync('git', ['checkout', ref], { cwd: targetPath, timeout: 10_000 }) } catch { /* shallow */ }
  }

  const effectivePath = gh.subpath ? join(targetPath, gh.subpath) : targetPath

  if (gh.subpath && !existsSync(effectivePath)) {
    return { content: `Error: subpath '${gh.subpath}' not found in ${gh.owner}/${gh.repo}`, isError: true, uiContent: `Subpath not found: ${gh.subpath}` }
  }

  const stat = existsSync(effectivePath) ? lstatSync(effectivePath) : undefined
  return buildResult(
    `github.com/${gh.owner}/${gh.repo}${gh.subpath ? `/${gh.subpath}` : ''}`,
    effectivePath,
    cwd,
    { type: stat?.isDirectory() ? 'directory' : stat?.isFile() ? 'file' : 'directory', files: countFiles(targetPath, 3) },
  )
}

async function handleUrlImport(cwd: string, importDir: string, url: string): Promise<{ content: string; uiContent: string; isError?: boolean }> {
  let filename: string
  try {
    const parsed = new URL(url)
    filename = basename(parsed.pathname) || 'downloaded-content'
  } catch { filename = 'downloaded-content' }

  const targetName = importTargetName(url) + '_' + filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const targetPath = join(importDir, targetName)

  try {
    execFileSync('curl', ['-sL', '-o', targetPath, url], { timeout: 60_000 })
  } catch (err) {
    // On Windows, curl may not be installed. Fall back to Node.js fetch.
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        const res = await fetch(url)
        if (!res.ok) {
          return { content: `Error downloading ${url}: HTTP ${res.status}`, isError: true, uiContent: `Download failed: ${url}` }
        }
        const buf = Buffer.from(await res.arrayBuffer())
        writeFileSync(targetPath, buf)
      } catch (fetchErr) {
        const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
        return { content: `Error downloading ${url}: ${msg}`, isError: true, uiContent: `Download failed: ${url}` }
      }
    } else {
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error downloading ${url}: ${msg}`, isError: true, uiContent: `Download failed: ${url}` }
    }
  }

  if (!existsSync(targetPath) || statSync(targetPath).size === 0) {
    return { content: `Error: download produced empty file from ${url}`, isError: true, uiContent: `Empty download: ${url}` }
  }

  return buildResult(url, targetPath, cwd, { type: 'file', size: statSync(targetPath).size })
}

function countFiles(dir: string, maxDepth: number): number {
  if (maxDepth <= 0) return 1
  try {
    let count = 0
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      count += entry.isDirectory() ? countFiles(join(dir, entry.name), maxDepth - 1) : 1
    }
    return count
  } catch { return 1 }
}
