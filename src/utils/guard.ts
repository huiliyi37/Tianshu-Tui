/**
 * Type guard utilities — narrow nullable / indexed types without `!` assertions.
 *
 * These enable `noUncheckedIndexedAccess: true` without the code noise of
 * non-null assertion operators (`!`) scattered across tests and production code.
 *
 * Usage:
 *   const item = checkedAt(items, 0)            // replaces items[0]!
 *   const plan = checked(maybePlan, 'no plan')  // replaces maybePlan!
 */

/** Type-safe index access: narrows `T[]` to `T` without `!`. Throws on out-of-bounds. */
export function checkedAt<T>(arr: readonly T[], index: number): T {
  const val = arr[index]
  if (val === undefined) {
    throw new Error(`Index ${index} out of bounds for array of length ${arr.length}`)
  }
  return val
}

/**
 * Type-safe nullable unwrap: narrows `T | null | undefined` to `T`.
 * Throws with optional message if value is null/undefined.
 */
export function checked<T>(val: T | null | undefined, msg?: string): T {
  if (val === null || val === undefined) {
    throw new Error(msg ?? 'Value was null or undefined')
  }
  return val
}
