import type { BenchmarkRun, CapabilityMatrixRow } from './types.js'
import { readBenchmarkRuns } from './store.js'

/**
 * Compute a single capability matrix row from a set of runs for the same
 * (provider, model, suiteId) combination.
 */
export function computeMatrixRow(
  runs: BenchmarkRun[],
  provider: string,
  model: string,
  suiteId: string,
): CapabilityMatrixRow {
  const passed = runs.filter(r => r.status === 'passed').length
  const failed = runs.filter(r => r.status === 'failed').length
  const blocked = runs.filter(r => r.status === 'blocked').length
  const total = runs.length

  // median turns: sort the turns values, pick middle
  const turns = runs
    .map(r => r.metrics.turns)
    .sort((a, b) => a - b)
  const medianTurns = computeMedian(turns)

  // median tool calls
  const toolCalls = runs
    .map(r => r.metrics.toolCalls)
    .sort((a, b) => a - b)
  const medianToolCalls = computeMedian(toolCalls)

  // average cost
  const totalCost = runs.reduce((sum, r) => sum + (r.metrics.costUsd ?? 0), 0)
  const averageCostUsd = total > 0 ? totalCost / total : 0

  return {
    provider,
    model,
    suiteId,
    runs: total,
    passed,
    failed,
    blocked,
    passRate: total > 0 ? passed / total : 0,
    medianTurns,
    medianToolCalls,
    averageCostUsd: Math.round(averageCostUsd * 10000) / 10000,
  }
}

function computeMedian(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 0) {
    return Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 100) / 100
  }
  return sorted[mid]!
}

/**
 * Generate a Markdown capability matrix report from a store file.
 */
export function generateReportFromStore(
  storeFile: string,
  suiteId: string,
): string {
  const runs = readBenchmarkRuns(storeFile, { suiteId })

  // Group runs by (provider, model)
  const groups = new Map<string, BenchmarkRun[]>()
  for (const run of runs) {
    const key = `${run.provider}\x00${run.model}`
    const existing = groups.get(key)
    if (existing) {
      existing.push(run)
    } else {
      groups.set(key, [run])
    }
  }

  const rows: CapabilityMatrixRow[] = []
  for (const [key, groupRuns] of groups) {
    const [provider, model] = key.split('\x00') as [string, string]
    rows.push(computeMatrixRow(groupRuns, provider!, model!, suiteId))
  }

  return generateMarkdownReport(rows, suiteId)
}

/**
 * Generate a Markdown capability matrix report from pre-computed rows.
 */
export function generateMarkdownReport(
  rows: CapabilityMatrixRow[],
  suiteId: string,
): string {
  const parts: string[] = [
    `# Benchmark Report: ${suiteId}`,
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
  ]

  if (rows.length === 0) {
    parts.push('No benchmark runs recorded for this suite.')
    return parts.join('\n')
  }

  parts.push(
    '| Provider | Model | Runs | Passed | Failed | Blocked | Pass Rate | Median Turns | Median Tool Calls | Avg Cost (USD) |',
    '|----------|-------|------|--------|--------|---------|-----------|--------------|-------------------|----------------|',
  )

  for (const row of rows) {
    const passRatePct = (row.passRate * 100).toFixed(1)
    parts.push(
      `| ${row.provider} | ${row.model} | ${row.runs} | ${row.passed} | ${row.failed} | ${row.blocked} | ${passRatePct}% | ${row.medianTurns} | ${row.medianToolCalls} | ${row.averageCostUsd} |`,
    )
  }

  parts.push('')
  parts.push('> **Note:** All runs shown are dry-run records. Dry-run status is always `blocked` and does not represent real capability.')

  return parts.join('\n')
}
