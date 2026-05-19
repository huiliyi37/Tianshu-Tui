# 天枢之眼 — Agent 执行意识可视化设计

> 日期：2026-05-20
> 来源：deep-brainstorm 三轮达尔文演化（3 技术 scout + 1 神秘学 scout + 1 反证 scout）
> 前置：StarFlow v2 organ network 已实现（sensorium / star phase / vigor / theta）
> 核心洞察：用户不需要理解 agent 的思考过程，只需要 harness 的"同声传译"

---

## 问题

用户发一个任务，agent 自主执行 30-50 turn。用户看到的：
- 大段英文思考文本在滚动
- 工具调用列表（但数量太多后失去意义）
- 不知道在哪个阶段、做到哪里、接下来什么计划
- 不知道是否正常还是卡住了

**Rivet 已有的信号（但全部未暴露给用户）：**

| 信号 | 来源 | 当前状态 |
|------|------|---------|
| 8 个 Star Phase（中文名 + glyph） | `star-event.ts` mapSensoriumToPhase | 从未渲染 |
| 6 维 Sensorium | `sensorium.ts` computeSensorium | 从未展示 |
| TaskState (completed/current/remaining) | `task-state.ts` | 从未渲染 |
| Pheromone 信号 | stigmergy-hook | Cockpit 内（用户不看） |
| Doom loop 检测 | risk assessment | Cockpit 内（用户不看） |
| Evidence state | evidence-tracker | Cockpit 内（用户不看） |
| Tool history (recent 8) | AgentStatus 组件 | 有显示但信息密度低 |

---

## 核心设计：两层翻译

```
Agent 内部状态（英文思考、6 维浮点数、tool call 序列）
       ↓
  Harness 翻译层（不调用 LLM，纯模板 + 数据）
       ↓
  ┌─────────────────────────────────────────┐
  │ Layer 1: 星相 Strip（持续可见背景）     │
  │   ⚔ 执行 │ 步骤 3/5 │ T15 │ ██▓░      │
  │                                         │
  │ Layer 2: 天枢无线电（关键节点中文简报） │
  │   [天枢] 测试失败 2 个，正在修复。      │
  └─────────────────────────────────────────┘
```

手术观察廊类比：观众看的不是手术操作本身，而是翻译后的 vital signs + phase label。

---

## Layer 1：星相 Strip

### 布局

常驻在 agent 输出区域底部，一行：

```
⚔ 执行 │ 步骤 3/5 │ T15/50 │ ██▓░ │ write auth.ts → bash test → fix bug
```

### 组成部分

| 位置 | 内容 | 数据来源 | 更新频率 |
|------|------|---------|---------|
| 左 | Star phase glyph + 中文名 | `mapSensoriumToPhase()` | 每 turn |
| 中左 | 步骤进度 | `TaskState.completed.length / total` | 每 turn |
| 中 | Turn 计数器 | `session.getTurnCount()` | 每 turn |
| 中右 | 炼金色带 | sensorium → 四阶段映射 | 每 turn |
| 右 | 最近 3 个 tool 动作 | `recentToolHistory` 截断 | 每 turn |

### 炼金四色映射

| 阶段 | 色彩 | 条件 | 含义 |
|------|------|------|------|
| Nigredo（黑化） | 暗灰 `░░░░` | confidence < 0.3 | 分解问题、探索阶段 |
| Albedo（白化） | 白 `▓░░░` | confidence 0.3-0.5 | 提纯方案、形成计划 |
| Citrinitas（金化）| 金 `██▓░` | confidence 0.5-0.8 | 突破执行、代码生成 |
| Rubedo（赤化） | 红 `████` | confidence > 0.8 | 完成交付、验证通过 |

### 异常状态

| 状态 | 表现 |
|------|------|
| Doom loop (stability < 0.2) | Strip 变红闪烁 + `⚠ 可能卡住` |
| 高压 (pressure > 0.8) | 色带切换为压力色（橙） |
| 正常 | 按炼金四色渐进 |

### 实现位置

扩展现有 `AgentStatus` 组件（`src/tui/agent-status.tsx`），或合并到 `SummaryBar`。不新建组件。

---

## Layer 2：天枢无线电

### 触发条件

**不是每 turn 都触发。** 只在以下时刻生成简报：

1. **Phase 转换**：sensorium 驱动的 star phase 变化（如 探索 → 执行）
2. **里程碑事件**：测试通过/失败、文件写入、错误发生
3. **异常检测**：doom loop、连续失败、长时间同一 phase

### 消息格式

```
[天枢] {简报内容}
```

以 system message 形式插入对话流（不是 user/assistant message）。用户在思考文本流中看到夹杂的中文简报。

### 模板库

```typescript
const RADIO_TEMPLATES = {
  // Phase 转换
  'explore→plan': '[天枢] 已读取 {fileCount} 个文件{topFiles}。准备制定方案。',
  'plan→execute': '[天枢] 开始{action}。预计修改 {targetFiles}。',
  'execute→verify': '[天枢] 代码修改完成，运行测试验证。',
  'verify→deliver': '[天枢] ✓ 测试全部通过，准备交付结果。',
  
  // 里程碑
  'test_pass': '[天枢] ✓ 测试通过（{passCount}/{totalCount}）。',
  'test_fail': '[天枢] ✗ 测试失败 {failCount} 个：{failSummary}。正在修复。',
  'file_write': '[天枢] 修改了 {fileName}（{changeType}）。',
  'error': '[天枢] ⚠ {toolName} 出错：{errorBrief}。{recoveryAction}。',
  
  // 异常
  'stuck': '[天枢] ⚠ 已在{phaseName}停留 {turnCount} turn，可能遇到困难。',
  'doom_loop': '[天枢] ⚠⚠ 检测到循环：{pattern}。考虑换个方向。',
  'high_pressure': '[天枢] 上下文即将满，准备压缩。',
  
  // 会话节奏
  'session_start': '[天枢] 收到任务，开始分析。',
  'midpoint': '[天枢] 进度 {progress}%，已完成 {completedSteps}。',
  'near_complete': '[天枢] 接近完成，最后验证中。',
}
```

### 模板变量来源

| 变量 | 来源 | 示例 |
|------|------|------|
| `{fileCount}` | `recentToolHistory.filter(read_file).length` | `5` |
| `{topFiles}` | 最近 read_file 的 target 取文件名 | `（auth.ts, types.ts）` |
| `{action}` | 从 star phase 推断 | `修复 auth 模块` |
| `{targetFiles}` | 最近 write/edit 的 target | `middleware.ts, handler.ts` |
| `{failCount}` | test tool result 解析 | `2` |
| `{errorBrief}` | tool error message 截断 | `TypeError: cannot read...` |
| `{phaseName}` | star phase 中文名 | `执行期` |
| `{turnCount}` | 在同一 phase 的 turn 计数 | `8` |

### 频率控制

- Phase 转换：每次都触发（一个 30-turn session 约 3-5 次 phase 转换）
- 里程碑：去重（同一文件连续写入只报一次）
- 异常：cooldown 5 turn（避免重复告警）
- 预期：30-turn session 中约 **5-8 条**简报，不过多不过少

### 实现位置

新建 `src/agent/hooks/radio-hook.ts` 作为 RuntimeHookPipeline 的 postTool hook。

---

## 改动文件

| Phase | 文件 | 变更 | 行数 |
|-------|------|------|------|
| 1 | `src/tui/agent-status.tsx` | 扩展为星相 strip：phase glyph + 步骤 + 色带 + tool 摘要 | ~80 |
| 1 | `src/agent/star-event.ts` | 导出 phase→中文名映射供 TUI 消费 | ~10 |
| 1 | `src/tui/alchemy-bar.tsx` | 新建：sensorium → 炼金四色条渲染 | ~40 |
| 2 | `src/agent/hooks/radio-hook.ts` | 新建：天枢无线电 hook（phase 转换检测 + 模板拼装） | ~100 |
| 2 | `src/agent/radio-templates.ts` | 新建：15 个中文模板 + 变量提取逻辑 | ~80 |
| 2 | `src/agent/__tests__/radio-hook.test.ts` | 模板拼装 + 频率控制测试 | ~80 |
| 3 | `src/tui/app.tsx` | Doom loop 时自动弹出 cockpit | ~20 |
| **总计** | | | **~410 行** |

---

## 预期效果

### 30-turn 自主执行 session 用户体验对比

**Before（当前）：**
```
⠋ Writing…  3m 12s
  edit_file src/auth/middleware.ts
  bash npm test
  read_file src/auth/types.ts

  [大段英文 reasoning 文本滚动，用户看不懂...]
  [又一大段英文 reasoning...]
  [用户：到底做到哪里了？？]
```

**After（天枢之眼）：**
```
  [天枢] 已读取 5 个文件（auth.ts, types.ts, handler.ts...）。准备修复循环依赖。

  [英文 reasoning 滚动...]

  [天枢] 开始修改。预计修改 middleware.ts, handler.ts。

  [英文 reasoning 滚动...]

  [天枢] ✗ 测试失败 2 个：auth.test.ts。正在修复。

  [英文 reasoning 滚动...]

  [天枢] ✓ 测试全部通过。准备交付结果。

  ⚔ 执行 │ 步骤 4/5 │ T18/50 │ ███░ │ fix auth → test pass → deliver
```

### 信息获取时间

| 问题 | Before | After |
|------|--------|-------|
| "在哪个阶段？" | 不知道（需要读英文 thinking 推断） | 1 秒（看 strip phase glyph） |
| "做到哪里了？" | 不知道（数工具调用） | 1 秒（看步骤 3/5） |
| "在干什么？" | 不知道（英文 thinking 看不懂） | 1 秒（看最近的 [天枢] 简报） |
| "是否正常？" | 不知道（直到失败才知道） | 1 秒（看色带颜色 + 有无 ⚠） |

---

## 跨域映射

| 天枢之眼组件 | 手术观察廊 | 空管 | F1 | 指挥家 | 发车标 | 塔罗 | 炼金术 |
|-------------|-----------|------|-----|--------|--------|------|--------|
| 星相 Strip | Vital signs 面板 | Flight strip | 仪表盘 | 总谱位置 | 行状态 | — | 色彩阶段 |
| Phase glyph | 手术阶段标签 | — | — | 乐章标记 | 列车类型图标 | — | 阶段符号 |
| 炼金色带 | — | — | 圈速差值色 | — | 准点/延迟色 | — | 黑→白→金→红 |
| 天枢无线电 | 手术团队喊话 | ATC 指令 | 工程师无线电 | 指挥棒提示 | 广播通知 | — | — |
| 异常闪烁 | Vital 报警 | 冲突告警 | 红旗 | — | 延误高亮 | 逆位牌 | — |
| TaskState 进度 | — | — | 圈数/总圈 | 小节号/总小节 | 到站/终点 | 牌位 1/10 | — |

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Star phase 映射不准确 | 中 | 中 | Phase 1 后收集 10 session phase log 验证；即使粗糙也比无好 |
| Radio 模板不够准确 | 中 | 低 | 15 模板覆盖 80%；fallback 模板 `[天枢] {phase} 中，{lastTool}` |
| Strip 占终端空间 | 低 | 低 | 1 行高度；用户可 toggle 关闭 |
| Radio 消息太多/噪音 | 低 | 中 | 只在 phase 转换 + 里程碑触发；cooldown 机制 |
| TaskState 没有数据（模型没输出 plan） | 中 | 低 | 步骤进度 fallback 到 turn 计数器 |

---

## 三轮演化摘要

**第一轮（变异）：**
- V1 实时 Todo（Devin 模式）/ V2 星相 Strip（手术观察廊）/ V3 六爻+炼金（东方内核）/ V4 F1 无线电（harness 中文简报）

**第二轮（选择）：**
- V1 灭绝：依赖模型输出结构化 plan，DeepSeek 不可控
- V3 降级：学习成本高，但炼金色带作为 trait 回收
- V2 + V4 存活并组合：strip 是持续背景，radio 是关键节点事件

**第三轮（适应）：**
- V1 trait 回收：TaskState 进度 → 注入 strip
- V3 trait 回收：炼金四色 → strip 的进度色带
- 收敛洞察：用户不需要理解 agent 思考，只需要 harness 的同声传译
- 扩展适应：AgentStatus + SummaryBar 已有组件直接扩展，radio 用 RuntimeHookPipeline

---

## 调研来源

### 技术
- Rivet TUI 内部审计（AgentStatus, SummaryBar, star-event.ts, sensorium.ts, task-state.ts）
- Claude Code Agent View、Claude HUD、agentwatch
- Cursor Agent Dashboard、Canvas
- Devin 2.0 live plan/todo
- GitHub Copilot Workspace 4-step pipeline
- Warp block model、AG-UI protocol

### 跨域
- 手术观察廊：phase strip + vital signs
- 空管：exception-based flight strips
- F1 赛车工程师：2-3 word radio、shared mental model
- 指挥家：orchestral score as agent plan
- 日本发车标：hierarchical glanceability（色彩→目的地→详情）
- 塔罗牌阵：固定位点采样（不跟踪每一步，而是采样关键位置）
- 星盘：dense circular state dashboard
- 易经六爻：sensorium 6 维 → 六线二值编码 → 卦象
- 波利尼西亚星航：gestalt 整体感知而非逐指标监测
- 炼金四阶段：nigredo→albedo→citrinitas→rubedo 色彩进度
