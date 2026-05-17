# 天枢星图流 × Activity Status Layer · 对照分析

> 来源：天枢星图流设计文档 vs 天枢在 Dream Phase 1 复盘中的 activity-status-layer 指导意见

## 理念契合度：高

两个方案从**不同角度**解决同一个问题——"用户感知不到 agent 在做什么"。

| 维度 | 星图流 | Activity Status Layer | 契合 |
|------|--------|----------------------|------|
| **核心目标** | 让开发过程可感知、可追踪、可拟人化 | 让用户看到 agent 当前阶段 + 进度 | ✅ 完全一致 |
| **阶段划分** | 8 阶段（观局→请星→寻迹→排阵→立约→铸形→试锋→归航） | 6 阶段（research→analysis→implementation→verification→review→responding） | ✅ 高度可映射 |
| **事件通道** | StarEvent + StarActor 类型 | AgentCallbacks.onPhaseChange | ✅ 同一思路 |
| **TUI 表现** | 星图点亮 + 阶段动画 | 状态栏一行 + 心跳 | 互补——星图流偏视觉，ASL 偏信息密度 |
| **限流反馈** | 未涉及 | phase=blocked + reason | ASL 补充星图流缺失 |

## 阶段映射表

```
星图流 8 阶段           →  ASL 6 阶段
─────────────────────────────────────────
观局（天枢规划）          →  [前置，不在 ASL 中]
请星（紫微接收任务）       →  [前置，不在 ASL 中]
寻迹（读取项目/定位文件）  →  research
排阵（拆计划/最小改动）    →  analysis
立约（测试标准/验收）      →  analysis（合并入排阵）
铸形（代码实现）          →  implementation
试锋（测试/构建/追踪）    →  verification
归航（总结/交付/归档）    →  review + responding
```

两个方案都在 6-8 阶段范围内，核心流程一致。

## 星图流的独特价值（ASL 未覆盖）

### 1. 多模型路由

```
天枢（Opus/强推理）→ 只做规划
紫微（Sonnet/主执行）→ 执行 + 对话
```

ASL 假设单 agent 内切换 phase，星图流引入**双模型分工**。这个分层对代码质量有实质影响——复杂架构问题不交给执行模型硬猜。

### 2. 二次请星回路

> 测试失败超过一定次数 → 检测到架构冲突 → 出现多个实现路线 → 触发再次请求天枢

这是 ASL 没有的**失败回退机制**。当前实现（Cerebellar Loop + strategy-shift）只做策略调整，不做重新规划。

### 3. 人格化品牌

星图流把阶段命名为天枢/紫微/天璇等，每个角色有人格气质。这不只是命名术——它让用户形成"我有两个助手，一个规划一个执行"的心智模型，比"agent 正在 implementation 阶段"更有记忆点。

## ASL 的补充价值（星图流未覆盖）

| ASL 功能 | 星图流状态 |
|----------|-----------|
| 心跳机制（30s/60s 无事件告警） | 未涉及 |
| 限流反馈（phase=blocked） | 未涉及 |
| 进度量化（step: 3/9, file: dream.ts） | 未明确（StarEvent 可扩展） |
| 事件通道轻量化（不改 loop.ts 主体控制流） | 未明确实现路径 |

## 架构融合建议

两个方案不是竞争关系，可以分层融合：

```
┌─────────────────────────────────────────┐
│  TUI 表现层：星图流                      │
│  星图点亮 + 阶段动画 + 角色人格展示       │
│  src/tui/star-chart.tsx                  │
└──────────────┬──────────────────────────┘
               │ StarEvent
┌──────────────▼──────────────────────────┐
│  事件通道：AgentCallbacks.onPhaseChange  │
│  phase + detail + actor → StarEvent     │
│  src/agent/loop.ts (扩展现有回调)         │
└──────────────┬──────────────────────────┘
               │ phase change
┌──────────────▼──────────────────────────┐
│  编排层：天枢 ↔ 紫微路由                │
│  复杂任务 → createProviderClient(opus)   │
│  执行任务 → createProviderClient(sonnet) │
│  src/agent/star-router.ts (新建)         │
└─────────────────────────────────────────┘
```

### 实现顺序建议

| 阶段 | 内容 | 对应 MVP |
|------|------|---------|
| 1 | AgentCallbacks.onPhaseChange + 心跳 + 限流反馈 | ASL 核心 |
| 2 | TUI 星图组件消费 StarEvent | 星图流 MVP 1 |
| 3 | 星图流 8 阶段映射 + 角色展示 | 星图流 MVP 1 |
| 4 | 双模型路由（天枢规划 + 紫微执行） | 星图流 MVP 2 |
| 5 | 二次请星回路 | 星图流 MVP 3 |
| 6 | 星图回放 + 导出 | 星图流 MVP 4 |

### 当前代码就绪度

| 组件 | 就绪 | 位置 |
|------|------|------|
| AgentCallbacks 接口 | ✅ | `src/agent/loop.ts` |
| createProviderClient (多 provider) | ✅ | `src/api/factory.ts` |
| ProviderCapabilities (模型能力) | ✅ | `src/api/provider.ts` |
| Cerebellar Loop (策略调整) | ✅ | `src/agent/prediction-error.ts` |
| strategy-shift (失败检测) | ✅ | `src/agent/strategy-shift.ts` |
| TUI status-bar | ✅ 有框架 | `src/tui/status-bar.tsx` |
| StarEvent 类型 | ❌ 待建 | — |
| StarRouter 双模型 | ❌ 待建 | — |
| StarChart 组件 | ❌ 待建 | — |
