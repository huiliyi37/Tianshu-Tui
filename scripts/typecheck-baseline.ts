#!/usr/bin/env tsx
/**
 * Generate `.rivet/typecheck-baseline.json` — a snapshot of all current tsc
 * errors (as signatures) that the team accepts as pre-existing debt.
 *
 * The typecheck gate uses this baseline to distinguish NEW errors (which
 * escalate review to L3) from ACCEPTED errors (which are silently skipped).
 * Missing/empty baseline = strict (any error escalates).
 *
 * Usage:
 *   npm run typecheck:baseline
 *
 * Run this when you want to accept a batch of pre-existing errors as debt.
 * Never run it to "silence" errors you just introduced — fix those instead.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// Use the same diagnostics pipeline as the runtime gate — runTypeCheck +
// errorSignature — so signatures are guaranteed to match at comparison time.
// This eliminates the risk of divergence between how the script and the gate
// format multi-line TS2322/TS2345 messages.
import { runTypeCheck } from '../src/lsp/client.js'
import { errorSignature } from '../src/agent/typecheck-gate.js'

const cwd = process.cwd()

const res = runTypeCheck(cwd, '*')
if (!res.ranOk) {
  console.error('tsc did not run to completion — cannot generate a trustworthy baseline')
  process.exit(1)
}

const signatures = res.diagnostics
  .filter(d => d.severity === 'error')
  .map(d => errorSignature(cwd, d))
  .sort()

const outDir = join(cwd, '.rivet')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'typecheck-baseline.json')
writeFileSync(outPath, JSON.stringify(signatures, null, 2) + '\n', 'utf-8')

console.log(`Wrote ${signatures.length} baseline error signature(s) to ${outPath}`)
