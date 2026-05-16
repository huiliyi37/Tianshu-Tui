# Rivet Evolutionary TUI Memory 深度头脑风暴结果

## 背景

用户原始意图：

> 看所有智能体和终端 TUI 层的记忆系统的实现。随机领域探查，可多个 scout，不计成本。给出我们项目的 TUI 结合最佳实践的跨越式设计。目标是让运行在终端里的模型能力达到最强，并将大部分完整能力开源贡献。可以参考 XML，也可以参考生物学、进化学。我们要做智能进化的终端智能体 TUI。

当前 Rivet 已经不是一个简单聊天壳。它有 DeepSeek V4 前缀缓存策略、稳定 system prompt、volatile context、context layer report、session sidecar、context ledger、trace store、evidence tracker、worker coordinator、delivery gate、cockpit panels。真正的问题不是“加一个更大的记忆文件”，而是把这些已存在的器官接成一个能学习、能忘记、能防毒、能复盘、能开源复用的上下文生命系统。

现状基线：

- `src/context/session-memory.ts:7-52`，会话级 sidecar，最多 50 条，XML 投影为 `<session-memory>`。
- `src/agent/session-persist.ts:78-102`，把 sidecar 读写、XML block、ledger digest 接到 session persistence。
- `src/prompt/engine.ts:89-99`，把 session memory 注册为 stable-volatile context layer。
- `src/prompt/engine.ts:122-148`，历史 turn 使用 frozen volatile block，最新 turn 可带动态上下文，保护 DeepSeek prefix cache。
- `src/tui/app.tsx:322-335`，`/memory [text]` 只支持 list 和 manual append。
- `src/agent/loop.ts:203-210`，context ledger 可接收 session memory 摘要。
- `src/context/anchor-registry.ts:21-80`、`src/context/proactive-inject.ts:7-28`、`src/context/persistent-store.ts:33-108`、`src/tools/recall.ts:29-58` 已有雏形，但生产路径未完整接线。

## Scout 调研发现摘要

### Scout A，项目代码接线

Rivet 已有类型脊柱：`ContextAnchor`、`CompactedSpan`、`SessionMemoryEntry`、`ContextLedger`、`CompactTier`。但当前有 5 个断点：

1. `AnchorRegistry` 未接入 runtime，用户约束、决策、错误不会自动变成 anchors。
2. `PersistentStore` 和 `recall` tool 未注册到默认工具，归档和召回能力不可达。
3. `.meta.json` 写入函数存在，但生产路径未写 session metadata。
4. `SessionMemoryEntry.source` 支持 `manual | compact | resume`，生产路径只写 `manual`。
5. worker session 从空 `SessionContext` 起步，父任务的约束、working set、session memory、trace 没有传给 worker。

这说明我们不是从零开始。Rivet 已经长出了器官，但神经还没接上。

### Scout B，开源实现

可借鉴机制：

- Aider，用可读 Markdown history 提供调试友好性。
- OpenHands，用 event-sourced session 让状态可重放、可懒加载。
- Kiro，分成 persistent resources、session context、on-demand knowledge base。
- Cursor，把项目规则放进只读边界，模型不能改。
- Goose，记录结构化安全 finding 和用户 allow/deny 决策。
- Claude Code，compaction 后重挂最近读过的文件，大工具输出落盘只给预览。

可偷的不是某一个功能，而是分层：永久规则、会话事实、按需召回、证据日志、UI 预算可视化。

### Scout C，随机跨域机制

跨域类比直接映射到 Rivet：

- Synaptic tagging，短期信号先打 tag，只有再次被使用或被验证才巩固为长期记忆。
- Belady cache replacement，忘掉未来最不可能再用的内容，而不是单纯忘掉最老的。
- CRDT causal clocks，多 actor 输出要带因果时间和作者，但语义冲突不能盲合并。
- Kafka keyed compaction，append-only log 可保留每个 topic 的最新状态，同时保留审计顺序。
- Incident postmortem，一个长期 claim 必须能追溯到谁说的、哪轮用过、哪个决策依赖它。

### Scout D，技术和安全实践

本地优先 TypeScript CLI 的底座建议：

- 单文件 SQLite，WAL 模式，适合无服务本地存储。
- append-only event rows，加 projection tables，当前视图是 fold 出来的。
- `sqlite-vec` 可作为后续同库向量检索，但第一版先 full-text/scalar search。
- prompt 安全边界：结构化 tags、输入输出分离、Zod schema validation。
- 隐私默认 session-scoped，支持 retention days、path redaction、export/import，optional encryption。

### Scout E，反证前提

必须防止 7 个漂亮陷阱：

1. 被证据支持的 fact 仍然可能过期、局部、错误，所以应该叫 claim，不应该叫 truth。
2. event sourcing 不该一上来接管所有 runtime state，先只记录 derived context decisions。
3. 本地优先不等于跨机器一致，第一天就要设计 global IDs 和 export/import。
4. XML 是 projection，不是 canonical storage。
5. TUI 展示越多不等于越可信，默认只展示异常。
6. CRDT 能合并寄存器，不能自动解决语义真假。
7. token budget 不是唯一指标，quality budget 同样重要。

## 合成假设

基于项目已有但未接线的 anchors/store/recall、开源工具的 tiered context/event sourcing/read-only rule 实践、跨域系统的两阶段巩固和因果追溯、以及反证 scout 对“自动真相”的攻击，我认为：

**Rivet 应该从 session sidecar 进化为本地优先、证据约束、可投影、可遗忘、可争议的 Evolutionary Context Fabric。它不把模型说过的话当真相，而是把运行过程中的观察变成 claim，让 claim 通过复用、验证、用户纠正、测试结果、文件证据竞争进入 prompt。TUI 不展示所有 lineage，只展示会影响下一步判断的异常：冲突、过期、未验证晋升、预算失衡。**

## 证据分层

| 发现 | 类型 | 处理方式 |
|---|---|---|
| 当前 session memory 是 per-session sidecar | 现状 | 可替换，但要保持兼容迁移 |
| PromptEngine 已有 context layer 和 stable-volatile fingerprint | 事实/现状 | 必须复用，不能破坏 prefix cache |
| XML 当前适配 DeepSeek prompt layering | 现状/惯例 | 作为默认 renderer，不作为唯一格式 |
| AnchorRegistry 和 PersistentStore 未接生产路径 | 现状 | 是低成本 Phase 1 接线机会 |
| 本地 SQLite WAL 适合 CLI | 技术事实/工程判断 | 可作为默认 store，但抽象接口先行 |
| 向量检索会提升召回 | 假设 | 延后，先用 deterministic search 和 evidence keys |
| 多 worker claim 可自动合并 | 假设 | 禁止直接真值合并，先 conflict journal |
| 用户愿意看完整 lineage | 假设 | 默认只看异常，完整 lineage 放 drill-down |

## 第一轮：变异

[VARIATION]

生态位：开源 terminal coding agent。用户是每天在终端里让模型读代码、改代码、跑测试、开子代理、压长上下文的 builder。技术约束是 DeepSeek V4 prefix cache、1M context、Ink TUI、local-first storage、tool safety、MCP、worker orchestration。商业约束是大部分能力要开源，不能依赖私有云服务才能显得聪明。

选择压力：

- 每一轮模型都比上一轮少重复踩坑。
- 长会话和多 session 后还能保留真实约束。
- 子代理输出能回到主控，而不是变成一次性文本。
- prompt 不能被污染，缓存不能被轻易破坏。
- TUI 要让用户看到“系统正在进化”，但不能把用户淹死在 lineage 里。

已占据生态位：

- 手动 rules 文件，Cursor/Aider 风格。
- session replay，OpenHands/Goose 风格。
- LLM compaction summary，Claude Code/OpenCode 风格。
- vector knowledge base，Kiro/plugin 风格。

空生态位：

- 把 evidence、verification、trace、worker results、context ledger 合成可进化 claim 的 terminal coding agent。
- 把安全 finding 和失败轨迹也作为保护性“免疫记忆”。
- TUI 默认显示异常，而不是显示所有记忆。

调研发现：

- 当前 Rivet 已经有 anchors、persistent store、recall、context layer、evidence、trace、worker evidence，但很多未接线。
- 开源工具普遍有“保存历史”或“注入规则”，少有把事实晋升和验证做成 runtime 闭环。
- 生物和分布式系统都指向同一机制：先观察，再打标，再验证，再巩固，最后在冲突时显式裁决。

方案：

V1（主流，Steering File Plus）：开发者在项目里维护只读 rules 和手动 notes，Rivet 在每轮 prompt 注入这些规则，并在 TUI 显示它们占用多少 token。

- 谁：开发者。
- 场景：开一个项目时。
- 动作：写 `.rivet/rules/*.md` 和 `/memory` notes。
- 结果：模型每轮看到稳定规则，少违反偏好。

V2（邻近，Event-Sourced Replay）：Rivet 把工具调用、用户消息、compaction、checkpoint、worker result 写入本地 append-only log，再 fold 成 session view、project view、debug view。

- 谁：Rivet runtime。
- 场景：每次 turn 和 tool execution。
- 动作：写事件，按 session/repo/topic 投影。
- 结果：崩溃可恢复，长期会话可审计。

V3（空位，Evidence-Backed Claim Evolution）：Rivet 把用户约束、文件观察、测试结果、失败模式、worker 结论变成 claim，claim 只有在有 provenance、复用、验证、用户确认时才晋升到 prompt context。

- 谁：AgentLoop 和 coordinator。
- 场景：读文件、改文件、测试、用户纠正、worker 返回结果后。
- 动作：生成 claim proposal，附 evidence，跑晋升规则。
- 结果：模型看到的是经过选择的事实，而不是噪声摘要。

V4（突变，Multi-Agent Population Memory）：每个 subagent 都像一个个体，独立提出 claim、反证、补丁和 evidence，主控像生态系统一样选择、合并、隔离、淘汰。

- 谁：主控 coordinator 和 worker sessions。
- 场景：并行探索、代码审查、修 bug、验证。
- 动作：workers 输出 claim proposals，coordinator 合并 observation，冲突进入 adjudication queue。
- 结果：多智能体不只是并行跑任务，而是贡献可复用知识。

V5（免疫系统，Failure Antibody Layer）：Rivet 把 prompt injection finding、工具失败轨迹、重复误操作、用户纠正、安全拒绝、测试失败根因转成 antibodies，下一次相关上下文出现时主动提醒或阻断。

- 谁：approval-risk、trace-store、evidence tracker、failure-classifier。
- 场景：危险命令、重复失败、外部内容、失败测试、用户纠正后。
- 动作：记录 antibody，匹配相似轨迹，注入 short warning 或提高审批风险。
- 结果：模型不是只记得成功，也记得会伤人的坑。

创始假设：

- “记忆”默认是正向资产。但负面记忆，失败、注入、安全、误判，可能更快提升能力。
- “长期”默认更好。但不带 scope 和 expiry 的长期记忆会变成毒素。
- “多 agent”默认并行提速。但真正价值是产生不同证据和反证，不只是多跑几条命令。
- “XML”默认是系统真格式。但 XML 应该只是 provider projection。
- “展示更多”默认更透明。但用户真正需要的是异常和下一步可操作项。

适应度函数：

硬约束：

- 不破坏 DeepSeek prefix cache 的 stable/dynamic 分层。
- 不让未验证 assistant speculation 自动晋升为 durable claim。
- 默认本地、可导出、可删除，开源用户不需要云服务。
- 能与现有 `SessionPersist`、`PromptEngine`、`ContextLedger`、`EvidenceTracker`、`Coordinator` 分阶段接上。
- TUI 默认不产生认知噪声。

加分：

- 能把用户纠正转成下一轮可用能力。
- 能把 worker 结果变成主控可复用上下文。
- 能把 compaction 从“压缩文本”升级成“按 topic 保留可验证状态”。
- 能给开源社区一个可理解、可测试、可替换的数据模型。

减分：

- 引入复杂 native dependency 过早。
- 把所有 event 都塞进 SQLite，导致首版拖慢。
- 把 vector search 当救命稻草。
- TUI 太炫，用户看不出该怎么行动。
- 记忆系统自己成为 prompt-injection 通道。

## 第二轮：选择

[SELECTION]

目标重注入：用户要“看所有智能体和终端 TUI 层的记忆系统实现，随机领域探查，多 scout，不计成本，给 Rivet 一个跨时代的 TUI 记忆设计，让终端里的模型能力达到最强，并大部分开源”。所以方案必须是 architecture，不是局部 CRUD。必须连接 TUI、agent loop、subagent、prompt XML、context ledger、evidence、开源包装。

目标偏移：

- V1 偏弱。它回答“怎么稳定注入规则”，但没有回答“智能进化”。
- V2 偏底座。它回答“怎么保存和复盘”，但没有回答“保存后怎么选择”。
- V3 正中目标。它回答“模型如何从运行中变强”。
- V4 正中多智能体目标，但作为主方案风险过高。
- V5 正中可靠性目标，但它是保护层，不是完整上下文系统。

因果测试：

- V1 通过但上限低。手动 rules 让模型少忘，但因果链依赖用户持续维护。
- V2 通过但不充分。event log 让系统可重放，但 replay 不等于 insight。
- V3 通过。运行事件产生 claim，claim 经 evidence 和复用晋升，prompt 投影改变下一轮行为，下一轮行为再产生新 evidence。这是闭环。
- V4 部分通过。worker 多样性产生更多观察，但语义冲突不能像 CRDT register 那样自动 resolve。
- V5 通过。失败轨迹和安全 finding 匹配后影响审批、prompt warning、策略切换，能减少重复错误。

成本测试：

- V1 成本低，1 到 2 天可接只读 rules 和预算显示，但收益有限。
- V2 成本中高，SQLite event store、migrations、export/import、projection tables 需要 1 到 2 周，收益是地基。
- V3 成本中，先用现有 AnchorRegistry、EvidenceTracker、ContextLedger 做 claim proposal 和 promotion gate，3 到 5 天可 MVP。
- V4 成本高，worker protocol、merge journal、adjudication UI、conflict semantics 需要后续阶段。
- V5 成本中，复用 trace-store、approval-risk、failure-classifier，可以先做 2 到 4 类 antibodies。

共演化：

- V1 静态。规则写完后不会自己变强。
- V2 静态到动态之间。event log 是材料，但没有选择器时不会自动进化。
- V3 动态。越使用，越有 evidence，越能决定什么该进 prompt。
- V4 动态。多 worker 越多，variation 越多，但需要强选择机制。
- V5 动态。失败越多，抗体越准，但要防止过度保守。

局部最优：

V1 是最危险的局部最优。它最容易做，也最像竞品规则文件，但它会把“智能进化”降级成“更好的 CLAUDE.md”。这不够。Rivet 的优势是已经有 evidence、trace、verification、worker 这些器官。只做 rules 是浪费。

落地性：

- V1 第一步：新增 `.rivet/rules/` 只读加载并显示 context budget，可执行。
- V2 第一步：新增 `ContextStore` interface 和 SQLite/JSONL event adapter，先记录 claim events，可执行。
- V3 第一步：在 `AgentLoop.run()` 的 user input、tool result、verification result 后生成 `ClaimProposal`，用 `EvidenceTracker` 和 `AnchorRegistry` 判断是否进入 `active-claims` projection，可执行。
- V4 第一步：扩展 `WorkerResult` 增加 `claimProposals` 和 evidence refs，可执行但需要 V3 先存在。
- V5 第一步：把用户纠正、blocked risk、failed verification、prompt injection finding 记录为 `antibody` claim，并在 `approval-risk` 或 latest-turn context 注入，可执行。

灭绝：

- V1 作为主方案灭绝。原因：它不产生自动适应，只是手动 steering。回收特征：read-only project boundary、human override、diffable text export。
- V2 作为主方案灭绝。原因：event log 是地基，不是选择器。回收特征：append-only audit、projection table、export/import、lazy replay。
- V4 作为主方案灭绝。原因：多 worker semantic merge 过早，容易制造“多个错觉合并成一个真相”。回收特征：actor IDs、conflict journal、worker claim proposals、adjudication queue。

存活：

- V3 存活，排名 1。优势：它把现有运行信号转成下一轮模型能力，并用 evidence 防止污染。
- V5 存活，排名 2。优势：它把失败和攻击转成保护层，提升最快、用户最能感知。
- V1/V2/V4 的特征被吸收进 V3/V5，而不是丢弃。

最强竞争者：V3，Evidence-Backed Claim Evolution。

理由：Rivet 的核心目标是“模型在终端中越跑越强”。最短因果链是：运行产生证据，证据生成 claim，claim 竞争晋升，晋升改变 prompt 和审批，下一轮行为改善。这条链路能被测试、能被 TUI 展示、能开源。

新发现：真正的“记忆”不是 storage，而是 selection。没有 selection 的存储只是档案柜。Rivet 需要的是选择压力。

Discarded trait 回收：

- 从 V1 回收：read-only steering 层，作为 `project-rule` claim source，但模型不能自动写。
- 从 V2 回收：append-only claim event log，作为 audit 和 replay 底座，但不接管所有 runtime。
- 从 V4 回收：worker claim proposals 和 conflict journal，用于后续多 agent population。

## 第三轮：适应

[ADAPTATION]

套路清除：

- 清除“加向量库就是记忆”的套路。向量检索只能帮找相似文本，不能判断真假、范围、过期、是否该进 prompt。
- 清除“所有历史都 event source”的套路。首版只记录 context-relevant events，不记录每个 UI repaint 和普通 stream chunk。
- 清除“XML 是系统格式”的套路。canonical schema 是 typed claim，XML 只是 DeepSeek renderer。
- 清除“透明就是展示一切”的套路。TUI 默认展示异常和行动建议，完整 lineage 走 drill-down。
- 清除“多 agent 输出多数投票就是真”的套路。semantic conflict 要进入 conflict journal。

扩展适应：

已有器官的新用途：

1. `AnchorRegistry` 从测试用 salience collector，扩展适应为 ephemeral claim seed generator。
2. `EvidenceTracker` 从交付验收状态，扩展适应为 claim promotion gate。
3. `TraceStore` 从 doom-loop 检测，扩展适应为 antibody generator。
4. `ContextLayerReport` 从 cache diagnostics，扩展适应为 context genome inspector，显示哪些 claim projection 进了 prompt。
5. `Coordinator` 从任务调度器，扩展适应为 population selector，接收 worker claim proposals。
6. `SessionMemoryEntry.source='compact'|'resume'` 从未使用枚举，扩展适应为 compaction/resume-derived claim source。
7. `PersistentStore` 和 `recall` tool 从不可达代码，扩展适应为 deterministic recall MVP。

具体化：

人：

- 主要执行者：Rivet runtime，不把整理工作推给用户。
- 受益者：每天用终端模型改代码的 builder。
- 监督者：用户，只处理冲突、过期、高风险晋升，不手动管理所有 notes。
- 贡献者：subagents，提出 claim proposals，而不是只返回段落总结。

场：

- 用户在一个 TypeScript repo 中连续工作 6 小时，经历多轮文件读取、测试失败、用户纠正、子代理审查、compaction、resume。
- 当前系统如果只靠 transcript，模型会重复探索、忘记用户偏好、把旧文件状态当新事实、worker 结果不会形成长期资产。

动：

1. 用户说“不要改 cache 边界”。`AnchorRegistry` 生成 `ClaimProposal(kind=user_constraint, text=...)`。
2. 模型后续编辑 prompt/context 文件。claim 被再次引用，EvidenceTracker 记录相关文件和改动风险。
3. 用户没有反驳，测试通过，claim 获得 `reuse + verification` 信号，晋升为 session-level active claim。
4. 经过几次 session 后，用户再次纠正同类问题，claim 获得 project-level candidate 状态，但需要用户确认才能进 read-only project rule。
5. Prompt projection renderer 把 top active claims 注入 `<active-claims>`，只占固定 token budget。
6. TUI Context panel 只显示“1 个 stale claim，需要 revalidate”或“2 个 conflicts，需要用户裁决”。

果：

- 目标 1：重复用户纠正下降，下一次同类任务不再踩同坑。
- 目标 2：compaction 后不丢用户约束和关键决策。
- 目标 3：worker 输出的关键发现能被主控召回。
- 目标 4：未经证据支持的 assistant 推断不会变成长期规则。
- 目标 5：用户能在 TUI 看到系统为什么这么做，但默认只看异常。

收敛验证：

V1、V2、V3、V4、V5 都收敛到同一个核心真相：

**有用的终端智能体记忆不是“存下来”，而是“带着证据被选择出来，并在下一次行动前改变模型行为”。**

这就是最终方案的核心。

## 最终方案：Evolutionary Context Fabric

### 核心循环

```
observe → tag → validate → promote/quarantine → project → act → revalidate
```

- observe：捕捉用户约束、文件观察、工具结果、测试结果、worker finding、用户纠正、安全 finding。
- tag：变成 `ClaimProposal`，带 kind、scope、actor、source、evidence refs、expiry、confidence。
- validate：检查 provenance、是否来自 trusted source、是否被 verification 支持、是否有 counterevidence。
- promote/quarantine：晋升到 active context、保持 ephemeral、隔离为 conflict、转成 antibody。
- project：按 provider renderer 输出 XML 或其他格式，不把 canonical storage 绑定到 XML。
- act：prompt 和 approval risk 使用这些 claims。
- revalidate：文件变更、测试失败、用户反驳、resume 后重新计算 staleness。

### Canonical data model

```ts
interface ContextClaim {
  id: string
  kind:
    | 'user_constraint'
    | 'user_preference'
    | 'decision'
    | 'file_observation'
    | 'verification_fact'
    | 'failure_pattern'
    | 'security_finding'
    | 'worker_finding'
    | 'project_rule'
  scope: 'turn' | 'session' | 'project' | 'repo' | 'global'
  status: 'ephemeral' | 'active' | 'durable_candidate' | 'durable' | 'stale' | 'conflicted' | 'quarantined'
  text: string
  confidence: number
  fitness: number
  source: {
    actor: 'user' | 'assistant' | 'tool' | 'worker' | 'hook' | 'compact' | 'resume'
    sessionId: string
    turn: number
    eventId: string
  }
  evidence: EvidenceRef[]
  consumers: ConsumerRef[]
  counterevidence: EvidenceRef[]
  createdAt: number
  lastUsedAt: number
  expiresAt?: number
  tags: string[]
}
```

Important naming: use `claim`, not `fact`. A claim can be stale or wrong. This one word prevents a lot of future damage.

### Storage tiers

Phase 1 should not jump straight to a heavy all-runtime DB. Use a narrow `ContextStore` interface:

```ts
interface ContextStore {
  appendEvent(event: ContextEvent): void
  listClaims(filter: ClaimFilter): ContextClaim[]
  updateClaimStatus(id: string, status: ContextClaim['status'], reason: string): void
  searchClaims(query: ClaimQuery): ContextClaim[]
  exportSession(sessionId: string): string
}
```

Backends:

1. Phase 1，JSONL events plus projection JSON under `~/.rivet/context/`.
2. Phase 2，SQLite WAL backend with `events`, `claims`, `evidence_refs`, `claim_consumers`, `conflicts`, `antibodies` tables.
3. Phase 3，optional `sqlite-vec` module for semantic recall, behind the same interface.

Do not make vectors mandatory. Wild how often people build a vector database when what they needed was a primary key and humility.

### Prompt projection

Canonical claims are rendered into provider-specific context blocks.

Default DeepSeek renderer:

```xml
<context>
  <active-claims scope="session" count="3">
    <claim id="c_123" kind="user_constraint" confidence="0.92" evidence="e_99">
      Keep prefix-cache boundary changes out of display-only fixes.
    </claim>
  </active-claims>

  <antibodies count="1">
    <antibody id="a_17" trigger="read_tool_invalid_pages">
      If Read injects pages for non-PDF files twice, switch to Python file inspection.
    </antibody>
  </antibodies>
</context>
```

Rules:

- Active claims go into stable-volatile only if they are stable for the session.
- Latest-turn tool history, task progress, and strategy shifts remain dynamic.
- Claims from untrusted file/tool text are escaped and marked as data.
- Projection has a token budget, e.g. 2 percent of context window or fixed cap.
- If claim set changes mid-session, `PromptEngine.updateSessionMemory()` must rebuild the effective volatile block, not only mutate config.

### Promotion fitness

A claim's fitness should be a small deterministic function first, not LLM magic.

Positive signals:

- User stated it directly.
- User corrected the assistant.
- Referenced in later round.
- Tied to files actually read or modified.
- Test or verification passed after action followed it.
- Worker independently found same observation.
- Used after compaction/resume and still relevant.

Negative signals:

- Assistant inferred it without user/tool evidence.
- File evidence hash changed.
- User contradicted it.
- Test failed after action depended on it.
- It came from untrusted tool output or external page.
- It has not been used for N sessions.

Promotion thresholds:

- `ephemeral → active`: user direct statement or two weak signals.
- `active → durable_candidate`: repeated across sessions or user correction plus successful verification.
- `durable_candidate → durable`: user confirmation or project read-only rule import.
- Any contradiction: status becomes `conflicted`, not overwritten.

### TUI design

TUI should not become a scrolling genealogy chart. Default views:

1. SummaryBar small indicator:
   - `ctx 43% | claims 5 | stale 1 | conflicts 0 | antibodies 2`
2. Context panel section:
   - Active claims by kind and token budget.
   - Only anomalies expanded by default.
   - Commands: `/context claims`, `/context stale`, `/context conflicts`, `/context lineage <id>`.
3. Memory command replacement:
   - `/memory` shows current active claims and manual notes.
   - `/memory add <text>` creates a manual claim.
   - `/memory promote <id>` asks user to confirm durable status.
   - `/memory forget <id>` tombstones a claim.
   - `/memory export` writes readable Markdown/JSONL.
4. Conflict workflow:
   - If two claims conflict, TUI shows a short prompt: “Which claim should guide future turns?”
   - User can choose A/B/both scoped/forget.

### Worker integration

Extend worker output shape:

```ts
interface WorkerResult {
  // existing fields
  claimProposals?: ClaimProposal[]
  evidenceRefs?: EvidenceRef[]
  counterexamples?: EvidenceRef[]
}
```

Coordinator rules:

- Worker observations with file/test evidence can become active session claims.
- Worker conclusions without evidence remain ephemeral.
- Conflicting worker claims enter `conflict_journal`.
- Parent constraints and active claims are included in worker prompt packet, but with a smaller fixed budget.

This turns subagents from disposable interns into a population. Still supervised. No silent truth merge.

### Immune memory

Antibodies are a specialized claim class for “do not repeat this failure”. Sources:

- user corrections
- failed tests root causes
- repeated tool failure fingerprints
- prompt injection findings
- unsafe command denials
- stale evidence detected after file changes

Actions:

- raise tool approval risk
- inject one-line warning into latest-turn context
- suggest strategy shift
- block repeated doomed trajectory after threshold

Example antibody:

```json
{
  "kind": "failure_pattern",
  "trigger": "Read tool repeated invalid pages param on non-PDF",
  "action": "switch_to_python_file_inspection",
  "evidence": ["user correction", "tool errors"],
  "scope": "project"
}
```

## 实施路径

### Phase 1：最小可行进化闭环

动作：

1. 新增 `src/context/claims.ts`，定义 `ContextClaim`、`ClaimProposal`、`EvidenceRef`。
2. 新增 `src/context/context-store.ts`，先用 JSONL/projection backend，不引入 SQLite。
3. 把 `AnchorRegistry.processUserMessage()` 接进 `AgentLoop.run()` 用户输入路径。
4. 把 `EvidenceTracker`、verification result、user correction、tool failure 变成 claim evidence。
5. 新增 `buildActiveClaimsBlock()`，接进 `buildStableVolatileBlock()` 或 latest-turn renderer。
6. 修正 `PromptEngine.updateSessionMemory()` 类似路径，确保 claim projection 变化会进入下一次 request。
7. TUI 增加 `/context claims` 和 `/context stale`，SummaryBar 只显示计数。

预期产出：用户约束和失败抗体可以从运行中产生，并在下一轮影响模型。

成功标准：

- 用户直接说出的约束在下一轮 request 的 context block 中出现。
- 未验证 assistant 推断不会晋升 active。
- 文件变更后相关 file_observation 变 stale。
- `/context claims` 可看到 claim、evidence、status。
- 现有 prefix cache fingerprint 测试不退化。

退出条件：如果 claim projection 破坏 prefix cache，回退为 latest-turn only projection，先牺牲一点 token 稳定性，不污染历史 prefix。

### Phase 2：SQLite store + compaction/resume 接线

动作：

1. 实现 SQLite backend，WAL、events、claims、evidence refs、consumer refs、conflicts。
2. `SessionPersist.writeMetadata()` 接入 ledger snapshot。
3. auto-compaction 成功后写 `source='compact'` 的 claim summary，不再只改 transcript。
4. resume preflight 后写 `source='resume'` revalidation event。
5. 新增 export/import，默认去绝对路径，可选 path redaction。
6. 新增 `/memory promote/forget/export`。

预期产出：长会话和 resume 后保留有证据的上下文，不靠 transcript 原文活着。

成功标准：

- 断电或进程崩溃后 claim store 可恢复。
- compaction 后 active user constraints 仍被投影。
- export 可读，导入后同一 session 的 claims 可重建。
- 过期 evidence 被标 stale，不静默注入。

退出条件：SQLite native packaging 如果阻塞开源安装，保留 JSONL backend 为默认，SQLite 作为 optional adapter。

### Phase 3：Multi-agent population + immune cockpit

动作：

1. `WorkerResult` 增加 `claimProposals`。
2. `worker-prompts.ts` 要求 worker 输出 evidence-backed proposals。
3. Coordinator 合并 observation，冲突进入 conflict journal。
4. Cockpit Context panel 增加 conflicts/stale/antibodies drill-down。
5. approval-risk 读取 antibodies，重复危险动作提高风险。
6. failure-classifier 将稳定失败根因写入 antibody proposal。

预期产出：子代理不再只是“返回文本”，而是贡献可检验的观察、反证和保护性经验。

成功标准：

- 两个 worker 对同一文件给出冲突结论时，TUI 显示 conflict，不自动选边。
- worker evidence 不足时 claim 保持 ephemeral。
- 重复失败轨迹触发 antibody warning。
- 用户裁决 conflict 后，后续 worker prompt 收到 scoped decision。

退出条件：如果 conflict UI 造成干扰，默认只在 delivery gate 或 high-risk turn 展示。

### Phase 4：Optional retrieval intelligence

动作：

1. 增加 FTS5 full-text search。
2. 增加 optional sqlite-vec adapter。
3. 引入 retrieval eval，测 precision，不凭感觉上线。
4. 支持 project-level read-only claims import，例如 `.rivet/rules/*.md`。
5. 支持 cross-machine export/import，远程 sync 后置。

预期产出：Rivet 可以按需召回历史 claim 和证据，但不会把相似文本误当事实。

成功标准：

- 召回结果带 claim status 和 evidence freshness。
- 低 confidence 或 stale 结果不会默认注入 prompt。
- 用户可以一键查看“为什么召回这个”。

退出条件：vector recall precision 低于 deterministic search 时，不作为默认路径。

## 风险与应对

### 风险 1：事实污染

问题：assistant 推断或外部 tool output 被系统当作长期事实。

应对：所有 durable entry 都叫 claim。assistant-only source 默认不能 durable。untrusted content 只能产生 quarantined proposal，除非用户确认或工具证据支持。

### 风险 2：TUI 信息过载

问题：lineage、claims、events、conflicts 太多，用户开始忽略。

应对：默认只展示异常计数和下一步动作。完整 lineage 只能通过 drill-down 命令查看。

### 风险 3：prefix cache 退化

问题：claim projection 每轮变化，破坏稳定 prefix。

应对：active stable claims 固定在 session epoch 内，dynamic warnings 只进 latest-turn block。claim set 变化触发 context epoch，TUI 显示 cache impact。

### 风险 4：SQLite packaging 拖慢开源采用

问题：native binary、WAL、sqlite-vec、encryption 让安装复杂。

应对：接口先行，JSONL backend 默认可用，SQLite backend 是增强模式。sqlite-vec 延后。

### 风险 5：多 agent 合并伪真相

问题：多个 worker 都错，系统还以为共识可靠。

应对：共识只能提高 confidence，不能替代 evidence。语义冲突进 journal，用户或验证结果裁决。

### 风险 6：记忆变成保守主义

问题：antibodies 太强，模型不敢尝试新路径。

应对：antibody 有 scope、expiry、counterevidence。成功绕过失败模式后，抗体降权。

## 规格自检

占位符扫描：无占位符、无 TODO。

内部一致性：最终方案以 V3 为主，吸收 V1/V2/V4/V5 特征。V5 是保护层，不和主方案冲突。

范围检查：聚焦在 Rivet TUI/agent/context 记忆系统，不扩展到云同步平台、团队协作 SaaS 或完整数据库产品。

模糊性检查：核心名词已固定，canonical entity 是 `ContextClaim`，不是 fact。XML 是 renderer，不是存储。SQLite 是 Phase 2 adapter，不是 Phase 1 前提。

## 下一步

下一步应该写实施计划，不直接开写全部系统。Phase 1 第一个具体动作：

1. 新增 `src/context/claims.ts` 和测试，定义 claim/proposal/evidence/status 模型。
2. 新增 JSONL `ContextStore` MVP，记录 claim proposal 和 status transition。
3. 把 `AnchorRegistry` 接入用户输入路径，生成 ephemeral claim。
4. 把 active claims 投影到 prompt，并用测试证明下一轮 request 能看到用户约束。

设计文档到此结束。用户审查通过后，进入 `writing-plans`，生成 TDD 实施计划。
