import type { OaiMessage, OaiAssistantMessage } from '../api/oai-types.js'

/**
 * 语义化工具结果去重 —— Pi semantic-prune 移植。
 *
 * 对幂等查询工具（grep/glob/read_file/semantic_search）的重复调用，
 * 只保留最新一条结果。旧结果被新结果覆盖后无信息价值，但仍在消耗
 * 上下文窗口和前缀缓存 budget。
 */

const QUERY_TOOLS = new Set(['grep', 'glob', 'read_file', 'semantic_search'])

interface PruneKey {
  toolName: string
  key: string
}

/** 提取一条 assistant message 中首个查询工具的 prune key */
function queryKey(msg: OaiAssistantMessage): PruneKey | null {
  if (!msg.tool_calls || msg.tool_calls.length === 0) return null
  const tc = msg.tool_calls[0]!
  if (!QUERY_TOOLS.has(tc.function.name)) return null

  let args: Record<string, unknown> = {}
  try { args = JSON.parse(tc.function.arguments) } catch { return null }

  const toolName = tc.function.name
  switch (toolName) {
    case 'grep':
    case 'glob':
    case 'semantic_search': {
      const pattern = typeof args.pattern === 'string' ? args.pattern : typeof args.query === 'string' ? args.query : undefined
      if (!pattern) return null
      const path = typeof args.path === 'string' ? args.path : ''
      return { toolName, key: `${pattern}|${path}` }
    }
    case 'read_file': {
      const filePath = typeof args.file_path === 'string' ? args.file_path : ''
      if (!filePath) return null
      const offset = typeof args.offset === 'number' ? `:${args.offset}` : ''
      const limit = typeof args.limit === 'number' ? `:${args.limit}` : ''
      return { toolName, key: `${filePath}${offset}${limit}` }
    }
    default:
      return null
  }
}

export interface SemanticPruneResult {
  prunedCount: number
}

/**
 * 对消息列表做语义去重：同一 query key 只保留索引最大的（最新）条目。
 *
 * @param messages  完整的消息数组（原地修改）
 * @param anchorCount  前 N 条消息不剪枝（保护 cache anchor 前缀不位移）
 */
export function pruneOutdatedQueryResults(
  messages: OaiMessage[],
  anchorCount = 0,
): SemanticPruneResult {
  if (messages.length <= anchorCount) return { prunedCount: 0 }

  // 倒序遍历：记录每个 query key 的最新出现位置
  const latestByKey = new Map<string, number>()
  for (let i = messages.length - 1; i >= anchorCount; i--) {
    const msg = messages[i]!
    if (msg.role !== 'assistant') continue
    const key = queryKey(msg as OaiAssistantMessage)
    if (!key) continue
    const compound = `${key.toolName}:${key.key}`
    if (!latestByKey.has(compound)) {
      latestByKey.set(compound, i)
    }
  }

  // 正序遍历：标记需要剪枝的 assistant→tool_result 对
  const toPrune = new Set<number>()
  const seenKeys = new Set<string>()

  for (let i = anchorCount; i < messages.length; i++) {
    const msg = messages[i]!
    if (msg.role !== 'assistant') continue
    const key = queryKey(msg as OaiAssistantMessage)
    if (!key) continue
    const compound = `${key.toolName}:${key.key}`

    if (seenKeys.has(compound)) {
      // 已有更新版本 → 移除这条 assistant + 紧随的 tool_result
      toPrune.add(i)
      // 找到对应的 tool_result
      const tc = (msg as OaiAssistantMessage).tool_calls![0]!
      for (let j = i + 1; j < messages.length; j++) {
        const next = messages[j]!
        if (next.role === 'tool' && next.tool_call_id === tc.id) {
          toPrune.add(j)
          break
        }
      }
    }
    seenKeys.add(compound)
  }

  // 从后往前删除（避免索引位移）
  const indices = [...toPrune].sort((a, b) => b - a)
  for (const idx of indices) {
    messages.splice(idx, 1)
  }

  return { prunedCount: indices.length }
}
