# Rivet Glanceable Cockpit + 科技风视觉层 设计

## 背景

用户目标：在已有设计文档基础上，找出 TUI 优化和改造方向，提升模型在 TUI 的长任务开发能力；同时科技风化终端界面，在高可用的基础上增加设计感。

当前 Rivet TUI 已具备：

- Ink 6 + React 19 的 `<Static>` + live area 双区模型
- `AgentStatus` 组件（phase/timer/tool list）
- `StatusBar`（model/cache/cost）
- `ToolCard`（折叠/展开工具输出）
- `StreamOutput`（流式 LLM 输出）
- `CockpitState` 设计（P2.3 规格，尚未完整实现）
- `ContextLedger` + microcompact + resume preflight（Progressive Context Engine）
- Evidence/Verification 追踪

---

## 设计哲学："2 秒回神"

**核心洞察**：开发者在长任务（20-60 分钟）中会切换上下文。他们不会持续盯着终端看。TUI 的核心价值不是"展示更多信息"，而是"在用户注意力回来的那一刻，用最少的视觉元素传达最关键的状态"。

设计原则：

1. **一瞥即懂** — 切回终端 2 秒内知道：agent 在做什么、做到哪了、是否需要介入
2. **阈值驱动而非连续监控** — 只在关键阈值（context > 80%、测试失败、需要审批）时视觉强调
3. **科技风 = 信息编码** — 颜色=类型，亮度=重要性，结构线=层级，不是装饰
4. **优雅降级** — tmux 256-color / SSH 下功能完整，只丢失渐变和 truecolor 色彩细节

---

## 调研发现摘要

### 长任务 UX 模式

- Static + Dynamic split 是正确基础（Rivet 已有）
- One-line tool summaries by default, expandable on demand
- Breadcrumb "where am I" bar 是最有效的进度指示
- Error classification (retryable/recoverable/blocking) 减少用户认知负担
- Compaction as visible event showing what was preserved

### 竞品 TUI 设计

- eDEX-UI (44k stars)：赛博朋克配色 + 实时数据面板，全屏应用不适合嵌入式 TUI
- OpenCode (160k stars)：Go Bubbletea 分屏面板 + token/cost 状态栏
- Claude Code (123k stars)：Ink 6 同技术栈，streaming + collapsible tools + context budget
- blessed-contrib：braille sparkline + gauge + dashboard widgets

### Ink 6 视觉能力

- Truecolor (hex/rgb)：HIGH feasibility，graceful fallback via chalk
- gradient-string：HIGH，输出 ANSI 字符串
- Unicode box drawing / block elements / braille：HIGH，全终端支持
- Animated spinners (80ms interval)：HIGH
- Nerd Font 依赖：LOW-MEDIUM，避免

### 反证发现

- 开发者在 10+ 分钟任务中会离开 → 设计为 glanceable，非 continuous monitoring
- tmux 默认不透传 truecolor → 强制 256-color 降级
- Ink 6 复杂 live area 有 flicker 风险 → live area ≤ 15 行
- Dashboard fatigue 真实存在 → 只展示可操作指标
- Cache hit rate 对多数用户不可操作 → 降级为 on-demand (`/debug`)

---

## 三轮演化结论

### 灭绝方案

- **增强状态栏（V1）**：因果链断裂，看到数字≠能力提升
- **双模 TUI（V4）**：依赖用户主动切换模式，未验证假设

### 存活方案融合

- **任务阶段引擎（V2）**作为数据层：agent loop emit 阶段事件
- **Glanceable Cockpit（V3）**作为展示层：3 行摘要区消费阶段事件

### 核心收敛洞察

> 长任务 TUI 的核心价值不是"展示更多信息"，而是"在用户注意力回来的那一刻，用最少的视觉元素传达最关键的状态"。

---

## 推荐方案

### 总体架构

```text
┌─ SummaryBar (3 lines, live area top) ──────────────────────┐
│ ◆ task → phase (n/m) │ ▓▓▓░░ ctx 65% │ 4m12s             │
│ ├ last: edit middleware.ts → ✓ typecheck                    │
│ └ next: run_tests │ risk: none                              │
├─ Streaming / Tool Output (live area middle) ───────────────┤
│ [current streaming response or active tool card]            │
├─ InputBar (live area bottom) ──────────────────────────────┤
│ > _                                                         │
└────────────────────────────────────────────────────────────┘

上方（terminal scrollback via <Static>）：
│ 已完成的 tool cards, checkpoint notices, evidence badges    │
```

### 数据流

```text
AgentLoop (emit PhaseEvent)
  ↓
PhaseTracker (plan/code/test/verify state machine)
  ↓
SummaryState { task, phase, lastAction, nextStep, risk, contextPct, elapsed }
  ↓
<SummaryBar> component (live area top, 3 lines)
```

### SummaryBar 内容规格

**第 1 行（状态概览）**：
```
◆ {taskDescription} → {phase} ({stepN}/{totalSteps}) │ {contextBar} {pct}% │ {elapsed}
```

- `taskDescription`：从用户最近输入提取（≤30 字符）
- `phase`：planning / coding / testing / verifying / idle
- `contextBar`：block elements `▓░`，宽度 5 字符
- `pct`：context 使用百分比
- `elapsed`：当前 turn 计时

**第 2 行（最近动作）**：
```
├ last: {toolName} {target} → {result}
```

- `toolName`：edit / bash / read / write / test
- `target`：文件名或命令（≤30 字符）
- `result`：✓ pass / ✗ fail / ⚡ running

**第 3 行（下一步 + 风险）**：
```
└ next: {nextAction} │ risk: {riskLevel}
```

- `nextAction`：从 agent thinking 提取或推测（≤30 字符）
- `riskLevel`：none（dim）/ medium（amber）/ high（red, 需审批）

### 阶段状态机

```text
idle → planning → coding → testing → verifying → idle
                    ↑         │
                    └─────────┘ (test failed → back to coding)
```

触发规则：
- `planning`：agent 输出中包含 plan/思考/分析
- `coding`：调用 edit_file / write_file
- `testing`：调用 run_tests / bash (test command)
- `verifying`：调用 read_file (检查结果) / bash (typecheck)
- `idle`：等待用户输入

### 科技风视觉规格

**配色方案（双层）**：

| 语义 | Truecolor | 256-color fallback |
|------|-----------|-------------------|
| Primary (品牌/结构) | `#00ffcc` | `49` (cyan) |
| Secondary (辅助信息) | `#7b2fff` | `93` (purple) |
| Success | `#00ff88` | `48` (green) |
| Warning (阈值) | `#ffaa00` | `214` (amber) |
| Error/High risk | `#ff3333` | `196` (red) |
| Dim (元数据) | `#4a4a6a` | `60` (gray) |
| Background accent | `#1a1a2e` | `234` (dark) |

**工具卡片着色**：

| 工具类型 | 左边框色 | 含义 |
|---------|---------|------|
| bash | cyan | 执行 |
| edit_file | purple | 修改 |
| write_file | purple | 创建 |
| read_file | dim | 读取（低风险） |
| run_tests | green | 验证 |
| delegate_task | amber | 子代理 |

**启动 Banner**：
```
gradient-string(['#00ffcc', '#7b2fff'])('R I V E T')
```
一次性显示，进入 Static scrollback。

**Context Bar 阈值着色**：
- 0-60%：primary color (cyan)
- 60-80%：warning (amber)
- 80-95%：error (red)
- 95%+：error + bold (pulsing effect via alternating dim/bright)

**结构线字符**：
- `◆` 当前任务标记（菱形，视觉锚点）
- `├` 中间行连接
- `└` 最后行连接
- `│` 竖线分隔（配色为 dim）

### 阈值警告系统

不连续展示所有指标，只在阈值触发时改变视觉：

| 事件 | 视觉变化 |
|------|---------|
| context > 80% | context bar 变 amber，第 1 行闪烁一次 |
| context > 95% (auto-compact) | 第 3 行显示 `⚡ compact: 180k→45k │ 保留: {summary}` |
| test 失败 | 第 2 行 result 变 `✗ FAIL`，红色，持续到下次 pass |
| 需要审批 | 第 3 行变 `⚠ APPROVAL NEEDED: {tool} {target}`，红色 bold |
| checkpoint 创建 | Static 区推入 `⚑ checkpoint: {n} files` |

### 会话恢复增强

Resume 时 SummaryBar 显示恢复上下文：
```
◆ RESUMED │ 上次: edit auth.ts (test passed) │ ctx 45% │ session 23m
├ 已完成: 4 edits, 2 tests passed, 1 checkpoint
└ 建议: 继续 run_tests 覆盖剩余路径
```

3 秒后自动切换为正常 SummaryBar 模式。

### `/cockpit` 展开面板

`/cockpit` 命令将 SummaryBar 展开为详细面板（live area 扩展为 ~10 行）：

```
╭─── COCKPIT ─────────────────────────────────────────────╮
│ Phase: testing (3/5)  │  Context: ▓▓▓▓░░ 65%  │  4m12s │
│ Files: middleware.ts (+42/-18), handler.ts (+8/-3)       │
│ Tests: 3/5 passed │ ✗ auth.test.ts:42 "token expired"  │
│ Cache: 94% hit │ Cost: $0.04 │ Turns: 7                 │
│ Checkpoint: ⚑ 3 files (2m ago) │ Rollback: available    │
╰─────────────────────────────────────────────────────────╯
```

`/cockpit` 再次输入或 `Esc` 收起。

---

## 与已有设计的关系

- **P2.3 Harness Cockpit**：本方案是 P2.3 的视觉层实现，消费 P2.3 定义的 `CockpitState`
- **Progressive Context Engine**：本方案的 context bar 和 compact 通知消费 `ContextLedger`
- **子代理协同**：`delegate_task` 工具在 SummaryBar 中显示为 amber 子代理指示

---

## 风险与应对

1. **SummaryBar 3 行导致 live area flicker**
   - 应对：如果检测到 flicker，降级为 1 行（只保留第 1 行概览）
   - 验证：在 tmux 内测试 80ms 刷新率下的稳定性

2. **从 thinking 提取"下一步"不可靠**
   - 应对：fallback 为显示最近工具名 + "..."
   - 不依赖 LLM 额外调用，只做 regex/heuristic 提取

3. **科技风配色在某些终端下可读性差**
   - 应对：`RIVET_COLOR=256` 环境变量强制 256-color 模式
   - 所有颜色有 256-color fallback，语义不依赖精确色值

4. **阶段检测误判（如 read_file 被判为 verifying）**
   - 应对：阶段状态机有 debounce（连续 2 个同类型事件才切换）
   - 用户看到的是最终稳定状态，不是每次事件的瞬时响应

5. **gradient-string 依赖增加 bundle 大小**
   - 应对：gradient-string 是纯字符串操作包（~5KB），只在启动时调用一次
   - 如果不想加依赖，可用 chalk 手动写 3-4 色段近似

---

## 实施路径概览

| Phase | 内容 | 时间 | 依赖 |
|-------|------|------|------|
| 1 | SummaryBar 组件 + PhaseTracker | 1 周 | agent loop emit 事件 |
| 2 | 科技风视觉层（配色/工具着色/banner） | 1 周 | 无 |
| 3 | 智能摘要（next step 提取/risk 标注/compact 通知） | 1-2 周 | Phase 1 |
| 4 | 会话恢复增强 + `/cockpit` 面板 | 1 周 | Phase 1+3 |

Phase 1 和 Phase 2 可并行开发。

---

## 规格自检

- **占位符检查**：无"待定"、"TODO"
- **内部一致性**：SummaryBar 3 行格式、阶段状态机、配色方案、阈值规则一致
- **范围检查**：聚焦 TUI 层改造，不涉及 agent loop 核心逻辑重构
- **模糊性检查**：配色有精确 hex 值和 fallback；阶段触发规则有明确映射；SummaryBar 内容有精确格式模板
