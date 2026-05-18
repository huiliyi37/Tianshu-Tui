# Context Resilience Layer — 设计文档

## 背景

Rivet 在长会话中存在两类系统性故障：

1. **Token 炸穿** — 上下文无声增长到 1M 窗口极限，触发 checkpoint-resume 硬截断，丢失大量工作上下文
2. **幻觉循环** — 模型基于不完整信息（截断文件、压缩后丢失的历史）做出错误决策，doom loop 检测无法有效阻断

这两类问题互相放大：token 浪费导致更早触发压缩，压缩丢失上下文导致幻觉，幻觉导致重复失败的 tool 调用进一步浪费 token。

## 问题分析

### Token 增长的 5 个无守卫路径

| # | 路径 | 增长速率 | 当前防护 |
|---|------|----------|----------|
| 1 | Volatile context 每轮重复注入 | ~1000 tok/turn × N turns | 无 |
| 2 | Thinking blocks 不参与压缩 | 10K-50K tok/turn | 无 |
| 3 | Tool result 截断阈值过高 (100K) | 最高 100K tok/单次 | 有但过宽 |
| 4 | Compaction 触发太晚 (60%/80%) | 线性增长到 600K 无干预 | 有但太晚 |
| 5 | 50 轮 turn loop 无 token 预算 | 50 × 20K = 1M | 无 |

### 幻觉的 4 个结构性来源

| # | 来源 | 机制 |
|---|------|------|
| 1 | read_file 截断 (8K chars) | 模型看到头尾，推测中间内容 |
| 2 | enforceContextCeiling 硬截断 | 只保留 2 条 anchor + 摘要，丢失所有工作细节 |
| 3 | Doom loop blocked 不终止 turn | 模型收到 error 后换 tool 继续，或直接输出"完成了" |
| 4 | Strategy shift 是 hint 不是 constraint | 模型可以忽略 volatile 中的策略建议 |

### 根因链

```
用户发起复杂任务
  → 模型执行 20+ 轮 tool calls
    → volatile context × 20 = 20K token 纯重复
    → thinking blocks × 20 = 200K-400K token 不可压缩  ← ✅ 已修复 (5ed2c9d): 截断到 500 chars/条
    → tool results 累积 = 200K+ token
      → 到达 800K 触发 smart compact
        → compact 模型收到 24K chars 摘要输入（含 thinking 噪声）
        → 产出低质量摘要
          → 模型丢失关键上下文
            → 基于不完整信息做 edit
              → edit 失败 → doom loop
                → doom loop 只 warn 不 break
                  → 继续浪费 token 直到 95% ceiling
                    → 硬截断 → 彻底丢失上下文
```

## 设计目标

1. **渐进式 token 预算** — 从第 1 轮开始控制增长，而非等到 80% 才反应
2. **Thinking 可压缩** — thinking blocks 在历史 turns 中应被截断或移除
3. **幻觉硬阻断** — doom loop blocked 时终止 turn loop，强制返回用户
4. **截断感知** — 模型必须知道自己看到的是不完整信息，且被强制使用 offset/limit

## 设计方案

### 模块 1：Volatile Budget Cap

**位置**: `src/prompt/engine.ts`

**策略**: 限制 volatile block 注入的总 token 预算为 context window 的 5%（50K tokens for 1M window）。

- 计算当前 request 中所有 volatile blocks 的总 token
- 如果超出预算，从最早的 historical turns 开始跳过 volatile injection
- 最近 3 轮的 volatile 始终保留（模型需要近期上下文）
- frozen-V1 block 在超出预算时替换为单行 `<context cached="true" />`

### 模块 2：Thinking Compaction

**位置**: `src/compact/micro.ts`

**状态**: ✅ 已实现 — commit `5ed2c9d` on `feat/tui-2.4-structural-maturity`

**已实现方案**: 在 `microCompact()` Tier 1 中增加 `compactThinkingBlock()`：
- 历史（非近期、非 anchor）assistant 消息中的 thinking blocks 截断到 500 chars
- 近期消息（最后 KEEP_RECENT_MESSAGES=4）保持完整
- 短 thinking（≤500 chars）不处理
- 不需要新的 LLM 调用，不影响 prefix cache

**效果**: 20 轮会话中 thinking blocks 从 ~360K tokens 降至 ~9K tokens。

### 模块 3：Compaction 阈值前移

**位置**: `src/context/compact-policy.ts` + `src/compact/constants.ts`

**策略**: 降低触发阈值，实现渐进式压缩。

| 原始 | 新值 | 效果 |
|------|------|------|
| Tier 1: 60% | 40% (400K) | 更早开始截断 tool results |
| Tier 2: 78% | 55% (550K) | 更早推荐 session memory compact |
| Tier 3: 88% | 70% (700K) | 更早触发 reactive round summarization |
| Tier 4: 95% | 85% (850K) | 更早触发 checkpoint-resume |
| Tool result max: 100K | 30K | 单个 tool result 上限降低 |

### 模块 4：Doom Loop Hard Break

**位置**: `src/agent/loop.ts` + `src/agent/tool-pipeline.ts`

**策略**: doom loop `blocked` 时终止 turn loop，不允许模型继续。

- `executeToolUse` 返回一个 `shouldBreakLoop` flag
- 当 doom level = `blocked` 时，设置 `shouldBreakLoop = true`
- 主 turn loop 检查此 flag，如果为 true 则 `break` 并通知用户
- 同时：连续 3 个 tool 被 block（任何原因）也触发 break

### 模块 5：Truncation-Aware Read

**位置**: `src/tools/read-file.ts`

**策略**: 当文件被截断时，返回结构化提示强制模型使用 offset/limit。

- 截断时 `is_error: false` 但在 content 前加入强制指令：
  ```
  ⚠️ FILE TRUNCATED: Only showing lines 1-80 and 450-500 of 500 total lines.
  Lines 81-449 are NOT visible. You MUST use offset/limit to read the specific
  section you need before making any edits to this file.
  DO NOT guess or infer content in the omitted region.
  ```
- 同时降低 MODEL_MAX_CHARS 从 8000 到 6000（强制更多使用 offset/limit）

### 模块 6：Turn Budget Guard

**位置**: `src/agent/loop.ts`

**策略**: 每轮开始时检查 token 增长速率，如果预计会超出 ceiling 则提前终止。

- 计算最近 3 轮的平均 token 增长
- 如果 `currentTokens + avgGrowth * 3 > contextWindow * 0.85`，注入 warning 到 volatile
- 如果 `currentTokens + avgGrowth > contextWindow * 0.90`，强制 compact 后再继续
- 如果 compact 后仍然 > 85%，break turn loop 并通知用户

## 不做的事

- 不改变 prefix cache 策略（frozen volatile 的存在是为了 cache hit）
- 不引入新的 LLM 调用（所有新逻辑都是本地计算）
- 不改变 session persist 格式
- 不改变 tool 定义的 API schema

## 风险

| 风险 | 缓解 |
|------|------|
| 过早压缩导致信息丢失 | Thinking 截断保留开头结论；volatile 跳过只影响最早的 turns |
| Doom loop break 过于激进 | 只在 `blocked`（3 次相同 fingerprint）时触发，不影响 `warn` |
| read_file 截断提示被模型忽略 | 这是 DeepSeek 模型行为问题，但至少提供了正确信号 |
| Compaction 阈值前移影响 cache hit rate | 前移后 compact 更频繁但每次压缩量更小，cache prefix 更稳定 |

## 依赖

- 无外部依赖变更
- 所有修改在现有模块内完成
- 测试覆盖：每个模块对应的 `__tests__/` 文件
