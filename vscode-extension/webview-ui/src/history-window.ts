/** disk 上还有比当前回放窗口更早的事件时，才出「加载更早的历史」。 */
export function canLoadEarlier(floorSeq: number | null | undefined, diskFirstSeq: number | null | undefined): boolean {
  if (floorSeq == null || diskFirstSeq == null) return false
  return diskFirstSeq < floorSeq && floorSeq > 1
}

export function mergeHistoryFloor(current: number | null | undefined, incomingFloor: number): number {
  if (current == null) return incomingFloor
  return Math.min(current, incomingFloor)
}
