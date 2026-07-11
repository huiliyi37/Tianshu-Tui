import { stat, lstat, symlink, mkdir, cp, readFile, rm, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve, extname } from 'path'
import { execFile } from 'child_process'
import { existsSync } from 'fs'
import type { Tool, ToolCallParams } from './types.js'
import type { ArtifactStore } from '../artifact/store.js'
import { expandHome } from '../platform.js'
import { relativePosix } from '../path-format.js'
import { httpFetchGuarded } from './net/http-fetch.js'
import { extractDocumentText, isExtractableDocument, EXTRACTION_CAVEAT } from './doc-extract.js'

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

/** Validate a git ref (branch/tag/commit) supplied by the model/URL before it
 *  reaches `git clone --branch` / `git checkout`. The refs are passed as
 *  `execFile` args (no shell), so the real risk is git *option injection*: a
 *  ref like `--upload-pack=…` would be parsed as an option. Reject anything
 *  starting with `-`, plus whitespace/control and the characters git itself
 *  forbids in ref names (`~^:?*[\`). Returns true when the ref is safe. */
export function isSafeGitRef(ref: string): boolean {
  if (ref.length === 0 || ref.length > 255) return false
  if (ref.startsWith('-')) return false
  if (/[\s\x00-\x1f\x7f~^:?*[\\]/.test(ref)) return false
  return true
}

async function ensureImportDir(cwd: string): Promise<string> {
  const dir = join(cwd, IMPORT_DIR)
  await mkdir(dir, { recursive: true })
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

async function buildResult(
  source: string,
  localPath: string,
  cwd: string,
  stats: { type: 'file' | 'directory'; size?: number; files?: number },
  artifactStore?: ArtifactStore,
): Promise<{ content: string; uiContent: string }> {
  const relPath = relativePosix(cwd, localPath)
  let header = `Imported: ${source}\nLocal: ${relPath}\nType: ${stats.type}`
  if (stats.size !== undefined) header += `\nSize: ${(stats.size / 1024).toFixed(1)} KB`
  if (stats.files !== undefined) header += `\nFiles: ~${stats.files}`

  let preview = ''
  if (stats.type === 'file' && isTextFile(localPath)) {
    try {
      const content = await readFile(localPath, 'utf-8')
      preview = content.length > PREVIEW_BYTES
        ? `\n\n── Preview (first ${PREVIEW_BYTES} chars) ──\n${content.slice(0, PREVIEW_BYTES)}\n... (${content.length} total chars)`
        : `\n\n── Content ──\n${content}`
    } catch { /* binary / unreadable */ }
  } else if (stats.type === 'file' && isExtractableDocument(localPath)) {
    // Binary office document (PDF/DOCX/PPTX/…) — extract text via system
    // toolchains so the content is usable as context, not just a blob on disk.
    // Fail-open: extraction failure keeps the import and surfaces install advice.
    const extraction = await extractDocumentText(localPath)
    if (extraction.ok) {
      const marked = `${EXTRACTION_CAVEAT}\n\n${extraction.text}`
      let artifactNote = ''
      if (artifactStore) {
        try {
          const artifactId = await artifactStore.save({
            tool: 'import_resource',
            target: source,
            rawContent: marked,
            summary: `Extracted text (${extraction.engine}) from ${basename(localPath)} — ${extraction.text.length} chars`,
            sections: [],
          })
          artifactNote = `\nFull extracted text: read_section(artifactId="${artifactId}")\n[artifact:${artifactId}]`
        } catch { /* artifact persistence is best-effort */ }
      }
      const truncated = extraction.text.length > PREVIEW_BYTES
      const body = truncated
        ? `${extraction.text.slice(0, PREVIEW_BYTES)}\n... (${extraction.text.length} total chars)`
        : extraction.text
      preview = `\n\n── Extracted text (engine: ${extraction.engine}) ──\n${EXTRACTION_CAVEAT}\n${body}${artifactNote}`
    } else {
      preview = `\n\n(Binary document imported. ${extraction.suggestion})`
    }
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

    const importDir = await ensureImportDir(params.cwd)

    const gh = parseGitHubUrl(rawSource)
    if (gh) return await handleGitHubImport(params.cwd, importDir, gh, params.input.ref as string | undefined)

    if (/^https?:\/\//i.test(rawSource)) return await handleUrlImport(params.cwd, importDir, rawSource, params.artifactStore)

    return handleLocalImport(params.cwd, importDir, rawSource, params.artifactStore)
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

async function handleLocalImport(cwd: string, importDir: string, source: string, artifactStore?: ArtifactStore): Promise<{ content: string; uiContent: string; isError?: boolean }> {
  const expanded = expandHome(source)
  const resolved = resolve(expanded)

  try {
    await lstat(resolved)
  } catch {
    return { content: `Error: path does not exist: ${resolved}`, isError: true, uiContent: `Not found: ${resolved}` }
  }

  const ls = await lstat(resolved)
  const targetName = importTargetName(resolved)
  const targetPath = join(importDir, targetName)

  try { await rm(targetPath, { recursive: true, force: true }) } catch { /* not existing is fine */ }

  if (ls.isDirectory()) {
    await symlink(resolved, targetPath, 'junction')
    const result = await buildResult(source, targetPath, cwd, { type: 'directory', files: await countFiles(resolved, 3) })
    return { ...result, content: result.content + '\n\n(Linked as junction — no disk copy)' }
  }

  try {
    await symlink(resolved, targetPath, 'file')
  } catch {
    await cp(resolved, targetPath, { force: true })
  }

  return await buildResult(source, targetPath, cwd, { type: 'file', size: (await stat(resolved)).size }, artifactStore)
}

async function handleGitHubImport(
  cwd: string,
  importDir: string,
  gh: { owner: string; repo: string; ref?: string; subpath?: string },
  explicitRef?: string,
): Promise<{ content: string; uiContent: string; isError?: boolean }> {
  const ref = explicitRef ?? gh.ref
  if (ref !== undefined && !isSafeGitRef(ref)) {
    return {
      content: `Error: invalid git ref "${ref}". A branch/tag/commit must not start with "-" or contain whitespace/control characters.`,
      isError: true,
      uiContent: `Invalid ref: ${ref}`,
    }
  }
  const repoUrl = `https://github.com/${gh.owner}/${gh.repo}.git`
  const targetName = importTargetName(`${gh.owner}/${gh.repo}`)
  const targetPath = join(importDir, targetName)

  const execAsync = (cmd: string, args: string[], opts: { cwd?: string; timeout: number }) =>
    new Promise<void>((resolveExec, reject) => {
      execFile(cmd, args, { ...opts }, (err) => err ? reject(err) : resolveExec())
    })

  if (existsSync(join(targetPath, '.git'))) {
    try { await execAsync('git', ['pull', '--ff-only'], { cwd: targetPath, timeout: 30_000 }) } catch { /* offline */ }
  } else {
    try { await rm(targetPath, { recursive: true, force: true }) } catch { /* not existing is fine */ }
    try {
      // `--` terminates option parsing before the positional repo/target args.
      const args = ['clone', '--depth', '1']
      if (ref) args.push('--branch', ref)
      args.push('--', repoUrl, targetPath)
      await execAsync('git', args, { timeout: 120_000 })
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code
      if (code === 'ENOENT') {
        return { content: `Error: git is not installed or not on PATH — cannot clone ${repoUrl}. Install git and retry.`, isError: true, uiContent: `git not found` }
      }
      const msg = err instanceof Error ? err.message : String(err)
      return { content: `Error cloning ${repoUrl}: ${msg}`, isError: true, uiContent: `Clone failed: ${gh.owner}/${gh.repo}` }
    }
  }

  if (ref && existsSync(join(targetPath, '.git'))) {
    // ref is validated (no leading `-`); trailing `--` disambiguates it from any
    // pathspec so git treats it strictly as a revision.
    try { await execAsync('git', ['checkout', ref, '--'], { cwd: targetPath, timeout: 10_000 }) } catch { /* shallow */ }
  }

  const effectivePath = gh.subpath ? join(targetPath, gh.subpath) : targetPath

  if (gh.subpath && !existsSync(effectivePath)) {
    return { content: `Error: subpath '${gh.subpath}' not found in ${gh.owner}/${gh.repo}`, isError: true, uiContent: `Subpath not found: ${gh.subpath}` }
  }

  let ls: Awaited<ReturnType<typeof lstat>> | undefined
  if (existsSync(effectivePath)) {
    try { ls = await lstat(effectivePath) } catch { /* ignore */ }
  }
  return await buildResult(
    `github.com/${gh.owner}/${gh.repo}${gh.subpath ? `/${gh.subpath}` : ''}`,
    effectivePath,
    cwd,
    { type: ls?.isDirectory() ? 'directory' : ls?.isFile() ? 'file' : 'directory', files: await countFiles(targetPath, 3) },
  )
}

async function handleUrlImport(cwd: string, importDir: string, url: string, artifactStore?: ArtifactStore): Promise<{ content: string; uiContent: string; isError?: boolean }> {
  let filename: string
  try {
    const parsed = new URL(url)
    filename = basename(parsed.pathname) || 'downloaded-content'
  } catch { filename = 'downloaded-content' }

  const targetName = importTargetName(url) + '_' + filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const targetPath = join(importDir, targetName)

  try {
    const { status, bytes } = await httpFetchGuarded(url, undefined, { timeoutMs: 60_000 })
    if (status >= 400) {
      return { content: `Error downloading ${url}: HTTP ${status}`, isError: true, uiContent: `Download failed: ${url}` }
    }
    if (bytes.length === 0) {
      return { content: `Error: download produced empty file from ${url}`, isError: true, uiContent: `Empty download: ${url}` }
    }
    await writeFile(targetPath, bytes)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { content: `Error downloading ${url}: ${msg}`, isError: true, uiContent: `Download failed: ${url}` }
  }

  let s: Awaited<ReturnType<typeof stat>>
  try {
    s = await stat(targetPath)
  } catch {
    return { content: `Error: download produced empty file from ${url}`, isError: true, uiContent: `Empty download: ${url}` }
  }
  if (s.size === 0) {
    return { content: `Error: download produced empty file from ${url}`, isError: true, uiContent: `Empty download: ${url}` }
  }

  return await buildResult(url, targetPath, cwd, { type: 'file', size: s.size }, artifactStore)
}

async function countFiles(dir: string, maxDepth: number): Promise<number> {
  if (maxDepth <= 0) return 1
  try {
    let count = 0
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue
      count += entry.isDirectory() ? await countFiles(join(dir, entry.name), maxDepth - 1) : 1
    }
    return count
  } catch { return 1 }
}
