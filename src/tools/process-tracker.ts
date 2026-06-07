import type { ChildProcess } from 'child_process'
import { killProcessTree } from './process-kill.js'

const activeProcesses = new Set<ChildProcess>()

export function track(child: ChildProcess, _loopId?: string): ChildProcess {
  activeProcesses.add(child)
  child.on('close', () => activeProcesses.delete(child))
  child.on('error', () => activeProcesses.delete(child))
  return child
}

/** Kill all tracked processes — for process.exit() cleanup only (main.tsx). */
export function killAll(): void {
  for (const child of activeProcesses) {
    killProcessTree(child, 'SIGTERM')
  }
  setTimeout(() => {
    for (const child of activeProcesses) {
      killProcessTree(child, 'SIGKILL')
    }
    activeProcesses.clear()
  }, 2000)
}

export function getActiveCount(): number {
  return activeProcesses.size
}

// Synchronous variant for exit paths: process.exit() runs before any setTimeout
// fires, so killAll's deferred SIGKILL never executes and children are orphaned
// (PPID=1). This SIGKILLs inline so the tree dies before the process exits.
export function killAllSync(): void {
  for (const child of activeProcesses) {
    killProcessTree(child, 'SIGTERM')
    killProcessTree(child, 'SIGKILL')
  }
  activeProcesses.clear()
}
