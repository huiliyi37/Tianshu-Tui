import { spawn } from 'node:child_process'
import { gracefulKill, forceKill } from '../platform.js'
import { track } from '../tools/process-tracker.js'

export interface ThetaCheckResult {
  errors: string[]
  durationMs: number
  timedOut: boolean
}

function parseTypeScriptErrorFiles(output: string): string[] {
  const files = new Set<string>()
  for (const line of output.split('\n')) {
    if (!line.includes('error TS')) continue
    const match = line.match(/^(.+?)\(\d+,\d+\):\s+error TS\d+:/)
    if (match?.[1]) files.add(match[1])
  }
  return [...files]
}

// ── Cross-session result cache ─────────────────────────────────────
// Multiple agent sessions (main + workers) share the same repo and
// would otherwise each spawn a full `tsc --noEmit` (~6s).  This cache
// deduplicates: the first caller spawns the process; subsequent callers
// within `CACHE_TTL_MS` receive the same result without spawning.
const CACHE_TTL_MS = 15_000

let cachedResult: ThetaCheckResult | null = null
let cachedAt = 0
let inFlight: Promise<ThetaCheckResult> | null = null

/**
 * Run a lightweight theta-gamma consistency check with an isolated tsc process.
 *
 * This is intentionally best-effort: missing tsc, missing tsconfig, and timeouts
 * return an empty error set so the agent loop never blocks on rhythmic checks.
 *
 * Cross-session dedup: if a tsc is already running (or completed within 15s),
 * the cached/in-flight result is returned instead of spawning another process.
 */
/** Clear the result cache (for testing). */
export function clearThetaCache(): void {
  cachedResult = null
  cachedAt = 0
  inFlight = null
}

export function runThetaCheck(cwd: string, timeoutMs = 15_000): Promise<ThetaCheckResult> {
  // Return cached result if still fresh
  if (cachedResult && (Date.now() - cachedAt) < CACHE_TTL_MS) {
    return Promise.resolve(cachedResult)
  }

  // Deduplicate in-flight checks
  if (inFlight) return inFlight

  inFlight = runThetaCheckInner(cwd, timeoutMs).then(result => {
    cachedResult = result
    cachedAt = Date.now()
    inFlight = null
    return result
  }).catch(err => {
    inFlight = null
    throw err
  })

  return inFlight
}

function runThetaCheckInner(cwd: string, timeoutMs: number): Promise<ThetaCheckResult> {
  const start = Date.now()

  return new Promise(resolve => {
    const child = track(spawn('npx', ['tsc', '--noEmit', '--skipLibCheck'], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }))

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (errors: string[], didTimeOut = timedOut): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ errors, durationMs: Date.now() - start, timedOut: didTimeOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      gracefulKill(child)
      setTimeout(() => forceKill(child), 3000)
      finish([])
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 100_000) stdout = stdout.slice(-80_000)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 100_000) stderr = stderr.slice(-80_000)
    })

    child.on('close', (code) => {
      if (timedOut) return
      if (code === 0) {
        finish([])
        return
      }
      finish(parseTypeScriptErrorFiles(`${stdout}\n${stderr}`))
    })

    child.on('error', () => {
      finish([])
    })
  })
}
