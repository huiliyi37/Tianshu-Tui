/**
 * 探针：2026-08-09 会话 mskl1neqgwksu66h「Retry budget exhausted: 600s across
 * 1 attempt(s)」事故解剖复现。cache-log 实录：turn 50 正常完成后，下一次请求
 * elapsedMs=911724、receivedChars=0、error="OpenAI SSE stream idle timeout (180s)"。
 *
 * 三个探针把 911s 拆成可复现的机械时序：
 *
 *   A. deepseek-spark（自定义 provider 名，不在 SLOW_THINKING_PROVIDERS 集合）
 *      thinking 模式：reasoning 滴漏（每个 <180s 来一个 data: 事件）会持续重置
 *      idle 计时器（openai-client.ts:856 sawDataEvent → resetIdleTimer），流被
 *      合法续命；最终停滞由 read 窗口 REASONING_READ_TIMEOUT_MS=180s 开枪。
 *      → 单次尝试可以合法活到 600s 重试预算之外。
 *   B. 预算文案复现：单次尝试耗 911s 后失败，withStructuredRetry 在进入第 1 次
 *      重试前开枪 → 用户看到的「across 1 attempt(s)」就是这么来的。
 *   C. 对照：同名 DeepSeek 兼容端点若叫 'deepseek'（在慢速集合），read 窗口是
 *      SLOW_READ_TIMEOUT_MS=300s 而非 180s——自定义 provider 名不含确切字面量
 *      会拿到更紧的窗口（信息性差异，非断言修复方向）。
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'
import { withStructuredRetry } from '../retry-engine.js'

// setImmediate 未被 mock（只 mock setTimeout/Date），用它 flush 微任务 + reader.read() 的异步解析
const flush = () => new Promise<void>((r) => setImmediate(r))

const REASONING_CHUNK = 'data: {"choices":[{"delta":{"reasoning_content":"想。"},"index":0}]}\n\n'

function makeClient(providerName: string, baseUrl = 'https://example.invalid/v1'): OpenAIClient {
  const config: OpenAIClientConfig = {
    baseUrl,
    apiKey: 'sk-test',
    model: 'probe-model',
    maxTokens: 1024,
    providerName,
    thinking: 'enabled',
  }
  return new OpenAIClient(config)
}

type ParseFn = (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  cb: unknown,
) => Promise<void>

function callParse(client: OpenAIClient, reader: ReadableStreamDefaultReader<Uint8Array>): {
  done: Promise<void>
  getErr: () => Error | null
} {
  let err: Error | null = null
  const done = (client as unknown as { parseStreamFromReader: ParseFn })
    .parseStreamFromReader(reader, { onTextDelta() {}, onStopReason() {} })
    .catch((e: Error) => { err = e })
  return { done, getErr: () => err }
}

describe('探针 A/C：reasoning 滴漏续命 → 最终停滞由 read 窗口开枪', () => {
  async function trickleThenStall(providerName: string, expectedWindowSecs: number, baseUrl?: string) {
    mock.timers.enable({ apis: ['setTimeout'] })
    try {
      const client = makeClient(providerName, baseUrl)
      const enc = new TextEncoder()
      let ctl!: ReadableStreamDefaultController<Uint8Array>
      const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
      const reader = new Response(stream).body!.getReader()
      const { done, getErr } = callParse(client, reader)
      await flush()

      // 滴漏：每 100s 一个 reasoning data: 事件（< read 窗口，合法续命）。
      // 首chunk前窗口 90s（非慢速集合 thinking），若滴漏不重置计时器，流会在
      // t=90s 就死——活到 481s 即证明续命机制生效（事故同款）。
      for (let i = 0; i < 3; i++) {
        ctl.enqueue(enc.encode(REASONING_CHUNK))
        await flush()
        mock.timers.tick(100_000)
        await flush()
      }
      // t=300：最后一个 chunk，计时器重臂至 300+read窗口。推进到窗口之外。
      ctl.enqueue(enc.encode(REASONING_CHUNK))
      await flush()
      mock.timers.tick((expectedWindowSecs + 1) * 1000)
      await flush()
      await flush()
      await done

      const err = getErr()
      assert.ok(err, '滴漏停止后应由 idle 看门狗开枪')
      assert.match(
        (err as unknown as Error).message,
        new RegExp(`idle timeout \\(${expectedWindowSecs}s\\)`),
        `${providerName} 的 read 窗口应为 ${expectedWindowSecs}s`,
      )
    } finally {
      mock.timers.reset()
    }
  }

  it('deepseek-spark（不在慢速集合）：180s read 窗口（事故实录值）', async () => {
    await trickleThenStall('deepseek-spark', 180)
  })

  it('deepseek（慢速集合成员）对照：300s read 窗口', async () => {
    await trickleThenStall('deepseek', 300)
  })

  it('URL 匹配端到端：任意名称 + api.deepseek.com → 300s read 窗口', async () => {
    // 2026-08-09 修复后：名称不在集合也不要紧，baseUrl host 命中即慢速档
    await trickleThenStall('deepseek-spark', 300, 'https://api.deepseek.com/v1')
  })
})

describe('探针 B：单次尝试 911s → 预算开枪文案复现', () => {
  it('第 0 次尝试耗尽 600s 预算 → "across 1 attempt(s)"', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    try {
      let calls = 0
      let err: Error | null = null
      // maxTotalRetries: 1 —— 复刻 openai-client 思考模式（非慢速集合 provider）
      // 的重试上限（openai-client.ts:669-671）。若上限更宽，预算错误自身会被
      // 分类成 unknown/retryable 再空转一拍，最终文案变成 "across 2 attempt(s)"。
      const p = withStructuredRetry(
        async () => {
          calls++
          // 模拟事故中的第 0 次尝试：流挂了 911s 才被 180s idle 看门狗杀掉
          mock.timers.tick(911_000)
          throw new Error('OpenAI SSE stream idle timeout (180s)')
        },
        undefined,
        { maxTotalDurationMs: 600_000, maxTotalRetries: 1 },
      ).catch((e: Error) => { err = e })

      // 多拍 flush：等 fn 拒绝 → 分类 → abortableDelay 武装完成
      for (let i = 0; i < 5; i++) await flush()
      // 重试延迟 = retryDelayMs 3000 + applyDelayJitter 最多 +50%，10s 覆盖
      mock.timers.tick(10_000)
      for (let i = 0; i < 5; i++) await flush()
      await p

      assert.equal(calls, 1, '预算开枪后不得再发起新尝试')
      assert.ok(err)
      assert.match((err as unknown as Error).message, /Retry budget exhausted/)
      assert.match((err as unknown as Error).message, /across 1 attempt\(s\)/)
    } finally {
      mock.timers.reset()
    }
  })
})
