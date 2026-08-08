/**
 * Essence-gate 侧路调用的有界执行（主控可靠性闭环 Wave 1）。
 *
 * 假超时根因：旧实现只 `setTimeout(abort)` 不立即 reject——底层 stream 忽略
 * abort 时（部分 client 不监听 signal），`gateClient.stream()` 一直挂起，直到
 * 外层 Runtime Hook 预算（10s）先炸，报成「hook timed_out」假象。
 *
 * 本函数 Promise.race 内层预算：到点同时 abort + reject（EssenceGateTimeoutError），
 * 保证有界返回；abort 引发的 onError 不掩盖超时归因（超时优先）。
 *
 * 独立成文件的原因：essence-gate 测试需要走完整超时链路（race → 哨兵错误 →
 * failureReason=timeout），但 loop-factory 依赖链包含其他会话未提交的新模块，
 * 隔离测试快照里会缺文件。gate-completion 的依赖只有已跟踪的 memory 模块。
 */

import type { Usage } from '../api/types.js'
import { EssenceGateTimeoutError } from '../memory/essence-gate.js'

export interface GateCompletionClient {
  stream(
    request: { model: string; messages: Array<{ role: 'user'; content: string }>; max_tokens: number; stream: boolean },
    handlers: {
      onTextDelta: (text: string) => void
      onThinkingDelta: () => void
      onContentBlock: () => void
      onStopReason: (reason: unknown, usage?: Partial<Usage>) => void
      onError: (err: Error) => void
    },
    signal: AbortSignal,
  ): Promise<void>
}

export async function runGateCompletion(
  client: GateCompletionClient,
  recordSidePath: (kind: string, usage: Partial<Usage>) => void,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  // 独立新建 request（不复用主请求对象）——无 prefixProbe、无 mutation 风险
  const request = {
    model: '', // client already binds the model
    messages: [{ role: 'user' as const, content: prompt }],
    max_tokens: 2048,
    stream: true,
  }
  const chunks: string[] = []
  let streamError: Error | undefined
  let timedOut = false
  const abort = new AbortController()

  const streamPromise = client.stream(request, {
    onTextDelta: text => { chunks.push(text) },
    onThinkingDelta: () => {},
    onContentBlock: () => {},
    onStopReason: (_reason, usage) => {
      recordSidePath('essence_gate', usage ?? {})
    },
    onError: err => { streamError = err },
  }, abort.signal)

  // race 保底：stream 忽略 abort 也不得拖过内层预算
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      abort.abort()
      reject(new EssenceGateTimeoutError())
    }, timeoutMs)
  })

  try {
    await Promise.race([streamPromise, timeoutPromise])
  } finally {
    if (timer) clearTimeout(timer)
  }
  // 超时优先于 streamError——abort 引发的 onError（AbortError）不掩盖归因
  if (timedOut) throw new EssenceGateTimeoutError()
  if (streamError) throw streamError
  return chunks.join('')
}
