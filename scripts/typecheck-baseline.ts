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
import { join, isAbsolute, relative } from 'node:path'

const cwd = process.cwd()

// Load typescript from node_modules — same approach as runTypeCheck.
const ts = require('typescript')

const configPath = ts.findConfigFile(cwd, ts.sys.fileExists, 'tsconfig.json')
if (!configPath) {
  console.error('No tsconfig.json found')
  process.exit(1)
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
if (configFile.error) {
  console.error('Failed to read tsconfig:', ts.flattenDiagnosticMessageText(configFile.error.messageText, '\n'))
  process.exit(1)
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, cwd)
const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true, pretty: false })
const diagnostics = ts.getPreEmitDiagnostics(program)

const signatures: string[] = []
for (const d of diagnostics) {
  if (d.category !== ts.DiagnosticCategory.Error) continue
  const file = d.file
  if (!file) continue
  const relFile = isAbsolute(file.fileName) ? relative(cwd, file.fileName) : file.fileName
  const pos = ts.getLineAndCharacterOfPosition(file, d.start ?? 0)
  const message = ts.flattenDiagnosticMessageText(d.messageText, '\n')
  // Match the format used by errorSignature() in typecheck-gate.ts
  signatures.push(`${relFile}|${pos.line + 1}|${message}`)
}

signatures.sort()

const outDir = join(cwd, '.rivet')
mkdirSync(outDir, { recursive: true })
const outPath = join(outDir, 'typecheck-baseline.json')
writeFileSync(outPath, JSON.stringify(signatures, null, 2) + '\n', 'utf-8')

console.log(`Wrote ${signatures.length} baseline error signature(s) to ${outPath}`)
