# Team Mode V3 — 后置强化方向：worker 星域化 + 知识沉淀

> 生成时间：2026-06-07
> 上游文档：`2026-06-07-team-mode-v2-status.md`（V1/V2 基线状态）
> 性质：**后置强化**，非基线。前置条件 = V1/V2 编排层基线建设完成、team 模式可用。
> 范围：本文档**只固化调研事实 + 方向**，不写实现设计（设计待基线落地后再启动）。

---

## 0. 定位与时序（不要搞错层级）

| 阶段 | 谁做的 | 内容 | 触及马超? | 目标 |
|------|--------|------|-----------|------|
| **V1/V2** | 天权规划，天机/天府落地 | 编排层基线：解析、分组、视角合并、依赖透传、max 接 planner、多波次、review gate、profile routing | ❌ 不碰 | team 模式**可用** |
| **V3（本文档）** | 后置 | worker 星域化（马超/关羽等可派发专精认知）+ 星域知识库 + 经验沉淀/升级 | ✅ 核心 | 在可用之上**最大限度强化** |

**硬约束**：V3 的任何项**不得插队进 V2 的 P0/P1**。V2-status §3 的优先级（max 接 planner、多波次、review gate、routing）是基线，必须先落地。V3 在 team 模式可用之后才启动。

---

## 1. 方法论：剥洋葱——"幻想"剥到底是两个模块 + 接线

`/team` 那套"召之即来的专精 worker、各带星域认知、做长程任务、积攒经验升级"，初看像不切实际的幻想。但因为天枢底层一直在认真夯，一层层剥开后，**剩下的全是接线 + 补两个小模块**，不是从零造系统。

剥洋葱过程（每一层都用约束削平了一个看似的大难题）：

1. "worker 要解依赖图做并行" → **不用**。主控 LLM 自己就能拆分依赖与并发（2026-05-30 多会话并行实战已证），依赖是文本提示不是图求解。
2. "多视角需要多个强模型" → **不用**。同一模型进不同星域真做不同事，认知来自星域不来自模型品牌。
3. "worker 长程要补全套记忆 9 子系统" → **不用**。只要星域知识库 + 主控下发的任务上下文。
4. "worker 长程会爆上下文，要接压缩" → **不用**。flash 实配 1M，拆分子任务 <100k，余量离谱。
5. "worker 要造自治多回合循环" → **不用**。worker 与主控共用同一个 `AgentLoop._runInner` 多回合循环，早已共享。

剥到最后，真正剩下的只有 **§3 的两根认知层的线**。

---

## 2. 三轮调研的核实事实（每条都查过代码，只读未改）

### A. 星域是"半接通"的——主控能进，worker 进不去

- 主控侧**通**：`loop.ts:482-484` `bindSessionDomain → buildActiveDomain → setActiveDomain`，经 `prompt/volatile.ts:196-198` 渲染成 `<star-domain>` 注入主控 system prompt。
- worker 侧**断**：
  - `StarDomain.systemPromptSuffix`（那 6 段"你是天权/天机…"的认知注入，`star-domain.ts:35/48/61/74/87/100`）**全代码库零消费**（除定义与测试）。
  - dispatcher 算出的 `authority: StarDomainId`（`dispatcher.ts:34`）在转 `DelegationRequest` 时**被丢弃**（`coordinator.ts` 的 `DelegationRequest` 无 domain/authority 字段）。
  - `buildWorkerPrompt(order, authoritySuffix?)`（`worker-prompts.ts:187`）的 `authoritySuffix` 形参**三个调用方都没传**。
- 根因：worker 不走 `PromptEngine`，用手写字符串 `worker-prompts.ts:buildWorkerPrompt`（"You are a headless worker…"），整条 prompt-engine 通路被绕过。**马超 worker 派出去成不了马超，断点在此。**

### B. 三国英雄 spec 是视觉层，不是认知层

- `docs/superpowers/specs/2026-05-20-three-kingdoms-heroes-companion-design.md` + `avatar/types.ts:HeroId`（7 英雄槽）**纯 avatar/渲染**：字段是 `seal`/`gesture`/`primaryColor`/`greetingQuote`，激活英雄只换脸不换脑，无任何 prompt/派发绑定，且**不含马超**。
- 故"马超/关羽作为可派发的认知视角"**没有现成 spec，是净新**。英雄 avatar 是将来骑在认知层之上的一张脸，与 V3 不冲突、不是双轨。

### C. worker 长程环境差账——代入约束后塌缩

- **自治多回合循环已共享**：`worker-session.ts:68 agent.run → loop.ts:881 _runInner → loop.ts:1502 for(turn<maxTurns)`。heartbeat / 收敛 / abort / turnBudget 全部复用。唯一差别是 `maxTurns`（worker 8 / 主控 25，`main.tsx:558/956`）——一行配置。**多波次"需要 loop/re-entry"的难度可下调：循环是现成的，更可能是 orchestrator 重入接线。**
- **压缩不用管**：flash 实配 `contextWindow:1_000_000`（`config.json` + `main.tsx:535` worker 实拿 1M），拆分子任务 <100k。worker `compact.enabled:false`（`main.tsx:560`）无害。
- **记忆只要两样**：星域知识库 + 主控下发任务上下文，不要全套 9 子系统。worker 只 recall 本域知识，天然隔离跨会话污染。
- **注意**：V1 已落地 `team-grouping.ts`（拓扑+同文件串行+source/test 绑定）、`coordinator.ts` 依赖/groupId 透传（`team:T1` 稳定 ID）——本调研早期判为"net-new"的分组/依赖已被 V1 实现，以 v2-status 为准。

---

## 3. 真缺口：认知层两根线（V3 的全部核心）

1. **星域认知注入 worker**：把 `systemPromptSuffix`（或更丰富的星域人格）接进 worker 的 prompt。要么让 worker 走 `PromptEngine`，要么在 `buildWorkerPrompt` 真正消费 `authoritySuffix` + 在派发链透传 domain/authority。**三轮调研从三个角度都指向这同一断点。**
2. **星域知识库**：每个星域积攒自己的知识（马超带网络层经验），worker 在该域内 recall。结构净新；底座可复用 `stigmergy.ts`（扩 `domainId` 字段）。延伸形态：经验沉淀 → 新手/专家分级。

这两根线接通后，"召之即来的专精 worker"才有物理基础。其余（avatar 换脸、升级曲线、TUI）都是骑在这之上的增量。

---

## 4. 启动 V3 前的注意事项

- **前置闸门**：V1/V2 编排层基线（max 接 planner、多波次、review gate、profile routing）必须先完成、team 可用，再启动 V3。
- **可扩展性是隐含前提**：要"随手加马超关羽"，`star-domain.ts` 的写死枚举（`StarDomainId` 联合 + `STAR_DOMAINS` Record + `glance-bus.ts:ALL_DOMAINS` + `domain-voice` 平行列表，仅覆盖 6 个里的 4 个）需先改成注册表（照搬 `profile-registry.ts` 模式）。这是 §3 两根线的地基，但同样后置。
- **本文档不含实现设计**：设计在 V3 正式启动时再做，避免过早引爆复杂度。

