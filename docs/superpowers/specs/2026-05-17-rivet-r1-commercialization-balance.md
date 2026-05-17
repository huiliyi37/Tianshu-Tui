# Rivet R1 开源准备：商业化平衡方案

> **日期：** 2026-05-17
> **阶段：** R1（开源准备）
> **策略：** 社区影响力优先 + 可持续收入支撑
> **关联文档：**
> - [`specs/2026-05-16-rivet-open-source-harness-strategy-design.md`](../specs/2026-05-16-rivet-open-source-harness-strategy-design.md) — 开源策略三轮思考
> - [`plans/2026-05-16-rivet-open-source-productization-r1.md`](2026-05-16-rivet-open-source-productization-r1.md) — R1 产品化计划

---

## 1. 核心定位

**Rivet = 开源模型的 coding agent 基础设施。**

不是"Claude Code 的开源替代"（这是追赶），而是"让开源模型在 coding 任务上达到闭源模型水平的 harness 工程"（这是创造）。

---

## 2. 开源/商业切分

### 2.1 切分原则

| 原则 | 含义 |
|------|------|
| 开源版必须独立可用 | 不是残缺品，不需要付费才能完成基本任务 |
| 商业化卖"规模"不卖"能力" | 个人用开源版够好，团队/企业需要规模化才付费 |
| 护城河在持续优化能力 | 代码可复制，但持续的模型适配和 cache 调优不可复制 |

### 2.2 具体切分表

```
┌─────────────────────────────────────────────────────────────────┐
│  开源层（Apache 2.0）                                            │
│                                                                   │
│  ✅ Agent Loop + TurnHarness + doom-loop detection               │
│  ✅ 完整工具系统（bash/edit/read/glob/grep/run_tests）            │
│  ✅ Multi-pass Repair Pipeline（四骑士修复 + schema gate）        │
│  ✅ Prefix cache 基础设施（prompt engine + fingerprinting）       │
│  ✅ Dream 蒸馏 Phase 1（模板式 session 记忆）                     │
│  ✅ Activity Status Layer（phase 状态机 + 心跳）                  │
│  ✅ Failure Classifier（14 种错误分类 + repair hints）            │
│  ✅ TDD 计划执行框架（plan → execute → verify）                   │
│  ✅ Sub-agent 协调器（单机多 worker）                             │
│  ✅ Cockpit 可观测面板                                            │
│  ✅ Retrospective 基础版（/retrospect 命令）                      │
│  ✅ 天枢人格 prompt（作为示例 persona）                           │
│  ✅ 单 provider 接入（DeepSeek / OpenAI 兼容）                   │
│                                                                   │
├─────────────────────────────────────────────────────────────────┤
│  Pro 层（$20-30/月 订阅）                                        │
│                                                                   │
│  💎 多模型路由（天枢规划 + 紫微执行 + 自动切换）                  │
│  💎 Dream Phase 2+（LLM-powered 蒸馏 + 跨项目记忆迁移）          │
│  💎 星图流完整视觉体验（8 阶段动画 + 角色展示）                   │
│  💎 高级 Retrospective（自动触发 + claim promote + 知识图谱）     │
│  💎 多 session 并行编排（同时跑 3+ agent）                        │
│  💎 高级 model cards（模型能力矩阵 + 自动选型）                   │
│                                                                   │
├─────────────────────────────────────────────────────────────────┤
│  Enterprise 层（按需定价）                                        │
│                                                                   │
│  🏢 托管 Cache API（prefix cache 即服务，团队共享 cache pool）    │
│  🏢 私有模型接入（企业内部模型 + 定制 repair rules）              │
│  🏢 团队知识共享（多人 Dream 知识库 + 权限控制）                  │
│  🏢 审计日志 + 合规（SOC2 级别的 tool 执行审计）                  │
│  🏢 SLA 保障（99.9% 可用性 + 优先支持）                          │
│                                                                   │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. 为什么这样切

### 3.1 开源层的竞争力论证

| 对比 | Aider (开源) | Claude Code (闭源) | Rivet 开源版 |
|------|-------------|-------------------|-------------|
| 模型支持 | 多模型但无优化 | 仅 Claude | 开源模型专属优化 |
| Cache 工程 | 无 | 闭源 | ✅ 开源 |
| Tool repair | 无 | 闭源 | ✅ 开源 |
| 错误恢复 | 基础重试 | 闭源 | ✅ 14 类分类 + repair hints |
| Session 记忆 | 无 | 闭源 | ✅ Dream P1 |
| 可观测性 | 基础 | 无 | ✅ Cockpit + Activity Status |

**结论：** 开源版在"开源模型 coding agent"赛道上没有对手。

### 3.2 Pro 层的付费动力

Pro 层卖的不是"基础能力解锁"，而是"效率倍增"：

- 多模型路由：复杂任务自动升级到强推理模型，简单任务用便宜模型 → **省钱 + 提质**
- LLM 蒸馏：跨 session 知识越来越精准 → **越用越好**
- 多 session 并行：同时跑 3 个 agent 做不同任务 → **3x 产出**

### 3.3 Enterprise 层的价值

企业不缺 $30/月，缺的是：
- 团队共享 cache pool（10 人团队共享 prefix cache = 10x cache hit rate）
- 审计合规（谁用 agent 改了什么代码，可追溯）
- 私有模型（企业内部微调模型 + Rivet harness = 最佳组合）

---

## 4. 收入路径时间线

| 阶段 | 时间 | 目标 | 收入 |
|------|------|------|------|
| R1: 开源准备 | 现在 - 第 4 周 | 仓库就绪、文档完善、benchmark 叙事 | 无 |
| R2: 公开发布 | 第 5-8 周 | GitHub 发布、社区运营、获取 1000 stars | 无 |
| R3: Pro 内测 | 第 9-12 周 | 邀请 50 个活跃用户试用 Pro | 少量（验证付费意愿） |
| R4: Pro 正式 | 第 13-16 周 | 公开 Pro 订阅 | $1-3K MRR |
| R5: Enterprise | 第 20+ 周 | 首个企业客户 | $5-10K MRR |

---

## 5. 开源社区建设策略

### 5.1 贡献路径设计

| 贡献类型 | 难度 | 入口 |
|----------|------|------|
| 新增 repair rule | 低 | `src/agent/repair-passes.ts` 添加一个 pass |
| 新增 provider 适配 | 低 | `src/api/providers/` 添加一个 client |
| 新增 failure type | 中 | `src/agent/failure-classifier.ts` 添加分类 |
| 新增 persona prompt | 中 | `prompts/personas/` 添加人格模板 |
| 新增 model profile | 中 | `profiles/` 添加模型能力描述 |
| 核心架构改进 | 高 | 需要 RFC + 审查 |

### 5.2 社区叙事

**不说：** "我们是 Claude Code 的开源替代"
**说：** "我们让 DeepSeek/Qwen/Llama 在 coding 任务上达到闭源模型水平"

这个叙事的优势：
- 不是追赶，是创造新赛道
- 开源模型社区（DeepSeek/Qwen 用户）天然是目标用户
- 每次开源模型发布新版本，Rivet 都有新闻点（"Rivet + DeepSeek V5 benchmark 结果"）

### 5.3 传播节点

| 节点 | 内容 | 预期效果 |
|------|------|---------|
| GitHub README | 30 秒能看懂 Rivet 是什么 + 为什么用 | 转化 star |
| Benchmark 报告 | "DeepSeek + Rivet vs Claude Code" 对比数据 | 技术社区传播 |
| 人格 prompt 示例 | 天枢/紫微人格的实际效果展示 | 差异化记忆点 |
| 复盘案例 | Dream P1 执行报告这类真实案例 | 证明架构有效 |

---

## 6. 技术护城河维护

### 6.1 开源后不可复制的部分

| 护城河 | 为什么不可复制 |
|--------|--------------|
| 持续的 cache 策略调优 | 每个模型版本的 prefix cache 行为不同，需要持续测试 |
| 模型路由评估数据 | 需要大量真实任务数据才能做最优路由决策 |
| repair rule 积累 | 社区贡献的 repair rules 越多，Rivet 越强 |
| 用户行为数据（匿名） | Pro/Enterprise 用户的使用模式 → 优化 harness |

### 6.2 防 fork 策略

不是防止 fork（Apache 2.0 允许），而是让 fork 没有意义：

- **迭代速度 > 代码快照**：fork 拿到的是某一刻的代码，Rivet 每周都在适配新模型
- **社区绑定**：repair rules、model profiles 由社区贡献，fork 拿不走社区
- **服务层不可 fork**：cache pool、路由数据、团队知识库是服务，不是代码

---

## 7. R1 阶段具体交付物

| # | 交付物 | 状态 | 负责 |
|---|--------|------|------|
| 1 | 开源/服务边界文档 | ✅ 已有草案 | 已完成 |
| 2 | R1 总设计文档 | ✅ 已有草案 | 已完成 |
| 3 | Repository readiness checklist | 📋 待执行 | 下一步 |
| 4 | Capability matrix schema | 📋 待设计 | 下一步 |
| 5 | README 重写（面向外部用户） | 📋 待执行 | 下一步 |
| 6 | CONTRIBUTING.md | 📋 待创建 | 下一步 |
| 7 | LICENSE 文件（Apache 2.0） | 📋 待创建 | 下一步 |
| 8 | Secret scan + .gitignore 审计 | 📋 待执行 | 发布前闸门 |
| 9 | Benchmark 叙事文档 | 📋 待设计 | 下一步 |
| 10 | 商业化平衡方案（本文档） | ✅ 完成 | — |

---

## 8. 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| 开源后无人关注 | 中 | 高 | 先在 DeepSeek 社区建立存在感，再正式发布 |
| Pro 层无人付费 | 中 | 中 | 先验证 50 人内测，调整定价和功能 |
| 大厂做类似产品 | 低 | 高 | 保持迭代速度 + 深度社区绑定 |
| 开源模型原生解决 tool use 问题 | 低 | 中 | harness 层转向更高级优化（routing、evidence） |
| 维护开源社区精力不足 | 高 | 中 | 设计低门槛贡献路径，让社区自运转 |

---

## 9. 决策记录

| 决策 | 选择 | 理由 |
|------|------|------|
| 许可证 | Apache 2.0 | 企业友好，允许商业使用，社区接受度高 |
| 人格 prompt 是否开源 | 是（作为示例） | 人格是灵魂，开源建立信任；商业化的是多角色编排 |
| prefix cache 代码是否开源 | 是 | 这是最大传播点；商业化的是"帮你管 cache"服务 |
| Dream P1 是否开源 | 是 | 让用户尝到甜头；P2 LLM 蒸馏是付费升级动力 |
| 多模型路由是否开源 | 否（Pro） | 这是最清晰的付费价值点 |
| 星图流是否开源 | 否（Pro） | 视觉差异化 + 开发成本高，值得付费 |
