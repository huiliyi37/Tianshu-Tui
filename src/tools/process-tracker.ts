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
    try { child.kill('SIGTERM') } catch { /* already dead */ }
  }
  // Give 2s grace period then force kill
  setTimeout(() => {
    for (const child of activeProcesses) {
      try { child.kill('SIGKILL') } catch { /* already dead */ }
    }
    activeProcesses.clear()
  }, 2000)
}

export function getActiveCount(): number {
  return activeProcesses.size
}
