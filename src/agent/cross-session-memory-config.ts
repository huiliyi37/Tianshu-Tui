/**
 * Cross-session loading check — prefers config over env var.
 *
 * - RIVET_NO_CROSS_SESSION=1/true forces off.
 * - RIVET_NO_CROSS_SESSION=0/false forces on.
 * - Without env, config controls the behavior; an absent config stays disabled
 *   for backward compatibility with callers that do not carry configuration.
 */
export function crossSessionDisabled(configEnabled?: boolean): boolean {
  const value = process.env.RIVET_NO_CROSS_SESSION
  if (value === '1' || value === 'true') return true
  if (value === '0' || value === 'false') return false
  return configEnabled === undefined ? true : !configEnabled
}

/** Full query-ranked memory injection is an explicit cache A/B escape hatch. */
export function crossSessionMemoryPushEnabled(): boolean {
  const value = process.env.RIVET_CROSS_SESSION_INJECT
  return value === '1' || value === 'true'
}

/** Merge stable, adaptive, and opt-in memory blocks in deterministic order. */
export function combineMemoryBlocks(...blocks: Array<string | null>): string | null {
  const present = blocks.filter((block): block is string => Boolean(block))
  return present.length > 0 ? present.join('\n') : null
}
