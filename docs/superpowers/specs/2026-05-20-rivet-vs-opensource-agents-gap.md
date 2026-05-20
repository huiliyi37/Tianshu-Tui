# 天枢 vs 新兴开源 Agent 差距分析（OpenClaw / Ruflo / Hermes Agent）

> 日期：2026-05-20
> 方法：Deep Brainstorm (4 scout + 3 轮演化)
> 对标：OpenClaw (27.9万 stars) / Ruflo (4.5万 stars) / Hermes Agent (15.8万 stars)
> 前置：天枢 vs Claude Code 差距分析（同日）
> 核心洞察：Rivet 的学习闭环已存在（playbook → volatile → prompt），瓶颈不在架构而在三个质量节点：蒸馏质量（模板式）、检索精度（keyword substring）、claims 消费不对称。

---

## 差距总表（三竞品视角）

| 差距维度 | 来源竞品 | Rivet 当前 | 具体不足 | 优先级 |
|----------|---------|-----------|---------|--------|
| 知识蒸馏质量 | Hermes (Reflect→Crystallize) | dream.ts 模板提取 | Phase 2 LLM 蒸馏未实现 | **P0** |
| Claims 自动 surface | OpenClaw (USER.md 自动注入) | recall 工具需 LLM 主动调用 | playbook 注入 ≠ claims 注入，不对称 | **P0** |
| 知识检索精度 | Hermes (FTS5) / Ruflo (HNSW) | keyword substring match | 语义相似但关键词不匹配的知识被遗漏 | **P1** |
| 多模型路由成本优化 | Ruflo (75-85% 省) / OpenClaw (Fallback) | Ice Mirror 多 provider | 无成本感知路由（按 task complexity 选模型） | **P1** |
| 微隔离 sandbox | OpenClaw (Docker/Firecracker) | ❌ 无 | 与 Claude Code 差距分析一致 | P0 (已识别) |
| FSM 协调层 | OpenClaw (6 层解耦) | DelegationCoordinator | 状态机不够显式，调试困难 | P2 |
| 知识可编辑性 | OpenClaw (纯 Markdown) | playbook JSONL | 用户无法直接审阅/修改学到的知识 | P2 |

---

## 竞品调研发现

### OpenClaw（小龙虾，27.9 万 stars）

个人 Agent 操作系统，22+ 通讯平台，7×24 自主运行。

**架构亮点：**
- **Pi Agent 内核**：4 工具极简 ReAct 循环（read/write/edit/bash），system prompt < 1000 token
- **六层解耦**：交互 → 协调(FSM) → 工具(Docker/Firecracker) → 模型(30+ provider) → 记忆 → 安全
- **四层 Markdown 记忆**：SOUL.md(不可变人格) → TOOLS.md(动态工具) → USER.md(语义向量长期记忆) → Session(实时)
- **嵌入式集成**：`runEmbeddedPiAgent()` 进程内调用，零 IPC 开销

**已知坑点：** ClawHub 12-20% 恶意技能（供应链安全）、API 账单失控（一夜 $1,100）、3 万+ 未认证公网实例

**对 Rivet 的启示：** Pi 内核的极简设计与 prefix cache 哲学一致；四层 Markdown 记忆的"纯文本无数据库"思路值得借鉴（对应 V3 方案）；Docker/Firecracker 微隔离是 sandbox 参考

### Ruflo（原 Claude Flow，4.5 万 stars）

Claude Code 的多 agent 编排层。

**架构亮点：**
- **Hive-Mind Swarm**：三种 Queen（Strategic/Tactical/Adaptive）+ mesh/hierarchical/ring/star 四种拓扑
- **SONA 自学习**：9 种 RL 算法，跨 session ReasoningBank 持久化
- **HNSW 向量记忆**：Rust WASM 内核，150x-12,500x 检索加速
- **多模型路由**：6 provider，3 层策略，省 75-85% API 成本
- **Federation**：跨机器 agent 协作，Ed25519 身份认证

**SWE-bench：** 84.8%（8-agent swarm 85.2%）

**对 Rivet 的启示：** 多模型成本路由（按任务复杂度选模型）值得借鉴；HNSW 向量记忆是检索升级的远期方向；RL 自学习的实际 ROI 对编码任务未验证

### Hermes Agent（NousResearch，15.8 万 stars）

通用自进化 Agent 平台，"The agent that grows with you"。

**架构亮点：**
- **闭合学习循环**：Execute → Reflect → Crystallize → Reuse。5+ tool call 复杂任务自动提炼 SKILL.md
- **五层记忆**：工作记忆(context window) → 程序性记忆(Skill 文件) → 情节记忆(SQLite) → 用户建模(Honcho) → FTS5 全文检索
- **GEPA 自进化**（ICLR 2026 Oral）：遗传-Pareto 搜索优化 Prompt/Tool Description，比 GRPO +6%
- **200+ 模型零代码切换**：Pluggable Transport Layer

**对 Rivet 的启示：** Reflect→Crystallize 路径 = Rivet dream.ts Phase 2 的参考实现；FTS5 是 keyword match 的轻量升级；GEPA 与 prefix cache 冲突（不可用），但 fitness function 概念可降级为 A/B 记录

---

## 反证发现

Scout 4 深入 Rivet 代码库后发现假设需修正：

**学习闭环已存在：**
- `dream.ts` → 模板提取 → `playbook-store` → `volatile.ts:scoreLessons()` → `engine.ts:122` 注入 `volatile-user-message`
- 注入通道是 volatile user message（不在 system prompt），不破坏 prefix cache
- `habituation` 机制控制重复注入的 token 消耗

**真正的三个瓶颈：**

1. **蒸馏质量**：`dream.ts:5` 明确标注 "Phase 1 uses template-based extraction. Phase 2 will upgrade to LLM-powered distillation"。模板只能提取表面特征（改了哪些文件），无法提炼可迁移策略
2. **检索精度**：`lesson-relevance.ts:43` 用 `SCORE_KEYWORD_HIT=15` 做 substring match。语义相似但关键词不匹配的知识被遗漏
3. **Claims 消费不对称**：playbook lessons 自动注入 prompt，但 durable claims 需要 LLM 主动调用 `recall` 工具。`promotion.ts:18` 要求 5 次消费 + 10 分钟存活才升级为 durable——但 durable 后反而失去自动 surface 能力

---

## 三轮演化过程

### 第一轮：变异

| 方案 | 生态位 | 一句话 |
|------|--------|--------|
| V1 语义记忆 | 主流 | 用 FTS5/向量检索升级 keyword substring match |
| V2 LLM 蒸馏 | 邻近 | 实现 dream.ts Phase 2，用 LLM 从执行轨迹提炼可迁移策略 |
| V3 Markdown 记忆层 | 空位 | 借鉴 OpenClaw 四层 Markdown，给 Rivet 建纯文本知识层 |
| V4 遗传自进化 | 突变 | 借鉴 Hermes GEPA，用遗传搜索优化 prompt/tool description |

### 第二轮：选择

| 方案 | 因果 | 成本 | 落地性 | 判定 |
|------|------|------|--------|------|
| V1 | 通过 | 中（FTS5 轻量 / 向量重） | ✅ FTS5 补充 keyword | **存活（中）** |
| V2 | 通过 | 低（复用 dream hook） | ✅ 加 LLM summarize 步骤 | **存活（强）** |
| V3 | 弱（与 CLAUDE.md + playbook 重叠） | 中 | 用户价值不明确 | **灭绝** |
| V4 | 断裂（遗传变异 prompt 破坏 prefix cache） | 高 | ❌ | **灭绝** |

**回收特征：**
- V3 → 知识可编辑性：`rivet playbook export/import` CLI 命令
- V4 → fitness function：记录 prompt 版本 vs tool success rate（不做遗传搜索）

**独立发现：** durable claims 不自动 surface 是内部不对称 bug（P0）

### 第三轮：适应

**收敛洞察：** 管道已就绪，瓶颈在输入质量和检索精度。与 OpenClaw Pi 内核一致——简单架构 + 高质量内容 > 复杂架构 + 低质量内容。

---

## 实施路径

**Phase 1（1 周）：dream LLM 蒸馏 + claims auto-surface**
- dream.ts 模板提取后加 LLM summarize（~500 token/session 额外成本）
- claim-store 加 auto-surface 到 volatile-user-message（复用 scoreLessons 评分）
- 成功标准：lesson 从 "edited auth.ts" 升级为 "auth middleware 先检查 refresh token 有效性"；durable claims 下次 session 自动出现
- 退出条件：LLM 蒸馏增加 session 结束延迟 >5s

**Phase 2（1 周）：FTS5 检索 + 成本感知路由**
- lesson-relevance.ts 加 SQLite FTS5 全文匹配，与 keyword score 加权合并
- Ice Mirror adapter 加 task complexity 评估（简单→轻量模型，复杂→强模型）
- 成功标准：关键词不匹配 lesson 召回率 +30%；简单任务自动路由到轻量模型
- 退出条件：FTS5 索引增加 session 启动延迟 >1s

**Phase 3（1 周）：知识可编辑性 + 可观测性**
- `rivet playbook export` 导出 Markdown；`rivet playbook import` 导入编辑后版本
- fluency inspect 模式展示当前注入的 lessons 和 claims
- 成功标准：用户能导出→编辑→导入；inspect 模式列出全部注入知识
- 退出条件：导入导出格式不稳定

---

## 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| LLM 蒸馏产出低质量泛化 | 中 | 中 | 加验证步骤：蒸馏结果必须包含文件名/函数名等具体引用，否则丢弃 |
| FTS5 在大 playbook 上性能下降 | 低 | 低 | 定期归档旧 lessons（>30 天 + useCount=0） |
| Claims auto-surface 注入过多 token | 中 | 中 | 设预算上限（max 3 claims per session），复用 habituation 衰减机制 |
| 成本路由选错模型 | 中 | 中 | Fallback：如果轻量模型连续失败 2 次自动升级 |

---

## 两轮差距分析的合并优先级

结合 Claude Code 差距分析 + 本轮三竞品分析：

| 优先级 | 差距 | 来源 | 预期工作量 |
|--------|------|------|-----------|
| **P0** | Sandbox 轻量进程隔离 | Claude Code / OpenClaw | 2 周 |
| **P0** | Dream LLM 蒸馏 (Phase 2) | Hermes Agent | 1 周 |
| **P0** | Durable claims auto-surface | OpenClaw / 内部不对称 | 3 天 |
| **P1** | 自适应审批 (sensorium→approval) | Claude Code / 自调节路径 | 1 周 |
| **P1** | FTS5 知识检索升级 | Hermes / Ruflo | 1 周 |
| **P1** | 多模型成本路由 | Ruflo / OpenClaw | 1 周 |
| **P2** | 用户 Hook API 暴露 | Claude Code | 1 周 |
| **P2** | LSP 集成 | Claude Code | 2 周 |
| **P2** | Playbook 可编辑性 (export/import) | OpenClaw Markdown | 3 天 |
| **P2** | Fluency inspect 知识可观测 | 自研 | 3 天 |
| **P3** | 远程 agent 隔离 | Claude Code / Ruflo | 长期 |
| **P3** | FSM 协调层显式化 | OpenClaw | 长期 |
