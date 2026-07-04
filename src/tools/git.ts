import { spawn } from 'node:child_process'
import { readFile as fsReadFile, stat as fsStat } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import type { Tool, ToolCallParams } from './types.js'
import { auditCommitTagScope } from './commit-audit.js'
import { createWorkspaceGuard } from '../agent/workspace-guard.js'
import { killProcessTree } from './process-kill.js'
import { WinStreamDecoder } from '../platform.js'
import { getResolvedEnv } from './resolved-env.js'

const ACTIONS = ['status', 'diff_summary', 'commit', 'log', 'log_graph', 'stash', 'stash_pop'] as const
type GitAction = (typeof ACTIONS)[number]

const MAX_OUTPUT = 50_000
const GIT_TIMEOUT = 10_000
const FORCE_KILL_DELAY = 3_000

/**
 * Run a git command asynchronously with proper process cleanup on timeout.
 *
 * Uses spawn with detached:true + process-group kill (-pid) to ensure
 * the entire git process tree is killed on timeout — prevents zombie
 * processes that would otherwise accumulate and eventually freeze the TUI.
 */
async function runGit(args: string[], cwd: string, abortSignal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, {
      cwd,
      // Resolve the real PATH so `git` is found even under a GUI-launched minimal
      // env (Explorer/Finder/Dock) — same fix the bash tool uses.
      env: getResolvedEnv(cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
      // detached: true breaks stdio pipes on Windows — see bash.ts fix for details.
      detached: process.platform !== 'win32',
    })

    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null

    const cleanup = () => {
      if (timer) clearTimeout(timer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
    }

    const finish = (output: string, error?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (error) reject(error)
      else resolve(output)
    }

    // 用户中止：协作式取消，沿袭 bash.ts 的 killProcessTree 两级终止模式。
    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      killProcessTree(child, 'SIGTERM')
      forceKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), FORCE_KILL_DELAY)
      resolve('Aborted by user.')
    }
    if (abortSignal) {
      if (abortSignal.aborted) { onAbort(); return }
      abortSignal.addEventListener('abort', onAbort, { once: true })
    }

    const stdoutDecoder = new WinStreamDecoder()
    const stderrDecoder = new WinStreamDecoder()

    child.stdout!.on('data', (data: Buffer) => { stdout += stdoutDecoder.write(data) })
    child.stderr!.on('data', (data: Buffer) => { stderr += stderrDecoder.write(data) })

    child.on('close', (code) => {
      if (settled) return
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      stdout += stdoutDecoder.end()
      stderr += stderrDecoder.end()
      if (code !== 0) {
        const err = new Error((stderr || '').trim() || `git exited with status ${code}`)
        const gitErr = err as GitExitError
        gitErr.exitCode = code ?? 1
        // Preserve stdout even on non-zero exit — `git diff --no-index` exits 1
        // when files differ but prints the diff on stdout. Callers that need it
        // (getFileDiff fallback) read err.stdout via runGitExitCode.
        gitErr.stdout = stdout
        finish('', err)
      } else {
        let output = stdout
        if (output.length > MAX_OUTPUT) {
          output = output.slice(0, MAX_OUTPUT) + `\n\n[... truncated at ${MAX_OUTPUT} chars, total ${output.length}]`
        }
        finish(output)
      }
    })

    child.on('error', (err) => {
      if (settled) return
      if (abortSignal) abortSignal.removeEventListener('abort', onAbort)
      finish('', err)
    })

    // Timeout: SIGTERM first, then SIGKILL after FORCE_KILL_DELAY
    timer = setTimeout(() => {
      killProcessTree(child, 'SIGTERM')
      forceKillTimer = setTimeout(() => {
        killProcessTree(child, 'SIGKILL')
        finish('', new Error('git command timed out'))
      }, FORCE_KILL_DELAY)
    }, GIT_TIMEOUT)
  })
}

interface GitExitError extends Error { exitCode: number; stdout?: string }

/** runGit variant that returns exit code instead of throwing — for callers that need to distinguish exit codes.
 *  stdout is preserved on non-zero exit (e.g. `git diff --no-index` exits 1 with the diff on stdout). */
async function runGitExitCode(args: string[], cwd: string, abortSignal?: AbortSignal): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const stdout = await runGit(args, cwd, abortSignal)
    return { code: 0, stdout, stderr: '' }
  } catch (err) {
    const gitErr = err as GitExitError
    if (gitErr.exitCode !== undefined) return { code: gitErr.exitCode, stdout: gitErr.stdout ?? '', stderr: gitErr.message }
    throw err // non-exit errors (spawn failure, timeout) still throw
  }
}

/** runGit that returns {ok, output} instead of throwing — for callers that need error detail. */
async function runGitSafe(args: string[], cwd: string, abortSignal?: AbortSignal): Promise<{ ok: boolean; output: string }> {
  try {
    const output = await runGit(args, cwd, abortSignal)
    return { ok: true, output }
  } catch (err) {
    const output = err instanceof Error ? err.message : String(err)
    return { ok: false, output }
  }
}

function normalizeProjectRelativePath(cwd: string, filePath: string): string | null {
  const resolved = resolve(cwd, filePath)
  const rel = relative(cwd, resolved)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel
}

function getScopedCommitFiles(cwd: string, ownedFiles: string[] | undefined, sessionModifiedFiles: string[] | undefined): string[] {
  // B1: prefer ownedFiles (post-baseline) over sessionModifiedFiles (pre-baseline)
  const source = (ownedFiles?.length ? ownedFiles : sessionModifiedFiles) ?? []
  if (!source.length) return []
  const files = source
    .map(filePath => normalizeProjectRelativePath(cwd, filePath))
    .filter((filePath): filePath is string => filePath !== null)
  return [...new Set(files)].sort((a, b) => a.localeCompare(b))
}

async function hasStagedChanges(cwd: string, pathspecs?: string[], abortSignal?: AbortSignal): Promise<boolean> {
  const args = ['diff', '--cached', '--quiet']
  if (pathspecs?.length) args.push('--', ...pathspecs)
  const { code } = await runGitExitCode(args, cwd, abortSignal)
  if (code === 0) return false // no staged changes
  if (code === 1) return true  // has staged changes
  throw new Error(`git diff --cached failed with exit code ${code}`)
}

/** Best-effort: create a safety ref before stash so changes are recoverable (P2). */
async function createSafetyRef(cwd: string, abortSignal?: AbortSignal): Promise<void> {
  try {
    const sha = (await runGit(['stash', 'create'], cwd, abortSignal)).trim()
    if (!sha) return
    await runGit(['update-ref', 'refs/kiro-safety/last-stash', sha], cwd, abortSignal)
  } catch { /* best-effort, never block stash */ }
}

/** Run `git log --graph --all --oneline --decorate` for the desktop Git graph view. */
export async function getGitGraph(cwd: string, maxCount = 200): Promise<string> {
  const count = Math.max(1, Math.min(maxCount, 500))
  return runGit(
    ['log', `--max-count=${count}`, '--graph', '--all', '--oneline', '--decorate', '--branches', '--remotes'],
    cwd,
  )
}

/** A single file's working-tree change relative to HEAD. */
export interface WorkingTreeFile {
  path: string
  status: 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked'
  additions: number
  deletions: number
}

/** Parse `git diff HEAD --numstat` (+ untracked via status) into a file list.
 *  numstat gives "added\tdelted\tpath" per file; renames show as "R100\told\tnew". */
function parseWorkingTreeFiles(numstat: string, statusPorcelain: string): WorkingTreeFile[] {
  const files = new Map<string, WorkingTreeFile>()
  // numstat covers tracked changes (modified/added-to-index/deleted/rename)
  for (const line of numstat.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 3) continue
    const [addStr, delStr, ...pathParts] = parts
    const path = pathParts.join('\t') // paths with tabs are pathological but safe
    // Binary files show as "-\t-\t..." — count as 0 to avoid NaN
    const additions = addStr === '-' ? 0 : parseInt(addStr!, 10) || 0
    const deletions = delStr === '-' ? 0 : parseInt(delStr!, 10) || 0
    files.set(path, { path, status: 'modified', additions, deletions })
  }
  // porcelain covers untracked (??) + precise status codes
  for (const line of statusPorcelain.split('\n')) {
    if (line.length < 3) continue
    const xy = line.slice(0, 2)
    let rawPath = line.slice(3)
    // rename: "R  old -> new" — porcelain prints the new path with a ->
    if (rawPath.includes(' -> ')) rawPath = rawPath.split(' -> ').pop()!
    // strip surrounding quotes (core.quotepath)
    if (rawPath.startsWith('"') && rawPath.endsWith('"')) rawPath = rawPath.slice(1, -1)
    const existing = files.get(rawPath)
    if (xy[1] === '?' || xy === '??') {
      // untracked — not in numstat; add with 0/0, status untracked
      if (!existing) files.set(rawPath, { path: rawPath, status: 'untracked', additions: 0, deletions: 0 })
    } else if (existing) {
      // refine status from porcelain xy code
      const code = xy[0] !== ' ' ? xy[0] : xy[1]
      existing.status =
        code === 'A' ? 'added'
        : code === 'D' ? 'deleted'
        : code === 'R' ? 'renamed'
        : 'modified'
    }
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * List working-tree changes relative to `baseRef` (default HEAD) for the
 * desktop "changes" tab.
 * Uses `git diff <base> --numstat` (tracked) + `git status --porcelain` (untracked + status codes).
 * Lightweight: file list only, no diff body — the body is fetched per-file on demand via getFileDiff.
 * Returns `notARepo: true` (empty files) if cwd isn't a git repo, so the UI can degrade gracefully.
 *
 * Worktree sessions pass their recorded baseline commit as baseRef so the tab
 * shows the full task delta even after the agent commits mid-task.
 */
export async function getWorkingTreeFiles(cwd: string, baseRef = 'HEAD'): Promise<{ files: WorkingTreeFile[]; isRepo: boolean }> {
  const base = safeBaseRef(baseRef)
  const { ok: numstatOk, output: numstat } = await runGitSafe(['diff', base, '--numstat'], cwd)
  // git diff <base> fails if the ref doesn't exist (empty repo) — treat as "no tracked diff yet"
  const { ok: statusOk, output: statusOut } = await runGitSafe(['status', '--porcelain', '-uall'], cwd)
  if (!statusOk && !numstatOk) {
    // Both failed — likely not a git repo
    return { files: [], isRepo: false }
  }
  const files = parseWorkingTreeFiles(numstatOk ? numstat : '', statusOk ? statusOut : '')
  // Untracked files aren't in `git diff HEAD --numstat`, so their +N badge would
  // read 0. Backfill the addition count by reading the file and counting lines
  // (cheap, no spawn). Skip oversized/binary/unreadable files — badge stays 0.
  await backfillUntrackedAdditions(cwd, files)
  return { files, isRepo: true }
}

/** Max bytes to read when counting lines of an untracked file for its +N badge. */
const UNTRACKED_COUNT_MAX_BYTES = 1_000_000

async function backfillUntrackedAdditions(cwd: string, files: WorkingTreeFile[]): Promise<void> {
  await Promise.all(
    files
      .filter((f) => f.status === 'untracked' && f.additions === 0)
      .map(async (f) => {
        const rel = normalizeProjectRelativePath(cwd, f.path)
        if (!rel) return
        try {
          const stat = await fsStat(resolve(cwd, rel))
          if (!stat.isFile() || stat.size > UNTRACKED_COUNT_MAX_BYTES) return
          const content = await fsReadFile(resolve(cwd, rel), 'utf8')
          if (content.includes('\u0000')) return // binary — leave badge at 0
          if (content.length === 0) return
          // Count lines like git: a trailing newline doesn't add an empty line.
          const nl = (content.match(/\n/g) ?? []).length
          f.additions = content.endsWith('\n') ? nl : nl + 1
        } catch {
          // unreadable — leave badge at 0
        }
      }),
  )
}

/**
 * Reject base refs that could be parsed as git options or revision ranges.
 * Accepts commit hashes, HEAD, and simple branch/tag names.
 */
function safeBaseRef(ref: string): string {
  const trimmed = ref.trim()
  if (!trimmed || trimmed.startsWith('-') || /[\s~^:.\\]/.test(trimmed)) return 'HEAD'
  return trimmed
}

/**
 * Fetch the unified diff of a single file relative to `baseRef` (default
 * HEAD), for on-demand rendering in the desktop "changes" tab. Empty string =
 * no textual diff (binary file, or untracked with no base to diff against).
 */
export async function getFileDiff(cwd: string, path: string, baseRef = 'HEAD'): Promise<string> {
  // Guard against path traversal / pathspec injection — pathspec must be relative
  const rel = normalizeProjectRelativePath(cwd, path)
  if (!rel) throw new Error(`Invalid file path: ${path}`)
  const base = safeBaseRef(baseRef)
  // Tracked changes (modified/deleted/staged) diff cleanly against the base.
  const tracked = await runGitSafe(['diff', base, '--', rel], cwd)
  if (tracked.ok && tracked.output.trim()) return tracked.output
  // New / untracked file: not in HEAD, so `git diff HEAD` is empty. Render the
  // whole file as additions via --no-index against /dev/null. This exits 1 when
  // the files differ (the normal case) but prints the diff on stdout, which
  // runGitExitCode preserves. Binary files print "Binary files ... differ".
  const fallback = await runGitExitCode(['diff', '--no-index', '--', '/dev/null', rel], cwd)
  const out = fallback.stdout
  if (out && out.trim()) return normalizeNoIndexHeader(out, rel)
  return tracked.ok ? tracked.output : ''
}

/**
 * `git diff --no-index /dev/null file` emits headers referencing the literal
 * paths ("/dev/null" and the file path without a/ b/ prefixes). Rewrite the
 * `+++` header to the conventional `b/<rel>` form so the desktop diff parser
 * (which strips a leading `b/`) anchors line comments on the right file path.
 */
function normalizeNoIndexHeader(diff: string, rel: string): string {
  return diff
    .split('\n')
    .map((line) => {
      if (line.startsWith('+++ ')) return `+++ b/${rel}`
      if (line.startsWith('--- ')) return '--- /dev/null'
      return line
    })
    .join('\n')
}


export const GIT_TOOL: Tool = {
  definition: {
    name: 'git',
    description: `Structured git operations. Actions:
- status: Show working tree status, current branch, and file changes
- diff_summary: Show diff stats for staged and unstaged changes
- commit: Commit only this session's modified files when available; otherwise commit already staged changes only
- log: Show recent commit history (default 20, configurable with maxCount)
- log_graph: Show ASCII branch/merge graph across all local and remote refs
- stash: Stash current working directory changes

For complex git operations (branch, merge, rebase, push, pull), use the bash tool instead.`,
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...ACTIONS],
          description: 'The git operation to perform',
        },
        message: {
          type: 'string',
          description: 'Commit message (required for commit action)',
        },
        maxCount: {
          type: 'number',
          description: 'Maximum number of log entries (default 20, for log action)',
        },
      },
      required: ['action'],
    },
  },

  async execute(params: ToolCallParams) {
    const action = params.input.action as GitAction
    const cwd = params.cwd

    if (!ACTIONS.includes(action)) {
      return { content: `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`, isError: true }
    }

    try {
      switch (action) {
        case 'status': {
          const [branch, porcelain, untracked] = await Promise.all([
            runGit(['branch', '--show-current'], cwd, params.abortSignal),
            runGit(['status', '--porcelain'], cwd, params.abortSignal),
            runGit(['ls-files', '--others', '--exclude-standard'], cwd, params.abortSignal),
          ])
          const lines = [`Branch: ${branch.trim()}`]
          const porcelainTrimmed = porcelain.trim()
          if (!porcelainTrimmed) {
            lines.push('Status: clean')
          } else {
            lines.push('Changes:', porcelainTrimmed)
          }
          const untrackedTrimmed = untracked.trim()
          if (untrackedTrimmed) {
            lines.push('Untracked:', untrackedTrimmed)
          }
          return { content: lines.join('\n') }
        }

        case 'diff_summary': {
          const [staged, unstaged] = await Promise.all([
            runGit(['diff', '--cached', '--stat'], cwd, params.abortSignal),
            runGit(['diff', '--stat'], cwd, params.abortSignal),
          ])
          const lines: string[] = []
          const stagedTrimmed = staged.trim()
          const unstagedTrimmed = unstaged.trim()
          if (stagedTrimmed) lines.push('Staged:', stagedTrimmed)
          if (unstagedTrimmed) lines.push('Unstaged:', unstagedTrimmed)
          if (!stagedTrimmed && !unstagedTrimmed) lines.push('No changes.')
          return { content: lines.join('\n') }
        }

        case 'commit': {
          const message = params.input.message as string
          if (!message) {
            return { content: 'Commit requires a "message" parameter.', isError: true }
          }

          const scopedFiles = getScopedCommitFiles(cwd, params.ownedFiles, params.sessionModifiedFiles)
          const commitArgs = ['commit', '-m', message]
          if (scopedFiles.length > 0) {
            await runGit(['add', '--', ...scopedFiles], cwd, params.abortSignal)
            commitArgs.push('--only', '--', ...scopedFiles)
          } else if (!(await hasStagedChanges(cwd, undefined, params.abortSignal))) {
            return {
              content: 'No session-owned files were provided to git commit and no staged changes exist. Use deliver_task with commit=true for ownership-scoped delivery, or stage explicit files if you intentionally manage git manually.',
              isError: true,
            }
          }

          const commitResult = await runGitSafe(commitArgs, cwd, params.abortSignal)
          if (!commitResult.ok) {
            return { content: `git commit failed: ${commitResult.output}`, isError: true }
          }

          // Post-commit truth readback: show actual landed changes + audit tag scope
          const changed = (await runGit(['show', '--stat', '--format=%h%d', 'HEAD'], cwd, params.abortSignal)).trim()
          // --stat file rows contain '|'; this excludes the %h%d header line and the summary line
          const changedFiles = changed.split('\n')
            .filter(l => l.includes('|'))
            .map(l => l.split('|')[0]!.trim())
            .filter(f => f.length > 0)
          const audit = auditCommitTagScope(message, changedFiles)
          const body = `${commitResult.output.trim()}\n\n--- actual changes (git show --stat) ---\n${changed}`
          return { content: audit.ok ? body : `${body}\n\n${audit.message}` }
        }

        case 'log': {
          const maxCount = Math.max(1, Math.min((params.input.maxCount as number) ?? 20, 100))
          const log = (await runGit(['log', `--max-count=${maxCount}`, '--oneline', '--decorate'], cwd, params.abortSignal)).trim()
          return { content: log || 'No commits yet.' }
        }

        case 'log_graph': {
          const maxCount = Math.max(1, Math.min((params.input.maxCount as number) ?? 200, 500))
          const graph = (
            await runGit(
              [
                'log',
                `--max-count=${maxCount}`,
                '--graph',
                '--all',
                '--oneline',
                '--decorate',
                '--branches',
                '--remotes',
              ],
              cwd,
              params.abortSignal,
            )
          ).trimEnd()
          return { content: graph || 'No commits yet.' }
        }

        case 'stash': {
          const stashStatus = (await runGit(['status', '--porcelain'], cwd, params.abortSignal)).trim()
          if (!stashStatus) {
            return { content: 'No changes to stash.' }
          }

          // B1: scope stash to owned files when available
          if (params.ownedFiles?.length) {
            const scoped = getScopedCommitFiles(cwd, params.ownedFiles, params.sessionModifiedFiles)
            if (scoped.length === 0) {
              return {
                content: 'No owned files to stash. External dirty files are present but excluded from stash scope.',
                isError: true,
              }
            }
            await createSafetyRef(cwd, params.abortSignal)
            await runGit(['stash', 'push', '--', ...scoped], cwd, params.abortSignal)
            return { content: `Stashed ${scoped.length} owned file(s): ${scoped.join(', ')}` }
          }

          await createSafetyRef(cwd, params.abortSignal)
          await runGit(['stash'], cwd, params.abortSignal)
          return { content: 'Saved working directory and index state.' }
        }

        case 'stash_pop': {
          const stashRef = (params.input.stashRef as string) || 'stash@{0}'
          const safety = await createWorkspaceGuard(cwd).checkStashSafety(stashRef)
          if (safety.blocked) {
            return { content: safety.reasons.join('\n'), isError: true }
          }
          await runGit(['stash', 'pop', stashRef], cwd, params.abortSignal)
          return { content: `Popped ${stashRef} (safety-checked: no overwriting conflicts).` }
        }

        default:
          return { content: `Unknown action: ${action}. Supported: ${ACTIONS.join(', ')}`, isError: true }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `git ${action} failed: ${message}`, isError: true }
    }
  },

  requiresApproval(params: ToolCallParams): boolean {
    return (params.input.action as string) === 'commit'
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
