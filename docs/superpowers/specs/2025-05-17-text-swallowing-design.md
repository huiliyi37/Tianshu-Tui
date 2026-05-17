# 终端 Agent 回复被吞/截断问题 — 深度头脑风暴 & 设计文档

## 背景

**用户报告：**
- 会话内对话回复被吞（完全看不到）
- 有时一段回复的最后一句会看不见
- 多 turn 工具调用场景下尤其明显

**项目上下文：** Rivet TUI — 基于 Ink (React terminal) 的 AI coding agent，支持 DeepSeek/Codex 双协议，多 turn 工具调用循环。

---

## 调研发现摘要

### Scout 1: 竞态条件分析
- `lastTurnText` 不在 `run()` 中重置 — 跨对话轮次的去重误杀
- `onTurnComplete` 销毁 writer 后，后续 turn 文本通过 `blockWriterRef.current?.push(text)` 时 writer 为 null，文本静默丢弃
- `flush()` 本身是同步的，单次 turn 内不会丢文本

### Scout 2: Codex 双重发射
- **确认为真实 bug**：`response.output_text.delta`（line 301）和 `response.output_item.done`（line 364）都调用 `callbacks.onTextDelta()`
- 没有任何去重逻辑
- commit `802bb38` 作者误以为 API 只发 `output_item.done`，但实际两者都发
- 导致 `turnDisplayBuffer` 积累双倍文本

### Scout 3: 行业调研
- **Ink 框架已知 bug**：`textWrap="wrap"` 截断最后一行（ink#245）
- **Ink v5.1.0 竞态**：throttle 替换导致 unmount 后渲染（ink#692）— 已在 v6.7.0 修复
- **Claude Code CLI** 也有类似问题：#14694 "Response text missing from CLI display"
- **OpenAI Codex CLI**：硬编码截断限制静默删除内容
- 当前项目使用 Ink 6.8.0，已包含 unmount flush 修复

### Scout 4: 随机 7-Hop 探查
- `BlockStreamWriter` 500ms idle timer + 100 char minimum = 短尾内容丢失的直接机制
- `app.tsx` 1012 行 god-component + 5 个并发定时器 = 竞态温床
- `normalizeToolResultPairs` 静默丢弃孤儿 tool_result — compaction 后可能丢上下文

---

## 三轮演化思考

### 第一轮：变异（Variation）

```
生态位: 终端 TUI agent / 多 turn 流式对话 / Ink React 框架 / DeepSeek+Codex 双协议
选择压力: 文本不丢失 + 流式体验流畅 + 不引入新的闪烁/重复问题
已占据: turnDisplayBuffer 批量刷新方案 / 空位: 实时流式 + 分层缓冲

方案:
  V1(主流): 修复 onTurnComplete — 区分中间 turn 和最终 turn，中间 turn 不销毁 writer
  V2(邻近): 恢复实时流式 — 去掉 turnDisplayBuffer，回到直接 onTextDelta 转发
  V3(空位): 分层缓冲架构 — agent loop 只管数据，TUI 侧用独立 StreamSession 管理生命周期
  V4(突变): 事件总线 — EventEmitter 解耦 agent loop 和 TUI

创始假设: 假设「onTurnComplete 是 turn 结束的唯一信号」— 实际上 agent loop 的 turn 和 TUI 的 turn 是不同概念
适应度函数:
  硬约束=文本零丢失 + 不引入新 bug + 改动最小化
  加分=保留 turnDisplayBuffer 去重能力 + 保留 BlockStreamWriter 流畅性
  减分=大范围重构 + 引入新状态管理复杂度
```

### 第二轮：选择（Selection）

```
目标重注入: 用户报告"回复被吞"和"最后一句看不见"。核心需求是修复文本丢失。

因果测试:
  V1: 通过 — onTurnComplete 销毁 writer → 后续 turn 文本丢失 → 区分中间/最终 → 修复
  V2: 断裂 — 解决丢失但重新引入 commit 49e5ec9 修复的"重复 intro text"问题
  V3: 通过但过度 — 大范围重构，当前问题是明确的 bug 不是架构缺陷
  V4: 高概念寄生 — 用架构术语掩盖简单 bug fix

成本测试:
  V1: 低(改 2-3 文件) / V2: 低但有回退风险 / V3: 高(重写) / V4: 高(重写)

灭绝:
  V2 — 因果断裂，重新引入已修复的重复问题
  V3 — 成本远超收益
  V4 — 高概念寄生

存活: V1(强·最小改动修复核心 bug)

discarded_trait 回收:
  - V2 的"实时流式"→ 中间 turn 文本可直接追加 streamBuf 不经 writer
  - V3 的"生命周期独立管理"→ writer 生命周期跟随 run() 而非 onTurnComplete
```

### 第三轮：适应（Adaptation）

```
套路清除: 不需要"事件驱动"或"状态机"重构
扩展适应: V3 的"生命周期独立管理" → 简化为 writer 跟随 run() 生命周期

具体化:
  人: Rivet 用户在多 turn 对话中（模型调用工具后继续回复）
  场: 模型输出 text + tool_use → 工具执行 → 模型输出更多 text
  动: 修复 onTurnComplete 不再销毁中间 turn 的 writer
  果: 所有 turn 的文本都可见，"回复被吞"问题消失

收敛验证: V1 和 V3 收敛到"writer 生命周期不应由 onTurnComplete 控制"— 核心真相
```

---

## 最终 Bug 清单

| # | Bug | 严重度 | 表现 | 根因位置 |
|---|-----|--------|------|----------|
| B1 | `onTurnComplete` 中间 turn 销毁 writer | 🔴 Critical | 多 turn 对话中后续回复完全消失 | `app.tsx:761-764` |
| B2 | `lastTurnText` 跨 `run()` 不重置 | 🟡 Medium | 新对话首回复偶尔被误判为重复而抑制 | `loop.ts:99,503` |
| B3 | Codex client 双重文本发射 | 🟡 Medium | Codex 模式下 turnDisplayBuffer 积累双倍文本 | `codex-client.ts:301,364` |
| B4 | `StreamOutput` 使用 `wrap="wrap"` | 🟠 Low-Med | 长行文本最后一行可能被 Ink 截断 | `stream.tsx:17` |

---

## 最终设计方案

### 核心修复策略

**原则：** writer 的生命周期跟随 `handleSubmit` 的 `run()` 调用，而非 `onTurnComplete`。

**修复 B1：区分中间/最终 turn**

在 `loop.ts` 中给 `AgentCallbacks.onTurnComplete` 加 `isFinal: boolean` 参数：
- Line 599（中间 turn）：`callbacks.onTurnComplete(usage, turnCount, false)`
- Line 642（最终 turn）：`callbacks.onTurnComplete(usage, turnCount, true)`

在 `app.tsx` 的 `onTurnComplete` handler 中：
- `isFinal === false`：只 flush dirty tools + 更新 summary/activity，**不销毁 writer，不设 isStreaming=false，不 push to static**
- `isFinal === true`：执行当前完整清理逻辑

**修复 B2：重置 lastTurnText**

在 `loop.ts` 的 `run()` 方法开头加：`this.lastTurnText = ''`

**修复 B3：Codex 去重**

在 `codex-client.ts` 的 `processSSEStream` 中加 `seenTextDelta = false` 标记：
- `response.output_text.delta` handler 中设 `seenTextDelta = true`
- `output_item.done` message handler 中：如果 `seenTextDelta` 为 true，跳过文本发射（只保留 usage 提取）

**修复 B4：Ink wrap 截断**

`stream.tsx` 的 `<Text wrap="wrap">` 改为 `<Text>`（去掉 wrap 属性，让 Box 的 flexDirection="column" 自然换行）

---

## 风险与应对

| 风险 | 应对 |
|------|------|
| B1 修复后中间 turn 的 streamBuf 累积导致最终 push 重复 | 中间 turn 不 push to static，只在 isFinal 时 push |
| B3 修复后某些 Codex API 版本只发 output_item.done 不发 delta | seenTextDelta 为 false 时仍然发射 output_item.done 文本 |
| B4 去掉 wrap 后长行不换行 | Box 已有 paddingX={1}，Ink 默认按终端宽度截断 |
| turnDisplayBuffer 去重仍可能误杀完全相同的短回复 | 可接受 — 极端边界条件，后续可改为前缀匹配 |

---

## 下一步

使用配套实施计划 `2025-05-17-text-swallowing-fix.md` 进行开发。
