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

/**
 * Run a lightweight theta-gamma consistency check with an isolated tsc process.
 *
 * This is intentionally best-effort: missing tsc, missing tsconfig, and timeouts
 * return an empty error set so the agent loop never blocks on rhythmic checks.
 */
export function runThetaCheck(cwd: string, timeoutMs = 3000): Promise<ThetaCheckResult> {
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
