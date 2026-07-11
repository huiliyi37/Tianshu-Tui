import type { VirtueSignal } from './virtue-signals.js'

/** Accumulates collaboration-stance evidence so it survives compaction.
 *  Stance is read from the agent's own behavior (virtue signals), not injected
 *  as identity text — identity must emerge, not be re-asserted. */
export interface StanceTally {
  record(signal: VirtueSignal): void
  /** Render a compact handoff section, or null when no stance evidence exists. */
  render(): string | null
  /** T4: return all recorded signals for virtueCredit computation */
  getAllSignals(): VirtueSignal[]
  /** T5: render mirror-compatible virtue dimension — Fibonacci buckets + fixed order.
   *  Null when no virtue signals have been recorded. Byte-stable: bucket-internal
   *  count changes don't trigger appendix delta; only cross-bucket transitions. */
  renderMirror(): string | null
}

const WUCHANG_LABEL: Record<VirtueSignal['wuchang'], string> = {
  仁: '质疑而非附和',
  义: '主动验证',
  礼: '尊重边界',
  智: '觉察并调整',
  信: '守护缓存连续性',
}

export function createStanceTally(): StanceTally {
  const counts = new Map<VirtueSignal['wuchang'], number>()
  const signals: VirtueSignal[] = []
  let lastEvidence: string | null = null

  return {
    record(signal) {
      counts.set(signal.wuchang, (counts.get(signal.wuchang) ?? 0) + 1)
      signals.push(signal)
      lastEvidence = signal.evidence
    },
    getAllSignals() {
      return signals
    },
    render() {
      if (counts.size === 0) return null
      const parts = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([w, n]) => `${w}(${WUCHANG_LABEL[w]})×${n}`)
      const lines = [`本会话姿态轨迹：${parts.join(' · ')}`]
      if (lastEvidence) lines.push(`最近一次：${lastEvidence}`)
      return lines.join('\n')
    },
    renderMirror() {
      if (counts.size === 0) return null
      // Fibonacci 桶映射：计数 → 桶标签
      const fibBucket = (n: number): string => {
        if (n <= 1) return '1'
        if (n === 2) return '2'
        if (n === 3) return '3'
        if (n <= 5) return '5'
        if (n <= 8) return '8'
        return '8+'
      }
      // 固定排序：仁义礼智信
      const fixedOrder: VirtueSignal['wuchang'][] = ['仁', '义', '礼', '智', '信']
      const parts = fixedOrder
        .filter(w => counts.has(w))
        .map(w => `${w}×${fibBucket(counts.get(w)!)}`)
      if (parts.length === 0) return null
      return `virtue="${parts.join('·')}"`
    },
  }
}
