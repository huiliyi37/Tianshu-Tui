# 天枢纯净交付路线图

> 日期：2026-05-21
> 状态：活跃
> 原则：天枢是产品，不是实验场。CVM 是引擎，不是卖点。

## 背景

3.0 失败的根因：TUI 运行时、CVM 认知结构、项目开发文档、设计哲学文档混为一体。模型每轮呼吸 3375 tokens 的项目蓝图，被自己的文档淹没。

修复已完成：
- .rivet.md 瘦身到 435 tokens/turn（纯操作性信息）
- 架构文档移至 .rivet/dev-guide.md（按需读取）
- beliefs 宪法恢复到系统提示词
- buildCognitivePromptProjection 还原为正常工作
- 内存安全三道防线就位
- 测试类型错误修复

当前版本：2.5 稳定态。目标：纯净 3.0 → 可交付产品。

## 设计原则

1. **运行时是模型生活的世界，文档是它按需查阅的蓝图** — 不混淆
2. **对人类是噪音的东西，对模型可能是氧气** — cognitive mirror 对用户无意义，对模型是自我感知
3. **用户不需要理解 CVM** — 他们只需要感受到：更少返工、更敢质疑、更可靠
4. **每次只改一个变量** — 观察几轮，确认没有退化再继续

## 运行时架构（纯净版）

### 模型每轮看到的

```
[System Prompt — prefix cache 命中]
  <identity>   天枢身份 — 创造者不是补全器
  <beliefs>    信念宪法 — 质量>速度，异议是最高协作
  <rules>      verify-first + 安全规则
  <tools>      工具定义
  <workflow>    工作流程

[Volatile Stable — prefix cache 命中]
  <environment>     cwd/OS
  .rivet.md         命令+规范+常见错误（435 tokens）
  <git-status>      当前分支
  <working-set>     活跃文件

[对话历史]
  user/assistant 交替 + tool_use/tool_result

[Cognitive Projection — 最新 user message 末尾]
  <task-contract />       当前任务目标
  <verification-gap />    未验证文件警告
  <cognitive-mirror />    6 维状态读数
  [uncertainty framing]   低信心时的结构化模糊
  [sycophancy hint]       谄媚陷阱警告
```

### 模型看不到但在运行的

| 机制 | 职责 | 开销 |
|------|------|------|
| Sensorium | 6 维感知计算 | <1ms，零 token |
| Vigor | 动机能量 → 策略调制 | <1ms，零 token |
| Season | 生命周期阶段 → 节流决策 | <1ms，零 token |
| Pressure Monitor | CVM 自身开销追踪 | <1ms，零 token |
| Turn Budget | 每轮 tool_result token 上限 | 零额外 token |
| Stale Compaction | 旧轮 tool_result 截断 | 零额外 token |
| Stigmergy | 跨 session 文件记忆 | 磁盘 I/O |
| Runtime Hooks | 9 个 hook 按阶段执行 | <5ms 总计 |
| Approval Gate | 危险操作拦截 | 用户交互 |

### 与 Claude Code 的本质区别

| 维度 | Claude Code | 天枢 |
|------|-------------|------|
| 模型定位 | 执行器 | 协作者 |
| 上下文策略 | 最小化（减少干扰） | 结构化（提供自我感知） |
| 错误处理 | 重试 | 预防（verification gap） |
| 服从性 | 鼓励 | 质疑（beliefs + sycophancy trap） |
| 长 session | compaction | compaction + 认知季节 + 活力调制 |
| 安全 | 审批门 | 审批门 + uncertainty framing |

## 任务清单

### Wave 1：产品交付冲刺（多 session 并行，真实工作强度）

参考标准：4 TUI + 2 Opus 同分支 13 条独立交付，每个 session 1-2 小时独立完成。
Wave 1 目标：**一轮冲刺交付完整可用产品**，同时积累稳定性数据。

| # | 任务 | 复杂度 | 独立文档 |
|---|------|--------|----------|
| 1 | Chat mode 实现（5 task 完整交付） | 中 | 已有计划 |
| 2 | Multi-provider adapter（Anthropic + OpenAI + DeepSeek 统一接口） | 高 | 需出 |
| 3 | 安装体验（npx tianshu + 首次配置向导 + provider 选择） | 中 | 需出 |
| 4 | 用户文档重写（README 面向用户 + 快速开始 + 配置参考） | 中 | 需出 |
| 5 | Error recovery pipeline（工具失败分类 + 自动重试策略 + 降级路径） | 高 | 需出 |
| 6 | Verification dashboard（TUI 状态栏显示验证进度 + 未验证文件列表） | 中 | 需出 |
| 7 | Session replay（JSONL → 可回放的决策链 + TUI 回放视图） | 高 | 需出 |
| 8 | Confidence indicator + auto-escalation（状态栏信心度 + 低信心时建议切换模型） | 中 | 需出 |
| 9 | Cross-session memory 产品化（stigmergy → 用户可见的"项目记忆"面板） | 高 | 需出 |
| 10 | 多 session 协作协议（分支命名 + 文件锁 + 冲突检测 + 自动 rebase） | 高 | 需出 |
| 11 | Subagent orchestration Phase 1（只读 worker dispatch + 结果合并） | 高 | 已有设计 |
| 12 | Performance baseline（启动时间 <2s + 首 token <500ms + 内存 <256MB 稳态） | 中 | 需出 |
| 13 | E2E test suite（模拟完整用户 session：安装→配置→任务→验证→对话→退出） | 高 | 需出 |

**执行方式**：多个 TUI session 并行，每个 session 领取 1-2 个任务独立交付。任务间无依赖（除 #2 是 #3 的前置）。

### Wave 2：MiMO Demo + 对外展示

| # | 任务 | 目的 |
|---|------|------|
| 14 | 设计 30 秒 demo 场景（选择最能体现差异的任务类型） | 可见"200 vs 80" |
| 15 | 录制对比视频（裸 DeepSeek vs 天枢 CVM，同一任务） | 证据 |
| 16 | 技术白皮书（CVM 原理 + 数据 + 可复现实验） | 给技术团队看 |
| 17 | 产品 landing page（一句话价值主张 + 安装命令 + 30s GIF） | 给所有人看 |

## 数据记录模板

每个任务完成后记录：

```yaml
task: <任务名>
session_id: <session 标识>
session_turns: <总轮数>
duration_minutes: <耗时>
rework_count: <返工次数>
model_challenged: <模型是否主动质疑用户> yes/no
model_verified: <模型是否主动验证> yes/no
model_discovered_boundary: <模型是否独立发现设计边界> yes/no
degradation_observed: <是否观察到退化> yes/no
reliability_mode_triggered: <是否触发 reliability mode> yes/no
parallel_sessions: <同时运行的 session 数>
git_conflicts: <是否产生 git 冲突> yes/no
notes: <观察>
```

## 成功标准

天枢 3.0 纯净版达标条件：
1. Wave 1 的 13 个任务在一轮冲刺中全部交付（≤ 3 天）
2. 多 session 并行无 git 冲突（协作协议有效）
3. 至少 8 个任务中模型主动质疑或主动验证
4. 单 session 40+ 轮无退化
5. `npx tianshu` 可安装可运行，新用户 5 分钟内完成首次任务
6. E2E test suite 全绿
7. 内存稳态 <256MB，无 OOM

## 不做的事

- 不在运行时注入项目文档
- 不在 .rivet.md 中放架构图
- 不追求"复现 3.0 的某个 session"
- 不在产品代码中引用万物为一/盘古/星座（这些是设计哲学，不是运行时）
- 不为了实验牺牲稳定性
- 不模仿 Claude Code 的交互模式（走自己的路）
