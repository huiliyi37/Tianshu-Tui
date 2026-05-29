import type { VirtueSignal } from './virtue-signals.js'

/** Accumulates collaboration-stance evidence so it survives compaction.
 *  Stance is read from the agent's own behavior (virtue signals), not injected
 *  as identity text — identity must emerge, not be re-asserted. */
export interface StanceTally {
  record(signal: VirtueSignal): void
  /** Render a compact handoff section, or null when no stance evidence exists. */
  render(): string | null
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
  let lastEvidence: string | null = null

  return {
    record(signal) {
      counts.set(signal.wuchang, (counts.get(signal.wuchang) ?? 0) + 1)
      lastEvidence = signal.evidence
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
  }
}
