import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export interface InjectedWorktreeContext {
  cwd?: string
  branch?: string
  head?: string
  isGitRepo?: boolean
}

export interface WorktreeReality {
  cwd: string
  isGitRepo: boolean
  repoRoot?: string
  branch?: string
  head?: string
  statusAvailable: boolean
  injectedContextMatchesReality: boolean
  mismatchReasons: string[]
  severity: 'green' | 'yellow' | 'red'
}

async function gitExec(args: string[], cwd: string, timeoutMs = 5000): Promise<string> {
  try {
    const { stdout } = await execFileP('git', args, {
      cwd,
      timeout: timeoutMs,
    })
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function detectWorktreeReality(
  _cwd: string,
  _injected?: InjectedWorktreeContext,
): Promise<WorktreeReality> {
  throw new Error('not implemented')
}
