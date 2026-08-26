/**
 * resolveRewindPoint — 用户气泡「退到这里」的回退点解析。
 *
 * 对齐桌面 rewind-point-resolve（手写一份，不 import desktop）：
 * seq 精确命中优先；seq 缺失时按「到该 user 为止的 user 序数」取 points。
 * 越界 / 空列表 → undefined（调用方报错，不猜）。
 */

export interface RewindPoint {
  index: number
  content: string
  timestamp: number
  seq?: number
}

export function resolveRewindPoint(
  items: ReadonlyArray<{ kind: string; seq?: number }>,
  points: ReadonlyArray<RewindPoint>,
  seq: number,
): RewindPoint | undefined {
  const bySeq = points.find((p) => p.seq === seq)
  if (bySeq) return bySeq

  let userOrdinal = -1
  for (const it of items) {
    if (it.kind !== 'user') continue
    userOrdinal++
    if (it.seq === seq) break
  }
  if (userOrdinal < 0) return undefined
  return points[userOrdinal] ?? undefined
}
