# Deep Interview — 认知对齐模式

## 背景

终端 coding agent 常见问题：用户给一个模糊需求，agent 立即开始写代码，方向跑偏后浪费大量 token。OMC 的 deep-interview 通过 Socratic 追问在执行前对齐意图，实践证明可显著降低返工率（但 token 开销约 7x）。

本设计将 deep-interview 简化为两阶段模式，集成到 Rivet TUI 的 status bar 中，以最小改动实现最大收益。

## 核心设计

### 两阶段流程

```
用户输入 → [Phase 1: 认知对齐] → 用户确认 → [Phase 2: 规划/实现]
                ↓
         status bar 显示 interview 状态
         agent 追问（消息流中自然展开）
         清晰度分数实时更新
```

**Phase 1: 认知对齐**（复用 cognitive-alignment 核心逻辑）

1. **意图保存**（Stage 0.1）— 逐字记录用户原话，不改写成工程任务
2. **问题层级标注**（Stage 0.2）— 判断 L1-L7 哪个层级，标注主层级
3. **澄清追问**（循环）— 每次一个问题，优先选择题，收集约束和成功标准
4. **认知同步摘要** — 3-5 句话向用户展示理解，请求确认或补充

**Phase 2: 进入规划** — 用户确认后对接现有 brainstorming/planning skill

### 触发方式

- `/interview "加个通知系统"` — 显式触发
- Agent 自判断 — 复杂需求自动进入（prompt 指令驱动）
- `直接做` / `跳过` — 用户随时可跳过 interview 进入实现

## Status Bar 展示

### 正常模式

```
deepseek-v4 │ cache:92.1% │ ctx:healthy │ rounds:safe │ ¥0.03 │ ▓▓▓▓▓░░░░░ 2.1k/8k (26%)
```

### Interview 激活时

```
⚡ interview │ R2/5 │ clarity:0.7▲ │ ~2.1k tok │ intent:加通知系统
```

字段说明：

| 字段 | 含义 | 示例 |
|------|------|------|
| `⚡ interview` | 当前处于 interview 模式 | 固定前缀 |
| `R2/5` | 当前第 2 轮追问 / 上限 5 轮 | 超过上限自动结束 |
| `clarity:0.7▲` | 清晰度分数 0-1 + 趋势箭头 | ▲上升 ▼下降 ─持平 |
| `~2.1k tok` | interview 累计 token 消耗 | 让用户感知成本 |
| `intent:...` | 意图一句话摘要 | 从 agent 输出中提取 |

颜色编码：
- `clarity < 0.4` → 红色
- `clarity 0.4-0.7` → 黄色
- `clarity > 0.7` → 绿色

### Interview 结束（摘要展示时）

```
⚡ interview │ clarity:0.9 │ ✓ 确认即规划 │ intent:站内+Webhook异步通知
```

### 回到正常模式

用户确认后 status bar 恢复正常显示。

## 清晰度分数算法

### 规则清单（底分）

| 检查项 | 权重 | 通过条件 |
|--------|------|---------|
| 意图明确 | 25% | 有具体目标（不是"优化一下"） |
| 约束已识别 | 25% | 有明确边界（技术栈/范围/排除项） |
| 成功标准可衡量 | 25% | 有可验证的完成条件 |
| 边缘场景已讨论 | 25% | 至少 1 个 edge case 被提及或明确排除 |

底分 = Σ(通过项 × 权重)，范围 0-1。

### Agent 动态加减分

| 场景 | 加减分 | 说明 |
|------|--------|------|
| 用户主动提供 edge case | +0.1 | 信息密度高 |
| 需求可映射到 BDD 场景 | +0.1 | 结构化程度高 |
| 存在未解决的矛盾假设 | -0.15 | 如"既要快又要全" |
| 连续 2 次回答"不确定" | -0.1 | 对齐困难 |
| 发现隐含约束 | +0.1 | 深度理解 |

最终分数 = clamp(底分 + 动态加减分, 0, 1)。

### 数据流

```
agent 输出结构化标记:
  <!-- interview:{"intent":"...","clarity":0.7,"round":2,"scores":{"intent":1,"constraints":0.5,"criteria":1,"edges":0}} -->

status-bar.tsx 解析标记 → 更新 StatusBar props → 渲染
```

Agent 在每轮回复末尾附加此标记。TUI 层只做解析和展示，不参与评分计算。

## 降级机制

### Round 上限

- 硬上限 5 轮。超过后 agent 自动生成摘要并请求确认（无论 clarity 多少）
- 用户可用 `直接做` 在任何轮次跳过

### 最佳努力模式

如果用户连续 2 次回答"不确定"/"不知道"/"跳过"，agent 切换到最佳努力模式：
- 基于已有信息制定方案
- 明确标注不确定区域（如"⚠ 未确认：是否需要离线支持"）
- 不再追问，直接进入摘要阶段

### 快速模式

用户输入以 `直接做` 或 `跳过 interview` 开头时，完全跳过 interview，clarity = 0。

## Prompt 设计

在 system prompt 中加入 interview segment：

```
## Interview Mode

When the user's request is complex (multi-file, multi-system, or ambiguous intent),
activate interview mode before implementing:

1. Save user's original intent verbatim — never rewrite into engineering tasks
2. Ask ONE clarifying question at a time (prefer multiple choice)
3. Track clarity across 4 dimensions: intent clarity, constraints, success criteria, edge cases
4. After each round, output: <!-- interview:{...} -->
5. When clarity ≥ 0.8 OR after 5 rounds, present a cognitive sync summary
6. Wait for user confirmation before proceeding to planning

Clarity scoring:
- Base = weighted average of 4 dimensions (each 0 or 1, weight 25%)
- +0.1 if user volunteers edge cases
- +0.1 if requirement maps to BDD scenario
- -0.15 if contradictory assumptions exist
- -0.1 if user answers "not sure" twice consecutively

Degradation:
- If user says "just do it" or "skip", exit interview immediately
- If 2 consecutive uncertain answers, switch to best-effort mode
- Hard cap: 5 rounds, then force summary
```

## 改动清单

| 文件 | 改动 | 复杂度 |
|------|------|--------|
| `src/tui/status-bar.tsx` | 加 interview 状态行渲染 | 低 |
| `src/tui/phase-tracker.ts` | Phase 新增 `interview` 状态 | 低 |
| `src/prompt/` (interview segment) | 新 prompt segment 驱动 agent 对齐行为 | 中 |
| `src/tui/app.tsx` | 解析 agent 输出中的 interview 标记，传递给 StatusBar | 中 |
| `src/tui/slash-commands.ts` | 新增 `/interview` 命令 | 低 |

不需要改动：
- agent loop 核心状态机
- cockpit panel（不新建 panel）
- 现有 planning/brainstorming skill

## 测试要点

1. Status bar interview 状态渲染正确（颜色、字段、趋势箭头）
2. Clarity 分数解析和 clamp 逻辑
3. Round 上限触发降级
4. 最佳努力模式触发条件
5. `/interview` 命令解析
6. Interview 结束后状态恢复

## 实现备注

- `/interview` 通过替换 `userInput` fall-through 到主 `agent.run` 调用，不重复回调逻辑
- Ctrl+C handler 使用 `_input === 'c' && _key.ctrl`（Ink 6 的 `useInput` 经 parseKeypress 后 Ctrl+C 的 input 是 `"c"`，不是 `"\x03"`）
- Interview marker regex 使用 `.*?`（非 `[^}]+`）以支持 intent 包含 `}` 字符
- 双击 Ctrl+C 使用 `process.emit('SIGINT')` 触发 gracefulShutdown（含 session 持久化）

## 参考

- oh-my-claudecode `/deep-interview` — Socratic 追问 + 加权模糊度评分 + 阈值门控
- hoyeon spec.json — BDD 场景模板 (given/when/then + verified_by)
- cognitive-alignment skill — 意图保存、问题层级标注、认知同步摘要
- Intent (augmentcode.com) — living spec + spec-level approval 模式
