import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { BenchmarkFailure, BenchmarkMetrics, BenchmarkStatus, TaskDefinition } from './types.js'

export interface BenchmarkExecutionResult {
  status: BenchmarkStatus
  metrics?: Partial<BenchmarkMetrics>
  failures?: BenchmarkFailure[]
}

export interface BenchmarkExecutor {
  execute(task: TaskDefinition): Promise<BenchmarkExecutionResult>
}

export interface RivetCliBenchmarkExecutorOptions {
  cwd: string
  entryPoint: string
  allowWriteTools?: boolean
  env?: NodeJS.ProcessEnv
}

interface ProcessResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

interface StreamSummary {
  metrics: BenchmarkMetrics
  resultError?: string
}

function runProcess(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<ProcessResult> {
  return new Promise(resolve => {
    const child = spawn(command, args, {
      cwd,
      env: env ?? process.env,
      shell: false,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => {
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
    })
    child.once('close', exitCode => {
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    })
  })
}

async function runShellCommand(command: string, cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<ProcessResult> {
  return new Promise(resolve => {
    const child = spawn(command, [], {
      cwd,
      env: env ?? process.env,
      shell: true,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.once('error', error => {
      clearTimeout(timer)
      resolve({ exitCode: null, stdout, stderr: `${stderr}${error.message}`, timedOut })
    })
    child.once('close', exitCode => {
      clearTimeout(timer)
      resolve({ exitCode, stdout, stderr, timedOut })
    })
  })
}

function failure(className: string, message: string): BenchmarkExecutionResult {
  return {
    status: 'failed',
    failures: [{ class: className, message: message.slice(0, 1000) }],
  }
}

function numberAt(value: unknown, keys: string[]): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const source = value as Record<string, unknown>
  for (const key of keys) {
    const candidate = source[key]
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate
  }
  return undefined
}

/** Parse Tianshu's stable headless NDJSON stream without coupling to AgentLoop. */
export function summarizeStreamJson(stdout: string): StreamSummary {
  let turns = 0
  let toolCalls = 0
  let usage: unknown
  let resultError: string | undefined

  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const event = JSON.parse(line) as Record<string, unknown>
      if (event.type === 'tool_use') toolCalls++
      if (event.type === 'turn_complete') {
        turns++
        usage = event.usage
      }
      if (event.type === 'result') {
        usage = event.usage ?? usage
        if (event.is_error === true) resultError = typeof event.result === 'string' ? event.result : 'Agent reported an error'
      }
      if (event.type === 'error') resultError = typeof event.error === 'string' ? event.error : 'Agent reported an error'
    } catch {
      // Providers or process diagnostics may write non-NDJSON lines. They are
      // retained in the process failure message but do not invalidate metrics.
    }
  }

  const inputTokens = numberAt(usage, ['inputTokens', 'input_tokens'])
  const cacheReadTokens = numberAt(usage, ['cacheReadInputTokens', 'cache_read_input_tokens'])
  const costUsd = numberAt(usage, ['costUsd', 'cost_usd'])
  const cacheHitRate = inputTokens && inputTokens > 0 && cacheReadTokens !== undefined
    ? Math.min(1, Math.max(0, cacheReadTokens / inputTokens))
    : undefined

  return {
    metrics: {
      turns,
      toolCalls,
      retries: 0,
      ...(cacheHitRate !== undefined ? { cacheHitRate } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
    },
    ...(resultError ? { resultError } : {}),
  }
}

/**
 * Executes one task through the published headless CLI and verifies its task
 * contract. Callers must provide an isolated workspace for code-edit tasks.
 */
export function createRivetCliBenchmarkExecutor(options: RivetCliBenchmarkExecutorOptions): BenchmarkExecutor {
  return {
    async execute(task): Promise<BenchmarkExecutionResult> {
      if (!existsSync(options.entryPoint)) {
        return failure('agent_entry_missing', `Agent entry point does not exist: ${options.entryPoint}`)
      }

      for (const command of task.setupCommands) {
        const result = await runShellCommand(command, options.cwd, task.timeoutMs, options.env)
        if (result.timedOut) return failure('setup_timeout', `Setup command timed out: ${command}`)
        if (result.exitCode !== 0) return failure('setup_failed', `Setup command failed (${result.exitCode}): ${command}\n${result.stderr || result.stdout}`)
      }

      const args = [options.entryPoint, '--print', task.prompt, '--stream-json']
      if (options.allowWriteTools) args.push('--dangerously-skip-permissions')
      const agent = await runProcess(process.execPath, args, options.cwd, task.timeoutMs, options.env)
      const summary = summarizeStreamJson(agent.stdout)
      if (agent.timedOut) return { ...failure('agent_timeout', `Agent timed out after ${task.timeoutMs}ms`), metrics: summary.metrics }
      if (agent.exitCode !== 0 || summary.resultError) {
        return {
          ...failure('agent_failed', summary.resultError ?? `Agent exited with ${agent.exitCode}: ${agent.stderr || agent.stdout}`),
          metrics: summary.metrics,
        }
      }

      for (const command of task.successCommands) {
        const result = await runShellCommand(command, options.cwd, task.timeoutMs, options.env)
        if (result.timedOut) return { ...failure('verification_timeout', `Verification command timed out: ${command}`), metrics: summary.metrics }
        if (result.exitCode !== 0) {
          return {
            ...failure('verification_failed', `Verification command failed (${result.exitCode}): ${command}\n${result.stderr || result.stdout}`),
            metrics: summary.metrics,
          }
        }
      }

      return { status: 'passed', metrics: summary.metrics }
    },
  }
}
