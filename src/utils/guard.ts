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
  // 越界用索引比较判定，不用 `val === undefined` 值哨兵——否则
  // (T | undefined)[] 中合法位置的 undefined 会被误判为越界并抛出撒谎的错误。
  if (index < 0 || index >= arr.length) {
    throw new Error(`Index ${index} out of bounds for array of length ${arr.length}`)
  }
  return arr[index] as T
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
