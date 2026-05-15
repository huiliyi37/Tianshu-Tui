import { spawn } from 'child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import type { Tool, ToolCallParams } from './types.js'
import { track } from './process-tracker.js'

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
    const totalMatch = raw.match(/#\s+tests\s+(\d+)/)
    const failMatch = raw.match(/#\s+fail\s+(\d+)/)
    const skipMatch = raw.match(/#\s+skip\s+(\d+)/)
    const passMatch = raw.match(/#\s+pass\s+(\d+)/)
    const durMatch = raw.match(/#\s+duration\s+([\d.]+m?s)/)
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
  const nodeTestFails = raw.matchAll(/not ok \d+ - (.+)\n((?:  .*\n)*)/g)
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

    let command = base
    if (filter) {
      if (runner === 'vitest') {
        command = `${base} "${filter}"`
      } else if (runner === 'jest') {
        command = `${base} --testPathPattern="${filter}"`
      } else if (runner === 'node-test') {
        command = `${base} ${filter}`
      } else {
        command = `${base} -- ${filter}`
      }
    }

    return new Promise((resolve) => {
      const child = track(spawn('sh', ['-c', command], {
        cwd: params.cwd,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
      }))

      let stdout = ''
      let stderr = ''

      child.stdout!.on('data', (data: Buffer) => {
        const text = data.toString()
        stdout += text
        params.onOutput?.(text)
        if (stdout.length > 100_000) {
          stdout = stdout.slice(-80_000)
        }
      })

      child.stderr!.on('data', (data: Buffer) => {
        const text = data.toString()
        stderr += text
        params.onOutput?.(text)
        if (stderr.length > 100_000) {
          stderr = stderr.slice(-80_000)
        }
      })

      const buildResult = (code: number, isTimeout = false) => {
        const raw = stdout + (stderr ? '\n' + stderr : '')
        const durationMs = Date.now() - startTime
        const exitCode = isTimeout ? -1 : code
        if (isTimeout) {
          return {
            content: 'Tests timed out',
            isError: true,
          }
        }

        const parsed = parseOutput(raw, runner)
        parsed.exitCode = exitCode
        const formatted = formatOutput(parsed)

        return {
          content: truncateOutput(formatted),
          isError: exitCode !== 0,
        }
      }

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        setTimeout(() => child.kill('SIGKILL'), 3000)
        resolve(buildResult(0, true))
      }, timeout)

      child.on('close', (code) => {
        clearTimeout(timer)
        resolve(buildResult(code ?? 1))
      })

      child.on('error', (err) => {
        clearTimeout(timer)
        resolve({ content: err.message, isError: true })
      })
    })
  },

  requiresApproval(): boolean {
    return false
  },

  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
