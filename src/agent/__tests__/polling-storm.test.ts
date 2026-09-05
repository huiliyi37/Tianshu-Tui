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

// 只读调研 fixture：read_file 不在 pollingClassOf 候选集（trace-store.ts:174
// POLLING_CLASS_TOOLS 无 read_file）——它的轮次不向 polling 系列追加记录，
// 修复前的 streak 冻结帧里这类合法只读轮会被迟到熔断（RED 反例的核心）。
const READ_TOOL: Tool = {
  definition: {
    name: 'read_file',
    description: 'read fixture',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
  execute: async () => ({ content: '[read] fixture content', isError: false }),
  requiresApproval: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

// bash 查询 fixture：真实 bash 工具语义（命令归一进 polling 系列）。
const BASH_TOOL: Tool = {
  definition: {
    name: 'bash',
    description: 'bash fixture',
    input_schema: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
    },
  },
  execute: async () => ({ content: '[bash] ok', isError: false }),
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

  // ── 2026-09-05 迟到误杀修复反例 ─────────────────────────────────────────
  // job×10（8 连 storm + streak 到 3 触发 warn）→ read×8（合法只读调研，不向
  // polling 系列追加、不写文件）→ end_turn。修复前：read 轮解不开 storm 帧，
  // streak 继续 +1，第 3 个 read 轮（总第 13 轮）即 abort——纯只读期迟到熔断
  //（主控 tsx 探针已实证 streak=6 abort）。修复后：无新增 polling 记录的轮次
  // 使 streak 向 0 收敛，8 个 read 轮安全走完并自然收尾。
  it('R1: read-only investigation after a storm must NOT be late-killed', async () => {
    let callCount = 0
    const client: StreamClient = {
      stream: async (_req: unknown, cb: StreamCallbacks) => {
        callCount++
        const id = `tu_${callCount}`
        if (callCount <= 10) {
          cb.onContentBlock({ type: 'tool_use', id, name: 'job', input: { action: 'list' } })
        } else if (callCount <= 18) {
          cb.onContentBlock({ type: 'tool_use', id, name: 'read_file', input: { path: `/f/${callCount}.ts` } })
        } else {
          cb.onContentBlock({ type: 'text', text: 'done' })
          cb.onStopReason('end_turn', { input_tokens: 120, output_tokens: 30 })
          return
        }
        cb.onStopReason('tool_use', { input_tokens: 120, output_tokens: 30 })
      },
    } as unknown as StreamClient

    const collect = { stops: [] as string[], finals: 0, aborts: 0 }
    const prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_SESSION_DIR = join(TEST_CWD, '.sessions-ro')
    const agent = makeAgent(client, READ_TOOL)

    try {
      await agent.run('check job then investigate the codebase', makeCallbacks(collect))
    } finally {
      if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
      else process.env.RIVET_SESSION_DIR = prevSessionDir
    }

    assert.equal(collect.finals, 1, 'run must reach its natural finish')
    assert.equal(collect.aborts, 0)
    assert.ok(collect.stops.every(s => !s.includes('轮询风暴')), `read-only turns must not trip the guard, got: ${collect.stops.join(' | ')}`)
    assert.equal(callCount, 19, '10 job + 8 read turns plus the end_turn call must complete')
  })

  // 防过度修复：衰减只作用于「无新增 polling 记录」的只读轮——回归真轮询
  // （有新增记录、无文件修改）仍必须触发 abort。job×8（storm 成形）→
  // read×2（修复后 streak 收敛到 0）→ job×7（新增记录照常递增至 abort）。
  it('R2: returning to real polling after read-only decay must still abort', async () => {
    let callCount = 0
    const client: StreamClient = {
      stream: async (_req: unknown, cb: StreamCallbacks) => {
        callCount++
        const id = `tu_${callCount}`
        const poll = () => {
          cb.onContentBlock({ type: 'tool_use', id, name: 'job', input: { action: 'list' } })
          cb.onStopReason('tool_use', { input_tokens: 120, output_tokens: 30 })
        }
        const read = () => {
          cb.onContentBlock({ type: 'tool_use', id, name: 'read_file', input: { path: '/f.ts' } })
          cb.onStopReason('tool_use', { input_tokens: 120, output_tokens: 30 })
        }
        if (callCount <= 8) poll()
        else if (callCount <= 10) read()
        else poll() // 回归轮询：第 6 个 poll（总第 16 轮）streak 应到 6 → abort
      },
    } as unknown as StreamClient

    const collect = { stops: [] as string[], finals: 0, aborts: 0 }
    const prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_SESSION_DIR = join(TEST_CWD, '.sessions-return')
    const agent = makeAgent(client, READ_TOOL)

    try {
      await agent.run('poll the job status', makeCallbacks(collect))
    } finally {
      if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
      else process.env.RIVET_SESSION_DIR = prevSessionDir
    }

    assert.ok(collect.stops.some(s => s.includes('轮询风暴')), 'returning to real polling must still hit the guard')
    assert.equal(collect.finals, 1)
    assert.equal(collect.aborts, 0)
  })

  // ── 2026-09-05 bash 内容查询桶化（用户报告：git show ×6 被误判风暴）──
  // 逐提交审查 git show <不同 hash> 是合法调研——目标桶化后每轮不同类，
  // 不得连成 8 连 storm。修复前（git:show 平类）第 8 轮 storm、后续 abort。
  // 用 14 个互异目标而非 10：abort 门槛是 8 连 storm 后 streak 累计到 6（第 13 轮
  // 即 abort）——旧实现 10 轮全低于阈值照样通过，对桶化修复几乎没有鉴别力。
  it('R3: reviewing commits via git show (different targets) must NOT trip the guard', async () => {
    let callCount = 0
    const hashes = ['a1b2c3d4e5f6', 'b2c3d4e5f6a1', 'c3d4e5f6a1b2', 'd4e5f6a1b2c3', 'e5f6a1b2c3d4', 'f6a1b2c3d4e5', '1a2b3c4d5e6f', '2b3c4d5e6f1a', '3c4d5e6f1a2b', '4d5e6f1a2b3c', '5e6f1a2b3c4d', '6f1a2b3c4d5e', 'a1b2c3d4e5f7', 'b2c3d4e5f7a1']
    const client: StreamClient = {
      stream: async (_req: unknown, cb: StreamCallbacks) => {
        callCount++
        const id = `tu_${callCount}`
        if (callCount <= 14) {
          const h = hashes[callCount - 1]!
          cb.onContentBlock({ type: 'tool_use', id, name: 'bash', input: { command: `git show ${h}` } })
        } else {
          cb.onContentBlock({ type: 'text', text: 'done' })
          cb.onStopReason('end_turn', { input_tokens: 120, output_tokens: 30 })
          return
        }
        cb.onStopReason('tool_use', { input_tokens: 120, output_tokens: 30 })
      },
    } as unknown as StreamClient

    const collect = { stops: [] as string[], finals: 0, aborts: 0 }
    const prevSessionDir = process.env.RIVET_SESSION_DIR
    process.env.RIVET_SESSION_DIR = join(TEST_CWD, '.sessions-gitreview')
    const agent = makeAgent(client, BASH_TOOL)

    try {
      await agent.run('review the last ten commits one by one', makeCallbacks(collect))
    } finally {
      if (prevSessionDir === undefined) delete process.env.RIVET_SESSION_DIR
      else process.env.RIVET_SESSION_DIR = prevSessionDir
    }

    assert.equal(collect.finals, 1, 'commit review must reach its natural finish')
    assert.equal(collect.aborts, 0)
    assert.ok(collect.stops.every(s => !s.includes('轮询风暴')), `git show review must not trip the guard, got: ${collect.stops.join(' | ')}`)
    assert.equal(callCount, 15, '14 git-show turns plus the end_turn call must complete')
  })
})
