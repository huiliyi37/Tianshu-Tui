/**
 * Compact-event analyzer — was each context compaction necessary, and what did it cost?
 *
 * Reads per-turn cache-log.jsonl entries and reports the history rewrites
 * (compact / partial / session-split / stale-round / heap micro-compact),
 * attributing each one with:
 *   - compactPreRatio : window fill ratio just before the rewrite (necessity signal)
 *   - compactReclaimed: tokens freed by the rewrite (benefit)
 *   - hitRate         : the turn's cache hit-rate (the cost the break paid)
 *
 * A rewrite with a low pre-ratio is a candidate wasteful prefix-cache break:
 * it paid a cache cost for headroom the window did not yet need.
 *
 * Usage:
 *   npx tsx scripts/analyze-compact-events.ts            # all sessions for this cwd
 *   npx tsx scripts/analyze-compact-events.ts <id-prefix> # one session
 *   RIVET_SESSION_DIR=/path npx tsx scripts/analyze-compact-events.ts
 *
 * Requires the compact-attribution instrumentation (compactPreRatio etc. in cache-log).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionDir } from '../src/agent/session-persist.js'
import { LOW_PRESSURE_REWRITE_RATIO, isLowPressureRewrite } from '../src/agent/compact-attribution.js'

interface LogEntry {
  turn?: number
  model?: string
  hitRate?: string
  historyRewritten?: boolean
  compactPreRatio?: number
  compactReclaimed?: number
  compactTokensBefore?: number
  compactTokensAfter?: number
}

function parseHitRate(s: string | undefined): number | undefined {
  if (typeof s !== 'string') return undefined
  const n = Number.parseFloat(s.replace('%', ''))
  return Number.isFinite(n) ? n : undefined
}

function readSessionLog(dir: string): LogEntry[] {
  const file = join(dir, 'cache-log.jsonl')
  if (!existsSync(file)) return []
  const lines = readFileSync(file, 'utf-8').split('\n').filter(Boolean)
  const entries: LogEntry[] = []
  for (const line of lines) {
    try { entries.push(JSON.parse(line) as LogEntry) } catch { /* skip malformed */ }
  }
  return entries
}

interface Agg {
  turns: number
  rewrites: number
  lowPressure: number
  reclaimed: number
  reclaimedCount: number
  preRatioSum: number
  preRatioCount: number
  hitRateSum: number
  hitRateCount: number
  suspicious: Array<{ turn?: number; preRatio?: number; reclaimed?: number; hitRate?: number }>
}

function emptyAgg(): Agg {
  return {
    turns: 0, rewrites: 0, lowPressure: 0, reclaimed: 0, reclaimedCount: 0,
    preRatioSum: 0, preRatioCount: 0, hitRateSum: 0, hitRateCount: 0, suspicious: [],
  }
}

function accumulate(agg: Agg, e: LogEntry): void {
  agg.turns++
  if (e.historyRewritten !== true) return
  agg.rewrites++
  const hr = parseHitRate(e.hitRate)
  if (typeof e.compactReclaimed === 'number') { agg.reclaimed += e.compactReclaimed; agg.reclaimedCount++ }
  if (typeof e.compactPreRatio === 'number') { agg.preRatioSum += e.compactPreRatio; agg.preRatioCount++ }
  if (typeof hr === 'number') { agg.hitRateSum += hr; agg.hitRateCount++ }
  if (isLowPressureRewrite(e.compactPreRatio)) {
    agg.lowPressure++
    agg.suspicious.push({ turn: e.turn, preRatio: e.compactPreRatio, reclaimed: e.compactReclaimed, hitRate: hr })
  }
}

function avg(n: number, d: number): string {
  return d > 0 ? (n / d).toFixed(2) : 'n/a'
}

function reportAgg(label: string, agg: Agg): void {
  console.log(`  ${label}`)
  console.log(`    turns                 : ${agg.turns}`)
  console.log(`    history rewrites      : ${agg.rewrites}`)
  if (agg.rewrites === 0) return
  console.log(`    avg pre-ratio         : ${avg(agg.preRatioSum, agg.preRatioCount)}`)
  console.log(`    avg reclaimed tokens  : ${avg(agg.reclaimed, agg.reclaimedCount)}`)
  console.log(`    avg hitRate on rewrite: ${avg(agg.hitRateSum, agg.hitRateCount)}%`)
  console.log(`    low-pressure rewrites : ${agg.lowPressure} (pre-ratio < ${LOW_PRESSURE_REWRITE_RATIO})`)
  for (const s of agg.suspicious.slice(0, 10)) {
    console.log(`      ! turn ${s.turn ?? '?'}: preRatio=${s.preRatio ?? '?'} reclaimed=${s.reclaimed ?? '?'} hitRate=${s.hitRate ?? '?'}%`)
  }
}

function verdict(agg: Agg): void {
  console.log('Verdict:')
  if (agg.rewrites === 0) {
    console.log('  No history rewrites recorded — nothing to attribute.')
    return
  }
  if (agg.lowPressure === 0) {
    console.log('  All rewrites fired under genuine window pressure — no wasteful breaks detected.')
    return
  }
  const share = (agg.lowPressure / agg.rewrites) * 100
  console.log(`  ${agg.lowPressure}/${agg.rewrites} (${share.toFixed(0)}%) rewrites broke the prefix cache`)
  console.log(`  while the window was below ${LOW_PRESSURE_REWRITE_RATIO} fill — candidate wasteful compactions.`)
  console.log('  Investigate the compaction gate that fired at those turns.')
}

function main(): void {
  const prefix = process.argv[2]
  const root = getSessionDir(process.cwd())
  if (!existsSync(root)) {
    console.error(`Session dir not found: ${root}`)
    console.error('Set RIVET_SESSION_DIR or run from a project that has run sessions.')
    process.exit(1)
  }

  const sessionDirs = readdirSync(root)
    .map(name => join(root, name))
    .filter(p => { try { return statSync(p).isDirectory() } catch { return false } })
    .filter(p => !prefix || p.includes(prefix))

  if (sessionDirs.length === 0) {
    console.error(`No session directories found under ${root}${prefix ? ` matching "${prefix}"` : ''}`)
    process.exit(1)
  }

  console.log(`Compact-event attribution — ${sessionDirs.length} session(s) under ${root}\n`)

  const overall = emptyAgg()
  for (const dir of sessionDirs) {
    const entries = readSessionLog(dir)
    if (entries.length === 0) continue
    const agg = emptyAgg()
    for (const e of entries) { accumulate(agg, e); accumulate(overall, e) }
    if (agg.turns === 0) continue
    const id = dir.split('/').pop() ?? dir
    reportAgg(id.slice(0, 12), agg)
    console.log('')
  }

  console.log('─'.repeat(50))
  reportAgg('OVERALL', overall)
  console.log('')
  verdict(overall)
}

main()
