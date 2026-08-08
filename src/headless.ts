import type { Usage } from './api/types.js'
import type { AgentCallbacks, AgentLoop } from './agent/loop.js'
import { serializeEvent } from './stream-json.js'
import { redactText, redactValue } from './server/redact.js'

export interface HeadlessCliArgs {
  headless: boolean
  prompt?: string
  json: boolean
  streamJson: boolean
  goal?: string
  budget?: number
}

export interface HeadlessJsonOutput {
  success: boolean
  text: string
  usage?: Partial<Usage>
  error?: string
}

export interface HeadlessRunResult {
  exitCode: number
  stdout: string
  stderr?: string
  json?: HeadlessJsonOutput
}

export interface HeadlessAgent {
  run(prompt: string, callbacks: AgentCallbacks): Promise<void>
}

export interface HeadlessRunConfig {
  prompt: string
  json: boolean
  streamJson: boolean
  /** For the stream-json `system/init` + `result` envelopes. Optional so the
   *  existing text/json callers stay unchanged. */
  sessionId?: string
  model?: string
  createAgent: () => Pick<AgentLoop, 'run'> | HeadlessAgent
}

export function parseCliArgs(args: string[]): HeadlessCliArgs {
  const printIndex = args.findIndex(arg => arg === '-p' || arg === '--print')
  const goalIndex = args.findIndex(arg => arg === '--goal')
  const json = args.includes('--json')
  const streamJson = args.includes('--stream-json')

  if (goalIndex >= 0) {
    const goal = args[goalIndex + 1]
    const budgetIndex = args.indexOf('--budget')
    const budget = budgetIndex >= 0 ? parseInt(args[budgetIndex + 1]!, 10) : 100
    return { headless: true, prompt: undefined, json, streamJson, goal, budget }
  }

  if (printIndex === -1) return { headless: false, json, streamJson }

  const prompt = args[printIndex + 1]
  return { headless: true, prompt, json, streamJson }
}

export async function runHeadless(config: HeadlessRunConfig): Promise<HeadlessRunResult> {
  const agent = config.createAgent()
  let text = ''
  let usage: Partial<Usage> | undefined
  let error: string | undefined

  // 脱敏纪律与 sidecar/event-tap 同口径：stdout 进 CI 日志即成泄漏面。
  const emit = (ev: import('./stream-json.js').StreamJsonEvent) => process.stdout.write(serializeEvent(ev))

  const callbacks: AgentCallbacks = config.streamJson
    ? {
        onTextDelta: delta => { text += delta; emit({ type: 'text_delta', text: redactText(delta) }) },
        onThinkingDelta: delta => emit({ type: 'thinking_delta', text: redactText(delta) }),
        onToolUse: (id, name, input) => emit({ type: 'tool_use', id, name, input: redactValue(input) as Record<string, unknown> }),
        onToolResult: (id, name, result, isError) => {
          if (isError) error = result
          emit({ type: 'tool_result', id, name, result: redactText(result), isError: isError ?? false })
        },
        onTurnComplete: (turnUsage, turnNumber, isFinal) => {
          usage = turnUsage
          emit({ type: 'turn_complete', usage: turnUsage, turn: turnNumber, is_final: isFinal ?? false })
        },
        onPhaseChange: (phase, detail) => emit({ type: 'phase', phase, tool: detail?.tool, reason: detail?.reason }),
        onDelegationActivity: activity => emit({
          type: 'worker',
          work_order_id: activity.workOrderId,
          parent_tool_id: activity.parentToolId,
          status: activity.status,
          profile: activity.profile,
          authority: activity.authority,
          objective: activity.objective,
          progress_line: activity.progressLine ? redactText(activity.progressLine) : undefined,
          tool_use_count: activity.toolUseCount,
          token_count: activity.tokenCount,
          model: activity.model,
          failure_reason: activity.failureReason,
        }),
        onError: err => { error = err.message; emit({ type: 'error', error: redactText(err.message) }) },
        onAbort: () => { error = 'Aborted' },
        onApprovalRequired: async () => false,
      }
    : {
        onTextDelta: delta => { text += delta },
        onThinkingDelta: () => {},
        onToolUse: () => {},
        onToolResult: (_id, _name, result, isError) => { if (isError) error = result },
        onTurnComplete: turnUsage => { usage = turnUsage },
        onError: err => { error = err.message },
        onAbort: () => { error = 'Aborted' },
        onApprovalRequired: async () => false,
      }

  if (config.streamJson) {
    emit({ type: 'system', subtype: 'init', session_id: config.sessionId ?? '', model: config.model ?? '', cwd: process.cwd() })
  }

  await agent.run(config.prompt, callbacks)

  const success = !error
  if (config.streamJson) {
    emit({
      type: 'result',
      subtype: success ? 'success' : 'error',
      session_id: config.sessionId ?? '',
      is_error: !success,
      result: redactText(success ? text : (error ?? 'Unknown error')),
      ...(usage ? { usage } : {}),
    })
  }

  const payload: HeadlessJsonOutput = success
    ? { success: true, text, ...(usage ? { usage } : {}) }
    : { success: false, text, error: error ?? 'Unknown error' }

  const stdout = config.json ? JSON.stringify(payload) : config.streamJson ? '' : payload.text

  return {
    exitCode: success ? 0 : 1,
    stdout,
    // 失败必须有出口：非 JSON 模式下 stdout 只承载 payload.text，模型一个字
    // 没输出就失败时（provider 报错、鉴权失败、模型名非法）text 为空串，
    // error 又只存在于 payload.json——json 未开时整条错误信息就此蒸发，
    // 用户看到的是 exit 1 加全空输出。stderr 字段此前定义了却从未被写过。
    ...(success ? {} : { stderr: error ?? 'Unknown error' }),
    // streamJson 的终止态已由 result 信封承载——遗留 payload 一并输出会在同一条
    // NDJSON 流里出现两个 schema 的收尾（且无 type 字段），消费者按 type 分派
    // 会在最后一行拿到 undefined。
    json: config.json ? payload : undefined,
  }
}
