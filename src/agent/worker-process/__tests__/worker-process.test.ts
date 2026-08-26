import { test, describe, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFrameDecoder, encodeFrame } from '../protocol.js'
import {
  runWorkerSessionOop, resolveChildEntry, WorkerOopUnavailable,
  type WorkerOopOptions,
} from '../parent.js'
import type { WorkerSessionConfig } from '../../worker-session.js'
import type { WorkOrder } from '../../work-order.js'

// ── 协议单测 ─────────────────────────────────────────────────────

describe('NDJSON 帧解码', () => {
  test('跨 chunk 半行拼接 + 多帧单 chunk + 坏行计数', () => {
    const dec = createFrameDecoder()
    const a = dec.feed(encodeFrame({ t: 'tick', at: 1 }).slice(0, 10))
    assert.equal(a.length, 0, '半行不应解出消息')
    const b = dec.feed(encodeFrame({ t: 'tick', at: 1 }).slice(10) + encodeFrame({ t: 'log', line: 'x' }) + 'not-json\n')
    assert.equal(b.length, 2, '补齐半行 + 完整帧各一条')
    assert.equal(dec.badLines, 1, '坏行计数')
    assert.equal((b[0] as { t: string }).t, 'tick')
  })

  test('空行静默跳过', () => {
    const dec = createFrameDecoder()
    assert.equal(dec.feed('\n\n').length, 0)
  })
})

// ── 集成（假子进程说协议）────────────────────────────────────────

/** 生成假子进程 fixture：说协议但不动真 agent。mode:
 *  - ok：activity×2 + mailbox + result 后退出 0
 *  - hang：init 后一声不吭（watchdog 击杀用）
 *  - crash：init 后 exit(1)
 *  - echo-steer：收到 steer 帧后把它放进 result.summary 证明下行通路 */
function writeFixture(dir: string, mode: 'ok' | 'hang' | 'crash' | 'echo-steer'): string {
  const src = `
const { createInterface } = require('node:readline')
const dec = (${createFrameDecoder.toString()})()
let mode = ${JSON.stringify(mode)}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\\n')
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  for (const msg of dec.feed(line + '\\n')) {
    if (msg.t === 'init') {
      if (mode === 'hang') return // 一声不吭
      if (mode === 'crash') { process.exit(1) }
      send({ t: 'activity', kind: 'text', detail: 'hello' })
      send({ t: 'mailbox', msg: { to: 'coordinator', type: 'finding', severity: 'info', body: 'm1' } })
    } else if (msg.t === 'steer') {
      send({ t: 'activity', kind: 'text', detail: 'steered:' + msg.text })
      send({ t: 'result', run: {
        result: { workOrderId: msg.text, status: 'passed', summary: 'steer-echo:' + msg.text, findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'verified' },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], repairAttempts: 0, errors: [] },
        usage: { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        messages: [{ role: 'user', content: msg.text }],
        turnCount: 1,
      } })
      process.exit(0)
    } else if (msg.t === 'abort') {
      send({ t: 'result', run: {
        result: { workOrderId: 'w', status: 'blocked', summary: 'aborted', findings: [], artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'skipped', failureReason: 'caller_aborted' },
        transcript: { text: '', thinking: '', toolUses: [], toolResults: [], repairAttempts: 0, errors: [] },
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        messages: [],
        turnCount: 0,
      } })
      process.exit(0)
    }
  }
})
`
  const path = join(dir, `fixture-${mode}.cjs`)
  writeFileSync(path, src)
  return path
}

function makeConfig(over: Partial<WorkerSessionConfig> = {}): WorkerSessionConfig {
  return {
    order: { id: 'wo_test', objective: 'test', profile: 'code_scout', allowedTools: ['read_file'], budget: { maxTurns: 3, maxTokens: 1000, wallClockMs: 60_000, inputTokens: 10_000, outputTokens: 2_000 } } as unknown as WorkOrder,
    client: {} as WorkerSessionConfig['client'],
    promptEngine: {} as WorkerSessionConfig['promptEngine'],
    toolRegistry: {} as WorkerSessionConfig['toolRegistry'],
    cwd: process.cwd(),
    maxTurns: 3,
    contextWindow: 64000,
    compact: { enabled: false, model: 'flash' },
    runtimeDecision: { providerName: 'deepseek', model: 'deepseek-v4-flash', maxTokens: 4096, contextWindow: 64000, thinkingBudget: 4096, isWrite: false },
    activeClaims: [],
    ...over,
  } as WorkerSessionConfig
}

const baseOpts = (fixture: string): WorkerOopOptions => ({
  getMemoryBlock: () => 'memory-block-snapshot',
  stallMsOverride: 8_000,
  entryOverride: { execArgs: [], script: fixture },
})

describe('OOP 运行器（真子进程假 agent）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'worker-oop-test-'))

  test('活动流 + mailbox 桥 + steer 下行 + result 映射', async () => {
    const activities: Array<[string, string | undefined]> = []
    const mailboxMsgs: string[] = []
    let steerText: string | null = null
    // ok 模式 fixture 等第一帧 steer 才 result——用 spawn 真进程跑 fixture
    const fixture = writeFixture(dir, 'echo-steer')
    const opts: WorkerOopOptions = {
      getMemoryBlock: () => 'mb',
      stallMsOverride: 15_000,
      entryOverride: { execArgs: [], script: fixture },
      spawnOverride: (execArgs, script) =>
        spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }),
    }
    const cfg = makeConfig({
      onActivity: (kind, detail) => activities.push([kind, detail]),
      mailbox: { send: (m) => mailboxMsgs.push((m as { body?: string }).body ?? ''), receive: () => [], broadcast: () => {}, all: () => [], byType: () => [], clear: () => {}, size: () => 0 },
      onSteerDrain: () => { const t = steerText; steerText = null; return t },
    })
    const p = runWorkerSessionOop(cfg, opts)
    // 模拟 coordinator 在结算点 drain steer
    steerText = 'GO-FAST'
    setTimeout(() => { cfg.onSteerDrain?.() }, 150)
    const run = await p
    assert.equal(run.result.status, 'passed')
    assert.equal(run.result.summary, 'steer-echo:GO-FAST', 'steer 经父进程转发到子进程并回到 result')
    assert.ok(activities.some(([k, d]) => k === 'text' && d === 'steered:GO-FAST'), '子进程 activity 上行到 onActivity')
    assert.deepEqual(mailboxMsgs, ['m1'], 'mailbox 帧桥到父侧 mailbox.send')
    assert.equal(run.session.getMessages()[0]?.content, 'GO-FAST', 'result.messages 投影成 duck-type session')
    assert.equal(run.usage.input_tokens, 1)
  })

  test('子进程崩溃（无 result 退出）→ 合成 failed/worker_crash', async () => {
    const fixture = writeFixture(dir, 'crash')
    const run = await runWorkerSessionOop(makeConfig(), { ...baseOpts(fixture), spawnOverride: (_e, script) => spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }) })
    assert.equal(run.result.status, 'failed')
    assert.equal(run.result.failureReason, 'worker_crash')
    assert.equal(run.result.evidenceStatus, 'skipped')
  })

  test('watchdog：子进程 hang → SIGTERM/SIGKILL 阶梯 → 合成 stalled', async () => {
    const fixture = writeFixture(dir, 'hang')
    const run = await runWorkerSessionOop(makeConfig(), {
      getMemoryBlock: () => 'mb',
      stallMsOverride: 900, // 压过心跳下限（测试专用）
      entryOverride: { execArgs: [], script: fixture },
      spawnOverride: (_e, script) => spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }),
    })
    assert.equal(run.result.status, 'failed')
    assert.equal(run.result.failureReason, 'stalled', '击杀梯收尾后合成 stalled 而非 worker_crash')
  })

  test('abort 下行 → 子进程返回 blocked/caller_aborted', async () => {
    const fixture = writeFixture(dir, 'ok')
    const cfg = makeConfig()
    const controller = new AbortController()
    cfg.abortSignal = controller.signal
    const p = runWorkerSessionOop(cfg, { ...baseOpts(fixture), spawnOverride: (_e, script) => spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] }) })
    setTimeout(() => controller.abort('caller_aborted'), 150)
    const run = await p
    assert.equal(run.result.status, 'blocked')
    assert.equal(run.result.failureReason, 'caller_aborted')
  })

  test('entry 缺失 → WorkerOopUnavailable（接线处回退进程内）', async () => {
    await assert.rejects(
      runWorkerSessionOop(makeConfig(), { getMemoryBlock: () => 'mb', entryOverride: null }),
      WorkerOopUnavailable,
    )
  })

  test('runtimeDecision 缺席 → WorkerOopUnavailable（防两端漂移）', async () => {
    const cfg = makeConfig()
    delete (cfg as Partial<WorkerSessionConfig>).runtimeDecision
    await assert.rejects(
      runWorkerSessionOop(cfg, { getMemoryBlock: () => 'mb', entryOverride: { execArgs: [], script: join(dir, 'fixture-ok.cjs') } }),
      WorkerOopUnavailable,
    )
  })

  test('entry 解析：dist/tsx 至少其一可解析（本仓 dev 必命中 .ts）', () => {
    const entry = resolveChildEntry()
    assert.ok(entry, 'dev 仓必有 src/agent/worker-process/child.ts')
    assert.match(entry.script, /child\.(ts|js)$/)
  })

  after(() => rmSync(dir, { recursive: true, force: true }))
})
