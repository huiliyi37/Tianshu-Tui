# Rivet 开源策略 + Harness 竞争力分析

## 背景

- **用户需求：** 分析 Rivet 的开源策略——如果开源，核心竞争力能否保留？如何利用 CTCL 兼容层和 harness 工程提升开源模型能力？
- **关联设计思想：** [Command Code: How did we make Kimi k2.6 nearly beat Opus 4.7](https://xueqiu.com/2144421443/387242511) — 核心论点：harness 工程 > 模型能力
- **CTCL 来源：** `ebook-v1.0` 项目仓库中的 `~/bin/claude-tool-compat-layer.mjs`（995 行），移植计划见 `docs/superpowers/plans/2026-05-16-tool-input-repair-cch-strip-schema-gate.md`
- **项目上下文：** Rivet 已有 cache-first prompt engine、TurnHarness、sub-agent coordinator、cockpit 可观测、CTCL 移植计划

## 调研发现

### Command Code 文章核心洞察

闭源模型的优势有相当一部分是**平台工程优势**，不是纯模型能力优势：
- Session 级 prefix cache 命中（TTFT 从 6-8s 降到 <1s）
- Canonical model ID 统一
- Provider 能力交集协商
- Reasoning mode bug 绕过

**结论：把 harness 做对，开源模型在 coding 任务上的表现可以显著提升。**

### CTCL 已验证能力（来自 ebook-v1.0）

| 能力 | 描述 | 验证指标 |
|------|------|---------|
| 四骑士修复 | null→omit、JSON string→array、single obj→unwrap、bare string→wrap | >95% 成功率 |
| CCH 剥离 | 剥离 Claude Code 注入的 cch=xxx 标记恢复 prefix cache | ~90% 命中率恢复 |
| SSE Schema Gate | 等 content_block_stop 后校验 required 字段 | 不合法 tool_use 被压制为 text block |

### Rivet 护城河分析

| 子系统 | 护城河深度 | DeepSeek 专属 vs 模型无关 |
|--------|----------|-------------------------|
| Prompt engine / volatile context / fingerprinting | **深** | DeepSeek V4 cache 策略是尖锐边 |
| Agent loop / TurnHarness / doom-loop | 中 | 模型无关 |
| Sub-agent coordinator | 中 | 模型无关 |
| Context ledger / session memory | 中 | 模型无关 |
| Micro/smart compaction | 低-中 | 模型无关 |
| Cockpit observability | 中 | 模型无关 |

**结论：护城河是堆叠系统，不是单模块。DeepSeek cache 工程是最尖锐的边。**

---

## 三轮思考

### 第一轮：变异

**生态位：** 终端编码代理 / 面向开源模型 / harness 工程驱动

**选择压力：** 开源模型任务成功率 + 开发者采用 + 商业可持续 + 护城河保留

**已占据：** Claude Code（闭源 harness）、Aider（开源但无 harness 优化）、Command Code（harness 即服务，低价订阅）

**空位：** 没有人做"开源模型专属 harness 中间件"

**方案：**

| 方案 | 生态位 | 核心选择 |
|------|--------|---------|
| V1(主流) | 纯开源 | 全部代码 MIT 开源，靠社区贡献和迭代速度竞争 |
| V2(邻近) | 开源 agent + 闭源 harness 服务 | agent 代码开源，harness 优化作为托管 API 收费 |
| V3(空位) | 分层开源 | 核心 agent 开源(Apache 2.0)，harness 优化按模块逐步开源但保留"最新一代"闭源 |
| V4(突变) | Harness 协议标准 | 发布 Rivet Context Protocol 规范，让所有 agent 采用，靠标准制定权和认证收费 |

**适应度函数：**
- 硬约束：社区可接受 / 核心团队能实现 / 有清晰变现路径
- 加分：保留 cache 工程优势 / 建立开发者社区 / 支持多模型 / CTCL 可复用
- 减分：被快速复制 / 运维成本过高 / 社区分裂

---

### 第二轮：选择

**目标重注入：** 核心问题是「如果开源，核心竞争力能否保留」。

**因果测试：**
- V1(纯开源)：**断裂** — Command Code 证明 harness 可复制；纯开源后竞争力 = 迭代速度，不是护城河
- V2(开源 agent + 闭源 harness 服务)：**通过** — 因果链：开源获客 → harness 服务提升性能 → 付费支撑开发 → 持续迭代
- V3(分层开源)：**通过** — 但维护两个版本的成本高于 V2
- V4(协议标准)：**断裂** — 没有用户基础就推标准是本末倒置

**成本测试：**
- V1：变现 = 无，风险 = 高（被 fork 后无法控制方向）
- V2：变现 = 清晰（订阅/API 调用费），风险 = 中（有人可能自建 harness）
- V3：变现 = 清晰（闭源许可证），风险 = 中（社区可能 fork 开源版本）
- V4：变现 = 远期，风险 = 高（可能无人采用）

**灭绝：**
- V1 — 纯开源无法回答"核心竞争力如何保留"
- V4 — 没有用户基础就推标准是本末倒置

**存活：**
- V2(最强) — 开源获客 + harness 服务变现，因果链完整
- V3(次强) — 分层策略灵活但维护成本高于 V2

**最强竞争者：V2 — 与 Command Code 在同一赛道但 Rivet 有更深的 cache 工程积累**

---

### 第三轮：适应

**套路清除：**
- "完全开源赢得社区" — 社区信任靠产品好用，不是靠开源协议
- "闭源保护竞争力" — 闭源会让开源模型社区不信任你
- "做平台生态" — 没有 10 万用户就做平台是自欺欺人
- "CTCL 只是中间件" — CTCL 的 3 项能力是"让开源模型可用"的核心工程

**扩展适应：**
- Rivet 的 cache-first prompt 分层 → 扩展为 harness 服务的核心差异化
- CTCL 的四骑士修复 → 扩展为开源模型 tool use 修复的通用服务
- TrajectoryRecorder + doom-loop → 扩展为 harness 服务的"模型行为分析"
- Sub-agent evidence contract → 扩展为 harness 服务的"结果可信度评分"

**具体化：**
- **人：** 用 DeepSeek/Qwen/Kimi 做真实 repo 修改的开发者
- **场：** 终端 + 真实 git repo + 长会话 + 多文件修改
- **动：** 第一步 = 把 agent 代码推到 GitHub + 把 harness 优化部署为 API
- **果：** 开源版本 task success 60%，harness 服务版本 task success 85%

**收敛验证：** V2 和 V3 收敛到同一洞察 — **harness 优化是"服务"不是"代码"。代码可以开源，但持续的优化能力不能。**

---

## 最终方案：Open Agent + Harness-as-a-Service

```
代码层（开源 Apache 2.0）          服务层（付费）
┌──────────────────────┐    ┌──────────────────────┐
│ Terminal UI (Ink)    │    │ Cache 优化引擎        │
│ Agent Loop           │    │ 模型路由智能          │
│ Tool Registry        │    │ 行为分析 & 预测       │
│ CTCL 修复逻辑(开源)  │    │ 高级 model cards      │
│ 基础 prompt engine   │    │ 企业级 SLA            │
│ Sub-agent 协调器     │    │                      │
│ Cockpit 可观测       │    │                      │
└──────────────────────┘    └──────────────────────┘
```

### 回答核心问题

**开源后核心竞争力能保留吗？能，但护城河形态必须转变。**

| 传统思维 | 真实情况 |
|---------|---------|
| 代码 = 护城河 | 代码会被复制，不是护城河 |
| 保密 = 竞争力 | 开源模型社区不信任闭源工具 |
| harness 代码 = 核心 IP | harness 工程能力 = 核心 IP |

护城河不消失，因为：
1. **Cache 工程需要持续投入** — 每个新模型的 prefix cache 行为不同
2. **Tool repair 需要模型特化** — 不同模型的 tool use 错误模式不同
3. **模型路由需要评估数据** — 需要持续运行 benchmark 才能做最优路由

### CTCL 战略定位

CTCL 不只是"兼容层"，它是 harness 即服务的最小可行产品：

| CTCL 能力 | 服务化价值 | 开源策略 |
|-----------|-----------|---------|
| 四骑士修复 | 免费层核心功能 | 开源（社区贡献规则） |
| CCH 剥离 | 付费层（cache 优化） | 部分开源（通用逻辑开源，优化策略闭源） |
| SSE schema gate | 付费层（可靠性保障） | 开源（安全相关，社区需要信任） |

### 实施路径

**Phase 1（第1-2周）：开源 agent + CTCL 移植**
- 把 Rivet 推到 GitHub（Apache 2.0）
- 把 CTCL 的四骑士修复、CCH 剥离、SSE schema gate 移植到 Rivet 应用层
- 成功标准：社区可以 fork 并运行，CTCL 功能原生可用

**Phase 2（第3-4周）：部署 harness 优化为 API 服务**
- 把 cache 优化、模型路由、tool repair 部署为 API
- 免费层（基础修复）+ 付费层（高级路由 + cache 优化 + 行为分析）
- 成功标准：第一个付费用户

**Phase 3（第5周+）：建立开源模型能力基准 + 社区**
- 发布"开源模型能力矩阵"
- 接受社区 PR：新增模型适配、新修复规则、新 cache 策略
- 成功标准：社区 PR > 10 个/月

### 脆弱点与应对

| 脆弱点 | 应对策略 |
|--------|---------|
| 大型 AI 公司可能自己做 harness 优化 | 保持更快迭代速度 + 深度社区绑定 |
| 开源后代码被 fork | harness 服务价值在持续模型适配，不在代码 |
| CTCL 移植可能遇兼容性问题 | 先移植最可靠的四骑士修复 |
| 定价敏感（Command Code $1/月） | 免费层提供基础修复，高级按使用量计费 |
| 开源模型可能原生解决 tool use 问题 | harness 层会随模型演进转向更高级优化（routing、evidence、compaction） |

---

## 下一步

1. 确认开源策略方向（用户审查）
2. 执行 CTCL 移植计划：`docs/superpowers/plans/2026-05-16-tool-input-repair-cch-strip-schema-gate.md`
3. 准备 GitHub 仓库结构和开源文档
