import type { ChildProcess } from 'child_process'
import { killProcessTree } from './process-kill.js'

const activeProcesses = new Set<ChildProcess>()

export function track(child: ChildProcess): ChildProcess {
  activeProcesses.add(child)
  child.on('close', () => activeProcesses.delete(child))
  child.on('error', () => activeProcesses.delete(child))
  return child
}

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
