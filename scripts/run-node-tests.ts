import { spawn } from 'node:child_process'
import { glob, mkdir } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const includeTui = !args.includes('--exclude-tui')
const integrationOnly = args.includes('--integration')
const unitOnly = args.includes('--unit') || args.includes('--fast') || args.includes('--exclude-tui')

// Positional (non-flag) args are substring filters over the file path, e.g.
// `npm test src/tools/web-search` runs only matching test files. Paths are
// normalized to forward slashes so Windows-style `\` filters also match.
const pathFilters = args
  .filter(a => !a.startsWith('--'))
  .map(a => a.replace(/\\/g, '/'))

// Temp dir policy: tests MUST get a temp dir OUTSIDE the repo when possible.
// An in-repo temp dir breaks fixture hermeticity — mkdtemp fixtures inside the
// repo let git discovery, node module resolution, tsc/tsconfig lookup and
// .rivet-config walk-up all "see" the real repo, which flips a dozen tests
// (checkpoint/git/worktree/theta/native-resolver/layered-config...).
// The in-repo .test-tmp fallback exists only for sandboxed runs where the OS
// temp dir is not writable (the original EPERM issue, commit 7cc487b2).
function resolveTestTmp(): string {
  try {
    const probe = mkdtempSync(join(tmpdir(), 'rivet-tmp-probe-'))
    rmSync(probe, { recursive: true, force: true })
    return tmpdir()
  } catch {
    return join(process.cwd(), '.test-tmp')
  }
}

const PROJECT_TMP = resolveTestTmp()
await mkdir(PROJECT_TMP, { recursive: true })

const files: string[] = []
for await (const file of glob('src/**/*.test.ts')) {
  const normalized = file.replace(/\\/g, '/')
  const isIntegration = normalized.includes('/integration/')
  if (integrationOnly && !isIntegration) continue
  if (unitOnly && isIntegration) continue
  if (!includeTui && normalized.includes('/tui/__tests__/')) continue
  if (pathFilters.length > 0 && !pathFilters.some(f => normalized.includes(f))) continue
  files.push(file)
}
files.sort()

if (files.length === 0) {
  console.error(
    pathFilters.length > 0
      ? `No test files matched: ${pathFilters.join(', ')}`
      : 'No test files found',
  )
  process.exit(1)
}

const testEnv = {
  ...process.env,
  TMPDIR: PROJECT_TMP,
  TMP: PROJECT_TMP,
  TEMP: PROJECT_TMP,
  // When the fallback in-repo temp dir is in use, stop git repo discovery
  // from walking up out of it into the real repo (test fixtures created via
  // mkdtemp expect "not a git repo"). Harmless for the OS temp dir case.
  GIT_CEILING_DIRECTORIES: PROJECT_TMP,
}

const NODE_FLAGS = ['--import', 'tsx', '--test-force-exit', '--test']

// Windows caps a process command line at ~32767 chars; passing all ~900 test
// files at once overflows it (ENAMETOOLONG). Chunk the file list by cumulative
// arg length so each spawn stays well under the limit. node runs each test file
// in its own child regardless, so batching across invocations is equivalent.
const FIXED_LEN = process.execPath.length + NODE_FLAGS.join(' ').length + 8
const MAX_ARGS_LEN = 24_000 - FIXED_LEN

function batchFiles(all: string[]): string[][] {
  const batches: string[][] = []
  let current: string[] = []
  let len = 0
  for (const file of all) {
    const cost = file.length + 3 // path + quotes/space overhead
    if (current.length > 0 && len + cost > MAX_ARGS_LEN) {
      batches.push(current)
      current = []
      len = 0
    }
    current.push(file)
    len += cost
  }
  if (current.length > 0) batches.push(current)
  return batches
}

function runBatch(batch: string[]): Promise<number> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...NODE_FLAGS, ...batch], {
      stdio: 'inherit',
      shell: false,
      env: testEnv,
    })
    child.on('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal)
        return
      }
      resolve(code ?? 1)
    })
    child.on('error', err => {
      console.error(err)
      resolve(1)
    })
  })
}

const batches = batchFiles(files)
if (batches.length > 1) {
  console.error(`Running ${files.length} test files in ${batches.length} batches (Windows cmdline limit)`)
}

let worstExit = 0
for (const batch of batches) {
  const code = await runBatch(batch)
  if (code !== 0) worstExit = code
}
process.exit(worstExit)
