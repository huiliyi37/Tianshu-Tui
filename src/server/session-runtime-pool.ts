/**
 * SessionRuntimePool (N3) — the missing RuntimePool implementation.
 *
 * TaskRegistry.scheduleExecution() acquires a runtime per task; here each
 * acquisition spins up a *visible* RuntimeSessionManager session, so a cron job
 * firing shows up in the desktop Agent Manager exactly like a human-started
 * agent. The handle's execute() awaits terminal state and reports the run's
 * summary + changed files back to the registry.
 */
import type { RuntimeHandle, RuntimePool, RuntimeResult } from './task-registry.js'
import type { RuntimeSessionManager } from './session-manager.js'

export interface SessionRuntimePoolOptions {
  manager: RuntimeSessionManager
  defaultCwd: string
  /** Title prefix for spawned sessions (defaults to "scheduled"). */
  titlePrefix?: string
}

export class SessionRuntimePool implements RuntimePool {
  size = 0
  private readonly manager: RuntimeSessionManager
  private readonly defaultCwd: string
  private readonly titlePrefix: string

  constructor(opts: SessionRuntimePoolOptions) {
    this.manager = opts.manager
    this.defaultCwd = opts.defaultCwd
    this.titlePrefix = opts.titlePrefix ?? 'scheduled'
  }

  acquire(taskId: string): Promise<RuntimeHandle> {
    this.size++
    const handle: RuntimeHandle = {
      execute: async (prompt, signal): Promise<RuntimeResult> => {
        const session = this.manager.createSession({
          cwd: this.defaultCwd,
          title: `${this.titlePrefix}:${taskId.slice(0, 8)}`,
        })
        const onAbort = () => this.manager.abort(session.id)
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort)
        try {
          const { summary, changedFiles } = await this.manager.runAndWait(session.id, prompt)
          return { summary, changedFiles }
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      },
      release: () => {
        this.size = Math.max(0, this.size - 1)
      },
    }
    return Promise.resolve(handle)
  }
}
