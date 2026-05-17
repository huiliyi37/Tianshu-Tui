import type { ChildProcess } from 'child_process'

const activeProcesses = new Set<ChildProcess>()

export function track(child: ChildProcess): ChildProcess {
  activeProcesses.add(child)
  child.on('close', () => activeProcesses.delete(child))
  child.on('error', () => activeProcesses.delete(child))
  return child
}

export function killAll(): void {
  for (const child of activeProcesses) {
    if (!child.pid) continue
    try {
      // Kill process group (negative PID) to catch the entire shell tree,
      // including &-backgrounded children. Falls back to single-process kill.
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try { child.kill('SIGTERM') } catch { /* already dead */ }
    }
  }
  // Give 2s grace period then force kill
  setTimeout(() => {
    for (const child of activeProcesses) {
      if (!child.pid) continue
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try { child.kill('SIGKILL') } catch { /* already dead */ }
      }
    }
    activeProcesses.clear()
  }, 2000)
}

export function getActiveCount(): number {
  return activeProcesses.size
}
