# 项目记忆系统 v2：Dream 蒸馏方案 — 深度头脑风暴

> **日期：** 2026-05-17
> **方法：** deep-brainstorm（三轮变异-选择-适应 + 4 并行 scout）
> **结论：** 放弃 V2-enhanced（扩展 claim-store），改用文件式 Dream 蒸馏 + Checkpoint 门控

---

## 1. 调研发现（4 Scout）

### Scout 1：项目内部代码扫描

| 发现 | 影响 |
|------|------|
| claim-store 只从最近 1 个 session 继承 durable claims | 知识链断裂，N-2 的知识丢失 |
| recall 工具只有 substring match | 检索精度极低，知识累积无意义 |
| promotion 门槛高（5+ consumers + 10min） | 大量有价值知识无法 promote |
| confidence 每跳衰减 0.9x | 3 个 session 后知识强度 < 0.73 |
| `.wolf/cerebrum.md` 文件式 KB 已在项目运行 | 文件方案有直接先例 |

### Scout 2：竞品方案对比

| 产品 | 方案 | 验证状态 |
|------|------|---------|
| Claude Code | 文件系统 (Markdown + YAML) + Dream 整合 (≥24h) | 百万用户生产级 |
| OpenAI Codex | SQLite + 两阶段异步提取 | 300万周活 |
| Aider | Tree-sitter Repo Map（无持久记忆） | 广泛采用 |
| OMEGA | MCP + 语义搜索 + 时间衰减 | LongMemEval #1 |
| Codified Context | 三层 Markdown 文件系统 | 108K行项目验证 |

**关键结论：** 文件系统仍是王者。人类可读、可编辑、可 git 追踪。

### Scout 3：天枢方案核心思想

可迁移的设计原则：

1. **Plan-vs-Actual Diff 是最高价值资产** — 差异比计划或结果更值得保存
2. **选择性写入** — high/medium/low/discard 分级，只有可复用模式进入长期存储
3. **召回偏航保护** — 检索到的知识必须经过 relevance 过滤
4. **可复用模式 = trigger + diagnosis + fix** — 结构化三元组
5. **失败经验隔离标记** — 保留但标记 do_not_apply_directly
6. **存储格式按消费者分层** — JSON runtime / XML model / Markdown human

### Scout 4：跨领域灵感

| 领域 | 机制 | Agent 记忆启示 |
|------|------|--------------|
| 认知科学 | 情景→语义转化 + 睡眠重放 | Session 结束后"蒸馏"抽象规则，丢弃原始上下文 |
| 免疫系统 | 亲和力成熟 + 竞争选择 | 知识条目有置信度，经验证的上升，被证伪的淘汰 |
| Roguelike | 分层持久化 + 银行检查点 | 写入长期记忆需要"检查点"门控，不自动持久化 |

---

## 2. 假设合成 + 反证

**合成假设：** Rivet 的项目记忆不应继续扩展 claim-store（session 级工作记忆），而应采用文件系统 "Dream" 整合模型 — session 结束时蒸馏结构化 Markdown 到项目级知识目录。

**隐含前提审计：**

| 前提 | 性质 | 如果不成立 |
|------|------|-----------|
| compactClient 能产出高质量摘要 | 假设 | 退回模板式提取（非 LLM） |
| 用户的 session 有明确结束点 | 假设 | 改用 turn 计数阈值触发 |
| 文件注入不会撑爆 prefix cache | 事实约束 | 知识文件必须有 token 上限 |
| 用户愿意让 .rivet/ 进 git | 惯例 | 提供 .gitignore 选项 |

---

## 3. 三轮思考

### 第一轮：变异

| 方案 | 核心选择 |
|------|---------|
| V1(扩展claim) | turn-end 提取 project_fact claim，跨 session durable 持久化 |
| V2(文件Dream) | session-end LLM 蒸馏到 .rivet/knowledge/*.md，启动时注入 |
| V3(归航引擎) | 对比 trajectory vs decisions 生成 deviation，写入知识文件 |
| V4(银行模型) | 只在用户确认或 tests pass 时才持久化 top-N claims |

### 第二轮：选择

**灭绝：**
- V1 — substring recall 是致命瓶颈，100 个 claims 也找不到相关的那个
- V3 — 需要结构化 plan 表示作为前置条件，当前不具备

**discarded_trait 回收：**
- V1 的 turn-end 自动提取 → V2 的蒸馏输入来源
- V3 的 Plan-vs-Actual diff → V2 的蒸馏 prompt 要求
- V4 的 checkpoint gating → V2 的触发条件

**存活：** V2(强) + V4(中) → 融合为 "Dream + Gate"

### 第三轮：适应

**最终方案：文件式 Dream 蒸馏 + Checkpoint 门控**

- **人**：Rivet agent 在 session 结束时自动执行
- **场**：用户完成有实质产出的开发 session（修改了文件 OR 通过测试）
- **动**：收集 evidence + trajectory + decisions → compactClient 蒸馏 → 追加到 .rivet/knowledge/
- **果**：下次 session 启动时模型已知道项目关键模式、决策、约束

**与现有 V2-enhanced 计划的关键差异：**

| 维度 | V2-enhanced | Dream 蒸馏 |
|------|-------------|-----------|
| 存储 | claim-store JSONL (session级) | .rivet/knowledge/*.md (project级) |
| 提取时机 | 每个 turn-end | session 结束时（延迟写入） |
| 检索 | substring match | 文件直接注入 prompt |
| 可见性 | /context 命令 | 文件系统直接可见 |
| Git 追踪 | 不可 (~/.rivet/) | 可 (项目目录 .rivet/) |
| 竞品验证 | 无 | Claude Code Dream 模型 |

---

## 4. 实施路径

| Phase | 改动 | 时间 |
|-------|------|------|
| Phase 1 | 最小可行 Dream：session-end 蒸馏 + 启动注入 | ~3 天 |
| Phase 2 | 门控 + 去重 + 衰减 | ~3 天 |
| Phase 3 | 多文件主题分类 + recall 搜索知识文件 | ~3 天 |
