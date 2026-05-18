# Genome-Immune Team Architecture 评估参考稿（完整回复版）

> Date: 2026-05-19  
> Status: Reference / Discussion Draft  
> Purpose: 作为团队讨论 Genome-Immune Team Architecture 未来发展规划的参考材料。  
> Scope: 本文基于以下文档通读后的评估：
>
> - `docs/superpowers/specs/2026-05-19-genome-immune-team-architecture-design.md`
> - `docs/superpowers/specs/2026-05-19-multi-agent-team-memory-brainstorm-process.md`
> - `docs/superpowers/plans/2026-05-19-genome-store.md`
> - `docs/superpowers/plans/2026-05-19-score-translation.md`
> - `docs/superpowers/plans/2026-05-19-surgical-pause.md`
> - `docs/superpowers/plans/2026-05-19-self-scoring-bid.md`
> - `docs/superpowers/specs/2026-05-19-star-chart-identity-system.md`

---

## 一句话结论

**Genome-Immune Team Architecture 是一个有潜力成为 Rivet 中长期差异化壁垒的方向，但它不应作为当前阶段的直接实施主线；更适合先进入“评估中 / Shadow Mode / 数据采样”阶段，用真实任务数据验证记忆、竞标、分谱、暂停检查是否确实提升成功率。**

它的价值不在于“多 agent 更热闹”，而在于把 Rivet 从一个单体 terminal coding agent，逐步演化为一个具备：

1. 角色经验积累；
2. 跨 session 学习；
3. 多 worker 安全合并；
4. 任务-角色自适应匹配；
5. 人类可审计团队协同；

的长期执行系统。

但它也非常容易过度设计。当前最需要避免的是：**在没有足够真实任务数据和稳定 worker 写能力之前，把 Genome / Score / Surgical Pause / Self-Bid 四条线一次性全部接进主执行链。**

---

## 业务线理解

Rivet 当前业务线不是普通聊天应用，而是一个面向真实本地代码仓库的 terminal coding agent。它的核心业务目标可以概括为：

> 让 DeepSeek V4 / OpenAI-compatible provider 在本地编码任务中，达到接近 Claude Code / opencode 的可用性，同时利用 DeepSeek 的长上下文与 prefix cache 成本优势，形成开放模型路线的工程产品竞争力。

现有能力底座已经覆盖：

- AgentLoop：模型调用、工具执行、循环推进；
- SessionContext：会话状态与上下文管理；
- ToolRegistry：工具注册、审批、安全边界；
- Evidence / Delivery Gate：修改后的验证证据；
- Subagent Orchestration：只读 worker / work order / schema-valid WorkerResult；
- Adaptive Context Fabric：长上下文压缩、anchor、cold storage、cache safety；
- TUI Cockpit：状态、风险、验证、成本、上下文可见性；
- Session HA：恢复、中断、partial output、MCP degradation、进程清理。

因此，Genome-Immune Team Architecture 不是“补齐 P0 可用性”的功能，而是**建立下一阶段差异化上限**的架构方向。

---

## 文档方案的核心判断

该方案最重要的洞察是：

> 协同的本质不是共享记忆，而是在正确的时机传递正确粒度的信息。

这点非常符合 Rivet 当前架构约束。因为 Rivet 已经有明确的 Subagent Phase 1 硬约束：

- worker message 不进入 primary session；
- 只回传压缩 WorkerResult；
- primary authority；
- schema-valid results；
- prefix cache preservation；
- budget gate。

Genome-Immune 的设计没有反向破坏这些约束，而是在这些约束之上提出了更长期的协同层：

| 设计概念 | 对现有 Rivet 的意义 |
|---|---|
| Role Genome | 让 worker 不再是无状态工具调用，而是角色经验可积累 |
| Score Translation | 保持上下文隔离，同时让任务指令按角色经验自适应 |
| Surgical Pause | worker 输出不直接合并，先做 provenance / scope / conflict 检查 |
| Self-Scoring Bid | 任务不只靠固定路由，而是参考角色历史经验选择执行者 |
| Pheromone Space | 通过低耦合信号进行间接协作，避免全量记忆共享污染 |
| Star Chart | 把技术角色抽象成可理解、可运营、可审计的身份系统 |

---

## 方案的强项

### 1. 方向与 Rivet 已有架构天然贴合

Genome-Immune 不是凭空设计。它能映射到当前已有模块：

| 现有组件 | 演化方向 |
|---|---|
| `AgentLoop` | Conductor |
| `WorkerSession` | Role Agent |
| `WorkOrder` | Score / 分谱 |
| `WorkerResult` | 带 provenance 的结果包 |
| `DelegationCoordinator` | 加入 self-score、score translation、staging |
| `EvidenceTracker` | 扩展为 worker / role 结果事实账本 |
| `checkpoint v2 agentTouchedFiles` | 未来可作为 worker 写 scope boundary |
| `PersistentStore / ClaimStore` | 可为 Genome 提供实现参考 |

这说明它不是“另起炉灶”，而是 Rivet 现有能力的自然延伸。

### 2. 它明确拒绝了最危险的“全量共享记忆”

多 agent 系统最容易出问题的是：

- 一个 agent 的错误结论污染所有 agent；
- worker 之间互相抄未经验证的结论；
- 全局记忆膨胀后不可控；
- 错误经验在未来任务中反复注入。

该方案通过 role genome、immune check、surgical pause、pheromone half-life 等机制，明确把“记忆污染”当成一等风险处理。这是正确方向。

### 3. 它把“学习”绑定到可审计 provenance

GenomeBullet 包含：

- role；
- successCount / failureCount；
- importance；
- provenance.sessionId；
- provenance.agentInstance；
- provenance.timestamp。

这使经验不是神秘地进入系统，而是可以追踪来源、使用次数和失败次数。对于 coding agent 来说，这是比普通“长期记忆”更工程化的设计。

### 4. Surgical Pause 是最接近业务安全收益的部分

如果未来 worker 支持写能力，那么 staging + pre-commit checks 几乎是必需的：

1. provenance 验证；
2. scope 越界检测；
3. 文件冲突检测；
4. 逻辑矛盾检查；
5. primary/conductor 裁决。

这比 Genome 更接近真实业务风险，因为它能直接阻止错误修改进入主线。

### 5. Star Chart 对产品心智有价值

星图系统不是核心执行逻辑，但它能成为：

- 多模型团队的身份层；
- git author / branch / genome 文件命名规范；
- 用户理解 agent 分工的产品语言；
- 团队协作审计线索。

它不应过早进入 runtime，但可以作为文档与命名体系长期保留。

---

## 主要风险

### 风险 1：当前数据稀疏，Genome 可能学不到有效经验

风暴文档中已经指出 counter-evidence：真正的问题可能不是“记忆架构不够高级”，而是“数据太少”。如果一个角色只有几条 lesson，那么 self-scoring、score translation、immune check 都会显得很聪明，但实际没有统计意义。

**判断：** 在没有足够历史样本前，不应让 Genome 影响主执行决策。

### 风险 2：计划过早假设 worker 写能力

当前 Subagent Phase 1 的硬约束是 read-only workers only。Surgical Pause 计划中大量内容围绕 changedFiles、scope violation、commit staged results，这更适合未来 write-capable workers 阶段。

**判断：** Surgical Pause 可以先做 read-only result provenance / contradiction check，但不能现在引入 worker write merge 语义。

### 风险 3：Score Translation 可能破坏 prefix cache / prompt 稳定性

如果分谱注入进入 prompt path，需要非常谨慎：

- 不能修改 stable system prompt；
- 不能让每个 worker 有 custom system prompt；
- 应作为 volatile worker packet 或 user-level work order 内容；
- 需要保持 schema 可控和长度可控。

**判断：** Score Translation 只能进入 worker volatile context，不能改变 static prompt 或 tool definitions。

### 风险 4：Self-Scoring Bid 容易形成错误自信闭环

如果角色因为早期偶然成功获得高 confidence，就会被分配更多同类任务，进一步强化偏差。反过来，冷门角色可能永远得不到训练机会。

方案中的 10% exploration 是正确的，但还不够。还需要：

- confidence calibration；
- success after verification 才能加分；
- failure 分类，区分 agent 问题、环境问题、测试 flaky；
- 人类可重置或降权 role genome。

### 风险 5：Genome 与现有 ClaimStore / Playbook / Session Memory 可能重复

Rivet 已经有不少记忆相关模块：

- Context Claim Store；
- PersistentStore；
- Session Memory；
- Playbook / historical lessons；
- Anchor Registry；
- Evidence tracker。

如果 GenomeStore 直接新增一套独立记忆系统，可能造成：

- 同一事实多处存储；
- TTL / decay / promotion 规则不一致；
- prompt 注入路径混乱；
- debug 成本上升。

**判断：** GenomeStore 需要先定义与现有 memory fabric 的边界，不应简单平行新增。

---

## 对四份实施计划的评估

### Plan 1: GenomeStore

**价值：高，但应先 shadow mode。**

GenomeStore 是四个计划的基础。它的类型、JSONL、zod schema、provenance、immuneCheck 都合理。

但建议调整：

1. 不要一开始注入 WorkerSession prompt；
2. 先只记录 candidate genome bullets；
3. 只从 verified / evidence-backed 结果生成经验；
4. 与现有 ClaimStore / Playbook 做边界设计；
5. capacity 不应固定 30，最好按 token budget 或 role 活跃度配置。

### Plan 2: Score Translation

**价值：中高，但依赖真实 genome 质量。**

分谱是很好的抽象。它解决“不同经验水平 agent 应收到不同指令粒度”的问题。

但它最容易变成 prompt 膨胀源。建议：

1. 只在 worker packet 中注入；
2. 每次最多注入 3 条 lesson；
3. 注入内容必须包含 provenance / success rate 摘要；
4. 初期只作为提示，不改变 task objective；
5. veteran / novice 阈值不要只看 genome.length，要看 verified success density。

### Plan 3: Surgical Pause

**价值：最高，但现在只能做只读版。**

Surgical Pause 是最值得优先孵化的部分，因为它直接提升多 worker 协作安全性。

但由于当前 worker 只读，应拆成两阶段：

- 当前可做：WorkerResult provenance、scope declared/read scope、finding conflict、evidenceStatus check；
- 未来可做：changedFiles、staging、commit/reject、merge conflict。

不要现在引入“commitStagedResults”这种写语义，否则会与 Subagent Phase 1 硬约束冲突。

### Plan 4: Self-Scoring Bid

**价值：中，但应最后接入 runtime。**

Self-scoring 很有想象力，但它依赖：

- Genome 有足够样本；
- success/failure 可靠；
- 任务关键词提取可靠；
- role 集合稳定；
- 路由失败有 fallback。

因此它应先离线计算 bid，不参与真实调度；等积累足够数据后，再与现有 ModelCapabilityCard / adaptive routing 融合。

---

## 推荐路线

### 阶段 A：评估中 / Shadow Mode（建议当前只做到这里）

目标：不改变 runtime 决策，只采集数据。

可做事项：

1. 定义 GenomeBullet / RoleIdentity / Provenance 类型；
2. 从已验证任务中生成 genome candidate；
3. 写入 `.rivet/genome-candidates/` 或类似非注入路径；
4. 生成评估报告：哪些 lesson 被提取、是否重复、是否冲突；
5. Surgical Pause 只做 WorkerResult provenance / conflict report，不改变结果流；
6. Self-scoring 只输出 telemetry，不参与 worker 选择。

成功标准：

- 采集 50+ 条 candidate lessons；
- 人工审查有效率 > 60%；
- conflict 检测能发现真实矛盾或重复；
- shadow bid 与人工选择一致率 > 60%。

### 阶段 B：只读增强

目标：在不破坏 Subagent Phase 1 的前提下增强 read-only worker。

可做事项：

1. 给 WorkerResult 加 provenance；
2. Role genome 只读查询；
3. Score Translation 作为 worker volatile packet；
4. worker 结果聚合前做 read-only surgical pause；
5. TUI 显示 role / provenance / evidence summary。

禁止事项：

- worker 写文件；
- worker 直接合并结果；
- genome 自动进入 primary prompt；
- self-bid 直接覆盖 coordinator 路由。

### 阶段 C：受控 runtime 注入

目标：让高质量 genome 以小剂量进入 worker prompt。

条件：

- Genome candidate 已人工或 evidence gate 验证；
- lesson 有 success/failure 反馈；
- prompt 注入有 token cap；
- 可以关闭该能力；
- 有 A/B 对照指标。

### 阶段 D：写 worker + 完整 Surgical Pause

目标：当 worker 写能力进入规划时，再启用 staging / commit / reject。

必须前置：

- checkpoint scope boundary；
- agentTouchedFiles ownership；
- conflict detection；
- rollback；
- delivery gate；
- TUI approval。

### 阶段 E：Self-Bid / Role Emergence

目标：让系统根据历史表现选择 role，并建议新角色。

前置条件：

- 每个 role 至少有足够样本；
- confidence calibration 完成；
- exploration 可控；
- fallback 到现有 routing；
- 可解释选择原因。

---

## 建议修改现有计划的地方

### 1. 明确标注“非当前阶段一定要做”

这套方案应标注为：

> Evaluation Track / Future Architecture / Not required for current phase.

避免团队误以为这是当前交付必须完成的主线。

### 2. GenomeStore 计划应增加“候选态”

建议 GenomeBullet lifecycle：

```text
candidate -> accepted -> active -> decayed -> archived / rejected
```

不要提取后直接进入 active genome。

### 3. immuneCheck 不应只靠 keyword overlap

keyword overlap 是 MVP，但长期不够。至少需要：

- context polarity；
- file / task scope；
- evidence status；
- semantic contradiction；
- human override。

### 4. Score Translation 的 veteran 判断需要改

不建议只用 genome.length > 20。更好的指标：

```text
verified_success_density = verified_success_count / active_lesson_count
recent_failure_rate
role_task_match_score
```

### 5. Self-Bid 不应替代 Model Routing

它应与 ModelCapabilityCard 合并：

```text
final_score = role_confidence * model_capability * provider_health * cost_policy
```

否则会出现角色适合但模型不适合的情况。

### 6. Star Chart 应先作为身份与命名规范

星图很有产品感染力，但不应立刻进入调度机制。建议先用于：

- git author；
- branch naming；
- genome file naming；
- role description；
- docs taxonomy。

---

## 最终建议

我建议团队采用以下决策：

1. **认可 Genome-Immune Team Architecture 作为 Rivet 中长期方向。**  
   它与 Rivet 的 subagent、context fabric、evidence gate、cockpit 都兼容，且有潜力形成区别于 Claude Code / Cursor / Aider 的长期壁垒。

2. **不要现在按四份实施计划直接全量推进。**  
   当前阶段应避免把 runtime 主链复杂化，尤其不能违反 read-only workers、primary authority、prefix cache preservation 等硬约束。

3. **先开一个 Evaluation Track。**  
   只做类型、候选经验采集、离线免疫检查、shadow bid、只读 surgical pause report，不改变真实执行结果。

4. **优先孵化 Surgical Pause 的只读版。**  
   因为它最直接提升多 worker 可信度，也是未来 write-capable workers 的安全前置。

5. **GenomeStore 先做 candidate ledger，而不是 active memory injection。**  
   等真实数据证明 lesson 有用，再进入 prompt 注入。

6. **Star Chart 保留为身份层与产品语言。**  
   它适合塑造 Rivet 的独特气质，但 runtime 应保持工程可验证。

---

## 建议标注

> **Status: Evaluating / Future Architecture**  
> **Current Phase: Not required**  
> **Runtime Impact: Shadow mode only until validated**  
> **Hard Constraint: Must not violate Subagent Phase 1 read-only worker rules**

---

## 适合当前团队讨论的问题

1. 我们是否认可“角色级 genome”而不是“全局共享记忆”？
2. Genome 与现有 ClaimStore / Playbook / Session Memory 的边界怎么划？
3. 哪些事件有资格生成 genome candidate？只允许 verified result 吗？
4. Surgical Pause 是否应先以 read-only report 形式落地？
5. Star Chart 是产品身份层，还是 runtime role taxonomy？
6. Self-Bid 的成功指标是什么？人工选择一致率？任务成功率？成本下降？
7. 如果 genome 学错了，如何回滚、降权、审计？

---

## 结语

这套方案最珍贵的地方不是某个具体类或存储文件，而是它提出了一个正确的长期原则：

> 多智能体协同不是共享更多上下文，而是建立更可靠的信息边界、翻译机制、验证关口和经验演化路径。

Rivet 如果沿着这个原则走，可以从“一个会调用工具的 terminal agent”，演化为“一个可审计、可成长、可协作的工程执行团队”。

但越是有想象力的方向，越需要慢启动、强验证、低耦合。当前最稳妥的做法是：**进入评估，不进主链；采集证据，不急着相信记忆；先做安全边界，再做智能涌现。**
