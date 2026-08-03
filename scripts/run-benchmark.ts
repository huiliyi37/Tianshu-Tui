import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { loadTaskSuite } from '../src/benchmark/task-suite.js'
import { runBenchmark } from '../src/benchmark/runner.js'
import { createRivetCliBenchmarkExecutor } from '../src/benchmark/executor.js'

const { values } = parseArgs({
  options: {
    suite: {
      type: 'string',
      short: 's',
    },
    'suite-id': {
      type: 'string',
    },
    provider: {
      type: 'string',
      short: 'p',
      default: 'deepseek',
    },
    model: {
      type: 'string',
      short: 'm',
      default: 'deepseek-v4-pro',
    },
    'store-file': {
      type: 'string',
      default: '.rivet/benchmark/runs.jsonl',
    },
    'dry-run': {
      type: 'boolean',
      default: false,
    },
    workspace: {
      type: 'string',
    },
    'agent-entry': {
      type: 'string',
      default: 'dist/main.js',
    },
    'allow-write-tools': {
      type: 'boolean',
      default: false,
    },
    help: {
      type: 'boolean',
      short: 'h',
    },
  },
})

function showHelp(): void {
  console.log(`benchmark — Rivet Agent Capability Benchmark Runner

Usage:
  npm run benchmark -- [options]

Options:
  --suite, -s <path>        Task suite JSON file (required)
  --suite-id <id>           Suite identifier for grouping runs (required)
  --provider, -p <name>     Provider name (default: deepseek)
  --model, -m <name>        Model name (default: deepseek-v4-pro)
  --store-file <path>       Output JSONL file (default: .rivet/benchmark/runs.jsonl)
  --dry-run                 Generate blocked records without live execution
  --workspace <path>        Isolated workspace for a live benchmark (required)
  --agent-entry <path>      Built headless CLI entry (default: dist/main.js)
  --allow-write-tools       Pass the explicit headless write-tools opt-in
  --help, -h                Show this help

Example:
  npm run benchmark -- --suite benchmark/tasks/r1-local-coding-smoke.json \\
    --suite-id r1-local-coding-smoke --provider deepseek \\
    --model deepseek-v4-pro --dry-run
`)
  process.exit(0)
}

if (values.help) showHelp()

if (!values.suite || !values['suite-id']) {
  console.error('Error: --suite and --suite-id are required')
  console.error('Use --help for usage info')
  process.exit(1)
}

if (!values['dry-run'] && !values.workspace) {
  console.error('Error: live benchmarks require --workspace <isolated path>')
  process.exit(1)
}

const suite = loadTaskSuite(values.suite)
const executor = values['dry-run']
  ? undefined
  : createRivetCliBenchmarkExecutor({
      cwd: resolve(values.workspace!),
      entryPoint: resolve(values['agent-entry']),
      allowWriteTools: values['allow-write-tools'],
    })
const report = await runBenchmark({
  suite,
  suiteId: values['suite-id'],
  provider: values.provider,
  model: values.model,
  storeFile: values['store-file'],
  dryRun: values['dry-run'],
  executor,
})

console.log(`\nBenchmark complete: ${report.runs.length} task(s)`)
for (const run of report.runs) {
  console.log(`  ${run.taskId} → ${run.status}`)
}
console.log(`\nResults written to: ${values['store-file']}`)
