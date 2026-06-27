# GLM Thinking / Streaming / Cache 机制分析 — 基于 API 文档

> 源：docs.bigmodel.cn 三页官方文档 + 项目代码 src/api/openai-client.ts
> 日期：2026-06-18

## 1. Preserved Thinking（保留式思考）— 已实现 ✓

**官方文档原文**：Coding Plan 端点默认开启 `clear_thinking: false`，标准 API 默认关闭。开启后需要"将完整、未修改的 reasoning content 传回 API"，且"所有连续的 reasoning content 必须与模型在原始请求期间生成的序列完全一致，不要重新排序或修改，否则会降低效果并影响缓存命中"。

**项目实现**（openai-client.ts:222）：
```ts
if (this.config.providerName === 'glm') {
  (body.thinking as Record<string, unknown>)['clear_thinking'] = false
}
```
同时 echoReasoning 逻辑会把 reasoning_content 回传。已正确实现。

## 2. mid-stream retry 的部分回灌问题 — 已修复 ✓

**问题**：sendStream 的 retry 逻辑把中断时积累的部分 reasoning_content 作为新 assistant 消息回灌。GLM preserved thinking 要求"完整、未修改的序列"，部分片段不被识别 → 模型从头推理。

**修复**（commit 00a4032c）：对 GLM 跳过部分回灌。GLM 服务端自己维护推理状态，客户端回灌反而干扰。

**文档佐证**：Preserved thinking 文档明确说"所有连续的 reasoning content 必须与模型在原始请求期间生成的序列完全一致"——部分片段违反了这个约束。修复方向正确。

## 3. 缓存机制 — 隐式 + 50% 折扣

**官方文档**：
- 隐式缓存，无需手动配置，基于内容相似度自动触发
- 缓存命中字段：`usage.prompt_tokens_details.cached_tokens`
- 缓存命中 Token 按标准价格 50% 计费
- "轻微的格式差异可能影响缓存效果"

**项目现状**（openai-client.ts:657）：
```ts
const cacheRead = usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0
cache_creation_input_tokens: usage.prompt_cache_miss_tokens ?? 0
```
GLM 返回 `prompt_cache_hit_tokens`（cacheRead 有值）但不返回 `prompt_cache_miss_tokens`（cacheCreate 恒 0）。这是字段缺失不是异常——GLM 不区分 cache creation/read，只有 hit 或不 hit。

## 4. Interleaved Thinking（交错式思考）— 工具调用间推理

**文档原文**：默认支持交错式思考（GLM 4.5+）。模型可以在工具调用之间、收到工具结果后继续思考。"当使用交错思考 + 工具时，必须显式保留 Reasoning content，并在返回工具结果时一并返回"。

**项目现状**：openai-client.ts 的 echoReasoning 逻辑在 thinking enabled + hasToolCalls 时保留 reasoning_content。已正确实现。

## 5. 轮级思考（Turn-level Thinking）— 新机会

**文档原文**：GLM-4.7+ 引入，每轮请求可独立开启/关闭思考。"更灵活的成本/时延控制：对轻量轮次可关闭思考追求快速响应，对重任务轮次可开启思考提升正确率"。

**项目现状**：未实现。当前是全会话 thinking on/off 二选一。

**加强方向**：可以在 PlusMenu 或 per-turn 级别加上"快速模式"（thinking disabled）vs"深思模式"（thinking enabled）的切换。对于"看一眼这个文件"vs"重构这个模块"这种不同重量级任务，可以在同一会话内切换，降低成本和延迟。

## 6. 对比 DeepSeek 的关键差异

| 维度 | GLM | DeepSeek |
|------|-----|---------|
| Preserved thinking | 服务端维护，需回传完整序列 | 客户端 echo reasoning_content |
| 缓存字段 | prompt_cache_hit_tokens（hit/miss） | prompt_cache_hit + prompt_cache_miss |
| 缓存计费 | 命中 = 50% 折扣 | 标准 exact-prefix 缓存 |
| 交错思考 | 默认支持（4.5+） | 通过 echo reasoning_content 实现 |
| 轮级思考 | GLM-4.7+ 支持 per-turn 切换 | 不支持 |
| mid-stream retry | 服务端有推理状态，客户端不应回灌部分片段 | 客户端回灌部分片段帮助续推 |

核心差异：**GLM 的推理状态在服务端**（preserved thinking 的增量是服务端管理的），客户端只负责回传完整的上一轮 reasoning_content。而 DeepSeek 的推理状态是"无状态的"——每轮的 reasoning_content 只是给 API 上下文用的，模型不会把它当成自己的推理状态。这就是为什么部分回灌对 DeepSeek 有帮助但对 GLM 有害。

## 7. 待讨论：还需改什么

1. **轮级思考**：是否要做 per-turn thinking 开关？（文档说 GLM-4.7+ 支持）
2. **缓存命中率优化**：GLM 缓存基于"内容相似度"而非 exact-prefix，我们的 T7 collapse/waterfall 机制是为 DeepSeek exact-prefix 设计的——在 GLM 上是否需要不同策略？
3. **交错思考 + reasoning 回传**：当前回传逻辑是否在所有工具调用轮次都正确？需要实际 GLM session 日志验证。
