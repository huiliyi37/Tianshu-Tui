/**
 * B：size-scaled first-byte timeout。
 *
 * 大上下文冷启动 prefill 合法地需要更久才吐首 token，固定的首字节超时（45/90/180s）
 * 会误杀。这里在推导/配置的 base 之上按预估输入规模上浮，并封顶。
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import {
  OpenAIClient,
  computeFirstByteTimeoutMs,
  type OpenAIClientConfig,
} from '../openai-client.js'

const BASE: OpenAIClientConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxTokens: 1024,
}

const flush = () => new Promise<void>(r => setImmediate(r))

describe('computeFirstByteTimeoutMs (B)', () => {
  it('small context keeps the base unchanged (< 100k tokens = 0 buckets)', () => {
    assert.equal(computeFirstByteTimeoutMs({ baseMs: 180_000, estInputTokens: 0 }), 180_000)
    assert.equal(computeFirstByteTimeoutMs({ baseMs: 180_000, estInputTokens: 80_000 }), 180_000)
    assert.equal(computeFirstByteTimeoutMs({ baseMs: 45_000, estInputTokens: 99_999 }), 45_000)
  })

  it('scales +60s per full 100k estimated input tokens', () => {
    // 180s base + floor(500k/100k)=5 buckets * 60s = 480s, capped to 420s
    assert.equal(computeFirstByteTimeoutMs({ baseMs: 180_000, estInputTokens: 500_000 }), 420_000)
    // 180s + 1 bucket (100k) * 60s = 240s (under cap)
    assert.equal(computeFirstByteTimeoutMs({ baseMs: 180_000, estInputTokens: 100_000 }), 240_000)
    // 90s + 2 buckets (200k..299k) * 60s = 210s
    assert.equal(computeFirstByteTimeoutMs({ baseMs: 90_000, estInputTokens: 250_000 }), 210_000)
  })

  it('enforces the cap (default 420s)', () => {
    assert.equal(computeFirstByteTimeoutMs({ baseMs: 180_000, estInputTokens: 5_000_000 }), 420_000)
  })

  it('respects custom per100kMs and capMs overrides', () => {
    assert.equal(
      computeFirstByteTimeoutMs({ baseMs: 100_000, estInputTokens: 300_000, per100kMs: 30_000, capMs: 200_000 }),
      190_000,
    )
    assert.equal(
      computeFirstByteTimeoutMs({ baseMs: 100_000, estInputTokens: 900_000, per100kMs: 30_000, capMs: 200_000 }),
      200_000,
    )
  })

  it('treats negative estimates as zero', () => {
    assert.equal(computeFirstByteTimeoutMs({ baseMs: 45_000, estInputTokens: -1 }), 45_000)
  })
})

/**
 * 驱动 parseStreamFromReader 停在 pre-first-chunk 态：不发任何 data，让首字节 idle 计
 * 时器决定生死。传入的 firstByteTimeoutMs 应生效（而非推导值）。
 */
async function runFirstByteWait(
  config: OpenAIClientConfig,
  firstByteMs: number,
  tickMs: number,
  closeAfterTick: boolean,
): Promise<Error | null> {
  const client = new OpenAIClient(config)
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
  const reader = new Response(stream).body!.getReader()

  let err: Error | null = null
  const p = (client as unknown as {
    parseStreamFromReader: (
      r: ReadableStreamDefaultReader<Uint8Array>,
      cb: unknown,
      signal?: AbortSignal,
      reasoningRef?: { content: string },
      lifecycle?: AbortController,
      firstByteTimeoutMs?: number,
    ) => Promise<void>
  }).parseStreamFromReader(reader, { onTextDelta() {}, onThinkingDelta() {}, onStopReason() {} }, undefined, undefined, undefined, firstByteMs)
    .catch((e: Error) => { err = e })

  await flush()
  mock.timers.tick(tickMs)
  await flush()
  await flush()
  // 未超时的分支：关流让 parse 正常收束（否则 promise 永挂）。
  if (closeAfterTick) { ctl.close(); await flush() }
  await p
  return err
}

describe('parseStreamFromReader honors size-scaled firstByteTimeoutMs (B)', () => {
  it('does NOT abort before the passed first-byte window elapses', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      // 传入 300s 窗口；只推进 250s（< 窗口）后关流 → 不应触发首字节超时。
      const err = await runFirstByteWait({ ...BASE }, 300_000, 250_000, true)
      assert.equal(err, null, '首字节窗口未到，不应中止')
    } finally {
      mock.timers.reset()
    }
  })

  it('aborts with idle-timeout reflecting the passed window once it elapses', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      // 传入 300s 窗口；推进 301s → 触发首字节 idle 超时，文案显示实际 300s。
      const err = await runFirstByteWait({ ...BASE }, 300_000, 301_000, false)
      assert.ok(err, '首字节窗口到点应中止')
      assert.match((err as unknown as Error).message, /idle timeout \(300s\)/, '文案应反映传入的 300s')
    } finally {
      mock.timers.reset()
    }
  })
})
