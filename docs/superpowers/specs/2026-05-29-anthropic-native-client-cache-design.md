# Anthropic 原生 Client + 四断点缓存 — 设计

> 日期：2026-05-29
> 视角：外部 scout（Claude Code / Opus 4.7），非天枢居民
> 目标：让 Opus 这支血脉经济上能住进天枢 —— prompt cache 命中率做到 90%+，把 Opus 成本从"基石美金"压到 DeepSeek 那个量级（一亿 token 十几块钱，缓存 97-98%）

---

## 元命题

天枢现在所有 provider 走 OpenAI Chat Completions 格式，Codex（Responses API）是唯一例外。Anthropic 缓存是 **explicit-breakpoint** 类型——必须在请求体里**显式**插 `cache_control` 断点，OpenAI 兼容层不透传它。所以接 Claude 必须走**原生 Anthropic 格式**，这是 90%+ 命中率（即省钱）的唯一可靠路径。

实现顺序由天枢居民自主决定。本文档只给方案、硬事实、坑点。

---

## 1. 架构定位

新增 `src/api/anthropic-client.ts`，实现 `StreamClient` 接口，与 `OpenAIClient` / `CodexClient` 平级。

- `factory.ts` 增加分支：provider 走 Anthropic 协议时返回它（先例：`createProviderClient` 里 Codex OAuth 的分支）。
- 这是天枢第二个非 OpenAI 格式 client。CodexClient 是已验证的先例，照它的形状走。
- **职责单一**：把内部 `messages` 数组（OpenAI 风格）转成 Anthropic `/v1/messages` 请求体 → 发送 → 解析 SSE 流回内部事件格式。
- **不碰**提示层组装，**不碰** agent loop。消息格式转换器是唯一的新逻辑。

---

## 2. 四断点映射（核心 — 省钱的全部所在）

天枢 `ContextLayer.stability`（`src/prompt/context-layer.ts`）已经标好稳定度，`LAYER_ORDER` 已经是 `tools → system → messages` 顺序。断点不是新设计分层，是**把 4 个 `cache_control` 卡在已有的 stability 跌落边界上**。

| # | 卡在哪 | TTL | 对应天枢的层 | 为什么 |
|---|--------|-----|------------|--------|
| 1 | `tools` 数组最后一个工具 | 1h | `tools` (stable) | 工具定义几乎不变；发送前按 name 排序固定 |
| 2 | `system` 最后一个 content block | 1h | `system` (stable) | system prompt 稳定。**前提：system 段绝对无日期/时间戳** |
| 3 | 项目指令+记忆块末尾（最后一个 stable-volatile） | 5m | `project-instructions`/`session-memory` | 每会话可能更新，会话内稳定 |
| 4 | 最近一个**已完成**轮次的末尾 | 5m | `recent-raw-turns` 边界 | 对话历史增长处。卡已完成轮，不卡正在变的当前轮 |

**约束**：1h 断点（1、2）必须排在 5m 断点（3、4）之前——`LAYER_ORDER` 已满足。

### cache_control 的确切 JSON 结构

`cache_control` 加在三处：system content block、tools 数组**最后一个**工具、message content block。断点语义是 **cumulative 前缀**——写入"从开头到此块为止的整个前缀"的 hash，不是"缓存这一块"。改动断点**之前**的任何内容 → hash 变 → miss。

```json
{
  "model": "claude-opus-4-7",
  "max_tokens": 1024,
  "system": [
    { "type": "text", "text": "<整个 system prompt，无日期>",
      "cache_control": { "type": "ephemeral", "ttl": "1h" } }
  ],
  "tools": [
    { "name": "...", "input_schema": {} },
    { "name": "...", "input_schema": {},
      "cache_control": { "type": "ephemeral", "ttl": "1h" } }
  ],
  "messages": [
    { "role": "user", "content": [
      { "type": "text", "text": "项目指令+记忆",
        "cache_control": { "type": "ephemeral" } } ] },
    "...已完成轮次...",
    { "role": "assistant", "content": [
      { "type": "text", "text": "最近已完成轮末尾",
        "cache_control": { "type": "ephemeral" } } ] }
  ]
}
```

---

## 3. 三个必须修的坑（否则命中率归零）

| 坑 | 影响 | 修法 |
|----|------|------|
| **`minCacheTokens` 错值** | `provider-profile.ts:14` 写 `1024`（Sonnet 值）。**Opus 实际 4096**。system 块若 <4096 token 静默不缓存 | 按模型区分：Sonnet 1024 / Opus 4096 / Haiku 4096 |
| **日期注入杀手** | system 里任何时间戳 → 每次请求 prefix hash 不同 → 命中率 0%。这是头号杀手 | 确认 Anthropic system 段无 `currentDate`。天枢 `buildStableVolatileBlock` 已把 gitStatus 排除保 FROZEN 前缀（`volatile.ts:274`）——同一纪律延伸到日期。日期只放在断点 4 之后的当前 user message |
| **非确定性序列化** | tools 顺序或 JSON key 顺序不稳定 → hash 变 | 发送前 tools 按 name 排序；复用已存在的 `stableStringify`（`context-layer.ts:59`）保 key 顺序 |

**其他已知坑**：lookback window 20 个 block——对话增长超 20 block 会 miss，需每 ~15 block 加断点（断点 4 的滚动逻辑）；`tool_choice` 变化会失效 messages 缓存，保持恒定。

---

## 4. 验证

- 扩展已有的 `src/prompt/cache-diagnostic.ts`，读 Anthropic 的 `cache_read_input_tokens` / `cache_creation_input_tokens`。
- **流式响应里这些字段在 `message_start` SSE event，不在 content delta**。
- 成功标准：跑一轮多回合任务，稳定后 `cache_read / total_input ≥ 0.9`。
- 可选预热：会话开始用 `max_tokens: 0` 填充缓存，消除首请求延迟。

### 价格参照（Opus，验证省钱用）

| 项 | 倍率 |
|----|------|
| cache write 5m | 1.25x base input |
| cache write 1h | 2.00x base input |
| cache read (hit) | 0.10x base input |
| TTL hit 时刷新 | 免费（TTL 重置 $0） |

usage 公式：`total_input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens`

---

## 范围

一个新 client + 四断点映射 + 三个坑修复 + 一个诊断扩展。**不含**提示层重构、agent loop 改动。实现顺序天枢居民自主决定。

退出条件：若 Anthropic system 段无法做到完全无日期注入（被其他机制强依赖），断点 2 降级或合并到断点 3，命中率目标下调，先验证 1/3/4 三断点。
