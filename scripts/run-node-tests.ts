import { spawn } from 'node:child_process'
import { glob, mkdir } from 'node:fs/promises'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const includeTui = !args.includes('--exclude-tui')
const integrationOnly = args.includes('--integration')
const unitOnly = args.includes('--unit') || args.includes('--fast') || args.includes('--exclude-tui')

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
  const isIntegration = file.includes('/integration/')
  if (integrationOnly && !isIntegration) continue
  if (unitOnly && isIntegration) continue
  if (!includeTui && file.includes('/tui/__tests__/')) continue
  files.push(file)
}
files.sort()

if (files.length === 0) {
  console.error('No test files found')
  process.exit(1)
}

const child = spawn(process.execPath, ['--import', 'tsx', '--test-force-exit', '--test', ...files], {
  stdio: 'inherit',
  shell: false,
  env: {
    ...process.env,
    TMPDIR: PROJECT_TMP,
    TMP: PROJECT_TMP,
    TEMP: PROJECT_TMP,
    // When the fallback in-repo temp dir is in use, stop git repo discovery
    // from walking up out of it into the real repo (test fixtures created via
    // mkdtemp expect "not a git repo"). Harmless for the OS temp dir case.
    GIT_CEILING_DIRECTORIES: PROJECT_TMP,
  },
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 1)
})

child.on('error', (err) => {
  console.error(err)
  process.exit(1)
})
