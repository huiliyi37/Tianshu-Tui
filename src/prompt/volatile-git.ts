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
  let value: string | undefined
  let timestamp = 0
  let refreshing: Promise<void> | null = null

  const isFresh = () => options.now() - timestamp < options.ttlMs

  return {
    get(cwd: string): string | undefined {
      if (!isFresh() && !refreshing) {
        void this.refresh(cwd)
      }
      return value
    },

    prime(nextValue: string | undefined): void {
      value = nextValue
      timestamp = options.now()
    },

    async refresh(cwd: string): Promise<void> {
      if (refreshing) return refreshing
      refreshing = options.load(cwd).then(nextValue => {
        value = nextValue
        timestamp = options.now()
      }).finally(() => {
        refreshing = null
      })
      return refreshing
    },
  }
}

export const gitStatusCache = createGitStatusCache({
  ttlMs: 30_000,
  now: () => Date.now(),
  load: loadGitStatus,
})
