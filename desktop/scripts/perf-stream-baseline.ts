/**
 * Wave 0/4 — desktop streaming render-cost baseline (Node-side, reproducible).
 *
 * Measures the markdown *pipeline* cost (remark-parse + gfm + math + breaks +
 * remark-rehype + katex — the exact plugin chain Markdown.tsx feeds to
 * react-markdown) over a simulated streaming session:
 *
 *   - "full reparse"  — current behaviour: every ~100ms UI tick re-parses the
 *                       whole accumulated text (O(n) per tick → O(n²) total).
 *   - "tail only"     — Wave 1 target: stable segments frozen, only the live
 *                       tail (~2KB) is re-parsed per tick (O(tail) per tick).
 *
 * Also estimates SSE frame counts: today one frame per provider delta vs the
 * Wave 2 server-side 40ms coalescing window.
 *
 * What this does NOT capture: React reconciliation and WebView layout/paint.
 * Those scale with the same input (DOM size ∝ parsed output), so the pipeline
 * ratio is a lower bound on the end-to-end win. Run from desktop/:
 *
 *   node --import tsx scripts/perf-stream-baseline.ts
 */
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import remarkMath from 'remark-math'
import remarkRehype from 'remark-rehype'
import rehypeKatex from 'rehype-katex'

// ── synthetic long reply: prose + fences + lists + table + math ─────────────
function buildDoc(targetChars: number): string {
  const chunks: string[] = []
  let i = 0
  while (chunks.join('').length < targetChars) {
    i++
    chunks.push(
      `## Section ${i}\n\n` +
      `This is a paragraph explaining step ${i} of the change. It references ` +
      '`someFunction()` and includes **bold** plus a [link](https://example.com).\n\n' +
      '```ts\n' +
      `export function handler${i}(input: string): number {\n` +
      '  const parsed = JSON.parse(input)\n' +
      '  return parsed.value * 2\n' +
      '}\n' +
      '```\n\n' +
      `- item one of list ${i}\n- item two\n- item three with \`code\`\n\n` +
      `| col A | col B |\n|-------|-------|\n| ${i} | value |\n\n` +
      `Inline math $e^{i\\pi} + 1 = 0$ and a block:\n\n$$\n\\sum_{k=1}^{${i}} k^2\n$$\n\n`,
    )
  }
  return chunks.join('')
}

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMath)
  .use(remarkBreaks)
  .use(remarkRehype)
  .use(rehypeKatex)

function parseOnce(text: string): number {
  const t0 = performance.now()
  const tree = processor.parse(text)
  processor.runSync(tree)
  return performance.now() - t0
}

// ── simulation parameters ────────────────────────────────────────────────────
const DOC = buildDoc(48_000)
const DELTA_CHARS = 35        // typical provider chunk
const DELTA_INTERVAL_MS = 20  // ~50 chunks/s
const UI_TICK_MS = 100        // ThreadView STREAM_THROTTLE_MS
const TAIL_CHARS = 2_000      // Wave 1 live-tail proxy
const COALESCE_MS = 40        // Wave 2 server window

function main(): void {
  // warmup (JIT + katex init)
  parseOnce(DOC.slice(0, 8_000))

  const nDeltas = Math.ceil(DOC.length / DELTA_CHARS)
  const durationMs = nDeltas * DELTA_INTERVAL_MS
  const nTicks = Math.floor(durationMs / UI_TICK_MS)
  const charsPerTick = DELTA_CHARS * (UI_TICK_MS / DELTA_INTERVAL_MS)

  let fullTotal = 0
  let tailTotal = 0
  const milestones = new Map<number, { full: number; tail: number }>()
  const marks = [4_000, 8_000, 16_000, 32_000, 48_000]

  for (let tick = 1; tick <= nTicks; tick++) {
    const len = Math.min(Math.floor(tick * charsPerTick), DOC.length)
    const text = DOC.slice(0, len)
    const full = parseOnce(text)
    const tail = parseOnce(text.slice(-TAIL_CHARS))
    fullTotal += full
    tailTotal += tail
    for (const m of marks) {
      if (!milestones.has(m) && len >= m) milestones.set(m, { full, tail })
    }
  }

  const sseToday = nDeltas
  const sseCoalesced = Math.ceil(durationMs / COALESCE_MS)

  console.log(`doc=${DOC.length} chars, deltas=${nDeltas} (@${DELTA_CHARS}ch/${DELTA_INTERVAL_MS}ms), ui ticks=${nTicks} (@${UI_TICK_MS}ms), stream≈${(durationMs / 1000).toFixed(0)}s`)
  console.log('')
  console.log('per-tick pipeline cost (ms) at document size:')
  for (const [m, v] of milestones) {
    console.log(`  ${String(m).padStart(6)} chars   full-reparse=${v.full.toFixed(1).padStart(6)}   tail-only=${v.tail.toFixed(1).padStart(5)}`)
  }
  console.log('')
  console.log(`total pipeline work over the stream: full=${fullTotal.toFixed(0)}ms  tail-only=${tailTotal.toFixed(0)}ms  (ratio ${(fullTotal / tailTotal).toFixed(1)}x)`)
  console.log(`main-thread busy fraction (pipeline only): full=${(100 * fullTotal / durationMs).toFixed(1)}%  tail-only=${(100 * tailTotal / durationMs).toFixed(1)}%`)
  console.log('')
  console.log(`SSE frames: today=${sseToday} (1/delta)  wave2-coalesced≈${sseCoalesced} (${COALESCE_MS}ms window)  (${(sseToday / sseCoalesced).toFixed(1)}x fewer)`)
}

main()
