/** Filter session ids restorable from the waiting prompt, excluding the current one (S11). */
export function selectRestorableSessions(all: readonly string[], currentId: string): string[] {
  return all.filter(id => id !== currentId)
}
