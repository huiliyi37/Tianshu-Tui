/**
 * Output-token breakdown analyzer (Phase 1 decision gate).
 *
 * Reads per-turn cache-log.jsonl entries and reports how the output-token
 * budget splits between reasoning (thinking) and text (final prose). This is
 * the data the optimization plan gates on:
 *   - reasoning >> text  → lever is effort routing (Phase 2A)
 *   - text dominant      → lever is verbosity steering (Phase 2B)
 *   - both already low    → stop, no headroom
 *
 * Usage:
 *   npx tsx scripts/analyze-output-tokens.ts            # all sessions for this cwd
 *   npx tsx scripts/analyze-output-tokens.ts <id-prefix> # one session
 *   RIVET_SESSION_DIR=/path npx tsx scripts/analyze-output-tokens.ts
 *
 * Requires the Phase 0 instrumentation (reasoning/text fields in cache-log).
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { getSessionDir } from '../src/agent/session-persist.js'

interface LogEntry {
  turn?: number
  model?: string
  output?: number
  reasoning?: number
  text?: number
}

interface Agg {
  turns: number
  output: number
  reasoning: number
  text: number
  withSplit: number
}

function emptyAgg(): Agg {
  return { turns: 0, output: 0, reasoning: 0, text: 0, withSplit: 0 }
}

function accumulate(agg: Agg, e: LogEntry): void {
  if (typeof e.output !== 'number') return
  agg.turns++
  agg.output += e.output
  if (typeof e.reasoning === 'number') {
    agg.reasoning += e.reasoning
    agg.text += typeof e.text === 'number' ? e.text : Math.max(0, e.output - e.reasoning)
    agg.withSplit++
  }
}

function pct(n: number, d: number): string {
  return d > 0 ? `${((n / d) * 100).toFixed(1)}%` : 'n/a'
}

function avg(n: number, d: number): string {
  return d > 0 ? (n / d).toFixed(0) : 'n/a'
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

function reportAgg(label: string, agg: Agg): void {
  if (agg.turns === 0) {
    console.log(`  ${label}: (no output-token data)`)
    return
  }
  console.log(`  ${label}`)
  console.log(`    turns with output    : ${agg.turns}`)
  console.log(`    avg output / turn    : ${avg(agg.output, agg.turns)} tok`)
  if (agg.withSplit > 0) {
    console.log(`    turns with split     : ${agg.withSplit}`)
    console.log(`    avg reasoning / turn : ${avg(agg.reasoning, agg.withSplit)} tok`)
    console.log(`    avg text / turn      : ${avg(agg.text, agg.withSplit)} tok`)
    console.log(`    reasoning share      : ${pct(agg.reasoning, agg.reasoning + agg.text)} of output`)
  } else {
    console.log(`    (no reasoning/text split — provider didn't report reasoning_tokens)`)
  }
}

function verdict(agg: Agg): void {
  if (agg.withSplit === 0) {
    console.log('Verdict: no reasoning split available. Either the provider does')
    console.log('  not report reasoning_tokens, or these logs predate Phase 0.')
    return
  }
  const share = agg.reasoning / Math.max(1, agg.reasoning + agg.text)
  const avgText = agg.text / agg.withSplit
  const avgReasoning = agg.reasoning / agg.withSplit
  console.log('Verdict:')
  if (avgReasoning < 200 && avgText < 200) {
    console.log('  Both reasoning and text are already low — little headroom.')
    console.log('  Recommend STOP (do not force an intervention).')
  } else if (share >= 0.6) {
    console.log(`  Reasoning dominates (${(share * 100).toFixed(0)}% of output).`)
    console.log('  Recommend Phase 2A: effort routing.')
  } else {
    console.log(`  Text dominates (${((1 - share) * 100).toFixed(0)}% of output).`)
    console.log('  Recommend Phase 2B: adaptive verbosity.')
  }
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

  console.log(`Output-token breakdown — ${sessionDirs.length} session(s) under ${root}\n`)

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
