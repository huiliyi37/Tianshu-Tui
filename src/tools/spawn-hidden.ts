import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
  type SpawnSyncReturns,
} from 'node:child_process'

/**
 * spawn() with `windowsHide: true` forced on.
 *
 * On Windows, spawning a console subprocess without this flag pops up a black
 * console window for a split second every time. The agent shells out constantly
 * (grep, tests, gh, lsp probes), so this flashing is very noticeable. This
 * wrapper guarantees the flag without each call site remembering it.
 *
 * Do NOT use this for bash.ts / git.ts — those already manage their own
 * detached/windowsHide lifecycle.
 */
export function spawnHidden(
  command: string,
  args: readonly string[] = [],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(command, args as string[], { ...options, windowsHide: true })
}

/** spawnSync() with `windowsHide: true` forced on (see spawnHidden). */
export function spawnSyncHidden(
  command: string,
  args: readonly string[] = [],
  options: SpawnSyncOptions = {},
): SpawnSyncReturns<Buffer> {
  return spawnSync(command, args as string[], { ...options, windowsHide: true }) as SpawnSyncReturns<Buffer>
}
