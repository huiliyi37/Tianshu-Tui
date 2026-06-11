/**
 * 2A：keepalive 感知的 idle stall。
 *
 * Bug：resetIdleTimer 在每次 reader.read() 返回任意字节时重置（包括服务端心跳/
 * 空白注释行）。服务端持续发心跳但模型无内容时，idle 检测永不触发，最坏拖到
 * 10min 硬顶。
 *
 * 修复：只有解析出真实 `data:` 内容事件才重置 idle timer；心跳注释行（`: ...`）
 * 不重置。
 *
 * 契约（RED→GREEN）：纯心跳注释流不重置计时器 → 仍按 first-byte 窗口触发 idle timeout。
 * 旧实现下心跳会把计时器一路推后，本测试在原窗口内就不会触发 → 失败。
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'

const CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxTokens: 1024,
}

// setImmediate 未被 mock（只 mock 了 setTimeout），用它 flush 微任务 + reader.read() 的异步解析
const flush = () => new Promise<void>(r => setImmediate(r))

describe('SSE keepalive-aware idle stall (2A)', () => {
  it('纯心跳注释流不重置 idle timer → 仍按期触发 idle timeout', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const client = new OpenAIClient(CONFIG)
      const enc = new TextEncoder()
      let ctl!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
      const reader = new Response(stream).body!.getReader()

      let err: Error | null = null
      const p = (client as unknown as {
        parseStreamFromReader: (r: ReadableStreamDefaultReader<Uint8Array>, cb: unknown) => Promise<void>
      }).parseStreamFromReader(reader, { onTextDelta() {}, onStopReason() {} })
        .catch((e: Error) => { err = e })

      // first-byte idle timer 已在 t=0 武装为 45s（非 thinking provider）
      await flush()

      // t=0：发心跳注释（旧实现会重置计时器，新实现不重置）
      ctl.enqueue(enc.encode(': keepalive\n\n'))
      await flush()

      // t=30s：再发一条心跳（仍不应重置）
      mock.timers.tick(30_000)
      ctl.enqueue(enc.encode(': keepalive\n\n'))
      await flush()

      // 推进到超过原始 45s 窗口（累计 46s）。
      // 旧实现：30s 处的心跳把计时器推到 75s，此刻 46s < 75s → 不触发（测试失败）。
      // 新实现：计时器仍是 t=0 武装的 45s → 此刻触发。
      mock.timers.tick(16_000)
      await flush()
      await flush()
      await p

      assert.ok(err, '纯心跳流应触发 idle timeout（心跳不得重置计时器）')
      assert.match((err as unknown as Error).message, /idle timeout/i)
    } finally {
      mock.timers.reset()
    }
  })

  it('真实 data 内容事件会重置 idle timer（不误杀正常流）', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const client = new OpenAIClient(CONFIG)
      const enc = new TextEncoder()
      let ctl!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
      const reader = new Response(stream).body!.getReader()

      let settled = false
      let err: Error | null = null
      const p = (client as unknown as {
        parseStreamFromReader: (r: ReadableStreamDefaultReader<Uint8Array>, cb: unknown) => Promise<void>
      }).parseStreamFromReader(reader, { onTextDelta() {}, onStopReason() {} })
        .then(() => { settled = true })
        .catch((e: Error) => { err = e })

      await flush()
      // 在窗口内持续发真实内容事件，每次都应重置计时器
      for (let i = 0; i < 3; i++) {
        mock.timers.tick(30_000) // < 120s read 窗口
        ctl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"x"},"index":0}]}\n\n'))
        await flush()
      }
      // 正常收尾
      ctl.enqueue(enc.encode('data: [DONE]\n\n'))
      await flush()
      ctl.close()
      await flush()
      await p

      assert.equal(err, null, '正常内容流不应被 idle timeout 误杀')
      assert.equal(settled, true, '收到 [DONE] 后应正常 settle')
    } finally {
      mock.timers.reset()
    }
  })
})
