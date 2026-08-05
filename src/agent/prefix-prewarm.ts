import type { StreamClient } from '../api/stream-client.js'
import type { OaiChatRequest, OaiMessage } from '../api/oai-types.js'

/**
 * P3 — 主动预热服务端前缀缓存（压缩/会话分裂/resume 之后）。
 *
 * 官方单元化缓存语义：新前缀第一轮必冷（cache write 价），第二轮才回暖
 * （cache read 价）。压缩/分裂/resume 之后没有"别人"替这个会话建缓存——不像
 * galaxy 多 worker 场景第一个 worker 的真实请求天然帮后面的 worker 建好缓存
 * （`docs/plans/2026-07-31-galaxy-prewarm-and-cache-affinity.md` 的"不引入
 * 提前发建缓存 API 请求"非目标正是针对那个场景：服务端自动前缀匹配，无需
 * 客户端协调）。单会话场景没有这个天然热身对象，冷启动代价必然由下一次真实
 * 请求来付——这里做的是把它挪到用户不可感知的时机（提前发一个极小请求），
 * **摊平延迟，不是省钱**：cache write 的钱无论走哪次请求都要付一次。
 *
 * 刻意不做的事：不去改共享 client 的 reasoning effort / thinking 配置。
 * fire-and-forget 调用不 await，若在此处临时切换共享 client 状态再异步恢复，
 * 会跟"本轮稍后才构建的真实请求"产生竞态（CLAUDE.md「request 对象会被多个
 * stream() 重入，client 变换层禁止 mutation」同一类问题）。一条空 ping 触发
 * 模型跑出意外长思维链的最坏情况，由 P2 思维链上限看门狗兜底。
 */

const PREWARM_PING: OaiMessage = { role: 'user', content: '.' }

export interface PrefixPrewarmResult {
  ok: boolean
  elapsedMs: number
  error?: string
}

export interface PrefixPrewarmDeps {
  client: Pick<StreamClient, 'stream'>
  /** 复用生产同一条构建路径（frozen base + appendixDelta + 边界合并），
   *  必须传 `{ sidePath: true }`——绝不能触碰主路径的冻结快照/appendix 基线。 */
  buildRequest: (messages: OaiMessage[]) => OaiChatRequest
  getMessages: () => OaiMessage[]
  /** 失败静默、不重试；仅用于把结果记进 cache-log.jsonl，从不影响调用方。 */
  onResult?: (result: PrefixPrewarmResult) => void
}

const noopCallbacks = {
  onTextDelta: () => {},
  onThinkingDelta: () => {},
  onContentBlock: () => {},
  onStopReason: () => {},
  onError: () => {},
}

/**
 * Fire-and-forget：调用方不 await，不重试，不阻塞真实轮次。
 */
export function firePrefixPrewarm(deps: PrefixPrewarmDeps): void {
  const startedAt = Date.now()
  let request: OaiChatRequest
  try {
    request = deps.buildRequest([...deps.getMessages(), PREWARM_PING])
    // 只要 1 个输出 token 就够触发服务端对输入前缀的处理/建缓存——不需要，
    // 也不想要，真实回答。
    request.max_tokens = 1
  } catch (err) {
    deps.onResult?.({ ok: false, elapsedMs: Date.now() - startedAt, error: String((err as Error)?.message ?? err) })
    return
  }
  const timeoutSignal = AbortSignal.timeout(30_000)
  deps.client.stream(request, noopCallbacks, timeoutSignal).then(
    () => { deps.onResult?.({ ok: true, elapsedMs: Date.now() - startedAt }) },
    (err: unknown) => {
      deps.onResult?.({ ok: false, elapsedMs: Date.now() - startedAt, error: String((err as Error)?.message ?? err) })
    },
  )
}
