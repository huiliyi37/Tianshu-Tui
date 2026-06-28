import { spawn } from 'node:child_process'
import { glob, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const args = process.argv.slice(2)
const includeTui = !args.includes('--exclude-tui')
const integrationOnly = args.includes('--integration')
const unitOnly = args.includes('--unit') || args.includes('--fast') || args.includes('--exclude-tui')

const PROJECT_TMP = join(process.cwd(), '.test-tmp')
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
