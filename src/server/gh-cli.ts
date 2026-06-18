/**
 * GitHub CLI (gh) integration — wraps `gh` commands for PR operations.
 * All calls are best-effort: returns null when `gh` is not installed or not
 * authenticated, so the desktop can gracefully degrade.
 */
import { spawn } from 'node:child_process'

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

const TIMEOUT_MS = 15_000

async function runGh(args: string[], cwd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn('gh', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: TIMEOUT_MS,
    })
    const chunks: Buffer[] = []
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.on('error', () => resolve(null))
    child.on('close', (code) => {
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf-8') : null)
    })
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
          summary.comments.push({
            author: typeof c.author === 'object' && c.author ? String((c.author as Record<string, unknown>).login ?? '') : '',
            body: String(c.body ?? ''),
            createdAt: String(c.createdAt ?? ''),
          })
        }
      } catch { /* ignore */ }
    }

    const filesRaw = await runGh(['pr', 'diff', String(number), '--name-only'], cwd)
    if (filesRaw) {
      for (const line of filesRaw.trim().split('\n')) {
        if (line.trim()) {
          summary.files.push({ path: line.trim(), additions: 0, deletions: 0, status: 'modified' })
        }
      }
    }

    return summary
  } catch {
    return null
  }
}

export async function isGhAvailable(cwd: string): Promise<boolean> {
  const result = await runGh(['auth', 'status'], cwd)
  return result !== null
}
