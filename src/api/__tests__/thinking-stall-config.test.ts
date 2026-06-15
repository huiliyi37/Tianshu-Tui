/**
 * 2B：可配置的 thinking-stall 超时 + 修正错误文案。
 *
 * 旧实现：THINKING_STALL_TIMEOUT_MS 恒等于 SLOW_READ_TIMEOUT_MS(300s)（实为禁用），
 * 但错误文案硬编码 "(90s)"，与实际触发时长不符。
 *
 * 修复：
 *  - 经 config.thinkingStallTimeoutMs 可配置（默认未配置 = 取 read 超时，等于禁用、不误杀深思模型）；
 *  - 错误文案动态反映实际生效的秒数；纯 thinking 卡死按配置值更早触发。
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'

const BASE: OpenAIClientConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxTokens: 1024,
}

const flush = () => new Promise<void>(r => setImmediate(r))
const REASONING_CHUNK = 'data: {"choices":[{"delta":{"reasoning_content":"thinking..."},"index":0}]}\n\n'
const TEXT_CHUNK = 'data: {"choices":[{"delta":{"content":"done"},"index":0}]}\n\n'
const DONE_CHUNK = 'data: [DONE]\n\n'

/**
 * 模拟「合法长思考」：持续吐 reasoning delta，每次间隔 < stall 窗口，总时长远超
 * 单次合法思考上限。每个 data 事件都会 resetIdleTimer——只要相邻间隔 < stall 窗，
 * 就不应触发 stall。最后吐 text + [DONE] 让流正常收束。
 * 返回捕获到的错误（期望为 null）。
 */
async function runLegitLongThinking(
  config: OpenAIClientConfig,
  gapMs: number,
  pumps: number,
): Promise<Error | null> {
  const client = new OpenAIClient(config)
  const enc = new TextEncoder()
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
  const reader = new Response(stream).body!.getReader()

  let err: Error | null = null
  const p = (client as unknown as {
    parseStreamFromReader: (r: ReadableStreamDefaultReader<Uint8Array>, cb: unknown) => Promise<void>
  }).parseStreamFromReader(reader, { onTextDelta() {}, onThinkingDelta() {}, onStopReason() {} })
    .catch((e: Error) => { err = e })

  await flush()
  for (let i = 0; i < pumps; i++) {
    ctl.enqueue(enc.encode(REASONING_CHUNK))
    await flush()
    // 每个间隙都 < stall 窗：reasoning delta 持续到达，stall 不应触发
    mock.timers.tick(gapMs)
    await flush()
  }
  // 收束：吐 text + [DONE]，流正常结束
  ctl.enqueue(enc.encode(TEXT_CHUNK))
  await flush()
  ctl.enqueue(enc.encode(DONE_CHUNK))
  ctl.close()
  await flush()
  await flush()
  await p
  return err
}

async function runThinkingStall(config: OpenAIClientConfig, tickMs: number): Promise<Error | null> {
  const client = new OpenAIClient(config)
  const enc = new TextEncoder()
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
  const reader = new Response(stream).body!.getReader()

  let err: Error | null = null
  const p = (client as unknown as {
    parseStreamFromReader: (r: ReadableStreamDefaultReader<Uint8Array>, cb: unknown) => Promise<void>
  }).parseStreamFromReader(reader, { onTextDelta() {}, onThinkingDelta() {}, onStopReason() {} })
    .catch((e: Error) => { err = e })

  await flush()
  // 进入纯 thinking 态（收到 reasoning，但无 text/tool）
  ctl.enqueue(enc.encode(REASONING_CHUNK))
  await flush()
  // 推进到刚好超过 stall 窗口
  mock.timers.tick(tickMs)
  await flush()
  await flush()
  await p
  return err
}

describe('thinking-stall configurable + message (2B)', () => {
  it('config.thinkingStallTimeoutMs 生效：纯 thinking 卡死按配置值更早触发，文案显示实际秒数', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      // 配置 50s（< read 120s）；推进 51s 后应触发 thinking-stall
      const err = await runThinkingStall({ ...BASE, thinkingStallTimeoutMs: 50_000 }, 51_000)
      assert.ok(err, '配置的 thinking-stall 应触发')
      assert.match((err as unknown as Error).message, /thinking stall timeout \(50s\)/, '文案应反映实际 50s，而非硬编码 90s')
    } finally {
      mock.timers.reset()
    }
  })

  it('默认未配置：到 read 超时(120s)以 idle 文案触发，不再硬编码 90s', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const err = await runThinkingStall({ ...BASE }, 121_000)
      assert.ok(err, '到 read 超时应触发')
      assert.match((err as unknown as Error).message, /idle timeout \(120s\)/, '默认禁用 thinking-stall → 以 idle(120s) 文案触发，非 90s')
      assert.doesNotMatch((err as unknown as Error).message, /90s/, '不得再出现硬编码 90s')
    } finally {
      mock.timers.reset()
    }
  })

  it('合法长思考不误杀：持续吐 reasoning（间隔<stall窗），总时长远超单次上限也不触发 stall', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      // 模拟 glm：slow provider → read 300s、stall 120s。
      // 每 90s（<120s stall 窗）吐一次 reasoning，共 3 次 = 270s 总时长（远超 158s）。
      const err = await runLegitLongThinking(
        { ...BASE, providerName: 'glm', thinking: 'enabled', thinkingStallTimeoutMs: 120_000 },
        90_000,
        3,
      )
      assert.equal(err, null, '相邻 reasoning 间隔 < stall 窗时，长思考不应被 stall 误杀')
    } finally {
      mock.timers.reset()
    }
  })
})
