/**
 * 推理锚点采集（spec 3c 动作 B · 开源接线侧纯函数）。
 *
 * spark 会话的 wire 层会截断 reasoning_content 尾部 N token 之外的前段
 * （src/api/openai-client.ts 的 WireTransform 调用点）；被截掉的推理里
 * 「已排除的路径」若不补偿，模型会走回头路（SAT conflict clause 类比）。
 * 本模块从完整推理（内存态/jsonl 始终完整，wire 才截）提取锚点句，
 * 经 PromptEngine.appendExcludedPathAnchors 流向 <excluded-paths> 块。
 *
 * 提取算法本体在闭源侧（ReasoningAnchorExtractor，pro-registry 注册）；
 * 开源构建注册表恒空 → 本模块全部函数恒返回 []，零行为差异。
 */

import type { ContentBlock } from '../api/types.js'
import type { OaiMessage } from '../api/oai-types.js'
import type { ReasoningAnchorExtractor, WireTransformContext } from '../api/pro-registry.js'

/** 单轮增量：从本轮收集的 content blocks 提取锚点。
 *  ctx = 会话冻结的 wire 上下文——必须与 wire 截断同源（同 N 才精确互补）。 */
export function anchorsFromBlocks(
  blocks: ContentBlock[],
  extractor: ReasoningAnchorExtractor,
  model: string | undefined,
  ctx?: WireTransformContext,
): string[] {
  const reasoning = blocks
    .filter((b): b is ContentBlock & { type: 'thinking' } => b.type === 'thinking')
    .map(b => b.thinking)
    .join('')
  if (!reasoning) return []
  return extractor(reasoning, model, ctx)
}

/**
 * 全量重建：扫消息历史里全部 assistant reasoning。
 * 用于恢复路径（resume / loadOai）后的惰性补课——历史消息在 wire 上
 * 同样被截断，锚点须重建。逐消息提取（与增量路径同粒度），并集即
 * 当初逐轮增量的并集：重建结果确定性等价（前提：ctx 与当初一致——
 * 这正是 meta 冻结要保证的）。
 */
export function anchorsFromMessages(
  messages: readonly OaiMessage[],
  extractor: ReasoningAnchorExtractor,
  model: string | undefined,
  ctx?: WireTransformContext,
): string[] {
  const anchors: string[] = []
  for (const m of messages) {
    if (m.role !== 'assistant' || !('reasoning_content' in m)) continue
    const reasoning = (m as { reasoning_content?: unknown }).reasoning_content
    if (typeof reasoning !== 'string' || reasoning === '') continue
    anchors.push(...extractor(reasoning, model, ctx))
  }
  return anchors
}
