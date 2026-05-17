# Agent Activity Status Layer · 设计概要

> 来源：天枢在 Dream Phase 1 复盘中的协作过程体验 + 对 activity-status-layer 的架构建议
> 版本：v0.1（概要，非完整设计文档）

## 问题

终端 TUI 未完成时，用户输入后看不到 agent 的中间状态——正在读文件、正在写代码、正在跑测试，还是卡住了。唯一感知通道是最终文本回复。

同时 agent 被工具限流时也缺少主动通知，结果双方都在盲等。

## 设计原则

1. 不改 AgentLoop 主体控制流
2. 复用现有 AgentCallbacks 接口，新增 `onPhaseChange`
3. 推 phase 不推 tool call（保持信息密度）
4. TUI 一行状态栏呈现，不新建独立面板

## Agent 活动状态机

```
idle → research → analysis → implementation → verification → review → responding → idle
```

| Phase | 含义 | 触发点 |
|-------|------|--------|
| `research` | 读取文件、搜索代码 | onToolUse(read_file/grep/glob) |
| `analysis` | 思考架构、拆解任务 | 首次 thinking block 或连续 research 后 |
| `implementation` | 编辑/写入代码 | onToolUse(edit_file/write_file) |
| `verification` | 运行测试/构建 | onToolUse(run_tests/bash test) |
| `review` | 自我审查、差异检查 | onToolUse(diff) 或 edit 后的 pause |
| `responding` | 生成最终回复 | 文本输出阶段 |

**特殊 phase**:

| Phase | 含义 |
|-------|------|
| `blocked` | 工具被限流，切换策略中 |
| `planning` | 执行多步骤计划，带进度 |

## AgentCallbacks 扩展

```typescript
// 新增到 src/agent/loop.ts AgentCallbacks 接口
onPhaseChange?: (phase: AgentPhase, detail?: PhaseDetail) => void

type AgentPhase = 'idle' | 'research' | 'analysis' | 'implementation'
  | 'verification' | 'review' | 'responding' | 'blocked' | 'planning'

interface PhaseDetail {
  tool?: string
  target?: string
  step?: string       // "3/9" when planning
  file?: string
  reason?: string     // when blocked
  suggestion?: string
}
```

## 心跳

| 无事件时长 | 触发 |
|-----------|------|
| 30s | phase='thinking'（agent 正在思考，等待 API） |
| 60s | phase='waiting'（可能卡住，建议用户询问） |

心跳由 TUI 端维护，不依赖 agent push。

## 限流反馈

工具被 rate limiter 拒绝时：

1. Agent 发送 `onPhaseChange('blocked', { reason: 'tool rate limited', suggestion: 'switching to bash' })`
2. TUI 状态栏显示：`⛔ Tool blocked — switching strategy`
3. 用户看到 agent 在主动自救，不需要干预

## 进度量化

对于多步骤实现计划：

```
onPhaseChange('planning', { step: '3/9', file: 'dream.ts' })
→ TUI 显示: 📋 Planning — 3/9 dream.ts
```

## TUI 呈现

StatusBar 组件当前显示：model, cache rate, cost, token

新增一行：phase 指示器

```
dream.ts   ○ research · analysis ▸ implementation · verification · review
                                 ── 编辑代码中 ──
```

不用独立面板，不改 cockpit 布局。

## 与星图流的关系

参见 `docs/analysis/2026-05-17-starflow-vs-activity-layer-analysis.md`

本设计是星图流的事件通道和底层实现基础。星图流在本层之上叠加：
- 多模型路由（天枢/紫微）
- 星图视觉组件
- 角色人格展示
