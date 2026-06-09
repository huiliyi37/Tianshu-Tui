# Team Mode V3 认知层设计：星域注入 + 经验沉淀

> 日期：2026-06-07
> 性质：**设计 spec**（供审查），非实施计划。
> 前置：**V2 落地已完成**（`team_orchestrate` 工具接线、max planner 扇出、多波次、审查门）——见 `2026-06-07-team-mode-v2-landing.md`。本 spec 把 V3 两根认知层线插在 V2 的派发链上。
> 上游方向：`2026-06-07-team-mode-v3-worker-stardomain.md`（只定方向；本文给设计）。
> 范围：V3 的**两个关联组件** + 它们的共享前置 + 闭环。不含 TUI/avatar/自动 merge。

---

## 0. 一句话

V3 = 让被派出的 worker **既是对的认知姿态（注入），又带着该星域累积的真实经验（沉淀）**。两者经一个闭环耦合：**派发时灌姿态 + recall 域经验 → worker 执行 → 把高信号产出沉淀回该域 → 下次派发更厚**。注入是读侧的"人格"，沉淀是写侧的"记忆"。

---

## 1. 现状底座（已读码核实，决定"造什么 vs 复用什么"）

| 能力 | 现状 | 对 V3 的意义 |
|------|------|------------|
| 星域人格文本 | `star-domain.ts`：6 域各有 `systemPromptSuffix` + `toolWhitelist` + `keywords` | **注入内容现成**，直接灌 |
| worker 注入口子 | `worker-prompts.ts:247` `if (authoritySuffix) { '## 权域指令' + authoritySuffix }` | **注入点现成**，3 调用方没传而已 |
| 域计算 | `dispatcher.ts:34` `DecomposedTask.authority: StarDomainId = matchDomain(objective) ?? 'tianliang'` | 域已能算出，但**转 DelegationRequest 时被丢** |
| worker recall | `worker-knowledge.ts` `buildWorkerKnowledgeBlock(claims)`：top-10 by fitness → `<worker-knowledge>` | recall 范式现成，但**投影主会话 claim，非按域** |
| 蒸馏门 | `dream.ts` `distillSession`：5 criteria 正则门 → `.rivet/knowledge/project-memory.md`，dedup(dream-key) + 单调前插 + 8KB 边界裁剪 | **经验沉淀的写入门范式现成**，按域复刻 |
| 强化/衰减 | `stigmergy.ts` `StigmergyStore`：deposit 覆盖(path+signal) + 指数衰减(7d 半衰期) + LRU 200 + prune<0.05；`computeCurrentStrength` 已导出 | **分级/老化模型现成**，复用衰减函数 |
| 写入不变量 | `project-memory-writer.ts`：文件锁(O_CREAT\|O_EXCL) + 原子写(temp+rename) + 单调追加 + compact 去重/cap | **canonical 写入不变量现成**（891cc1b6 事故的解药），必须遵守 |
| 域注册 | `StarDomainId` 是**硬编码 6-union** + `STAR_DOMAINS` Record + `glance-bus.ALL_DOMAINS` 平行列表 | **可扩展性瓶颈**——见 §4 前置 |

**结论**：A 是纯接线；B 是"三套现成范式按域命名空间化 + 加分级"。两者都不从零造系统。

---

## 2. Component A — 星域认知注入

### 2.1 目标

被派出的 worker（V2 的 max planner / executor）真正**成为**它的星域：天权 worker 带审查质疑姿态、天府带守护 fail-closed、马超带破坏欲——不再靠 objective 里塞一句"你是天权"（V2 现状 = prompt 戏服，正是命门）。

### 2.2 设计：沿派发链透传 `authority`

唯一缺口 = `DecomposedTask.authority` 没流到 `buildWorkerPrompt`。补一条贯通线（4 个落点）：

```
DecomposedTask.authority: StarDomainId        ← 已有 (dispatcher.ts:34)
  │  (新增字段，与 DomainArea 区域轴正交)
  ▼
DelegationRequest.authority?: StarDomainId     ← 新增 (coordinator.ts:30-42)
  ▼
WorkOrder.authority?: StarDomainId             ← 新增 (work-order.ts schema；注意 domain 是区域轴，authority 是星域轴，二者不同)
  ▼
worker-session → buildWorkerPrompt(order, authoritySuffix)   ← 解析 STAR_DOMAINS[order.authority].systemPromptSuffix 传入
```

- **注入内容**：`STAR_DOMAINS[authority].systemPromptSuffix`（已存在的人格文本）。
- **工具收敛（可选增强）**：worker 的 `allowedTools` 与 `STAR_DOMAINS[authority].toolWhitelist` 取交集——让破军能 bash、天府/天权只读，姿态连工具面一起约束。**建议做**：姿态不只在文字，也在 capability。
- **3 个 `buildWorkerPrompt` 调用方**都补传 `authoritySuffix`（V3 方向文档已定位）。

### 2.3 与 V2 的接点（关键）

V2 max planner 现在用 `profile:'reviewer'` + objective 文本携带姿态。A 落地后，team_orchestrator 派 planner 时直接带 `authority: 'tianquan'|'tianfu'|'tianxuan'`，executor 带 `'tianliang'`。**这就是把命门（戏服）换成真注入的那一刀**——V2 的 max 模式是 Component A 的第一个消费者。

### 2.4 A 是纯接线，无新算法

字段透传 + 一次 `STAR_DOMAINS[id].systemPromptSuffix` 查表。难度低、风险低。真正的设计在 B。

---

## 3. Component B — 星域知识库 + 经验沉淀

### 3.1 目标

每个星域**积累自己的、关于本代码库的经验**，并随使用**从新手长成专家**。天权域用久了 → 知道"这个库的缺陷常长在输入边界"；破军域 → 攒出一套畸形输入语料；天府域 → 攒出本库的不变量清单。worker 派发时 recall 本域经验，执行后把高信号产出沉淀回去。

### 3.2 存储模型：`DomainKnowledgeStore`（新建，复用三范式）

**不**强塞进 stigmergy（它是 file-path×signal 模型，域经验不绑文件）。新建专用 store，但**复用** stigmergy 的衰减、project-memory-writer 的写入不变量、dream 的蒸馏门。

命名空间分离（canonical 写入不变量）：每域一个文件
```
.rivet/knowledge/domains/<domainId>.jsonl
```

条目结构：
```ts
type DomainLessonKind =
  | 'defect_pattern'    // 天权/天府：本库缺陷模式
  | 'invariant'         // 天府：必须守的不变量
  | 'adversarial_input' // 破军/马超：能击穿的畸形输入
  | 'selection_rule'    // 天权：判断/取舍规则
  | 'reframe'           // 天璇/天机：盲区/重构视角

interface DomainLesson {
  id: string                 // hash(domainId + canonical(text)) — 去重键
  domainId: StarDomainId
  kind: DomainLessonKind
  text: string               // 一条可复用判断
  evidence: string           // file:line / 命令 / 反例
  strength: number           // 0-1，再次被独立推出时刷新，随时间指数衰减
  reinforcement: number      // 被独立复现次数 → 新手/专家分级的依据
  grade: 'novice' | 'journeyman' | 'expert'
  depositedAt: number
  halfLifeMs: number         // 复用 stigmergy 默认 7d；专家条目可给更长半衰期
}
```

接口（镜像 StigmergyStore + project-memory-writer 的安全写）：
```ts
class DomainKnowledgeStore {
  deposit(lesson: DepositInput): void   // 锁 + 原子 + 单调；命中去重键则 reinforce
  recall(domainId, opts?): DomainLesson[]  // 按 grade×衰减强度排序，取 top-K
  compact(domainId): void               // dedup + cap(每域 ≤100) + prune 衰减<阈值
}
```

### 3.3 经验沉淀（写侧）= dream 蒸馏门按域复刻

**绝不**把 worker 原始输出整坨写进去（那是噪声，会让域趋同 → 坍塌回单脑，命门）。沿用 dream 的高门槛纪律：

沉淀流程（worker 完成后触发）：
1. 输入：完成的域 worker 的 `WorkerResult`（findings/risks/patchSummary/verification）+ 它的 `authority`。
2. **抽取候选**：只取 `confidence==='high'` 且**有 evidence** 的 finding；materialized 的 risk；verification 的反例（counterexample）。
3. **按域映射 kind**：tianquan→`defect_pattern`/`selection_rule`；tianfu→`invariant`；pojun→`adversarial_input`；tianxuan/tianji→`reframe`。**这层映射是反趋同的关键**——一条天权 lesson 必须是"判断/质疑"形态，不是泛泛笔记。
4. **去重 / 强化（分级）**：
   - 命中已有 `id`（同域同 canonical text）→ `reinforcement++` + `strength` 刷新 → 可能升级 grade。**这就是新手→专家**：同一教训被多会话独立复现 = 它是真的，提级、recall 排前。
   - 新 → 以 `novice`（低 strength）落库。
5. **写**：锁 + 原子 + 单调追加（project-memory-writer 范式）。门不过则不写。

分级规则（可调）：`reinforcement 1=novice，2–3=journeyman，≥4=expert`；recall 权重 = `grade 权重 × computeCurrentStrength(衰减)`。衰减让陈旧教训自然降级/prune。

### 3.4 recall（读侧）= worker-knowledge 按域复刻

派发域 worker 时，`buildDomainKnowledgeBlock(domainId, store)`：load 本域 → 算衰减强度 → 按 grade×strength 排序 → top-K(建议 8) → 渲染
```
<domain-knowledge domain="tianquan" grade-span="expert..novice">
  <lesson grade="expert" kind="defect_pattern">本库解析层缺陷常长在 markdown 输入边界（反引号多路径被吞）。evidence: team-plan.ts:extractFiles</lesson>
  ...
</domain-knowledge>
```
追加进 worker prompt——与 §2 的 `systemPromptSuffix`（姿态）、既有 `<worker-knowledge>`（主会话 claim）并列。K 上限护住 prompt 体积。

### 3.5 经验沉淀的缓存安全机制（领航星硬约束：缓存先不能被打碎）

**优先级声明**：主会话 prefix 缓存完整性 **>** 经验新鲜度。二者一旦冲突，缓存赢——经验留在 worker 侧，不上主控。

worker 任务返回时沉淀，必须满足三条，确保**主会话（v4-pro 高命中）prefix 一字节不动**：

1. **沉淀 = 带外文件写，不碰消息流**。`precipitate` 只写 `.rivet/knowledge/domains/<id>.jsonl`，**绝不**写主会话的 system / volatile / 动态 appendix / message。主控 prefix = `[system][tools][冻结早期消息][…已缓存 tool_result]`，沉淀对它的增量恒为 0。
2. **结果只走正常 tool_result 尾部**。`team_orchestrate` 的 ToolResult 关于沉淀只报**一行极简摘要**（如 `✓ precipitated 2 lessons → tianquan`）。这是 prefix 之后的自然尾部追加（本回合未缓存、下回合自然进缓存）——是基线行为，**不是打碎**。**严禁**把新学到的域知识回灌主控 system/volatile/appendix（那会从该点滑动失效，正是 cache-killer 登记表 [[prefix-cache-invariant-registry-ref]] 的红线）。
3. **写不阻塞返回**（照搬 `StigmergyStore`）：deposit 进内存域缓存 + 200ms 防抖异步落盘 + 进程退出 `flushSync` 兜底。任务返回零等待磁盘。

**recall 同理**：域知识只渲进 **worker** prompt（独立、廉价 cache），每次派发新建、worker 生命周期内不变 → 主控 cache 不受影响。主控只通过 worker 的正常 tool_result（in-context 阅读，非 prefix 变更）间接受益。

> 一句话：经验系统对主控**只读不写**——喂养 worker，不改写主控提示词。主控高缓存因此永不被沉淀打碎。

---

## 4. 共享前置：StarDomain 注册表 + 专家经验卡（为开源规模设计）

两组件的地基，且**必须为开源后的庞大规模设计**——未来不止马超关羽，开源后用户会定制大量个性化"专家经验卡"，注册表与知识库都要扛得住。

### 4.1 注册表（registry）

`StarDomainId` 硬编码 6-union → 无法扩展。照搬 `profile-registry.ts` 建 `StarDomainRegistry`：
- 内置 6 域 + 从 `.rivet/domains/` 加载用户域。
- 收编平行列表（`STAR_DOMAINS` Record、`glance-bus.ALL_DOMAINS`、`domain-voice`）改读注册表，消除"6 个里只覆盖 4 个"的漂移。
- **按需解析（lazy）**：开源后可能数百张卡，启动不全载——派发时按 id 解析定义、recall 时按 id 加载**该域单文件** knowledge。规模天然可扩：每域一文件、用到才读，O(1) 加载，不随卡总数膨胀。

### 4.2 专家经验卡（Expert Experience Card）= 可分享的"域 + 经验"包

一张卡 = **域定义（姿态）+ 该域已沉淀的精选经验（记忆）**，自包含、可分享：
```
.rivet/domains/<id>/
  card.md          # frontmatter: id/name/keywords/toolWhitelist/decisionStyle；body = systemPromptSuffix（姿态）
  knowledge.jsonl  # 预置 DomainLesson[]（可选；预训练好的专家经验）
```

- **冷启动不冷**：装一张带 `knowledge.jsonl` 的卡 → recall 从第一次派发就有专家经验，不必从零攒。
- **导入/导出**（复用 `claim-export.ts` 范式）：导出 = 打包某域定义 + top-grade lessons → 一张卡；导入 = 放进 `.rivet/domains/`，lessons 以**折扣强度**入库（×0.8，照搬 `importClaims`），本地复现后才升回 expert——"外来专家先当熟手，本地实战挣回专家位"。这防止外来卡直接霸占 recall top-K。
- **开源契合**：专家卡 = 社区可分享资产。有人发布"马超·网络层渗透专家卡"，他人一键装上即得专家。直接服务开模 agent 能力抬升的项目目标 [[project_open_model_agent_goal]] [[project_open-source-layering-r1]]。

### 4.3 严格前置

A/B 落地前先注册表化 + 定卡格式（card.md + knowledge.jsonl），否则马超注入无处挂、专家卡无处装、B 的 per-domain 文件无命名规范。

---

## 5. 闭环（两组件如何"关联"）

```
team_orchestrate 派一个域 worker（authority=d）         [V2 派发链]
        │
        ├─(A) buildWorkerPrompt(order, suffix=STAR_DOMAINS[d].systemPromptSuffix)   ← 灌姿态
        ├─(B 读) + buildDomainKnowledgeBlock(d, store)                              ← 灌本域累积经验
        ▼
   worker 执行（既是对的姿态，又带本库历史教训）
        ▼
   WorkerResult
        ▼
   (B 写) precipitate(d, result, store)  ← 高信号产出蒸馏回 d 域，命中则 reinforce（分级）
        ▼
   下一次派 d 域 worker → recall 更厚 → 域更专家
```

- **冷启动优雅降级**：空域 store → recall 为空 → 退化为纯姿态注入（A）。域随 team run 次数成熟。
- **接点**：recall 挂 `coordinator.delegateOrder` 派 worker 之前；precipitate 挂其返回之后。team_orchestrator 在 §2.3 给每个 task 标 authority，闭环即自动生效。

---

## 6. 约束与风险（必须守）

| # | 约束 | 依据 |
|---|------|------|
| 1 | **缓存先不能被打碎**（领航星硬约束）：沉淀=带外文件写不碰主控消息流；recall 只进 worker prompt；严禁回灌主控 system/volatile/appendix | **详见 §3.5**。主控 prefix 一字节不动；缓存优先级 > 经验新鲜度 |
| 2 | **写入守 canonical 不变量**：每域独立文件（命名空间分离）+ 锁 + 原子 + 单调追加 + compact 去重/cap | `project-memory-writer.ts` 范式；891cc1b6 事故记忆 [[project_canonical-memory-write-invariants]] |
| 3 | **反趋同（命门）**：沉淀门必须高（只收 high-confidence+evidence+域特征形态的教训）；kind 按域映射强制差异 | 若写噪声 → 各域知识趋同 → 多视角坍塌回单脑，V3 的意义归零。[[tianshu-star-domain-thesis]] |
| 4 | **跨会话/跨域不污染**：worker 只 recall 本域命名空间；衰减老化跨会话噪声 | V3 方向文档已述 |
| 5 | **不依赖 Claude**：注入/沉淀全是本地文件 + worker（flash 即可），与模型品牌无关 | team 模式背景约束 |

---

## 7. 落地切分（交执行者，非本文实现）

> 顺序：前置 → A（接线，快） → B（store→沉淀→recall） → 接 V2 闭环。每步 TDD + 独立可验。

1. **P0 前置**：`StarDomainRegistry`（镜像 profile-registry）+ 收编平行列表。
2. **A**：`DelegationRequest.authority` / `WorkOrder.authority` 字段 + 3 处 `buildWorkerPrompt` 传 suffix + toolWhitelist 交集 + team_orchestrator 给 planner/executor 标 authority。
3. **B-store**：`DomainKnowledgeStore`（复用 computeCurrentStrength + 锁/原子写）。
4. **B-写**：`precipitateDomainLessons(result, authority, store)`（dream 门按域）。
5. **B-读**：`buildDomainKnowledgeBlock(domainId, store)` 接进 worker prompt。
6. **闭环**：recall/precipitate 挂 `coordinator.delegateOrder` 前后。

---

## 8. 决策状态（领航星 2026-06-07 评审后）

| # | 决策 | 状态 |
|---|------|------|
| 1 | **B 自建 `DomainKnowledgeStore`**（复用三范式），不扩 stigmergy domainId | ✅ **领航星已确认** |
| 2 | **沉淀 per-worker**（worker 返回后触发），且经 §3.5 带外写 + 异步落盘，**主控缓存零扰动** | ✅ **领航星已确认（缓存先不能被打碎）** |
| 3 | **注册表必须有**，且为开源规模设计（专家经验卡、按需加载、导入折扣）见 §4 | ✅ **领航星已确认** |
| 4 | 分级阈值 novice/journeyman/expert = 复现 1 / 2–3 / ≥4 | 🔸 先兜底，telemetry 后调（你已授权"后面按我设计"） |
| 5 | A 的 toolWhitelist 取交集（姿态约束工具面） | 🔸 建议做（你已授权"后面按我设计"） |

---

## 9. 关联记忆 / 文档

- [[tianshu-star-domain-thesis]] — 同模型不同星域真做不同事；命门=别退化成戏服（本设计 §6.3 直接对应）
- [[project_canonical-memory-write-invariants]] — 写入三不变量（§6.2）
- `2026-06-07-team-mode-v3-worker-stardomain.md` — 方向（剥洋葱：真缺口=认知层两根线）
- `2026-06-07-team-mode-v2-landing.md` — 本设计的前置（V2 派发链）
