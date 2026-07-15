/**
 * W1-A4: single source of truth for lossy-observation markers.
 *
 * Consumed by lossy-observation-hook (preventive advisory) and
 * negative-fact-detector (corrective inline warning). Every regex here is
 * anchored to REAL marker text produced by the harness — the source of each
 * pattern is annotated. Adding a marker requires citing the producing line.
 *
 * Anti-false-positive rule: only structural markers match — natural-language
 * words like "truncated" in ordinary command output must NOT trigger.
 */
export const LOSSY_CONTENT_MARKERS: readonly RegExp[] = [
  // src/compact/storm*.ts — storm collapse summary header
  /^\[storm-collapsed:/,
  // tiered summarizer output header
  /^\[tiered-summary:/,
  // src/compact/context-collapse.ts — semantic collapse summaries, e.g.
  // "[collapsed grep: 14 matches ...]"
  /^\[collapsed /,
  // src/tools/output-store.ts truncation footers
  /\[output truncated:/,
  // src/tools/bash.ts:409-414 — stream preview truncation notes
  /\[stdout truncated:/,
  /\[stderr truncated:/,
  // src/tools/truncation.ts:42 — "── PARTIAL view of <file> (N lines, M chars) ──"
  /PARTIAL view of /,
  // src/agent/per-message-budget.ts:41 — whole-content eviction replacement
  /\[budget-evicted:/,
  // src/agent/per-message-budget.ts:172 — cumulative tool-type budget summary
  // (also covers "... [remaining N lines omitted — cumulative budget exceeded]")
  /\[budget-summarized:/,
  // src/agent/per-message-budget.ts:160 — per-call hard slice footer:
  // "[truncated: 5000 tokens → 2000 token budget for bash]"
  /\[truncated: \d+ tokens/,
  // src/agent/per-message-budget.ts:77 — turn read budget summary line
  /lines omitted \(turn read budget exceeded/,
  // src/agent/per-message-budget.ts:114 — context pressure head-only preview
  /lines omitted \(context pressure/,
  // src/agent/per-message-budget.ts:158 — per-call head+tail budget line
  /lines omitted \(per-call budget/,
  // src/compact/micro.ts — micro-compact truncation stub
  /<microcompacted /,
  // src/compact/stale-round.ts — stale-round truncation tag
  /<stale-compacted /,
]

/** True when the content carries any structural lossy marker. */
export function isLossyObservation(content: string): boolean {
  for (const marker of LOSSY_CONTENT_MARKERS) {
    if (marker.test(content)) return true
  }
  return false
}
