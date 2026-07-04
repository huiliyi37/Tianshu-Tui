/**
 * GitHub CLI (gh) integration — wraps `gh` commands for PR operations.
 * All calls are best-effort: returns null when `gh` is not installed or not
 * authenticated, so the desktop can gracefully degrade.
 */
import { spawnHidden } from '../tools/spawn-hidden.js'

export interface PrSummary {
  number: number
  title: string
  state: string
  url: string
  headRefName: string
  author: string
  createdAt: string
  updatedAt: string
  additions: number
  deletions: number
  reviewDecision: string
  isDraft: boolean
}

export interface PrDetail extends PrSummary {
  body: string
  comments: PrComment[]
  files: PrFile[]
}

export interface PrComment {
  author: string
  body: string
  createdAt: string
  path?: string
  line?: number
}

export interface PrFile {
  path: string
  additions: number
  deletions: number
  status: string
}

/** A pending inline review comment anchored to a diff line. */
export interface PrReviewComment {
  path: string
  /** Diff line number to anchor on. RIGHT → new-side line; LEFT → old-side line. */
  oldLine?: number
  newLine?: number
  body: string
}

/** Input for submitting a PR review (verdict + summary + inline comments). */
export interface PrReviewInput {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body: string
  comments: PrReviewComment[]
}

/** GitHub reviews API payload shape (POST /pulls/:n/reviews). */
export interface GithubReviewPayload {
  event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT'
  body?: string
  comments?: { path: string; line: number; side: 'LEFT' | 'RIGHT'; body: string }[]
}

/** Result of a write-capable gh invocation (stderr surfaced for the UI). */
export interface GhResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
}

const TIMEOUT_MS = 15_000

async function runGh(args: string[], cwd: string): Promise<string | null> {
  const res = await runGhCapture(args, cwd)
  return res.ok ? res.stdout : null
}

/**
 * Run `gh` capturing stdout+stderr+exit code, with optional stdin input.
 * Unlike {@link runGh} (which drops stderr and collapses failures to null),
 * this surfaces gh's error message so write operations can report why they
 * failed. `input` is piped to stdin then closed (for `gh api --input -`).
 */
export async function runGhCapture(args: string[], cwd: string, input?: string): Promise<GhResult> {
  return new Promise((resolve) => {
    const child = spawnHidden('gh', args, {
      cwd,
      stdio: [input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout?.on('data', (d: Buffer) => out.push(d))
    child.stderr?.on('data', (d: Buffer) => err.push(d))
    child.on('error', (e) => resolve({ ok: false, stdout: '', stderr: String(e), code: null }))
    child.on('close', (code) => {
      resolve({
        ok: code === 0,
        stdout: Buffer.concat(out).toString('utf-8'),
        stderr: Buffer.concat(err).toString('utf-8'),
        code,
      })
    })
    if (input !== undefined) {
      child.stdin?.end(input)
    }
  })
}

export async function listPrs(cwd: string, limit = 10): Promise<PrSummary[] | null> {
  const fields = 'number,title,state,url,headRefName,author,createdAt,updatedAt,additions,deletions,reviewDecision,isDraft'
  const raw = await runGh(['pr', 'list', '--json', fields, '--limit', String(limit)], cwd)
  if (!raw) return null
  try {
    const arr = JSON.parse(raw) as Record<string, unknown>[]
    return arr.map(p => ({
      number: Number(p.number),
      title: String(p.title ?? ''),
      state: String(p.state ?? ''),
      url: String(p.url ?? ''),
      headRefName: String(p.headRefName ?? ''),
      author: typeof p.author === 'object' && p.author ? String((p.author as Record<string, unknown>).login ?? '') : '',
      createdAt: String(p.createdAt ?? ''),
      updatedAt: String(p.updatedAt ?? ''),
      additions: Number(p.additions ?? 0),
      deletions: Number(p.deletions ?? 0),
      reviewDecision: String(p.reviewDecision ?? ''),
      isDraft: Boolean(p.isDraft),
    }))
  } catch {
    return null
  }
}

export async function getPrDetail(cwd: string, number: number): Promise<PrDetail | null> {
  const fields = 'number,title,state,url,headRefName,author,createdAt,updatedAt,additions,deletions,reviewDecision,isDraft,body'
  const raw = await runGh(['pr', 'view', String(number), '--json', fields], cwd)
  if (!raw) return null
  try {
    const p = JSON.parse(raw) as Record<string, unknown>
    const summary: PrDetail = {
      number: Number(p.number),
      title: String(p.title ?? ''),
      state: String(p.state ?? ''),
      url: String(p.url ?? ''),
      headRefName: String(p.headRefName ?? ''),
      author: typeof p.author === 'object' && p.author ? String((p.author as Record<string, unknown>).login ?? '') : '',
      createdAt: String(p.createdAt ?? ''),
      updatedAt: String(p.updatedAt ?? ''),
      additions: Number(p.additions ?? 0),
      deletions: Number(p.deletions ?? 0),
      reviewDecision: String(p.reviewDecision ?? ''),
      isDraft: Boolean(p.isDraft),
      body: String(p.body ?? ''),
      comments: [],
      files: [],
    }

    const commentsRaw = await runGh(['pr', 'view', String(number), '--json', 'comments,reviews'], cwd)
    if (commentsRaw) {
      try {
        const cd = JSON.parse(commentsRaw) as Record<string, unknown>
        const comments = Array.isArray(cd.comments) ? cd.comments : []
        const reviews = Array.isArray(cd.reviews) ? cd.reviews : []
        for (const c of [...comments, ...reviews] as Record<string, unknown>[]) {
          // Skip empty review shells (e.g. an APPROVE with no summary body).
          const body = String(c.body ?? '')
          if (!body) continue
          summary.comments.push({
            author: typeof c.author === 'object' && c.author ? String((c.author as Record<string, unknown>).login ?? '') : '',
            body,
            createdAt: String(c.createdAt ?? ''),
          })
        }
      } catch { /* ignore */ }
    }

    // Inline review comments (path/line) are not exposed by `gh pr view --json`,
    // so pull them from the review-comments API endpoint and merge in.
    const inline = await getPrReviewComments(cwd, number)
    if (inline) summary.comments.push(...inline)

    // Accurate per-file counts + status from the files API (name-only dropped them).
    const filesRaw = await runGh(['pr', 'view', String(number), '--json', 'files'], cwd)
    if (filesRaw) {
      try {
        const fd = JSON.parse(filesRaw) as Record<string, unknown>
        const files = Array.isArray(fd.files) ? (fd.files as Record<string, unknown>[]) : []
        for (const f of files) {
          const path = String(f.path ?? '')
          if (!path) continue
          summary.files.push({
            path,
            additions: Number(f.additions ?? 0),
            deletions: Number(f.deletions ?? 0),
            status: String(f.status ?? 'modified'),
          })
        }
      } catch { /* ignore */ }
    }

    return summary
  } catch {
    return null
  }
}

/** Full unified diff for a PR (`gh pr diff <n>`). Null when gh unavailable. */
export async function getPrDiff(cwd: string, number: number): Promise<string | null> {
  return runGh(['pr', 'diff', String(number)], cwd)
}

/**
 * Inline review comments (path + line) via the review-comments API endpoint.
 * `gh pr view --json` only exposes top-level comment/review bodies, so this
 * recovers the per-line threads that would otherwise be dropped.
 */
export async function getPrReviewComments(cwd: string, number: number): Promise<PrComment[] | null> {
  const raw = await runGh(['api', `repos/{owner}/{repo}/pulls/${number}/comments`, '--paginate'], cwd)
  if (!raw) return null
  try {
    const arr = JSON.parse(raw) as Record<string, unknown>[]
    if (!Array.isArray(arr)) return []
    return arr.map(c => ({
      author: typeof c.user === 'object' && c.user ? String((c.user as Record<string, unknown>).login ?? '') : '',
      body: String(c.body ?? ''),
      createdAt: String(c.created_at ?? ''),
      path: c.path ? String(c.path) : undefined,
      // `line` is the new-side line; fall back to original_line for outdated threads.
      line: c.line != null ? Number(c.line) : (c.original_line != null ? Number(c.original_line) : undefined),
    })).filter(c => c.body)
  } catch {
    return null
  }
}

/**
 * Map a review verdict + inline comments to the GitHub reviews API payload.
 * Pure (no IO) so it can be unit-tested. Comments without any usable line
 * anchor are dropped (the API rejects comments missing path+line). New-side
 * lines map to RIGHT, deletions (old-side only) map to LEFT.
 */
export function buildReviewPayload(input: PrReviewInput): GithubReviewPayload {
  const payload: GithubReviewPayload = { event: input.event }
  const body = input.body?.trim()
  if (body) payload.body = body
  const comments = (input.comments ?? [])
    .map((c) => {
      const side: 'LEFT' | 'RIGHT' = c.newLine != null ? 'RIGHT' : 'LEFT'
      const line = c.newLine != null ? c.newLine : c.oldLine
      if (!c.path || line == null || !c.body?.trim()) return null
      return { path: c.path, line, side, body: c.body.trim() }
    })
    .filter((c): c is NonNullable<typeof c> => c !== null)
  if (comments.length > 0) payload.comments = comments
  return payload
}

/**
 * Submit a PR review (verdict + summary + inline comments) as one GitHub review
 * via `gh api --method POST .../reviews --input -` (JSON piped over stdin;
 * gh fills {owner}/{repo} from the cwd repo). Returns gh's result so the caller
 * can surface stderr on failure.
 */
export async function submitPrReview(cwd: string, number: number, input: PrReviewInput): Promise<GhResult> {
  const payload = buildReviewPayload(input)
  return runGhCapture(
    ['api', '--method', 'POST', `repos/{owner}/{repo}/pulls/${number}/reviews`, '--input', '-'],
    cwd,
    JSON.stringify(payload),
  )
}

export async function isGhAvailable(cwd: string): Promise<boolean> {
  const result = await runGh(['auth', 'status'], cwd)
  return result !== null
}

export interface CreatePrResult {
  ok: boolean
  /** PR URL on success. */
  url?: string
  error?: string
}

/**
 * Create a PR from the current branch of `cwd` via `gh pr create`. The branch
 * must already be pushed (the caller handles `git push -u`). Without a title,
 * `--fill` derives title/body from the commits.
 */
export async function createPr(
  cwd: string,
  opts: { title?: string; body?: string; draft?: boolean } = {},
): Promise<CreatePrResult> {
  const args = ['pr', 'create']
  if (opts.title?.trim()) {
    args.push('--title', opts.title.trim(), '--body', opts.body ?? '')
  } else {
    args.push('--fill')
  }
  if (opts.draft) args.push('--draft')
  const res = await runGhCapture(args, cwd)
  if (!res.ok) return { ok: false, error: (res.stderr || res.stdout).trim() || 'gh pr create failed' }
  // gh prints the PR URL as the last stdout line.
  const url = res.stdout.split('\n').map(l => l.trim()).filter(l => l.startsWith('https://')).pop()
  return { ok: true, url }
}
