/**
 * SSE 去重：热事件按 seq 单调前进；seq=0 是合成元事件
 *（replay_window / job_snapshot），必须放行且不改 lastSeq。
 */
export function classifyStreamEvent(evSeq: number, lastSeq: number): 'meta' | 'next' | 'dup' {
  if (evSeq === 0) return 'meta'
  if (evSeq > lastSeq) return 'next'
  return 'dup'
}
