import type { Tool, ToolCallParams, ToolResult } from './types.js'
import { sandboxExec } from './sandbox-exec.js'

const SANDBOX_EXEC_DEFINITION = {
  name: 'sandbox_exec',
  description: [
    'Execute JavaScript code in an isolated Node.js child process.',
    'Use this for data processing where you only need the final result, not intermediate output.',
    'Examples: parse a JSON file and extract one field, compute aggregate stats, transform a list.',
    'Environment is stripped (no access to secrets); cwd is the project root.',
    'Output is truncated to 8000 chars by default. Timeout is 3s by default.',
    'DO NOT use for: file edits (use edit_file), shell commands (use bash), long-running tasks.',
  ].join(' '),
  input_schema: {
    type: 'object' as const,
    properties: {
      code: {
        type: 'string' as const,
        description: 'JavaScript code to execute. Use console.log to return values to context.',
      },
      timeout_ms: {
        type: 'number' as const,
        description: 'Optional timeout in milliseconds. Default: 3000.',
      },
      max_output_chars: {
        type: 'number' as const,
        description: 'Optional output truncation cap. Default: 8000.',
      },
    },
    required: ['code'],
  },
}

export const SANDBOX_EXEC_TOOL: Tool = {
  definition: SANDBOX_EXEC_DEFINITION,
  async execute(params: ToolCallParams): Promise<ToolResult> {
    const code = String(params.input.code ?? '')
    if (!code.trim()) {
      return {
        content: '[sandbox_exec] error: empty code',
        isError: true,
      }
    }
    const timeoutMs = typeof params.input.timeout_ms === 'number' ? params.input.timeout_ms : 3000
    const maxOutputChars = typeof params.input.max_output_chars === 'number' ? params.input.max_output_chars : 8000

    const result = await sandboxExec(code, {
      timeoutMs,
      maxOutputChars,
      cwd: params.cwd,
    })

    const isError = result.exitCode !== 0
    const header = `[sandbox_exec] exit=${result.exitCode}`
    const body = isError
      ? `${header}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      : `${header}\n${result.stdout}`

    return { content: body, isError }
  },
  requiresApproval(): boolean { return true },
  isConcurrencySafe(): boolean { return true },
  isEnabled(): boolean { return true },
}
