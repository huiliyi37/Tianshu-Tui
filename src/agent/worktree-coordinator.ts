import { createWorktree, removeWorktree } from './worktree.js'

export interface WorktreeHandle {
  path: string
  branch: string
}

/**
 * Manages git worktrees for write-capable worker sessions.
 * Each worker gets its own worktree with a unique branch,
 * isolated from the primary session's working directory.
 *
 * Worktrees are cleaned up when the worker completes or fails.
 */
export class WorktreeCoordinator {
  private active: Map<string, WorktreeHandle> = new Map()

  constructor(private readonly baseCwd: string) {}

  /**
   * Create a new worktree for a worker session.
   * Cleans up any stale worktree for the same worker id first.
   */
  create(workerId: string): WorktreeHandle {
    // Cleanup any stale worktree for this worker id
    this.remove(workerId)

    const branch = `rivet-hands-${workerId.slice(0, 8)}`
    const wt = createWorktree(this.baseCwd, workerId, branch)
    const handle: WorktreeHandle = { path: wt.path, branch: wt.branch }
    this.active.set(workerId, handle)
    return handle
  }

  /** Remove a worktree by worker id. No-op if not found. */
  remove(workerId: string): void {
    const handle = this.active.get(workerId)
    if (handle) {
      removeWorktree(this.baseCwd, handle.path, handle.branch)
      this.active.delete(workerId)
    }
  }

  /** Remove all active worktrees. Best-effort. */
  cleanupAll(): void {
    for (const [id] of this.active) {
      this.remove(id)
    }
  }

  /** Get the worktree handle for a worker id, if active. */
  getWorktree(workerId: string): WorktreeHandle | undefined {
    return this.active.get(workerId)
  }

  /** Number of currently active worktrees. */
  getActiveCount(): number {
    return this.active.size
  }
}
