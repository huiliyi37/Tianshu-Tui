import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

interface GitStatusCacheOptions {
  ttlMs: number
  now: () => number
  load: (cwd: string) => Promise<string | undefined>
}

export function formatGitStatus(branch: string, status: string): string | undefined {
  if (!branch && !status) return undefined
  return `Current branch: ${branch}\nStatus:\n${status || '(clean)'}`
}

async function loadGitStatus(cwd: string): Promise<string | undefined> {
  try {
    const [branchResult, statusResult, logResult] = await Promise.all([
      execFileP('git', ['branch', '--show-current'], { cwd, timeout: 5000 }),
      execFileP('git', ['status', '--short'], { cwd, timeout: 5000 }),
      execFileP('git', ['log', '--oneline', '-5'], { cwd, timeout: 5000 }).catch(() => ({ stdout: '' })),
    ])
    const base = formatGitStatus(branchResult.stdout.trim(), statusResult.stdout.trim())
    const log = logResult.stdout.trim()
    if (!base && !log) return undefined
    return log ? `${base ?? ''}\nRecent commits:\n${log}` : base
  } catch {
    return undefined
  }
}

export function createGitStatusCache(options: GitStatusCacheOptions) {
  const values = new Map<string, { value: string | undefined; timestamp: number }>()
  const refreshing = new Map<string, Promise<void>>()

  const isFresh = (cwd: string) => {
    const entry = values.get(cwd)
    return !!entry && options.now() - entry.timestamp < options.ttlMs
  }

  return {
    get(cwd: string): string | undefined {
      if (!isFresh(cwd) && !refreshing.has(cwd)) {
        void this.refresh(cwd)
      }
      return values.get(cwd)?.value
    },

    prime(cwd: string, nextValue: string | undefined): void {
      values.set(cwd, { value: nextValue, timestamp: options.now() })
    },

    async refresh(cwd: string): Promise<void> {
      const existing = refreshing.get(cwd)
      if (existing) return existing
      const work = options.load(cwd).then(nextValue => {
        values.set(cwd, { value: nextValue, timestamp: options.now() })
      }).finally(() => {
        refreshing.delete(cwd)
      })
      refreshing.set(cwd, work)
      return work
    },
  }
}

export const gitStatusCache = createGitStatusCache({
  ttlMs: 30_000,
  now: () => Date.now(),
  load: loadGitStatus,
})
