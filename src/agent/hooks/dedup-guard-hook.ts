import type { PostTurnRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * P5: Dedup Guard — postTurn hook that detects when the current assistant
 * reply significantly overlaps with the previous turn's reply, and injects
 * a suppression hint to prevent regurgitation.
 *
 * Algorithm: trigram overlap ratio on the first 500 chars of each reply.
 * Threshold is configurable (default 60%).
 *
 * A1: when advisoryBus is provided, routes through unified advisory bus
 * instead of injecting a system-reminder (which breaks prefix cache).
 */

export interface DedupGuardHookDeps {
  /** Get the current turn's streamed assistant text. */
  getStreamedText: () => string
  /** Get/set the previous turn's streamed text for comparison. */
  getPrevStreamedText: () => string | null
  setPrevStreamedText: (text: string) => void
  /** Overlap ratio threshold (0-1). Default: 0.6 */
  threshold?: number
  /** A1: unified advisory bus for noise-gated corrective signals */
  advisoryBus?: AdvisoryBus
}

/** Extract trigrams from text (lowercased, whitespace-normalized). */
function trigrams(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim()
  const set = new Set<string>()
  for (let i = 0; i <= normalized.length - 3; i++) {
    set.add(normalized.slice(i, i + 3))
  }
  return set
}

/** Compute Jaccard-like overlap: |A ∩ B| / |A ∪ B|. */
function trigramOverlap(a: string, b: string): number {
  const tgA = trigrams(a)
  const tgB = trigrams(b)
  if (tgA.size === 0 && tgB.size === 0) return 0
  let intersection = 0
  for (const t of tgA) {
    if (tgB.has(t)) intersection++
  }
  const union = tgA.size + tgB.size - intersection
  if (union === 0) return 0
  return intersection / union
}

export function createDedupGuardHook(deps: DedupGuardHookDeps): PostTurnRuntimeHook {
  const threshold = deps.threshold ?? 0.6

  return {
    phase: 'postTurn',
    name: 'dedup-guard',
    run(ctx: RuntimeHookContext) {
      const currentText = deps.getStreamedText()
      const prevText = deps.getPrevStreamedText()

      // Always update stored text for next turn
      deps.setPrevStreamedText(currentText)

      if (!prevText || currentText.length < 50) return

      // Compare first 500 chars
      const head = currentText.slice(0, 500)
      const prevHead = prevText.slice(0, 500)

      const overlap = trigramOverlap(head, prevHead)
      if (overlap < threshold) return

      // Generate a short summary of what was repeated (first 150 chars)
      const summary = head.slice(0, 150).replace(/\n/g, ' ').trim()

      // A1: route through advisory bus instead of injectUserMessage (prefix-cache safe)
      // W3-C2 expect 审计：采纳信号是“下一轮文本不再重复”——文本级现象，
      // 无唯一工具签名可核销（convergence 的 textRepetitionPenalty 已独立
      // 度量重复度）。刻意不填 expect，避免伪采纳率。
      if (deps.advisoryBus) {
        deps.advisoryBus.submit({
          key: 'dedup-guard',
          priority: 0.7,
          category: 'dedup',
          content: `【天璇】重复输出检测 (${Math.round(overlap * 100)}%)："${summary}${head.length > 150 ? '…' : ''}" — 你在同一个视角里循环了。换个角度，或 recall 天璇胶囊（docs/seed-capsule-tianxuan.md）。`,
        })
      }

      // Without advisory bus, silently skip — SR injection for dedup is not worth
      // the noise overhead (convergence detector already catches repetition via
      // textRepetitionPenalty signal).
    },
  }
}

// Export for testing
export { trigramOverlap, trigrams }
