import { spawn } from 'child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolCallParams } from './types.js'
import { track } from './process-tracker.js'
import { persistRawOutput, buildUiOutput } from './output-store.js'

function detectTestCommand(cwd: string): { base: string; runner: string } {
  const pkgPath = join(cwd, 'package.json')
  if (!existsSync(pkgPath)) {
    return { base: 'npm test', runner: 'npm' }
  }

  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { scripts?: { test?: string } }
  const testScript = pkg.scripts?.test ?? ''

  if (testScript.includes('vitest')) return { base: 'npx vitest run', runner: 'vitest' }
  if (testScript.includes('jest')) return { base: 'npx jest', runner: 'jest' }
  if (testScript.includes('tsx --test') || testScript.includes('node:test')) {
    return { base: testScript, runner: 'node-test' }
  }

  return { base: 'npm test', runner: 'npm' }
}

interface ParsedResult {
  exitCode: number
  passed: number
  failed: number
  skipped: number
  duration: string
  failures: Array<{ name: string; error: string }>
}

function asNum(s: string | undefined, fallback = 0): number {
  return s ? parseInt(s, 10) : fallback
}

function parseOutput(raw: string, runner: string): ParsedResult {
  const result: ParsedResult = {
    exitCode: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    duration: '',
    failures: [],
  }

  if (runner === 'vitest' || runner === 'npm') {
    const summaryMatch = raw.match(/Tests\s+(.*?)$/m)
    if (summaryMatch) {
      const s = summaryMatch[1] ?? ''
      result.failed = asNum(s.match(/(\d+)\s+failed/)?.[1])
      result.passed = asNum(s.match(/(\d+)\s+passed/)?.[1])
      result.skipped = asNum(s.match(/(\d+)\s+skipped/)?.[1])
    }
    const durMatch = raw.match(/Duration\s+([\d.]+s)/)
    if (durMatch) result.duration = durMatch[1] ?? ''
  }

  if (runner === 'node-test') {
    const totalMatch = raw.match(/[ℹ#]\s+tests\s+(\d+)/)
    const failMatch = raw.match(/[ℹ#]\s+fail\s+(\d+)/)
    const skipMatch = raw.match(/[ℹ#]\s+skip\s+(\d+)/)
    const passMatch = raw.match(/[ℹ#]\s+pass\s+(\d+)/)
    const durMatch = raw.match(/[ℹ#]\s+duration\s+([\d.]+m?s)/)
    const total = asNum(totalMatch?.[1])
    const fails = asNum(failMatch?.[1])
    const skips = asNum(skipMatch?.[1])
    const passes = asNum(passMatch?.[1])
    if (total > 0) {
      result.passed = passes > 0 ? passes : total - fails - skips
      result.failed = fails
      result.skipped = skips
    }
    if (durMatch) result.duration = durMatch[1] ?? ''
  }

  if (runner === 'jest') {
    const summaryMatch = raw.match(/Tests:\s+(.*?)$/m)
    if (summaryMatch) {
      const s = summaryMatch[1] ?? ''
      result.failed = asNum(s.match(/(\d+)\s+failed/)?.[1])
      result.passed = asNum(s.match(/(\d+)\s+passed/)?.[1])
      result.skipped = asNum(s.match(/(\d+)\s+skipped/)?.[1])
    }
    const durMatch = raw.match(/Time:\s+([\d.]+s)/)
    if (durMatch) result.duration = durMatch[1] ?? ''
  }

  // Extract failure details
  const failLines: Array<{ name: string; error: string }> = []
  // Node 22 test runner: ✖ test_name (duration)
  const nodeTestFails = raw.matchAll(/✖\s+(.+?)(?:\s+\([\d.]+m?s\))?\n((?:  .*\n)*)/g)
  for (const m of nodeTestFails) {
    failLines.push({ name: (m[1] ?? '').trim(), error: (m[2] ?? '').trim() })
  }
  const vitestFails = raw.matchAll(/FAIL\s+(.+)\n((?:  .*\n|\t.*\n)*)/g)
  for (const m of vitestFails) {
    failLines.push({ name: (m[1] ?? '').trim(), error: (m[2] ?? '').trim() })
  }
  result.failures = failLines

  return result
}

function formatOutput(result: ParsedResult): string {
  const lines: string[] = []
  lines.push(`Exit code: ${result.exitCode}`)
  lines.push(`${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped`)

  if (result.failures.length > 0) {
    lines.push('FAILURES:')
    for (const f of result.failures) {
      lines.push(`  ✖ ${f.name}`)
      if (f.error) {
        const errorLines = f.error.split('\n').slice(0, 5)
        for (const el of errorLines) {
          lines.push(`    ${el}`)
        }
      }
    }
  }

  if (result.duration) {
    lines.push(`Duration: ${result.duration}`)
  }

  return lines.join('\n')
}

const MAX_OUTPUT = 8000
const HEAD_CHARS = 4000
const TAIL_CHARS = 3000

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT) return output
  const head = output.slice(0, HEAD_CHARS)
  const tail = output.slice(-TAIL_CHARS)
  const omitted = output.length - HEAD_CHARS - TAIL_CHARS
  return `${head}\n... (${omitted} chars omitted) ...\n${tail}`
}

export const RUN_TESTS_TOOL: Tool = {
  definition: {
    name: 'run_tests',
    description: `Run project tests and return parsed results.

### Usage
- Use run_tests to verify changes after editing code
- Use filter to run a specific test file or test name
- Automatically detects package manager and test command from package.json
- Reports: exit code, failed tests, error details, duration

### Examples
Good: run_tests() — run all tests
Good: run_tests(filter="loop.test.ts") — run specific test file
Good: run_tests(timeout=300000) — longer timeout for slow suites`,
    input_schema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: 'Test file or name pattern' },
        timeout: { type: 'integer', description: 'Timeout in ms (default: 120000)' },
      },
    },
  },

  async execute(params: ToolCallParams) {
    const filter = params.input.filter as string | undefined
    const timeout = (params.input.timeout as number) ?? 120_000
    const startTime = Date.now()
    const { base, runner } = detectTestCommand(params.cwd)

    // Build safe argv array — no shell interpolation to prevent injection
    const commandDisplay = filter ? `${base} ${filter}` : base
    let argv = ['sh', '-c', base]
    if (filter) {
      // Validate filter: no shell metacharacters
      const safeFilter = filter.replace(/[`$\\;"'|]/g, '')
      if (runner === 'vitest') {
        argv = ['sh', '-c', base, '--', safeFilter]
      } else if (runner === 'jest') {
        argv = ['sh', '-c', `${base} --testPathPattern`, '--', safeFilter]
      } else if (runner === 'node-test') {
        argv = ['sh', '-c', base, '--', safeFilter]
      } else {
        argv = ['sh', '-c', base, '--', safeFilter]
      }
    }

    return new Promise((resolve) => {
      const child = track(spawn(argv[0]!, argv.slice(1), {
        cwd: params.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }))

      let stdout = ''
      let stderr = ''

      let onOutputBudget = 20_000

      child.stdout!.on('data', (data: Buffer) => {
        const text = data.toString()
        stdout += text
        if (onOutputBudget > 0) {
          const chunk = text.slice(0, onOutputBudget)
          onOutputBudget -= chunk.length
          params.onOutput?.(chunk)
        }
        if (stdout.length > 100_000) {
          stdout = stdout.slice(-80_000)
        }
      })

      child.stderr!.on('data', (data: Buffer) => {
        const text = data.toString()
        stderr += text
        if (onOutputBudget > 0) {
          const chunk = text.slice(0, onOutputBudget)
          onOutputBudget -= chunk.length
          params.onOutput?.(chunk)
        }
        if (stderr.length > 100_000) {
          stderr = stderr.slice(-80_000)
        }
      })

      const timer = setTimeout(async () => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 3000)
        const raw = stdout + (stderr ? '\n' + stderr : '')
        const meta = { command: commandDisplay, exitCode: -1, durationMs: Date.now() - startTime }
        const rawPath = await persistRawOutput(params.toolUseId, raw)
        resolve({
          content: 'Tests timed out',
          uiContent: buildUiOutput(raw, meta),
          rawPath,
          isError: true,
        })
      }, timeout)

      child.on('close', async (code) => {
        clearTimeout(timer)
        const raw = stdout + (stderr ? '\n' + stderr : '')
        const durationMs = Date.now() - startTime
        const exitCode = code ?? 1

        const parsed = parseOutput(raw, runner)
        parsed.exitCode = exitCode
        const formatted = formatOutput(parsed)
        const truncated = truncateOutput(formatted)
        const rawPath = await persistRawOutput(params.toolUseId, raw)
        const meta = { command: commandDisplay, exitCode, durationMs }

        resolve({
          content: truncated,
          uiContent: buildUiOutput(raw, meta),
          rawPath,
          isError: exitCode !== 0,
        })
      })

      child.on('error', async (err) => {
        clearTimeout(timer)
        const rawPath = await persistRawOutput(params.toolUseId, err.message)
        resolve({
          content: err.message,
          uiContent: err.message,
          rawPath,
          isError: true,
        })
      })
    })
  },

  requiresApproval(): boolean {
    return false
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
