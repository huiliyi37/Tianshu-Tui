import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentLoop } from '../loop.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { ToolRegistry } from '../../tools/registry.js'
import { WRITE_FILE_TOOL } from '../../tools/write-file.js'
import type { Tool } from '../../tools/types.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'
import type { AgentCallbacks } from '../loop-types.js'

// P0-1 polling-storm guard: repeated successful observation-tool calls must end
// the run with a final turn_complete (not an abort) once the storm persists
// across turns without file progress.

const TEST_CWD = mkdtempSync(join(tmpdir(), 'rivet-polling-storm-'))

const POLL_TOOL: Tool = {
  definition: {
    name: 'job',
    description: 'poll fixture',
    input_schema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['list'] } },
      required: ['action'],
    },
  },
  execute: async () => ({ content: '[job] running=0', isError: false }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function makeEngine(definitions: Tool['definition'][]): PromptEngine {
  return new PromptEngine({
    model: 'deepseek-v4-pro',
    maxTokens: 1024,
    staticCtx: { tools: definitions },
    volatileCtx: { cwd: TEST_CWD },
  })
}

/** Emits one successful job(list) call per model turn, forever. */
function makePollingClient(): StreamClient & { calls: () => number } {
  let callCount = 0
  return {
    calls: () => callCount,
    stream: async (_req: unknown, cb: StreamCallbacks) => {
      callCount++
      cb.onContentBlock({
        type: 'tool_use',
        id: `tu_${callCount}`,
        name: 'job',
        input: { action: 'list' },
      })
      cb.onStopReason('tool_use', { input_tokens: 120, output_tokens: 30 })
    },
  } as unknown as StreamClient & { calls: () => number }
}

function makeCallbacks(collect: { stops: string[]; finals: number; aborts: number }): AgentCallbacks {
  return {
    onTextDelta: () => {},
    onThinkingDelta: () => {},
    onToolUse: () => {},
    onToolResult: () => {},
    onTurnComplete: (_usage, _turn, isFinal) => { if (isFinal) collect.finals++ },
    onError: (error: Error) => { throw error },
    onAbort: () => { collect.aborts++ },
    onApprovalRequired: async () => true,
    onPhaseChange: (phase, detail) => {
      if (phase === 'stop-reason' && detail?.reason) collect.stops.push(detail.reason)
    },
  }
}

/** 8 次 job 风暴 → 1 次真实写入（推进信号）→ 5 次 job → 自然收尾。 */
function makeProgressResetClient(): StreamClient & { calls: () => number } {
  let callCount = 0
  return {
    calls: () => callCount,
    stream: async (_req: unknown, cb: StreamCallbacks) => {
      callCount++
      if (callCount <= 10) {
        cb.onContentBlock({ type: 'tool_use', id: `tu_${callCount}`, name: 'job', input: { action: 'list' } })
        cb.onStopReason('tool_use', { input_tokens: 120, output_tokens: 30 })
        return
      }
      if (callCount === 11) {
        cb.onContentBlock({
          type: 'tool_use',
          id: `tu_${callCount}`,
          name: 'write_file',
          input: { file_path: join(TEST_CWD, 'progress.txt'), content: 'progress' },
        })
        cb.onStopReason('tool_use', { input_tokens: 120, output_tokens: 30 })
        return
      }
      if (callCount <= 16) {
        cb.onContentBlock({ type: 'tool_use', id: `tu_${callCount}`, name: 'job', input: { action: 'list' } })
        cb.onStopReason('tool_use', { input_tokens: 120, output_tokens: 30 })
        return
      }
      cb.onTextDelta('done')
      cb.onContentBlock({ type: 'text', text: 'done' })
      cb.onStopReason('end_turn', { input_tokens: 120, output_tokens: 30 })
    },
  } as unknown as StreamClient & { calls: () => number }
}

function makeAgent(client: StreamClient, extraTool?: Tool): AgentLoop {
  const registry = new ToolRegistry()
  registry.register(POLL_TOOL)
  if (extraTool) registry.register(extraTool)
  const definitions = extraTool
    ? [POLL_TOOL.definition, extraTool.definition]
    : [POLL_TOOL.definition]
  return new AgentLoop({
    client,
    promptEngine: makeEngine(definitions),
    toolRegistry: registry,
    maxTurns: 40,
    contextWindow: 200_000,
    approvalMode: 'dangerously-skip-permissions',
    compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
  }, new SessionContext(), TEST_CWD)
}

describe('TurnOrchestrator: polling-storm guard (P0-1)', () => {
  it('ends a successful job-polling run with tool-storm final turn_complete', async () => {
    const client = makePollingClient()
    const collect = { stops: [] as string[], finals: 0, aborts: 0 }
    const prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_SESSION_DIR = join(TEST_CWD, '.sessions')
    const agent = makeAgent(client)

    try {
      await agent.run('keep polling job status', makeCallbacks(collect))
    } finally {
      if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
      else process.env.RIVET_SESSION_DIR = prevSessionDir
    }

    assert.ok(client.calls() >= 8, 'guard only arms after the storm threshold')
    assert.ok(client.calls() < 40, `run must be terminated by the guard, got ${client.calls()} calls`)
    assert.equal(collect.finals, 1, 'guard stop is a final completion (UI busy latch released)')
    assert.equal(collect.aborts, 0, 'polling guard must not surface as a bare user abort')
    assert.ok(collect.stops.some(s => s.includes('轮询风暴')), `expected tool-storm stop reason, got: ${collect.stops.join(' | ')}`)
  })

  it('file progress resets the polling-storm streak (no false abort)', async () => {
    const client = makeProgressResetClient()
    const collect = { stops: [] as string[], finals: 0, aborts: 0 }
    const prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_SESSION_DIR = join(TEST_CWD, '.sessions-reset')
    const agent = makeAgent(client, WRITE_FILE_TOOL)

    try {
      await agent.run('poll, make progress, then poll a little more', makeCallbacks(collect))
    } finally {
      if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
      else process.env.RIVET_SESSION_DIR = prevSessionDir
    }

    assert.equal(client.calls(), 17, 'write_file progress must let the run reach its natural finish')
    assert.equal(collect.finals, 1)
    assert.equal(collect.aborts, 0)
    assert.ok(collect.stops.every(s => !s.includes('轮询风暴')), `progress must suppress the guard, got: ${collect.stops.join(' | ')}`)
  })
})
