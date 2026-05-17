import type { ChildProcess } from 'child_process'

type KillFn = (pid: number, signal: NodeJS.Signals) => void

type KillableChild = Pick<ChildProcess, 'pid' | 'kill'>

export function killProcessTree(
  child: KillableChild,
  signal: NodeJS.Signals,
  kill: KillFn = process.kill,
): void {
  if (!child.pid) return
  try {
    kill(-child.pid, signal)
  } catch {
    try { child.kill(signal) } catch { }
  }
}
