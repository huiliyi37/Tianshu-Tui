# 天枢创新优化路线图

> 基于 8 个并行 Scout 代理的全方位调研，整合竞品分析、内部审计、前沿论文、DeepSeek 专项研究。
> 按 **影响力 × 可行性** 排序，分为"立即可做"、"短期规划"、"中期创新"三层。

---

## 🔴 P0 — 立即可做（1-3 天，高 ROI）

### 1. Volatile Block 去重（每次 API 调用省 2500-10000 tokens）

**问题**：每个历史 user message 前都注入了 frozen volatile block（.rivet.md + project-memory + environment），5 条 user message = 重复 5 次。

**修复**：只在第一条 user message 注入 frozen volatile block，历史 user messages 不再重复注入。

**文件**：`src/prompt/engine.ts:104-165`
**预期收益**：长 session 每次 API 调用省 5000+ tokens，延迟 compaction 触发点

---

### 2. Read-only Tool 并行执行（省 2-10s 延迟/turn）

**问题**：`tool-execution.ts:105` 的 `for...of` 循环串行执行所有 tool，包括可并行的 read_file/grep/glob。

**修复**：
```typescript
const readOnly = toolUses.filter(isConcurrencySafe)
const writeTools = toolUses.filter(t => !isConcurrencySafe(t))
const readResults = await Promise.all(readOnly.map(tu => executeToolUse(tu, ...)))
for (const tu of writeTools) { /* sequential */ }
```

**文件**：`src/agent/tool-execution.ts:104-148`
**预期收益**：3 个并行 read_file 从 ~600ms 降到 ~200ms

---

### 3. stableStringify 仅用于 fingerprint（省 10-50ms CPU/call）

**问题**：HTTP body 用 `stableStringify`（递归 key 排序），API 不关心 key 顺序。

**修复**：HTTP body 用 `JSON.stringify`，`stableStringify` 仅用于 `PrefixFingerprint` 计算。

**文件**：`src/api/openai-client.ts:182`

---

### 4. Chinese Thinking 指令移入静态 system prompt（修复 prefix cache miss）

**问题**：每次请求时追加中文思考指令到 system message，改变了 system prompt 字节，可能破坏 prefix cache。

**修复**：在 `buildSystemPrompt` 时根据 provider 条件性包含，而非请求时追加。

**文件**：`src/api/openai-client.ts:140-148`

---

### 5. Tool Description 去重（省 ~200 tokens/call）

**问题**：bash 工具描述中的 git 规则、文件操作规则与 system prompt 重复。

**修复**：从 bash tool description 中删除已在 `<tool-usage>` 和 `<git>` section 中存在的规则。

**文件**：`src/tools/` 相关定义文件

---

## 🟡 P1 — 短期规划（1-2 周）

### 6. Streaming Tool Call 预执行（省 200-500ms/tool call）

**来源**：PASTE 论文 + Cursor speculative execution

**方案**：流式解析 tool call JSON，当 `file_path` 可解析时立即触发 prewarm read，不等 `finish_reason`。

**实现**：
- 在 `processDelta()` 中增量解析 `toolCallBuffer`
- 当检测到完整的 `{"file_path": "..."}` 时，触发 `prewarmCache.warmFile(path)`
- tool 执行时直接命中 prewarm cache

**文件**：`src/api/openai-client.ts` (streaming), `src/agent/prewarm.ts`

---

### 7. Observation Masking（比 summarization 更好的长 session 策略）

**来源**：JetBrains 2025 研究 — masking 比 summarization 省 52% 成本且 +2.6% 解决率

**方案**：保留所有 reasoning 和 action，只替换旧的 environment observations（tool results）为占位符。保留最近 10 轮的完整 observations。

**与现有 prune 的关系**：当前 prune 只清理 >1200 chars 的 tool results。Observation masking 更激进 — 对超过 10 轮前的 ALL tool results 替换为 `[observation masked: read_file src/foo.ts, 245 lines]`。

**文件**：新建 `src/compact/observation-mask.ts`

---

### 8. File Deduplication（同文件多次读取去重）

**来源**：Cline 的 context management

**方案**：追踪 session 中已展示的文件内容。当同一文件被再次 read 且内容未变时，替换为 `[file unchanged since turn 5, use read_file to refresh]`。

**实现**：在 `SessionContext` 中维护 `fileContentHashes: Map<string, {hash: string, turn: number}>`

---

### 9. Progressive Compression 五级管线（借鉴 Claude Code）

**来源**：Claude Code 的 5 级压缩管线

**当前状态**：Rivet 有 prune + stale-round + microCompact + autoCompact。缺少：
- Level 0: Tool result budget（>50K 持久化到磁盘，注入 2KB preview）
- Level 3: Context Collapse（非破坏性投影，messages 不变但 API 只看过滤后的子集）

**优先实现**：Tool result budget（防止单个 bash 输出吃掉整个 context）

---

### 10. Reflective Internalization Compaction（意图级压缩）

**来源**：ProductResearch 2026 论文

**方案**：compaction 时不做简单 summarization，而是让模型"回顾自己的轨迹"，产出：
- 我做了什么决策，为什么
- 关键发现和状态
- 下一步计划

**比 naive summary 保留更多决策理由，丢弃机械步骤。**

---

## 🟢 P2 — 中期创新（2-4 周，天枢差异化）

### 11. PASTE-lite: Tool Pattern Mining + Shadow Queue

**来源**：PASTE 论文（48.5% 任务完成时间减少，93.8% 命中率）

**方案**：
- 从 `trace-store` 挖掘工具调用序列模式（如 "grep 后 55% 概率 read_file 匹配文件"）
- 维护 shadow queue，在 LLM 生成时预执行高概率下一步工具
- 结果缓存，命中时直接返回

**天枢创新点**：结合 DeepSeek 的低成本优势，可以更激进地预执行

---

### 12. 多代理 Context Isolation 架构

**来源**：Devin 生产经验 + Anthropic 多代理研究

**核心发现**：
- 3 个专注代理 > 1 个通才工作 3 倍时间
- Context isolation（独立 context window）比 context sharing 效果好 58%
- File-system as shared memory（JSON/git）比共享 context 更可靠

**天枢方案**：
- Main agent（规划 + 协调）
- Worker agents（独立 git worktree，专注单文件/单模块）
- Reviewer agent（只看 diff，clean context = 更好的 attention）

---

### 13. 基于 Tree-sitter 的增量代码图（替代 Vector DB）

**来源**：Aider PageRank repo map + codemap/codemogger 项目

**方案**：
- Tree-sitter AST → 提取 symbols/edges → SQLite 存储
- Personalized PageRank 排序（当前 chat 文件 50x 权重）
- Binary search 适配 token budget（默认 1K tokens 的 repo map）
- 增量更新（SHA-256 hash 检测变更文件）

**优势**：无需外部向量数据库，无需 embedding API 调用，纯本地，毫秒级查询

---

### 14. Adaptive Model Routing（Flash/Pro 自动切换）

**来源**：DeepSeek V4 Flash vs Pro 定价差异（Flash 便宜 12x）

**方案**：
| 任务类型 | 模型 | 理由 |
|---------|------|------|
| read_file, grep, glob | V4 Flash | 简单 dispatch |
| 单文件编辑 | V4 Flash | 足够 |
| 复杂调试 | V4 Pro (thinking) | 需要推理 |
| 架构决策 | V4 Pro (thinking) | 需要深度分析 |

**实现**：基于 tool_calls 模式和 user message 复杂度自动路由

---

### 15. Chat Prefix Completion（强制结构化输出）

**来源**：DeepSeek Beta API

**方案**：对于代码生成，使用 prefix completion 强制模型直接输出代码：
```typescript
messages = [
  { role: "assistant", content: "```typescript\n", prefix: true }
]
```
减少 "Let me..." 等废话，直接输出代码。省 30%+ output tokens。

---

## 🔵 P3 — 远期愿景（探索性）

### 16. AgenticCache（缓存验证过的 plan-to-plan 转换）

86% 延迟减少，79% 成本节省。需要 pattern DB 基础设施。

### 17. Online RL 学习用户偏好

类似 Cursor Tab 的 accept/reject 学习循环。需要数据收集基础设施。

### 18. Speculative Edit（原文件作为 draft prediction）

Cursor 已废弃此方案（转向多代理），但概念仍有价值。需要 speculative decoding 基础设施。

### 19. 异步后台代理（"Sleep While Coding"）

类似 Jules/Codex 的后台任务队列。需要持久化执行环境。

---

## 关键数据点

| 指标 | 当前 | 优化后预期 |
|------|------|-----------|
| Prefix cache hit rate | ~70-80% | 90-95%（修复 P0-1,4） |
| 每次 API 调用 token 浪费 | ~5000-10000 | <500（P0-1,5） |
| Tool 执行延迟（多 tool） | 串行 600ms+ | 并行 200ms（P0-2） |
| 长 session compaction 频率 | 每 15-20 turn | 每 25-30 turn（P1-7,8） |
| 单次 bash 输出最大 context 占用 | 无限 | 2KB preview + 磁盘（P1-9） |

---

## DeepSeek 专项要点

1. **Cache hit = 50x 便宜** — 一切优化的核心目标是保持 prefix 稳定
2. **最小 cache 单位 = 64 tokens** — 短于此的内容永远不会被缓存
3. **TTL = 数小时到数天** — 不用担心 5 分钟过期（Anthropic 的问题）
4. **Temperature 0.6** — 不要用 0.0，会导致 R1 进入重复推理循环
5. **V4 Flash 并发限制 2500** — 可以大胆并行
6. **FIM 不适合 agent 编辑** — 但适合未来的 autocomplete 功能
7. **R1 token 在 turn 1 后下降 69.7%** — 多轮 session 自然变高效

---

## 执行建议

**第一批（本周）**：P0-1 到 P0-5，纯代码修改，无架构变更，立即见效
**第二批（下周）**：P1-6 到 P1-8，需要新模块但逻辑简单
**第三批（两周后）**：P1-9 到 P2-15，架构级变更，需要设计评审

要开始执行哪一批？
