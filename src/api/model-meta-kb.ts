/**
 * model-meta-kb — 静态模型元数据库（L2 知识源）。
 *
 * 探测拿到的裸 id 列表里，凡命中这张表的型号即视为"已知"：contextWindow /
 * maxTokens / reasoning 等元数据自动回填，免手填补参。两个来源：
 *
 * 1. PROVIDER_PRESETS 各家 fleet（已在 MODEL_ALIAS_TABLE 中，此处不重复）；
 * 2. 官网规格补充条目（MODEL_META_KB）——fleet 未收录但在售的型号，
 *    如 GLM-5.1/4.7/4.6 全系与 kimi-k2.6/k2.5。官网未公布最大输出的型号
 *    maxTokens 留空——命中后向导表单预填已知项、只问缺失项。
 *
 * 匹配走 model-id-matcher 的 L1/L2（大小写不敏感、去厂商前缀），与别名表同源。
 */

import { MODEL_ALIAS_TABLE, type ModelAliasEntry } from './model-aliases.js'

/** 官网规格补充条目（canonical id 按端点实际返回的小写形态存放）。 */
export const MODEL_META_KB: readonly ModelAliasEntry[] = [
  // ── GLM（智谱 open.bigmodel.cn 官网规格，2026-08） ──
  { canonicalId: 'glm-5.1', aliases: [], metadata: { contextWindow: 204_800, maxTokens: 131_072, capabilities: { reasoningSplit: true } } },
  { canonicalId: 'glm-5', aliases: [], metadata: { contextWindow: 204_800, maxTokens: 131_072, capabilities: { reasoningSplit: true } } },
  { canonicalId: 'glm-5-turbo', aliases: [], metadata: { contextWindow: 204_800, maxTokens: 131_072, capabilities: { reasoningSplit: true } } },
  { canonicalId: 'glm-4.7', aliases: [], metadata: { contextWindow: 204_800, maxTokens: 131_072, capabilities: { reasoningSplit: true } } },
  { canonicalId: 'glm-4.7-flash', aliases: [], metadata: { contextWindow: 204_800, maxTokens: 131_072, capabilities: { reasoningSplit: true } } },
  { canonicalId: 'glm-4.7-flashx', aliases: [], metadata: { contextWindow: 204_800, maxTokens: 131_072, capabilities: { reasoningSplit: true } } },
  { canonicalId: 'glm-4.6', aliases: [], metadata: { contextWindow: 204_800, maxTokens: 131_072, capabilities: { reasoningSplit: true } } },
  { canonicalId: 'glm-4.5-air', aliases: [], metadata: { contextWindow: 131_072, maxTokens: 98_304, capabilities: { reasoningSplit: true } } },
  { canonicalId: 'glm-4.5-airx', aliases: [], metadata: { contextWindow: 131_072, maxTokens: 98_304, capabilities: { reasoningSplit: true } } },
  // 老型号无思考输出通道。
  { canonicalId: 'glm-4-long', aliases: [], metadata: { contextWindow: 1_000_000, maxTokens: 4_096 } },
  { canonicalId: 'glm-4-flashx-250414', aliases: [], metadata: { contextWindow: 131_072, maxTokens: 16_384 } },
  // ── Kimi（Moonshot 官网规格，2026-08）——官网未公布最大输出，maxTokens 留空 ──
  { canonicalId: 'kimi-k2.6', aliases: [], metadata: { contextWindow: 262_144, capabilities: { reasoningSplit: true } } },
  { canonicalId: 'kimi-k2.5', aliases: [], metadata: { contextWindow: 262_144, capabilities: { reasoningSplit: true } } },
]

/** 别名表 + 官网知识库——探测匹配/回填的统一基准（fleet 条目优先，不被覆盖）。 */
export const ENRICHED_ALIAS_TABLE: readonly ModelAliasEntry[] = [...MODEL_ALIAS_TABLE, ...MODEL_META_KB]
