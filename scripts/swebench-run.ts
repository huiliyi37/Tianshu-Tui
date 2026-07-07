/**
 * swebench-run — Tianshu SWE-bench Verified inference runner
 *
 * Loads SWE-bench Verified dataset, runs Tianshu agent headless on each
 * instance (clone repo → agent → git diff → patch), and writes
 * predictions.jsonl for official SWE-bench evaluation.
 *
 * Usage:
 *   tsx scripts/swebench-run.ts --dataset <path.parquet> [options]
 */

import { parseArgs } from 'node:util'
import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
} from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'

// ── Types ──────────────────────────────────────────────────────

export interface SwebenchInstance {
  instance_id: string
  repo: string
  base_commit: string
  problem_statement: string
  test_patch: string
  version: string
}

export interface RunRecord {
  instance_id: string
  status: 'running' | 'completed' | 'failed'
  patch?: string
  error?: string
  startedAt: string
  endedAt?: string
  exitCode?: number
  agentText?: string
}

export interface RunnerOptions {
  datasetPath: string
  outputPath: string
  progressPath: string
  workRoot: string
  maxInstances: number
  maxTurns: number
  parallel: number
  dryRun: boolean
}

// ── Dataset loading ────────────────────────────────────────────

const SWEBENCH_VERIFIED_URL =
  'https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified/resolve/main/data/test-00000-of-00001.parquet'

export async function loadDataset(parquetPath: string): Promise<SwebenchInstance[]> {
  const { readParquet } = await import('parquet-wasm')
  const buf = readFileSync(parquetPath)
  const table = readParquet(buf)

  const instances: SwebenchInstance[] = []
  const idCol = table.getColumn('instance_id')
  const repoCol = table.getColumn('repo')
  const commitCol = table.getColumn('base_commit')
  const problemCol = table.getColumn('problem_statement')
  const testPatchCol = table.getColumn('test_patch')
  const versionCol = table.getColumn('version')

  if (!idCol || !repoCol || !commitCol || !problemCol || !testPatchCol || !versionCol) {
    throw new Error('Missing required columns in SWE-bench parquet file')
  }

  for (let i = 0; i < table.numRows; i++) {
    instances.push({
      instance_id: String(idCol.get(i)),
      repo: String(repoCol.get(i)),
      base_commit: String(commitCol.get(i)),
      problem_statement: String(problemCol.get(i)),
      test_patch: String(testPatchCol.get(i)),
      version: String(versionCol.get(i)),
    })
  }

  return instances
}

export async function downloadDataset(cachePath: string): Promise<string> {
  if (existsSync(cachePath)) {
    console.log(`Using cached dataset: ${cachePath}`)
    return cachePath
  }
  console.log(`Downloading SWE-bench Verified from HuggingFace...`)
  const res = await fetch(SWEBENCH_VERIFIED_URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
  const buf = Buffer.from(await res.arrayBuffer())
  const dir = dirname(cachePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  await writeFile(cachePath, buf)
  console.log(`Downloaded to ${cachePath} (${(buf.length / 1024).toFixed(1)} KB)`)
  return cachePath
}

// ── Progress persistence ───────────────────────────────────────

export function loadProgress(progressPath: string): string[] {
  if (!existsSync(progressPath)) return []
  const content = readFileSync(progressPath, 'utf-8')
  return content
    .split('\n')
    .filter(Boolean)
    .map(line => {
      try { return JSON.parse(line) as RunRecord }
      catch { return null }
    })
    .filter((r): r is RunRecord => r !== null && r.status === 'completed')
    .map(r => r.instance_id)
}

export function appendProgress(progressPath: string, record: RunRecord): void {
  const dir = dirname(progressPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  appendFileSync(progressPath, JSON.stringify(record) + '\n')
}

export function appendPrediction(outputPath: string, record: RunRecord): void {
  if (record.status !== 'completed' || !record.patch) return
  const dir = dirname(outputPath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const prediction = {
    instance_id: record.instance_id,
    model_name_or_path: 'tianshu-agent-v1',
    model_patch: record.patch,
  }
  appendFileSync(outputPath, JSON.stringify(prediction) + '\n')
}

// ── Helpers ────────────────────────────────────────────────────

const GITHUB_MIRROR = process.env.GITHUB_MIRROR || 'https://github.com'

export function buildSwebenchPrompt(instance: SwebenchInstance): string {
  return `You are working in the ${instance.repo} repository (version ${instance.version}).
Your task is to fix the following GitHub issue by making the necessary code changes.

## Issue

${instance.problem_statement}

## Instructions

1. Read the relevant source files to understand the codebase
2. Identify the root cause of the issue
3. Make the minimal code changes needed to fix it
4. Use the edit_file tool to apply your changes
5. After making changes, use deliver_task to confirm completion

Fix the issue described above. Make only the changes necessary to resolve it.`
}

// ── CLI ────────────────────────────────────────────────────────

function showHelp(): void {
  console.log(`swebench-run — Tianshu SWE-bench inference runner

Usage: tsx scripts/swebench-run.ts --dataset <path> [options]

Options:
  --dataset, -d <path>     Path to SWE-bench Verified parquet file
  --output, -o <path>      predictions.jsonl output (default: ./predictions.jsonl)
  --progress <path>        Progress file for resume (default: ./swebench-progress.jsonl)
  --work-root <path>       Git clone working directory (default: /tmp/swebench-work)
  --max-instances <n>      Max instances to run (0=all, default: 0)
  --max-turns <n>          Max agent turns per instance (default: 100)
  --parallel <n>           Number of parallel instances (default: 1)
  --dry-run                Load dataset + print summary, skip agent
  --help, -h               Show this help
`)
}

export function parseRunnerArgs(argv: string[]): {
  opts: RunnerOptions
  help: boolean
  error?: string
} {
  const { values } = parseArgs({
    args: argv,
    options: {
      dataset: { type: 'string', short: 'd' },
      output: { type: 'string', short: 'o', default: './predictions.jsonl' },
      progress: { type: 'string', default: './swebench-progress.jsonl' },
      'work-root': { type: 'string', default: join(tmpdir(), 'swebench-work') },
      'max-instances': { type: 'string', default: '0' },
      'max-turns': { type: 'string', default: '100' },
      parallel: { type: 'string', default: '1' },
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
    strict: false,
  })

  if (values.help) return { opts: null as any, help: true }
  if (!values.dataset) return { opts: null as any, help: false, error: '--dataset is required' }

  return {
    help: false,
    opts: {
      datasetPath: values.dataset,
      outputPath: values.output,
      progressPath: values.progress,
      workRoot: values['work-root'],
      maxInstances: parseInt(values['max-instances'], 10) || 0,
      maxTurns: parseInt(values['max-turns'], 10) || 100,
      parallel: parseInt(values.parallel, 10) || 1,
      dryRun: values['dry-run'],
    },
  }
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  const parsed = parseRunnerArgs(process.argv.slice(2))
  if (parsed.help) { showHelp(); return }
  if (parsed.error) {
    console.error(`Error: ${parsed.error}\nUse --help for usage info.`)
    process.exit(1)
  }

  const opts = parsed.opts

  console.log(`Loading dataset from ${opts.datasetPath}...`)
  const instances = await loadDataset(opts.datasetPath)
  console.log(`Loaded ${instances.length} instances`)

  if (opts.dryRun) {
    console.log('First 3 instances:')
    for (const inst of instances.slice(0, 3)) {
      console.log(`  ${inst.instance_id}: ${inst.repo}@${inst.base_commit?.slice(0, 8) ?? '?'}`)
    }
    console.log('\nDry-run complete. No agent was invoked.')
    return
  }

  const completed = loadCompletedIds(opts.progressPath)
  console.log(`Previously completed: ${completed.size}`)

  const toRun = opts.maxInstances > 0
    ? instances.filter(i => !completed.has(i.instance_id)).slice(0, opts.maxInstances)
    : instances.filter(i => !completed.has(i.instance_id))

  if (toRun.length === 0) {
    console.log('All instances already completed.')
    return
  }

  console.log(`Running ${toRun.length} instances (maxTurns=${opts.maxTurns})...`)

  for (let i = 0; i < toRun.length; i++) {
    const instance = toRun[i]!
    console.log(`\n[${i + 1}/${toRun.length}] ${instance.instance_id} — starting...`)

    // Each instance gets a fresh run record
    const record: RunRecord = {
      instance_id: instance.instance_id,
      status: 'running',
      startedAt: new Date().toISOString(),
    }

    // Agent invocation — stubbed until task 3
    record.status = 'failed'
    record.error = 'Agent invocation not yet implemented (see task 3)'
    record.endedAt = new Date().toISOString()

    appendProgress(opts.progressPath, record)
    appendPrediction(opts.outputPath, record)
    console.log(`[${instance.instance_id}] ${record.status}: ${record.error}`)
  }

  console.log(`\nDone. Predictions written to ${opts.outputPath}`)
}

// Only run when executed directly (not imported as a module)
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
const resolvedEntry = resolve(process.argv[1] ?? '')
const currentFile = fileURLToPath(import.meta.url)
const isDirectlyExecuted = resolvedEntry === currentFile
if (isDirectlyExecuted) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
