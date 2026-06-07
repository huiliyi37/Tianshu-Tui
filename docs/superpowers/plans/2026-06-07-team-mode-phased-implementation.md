# `/team` 模式阶段实施计划（核心骨架版）

> 日期：2026-06-07  
> 状态：实施计划 / Core Skeleton  
> 关联设计：`docs/superpowers/specs/2026-06-07-team-mode-design-discussion.md`  
> 主原则：先把 `/team` 的可用骨架打通；DAG 细节、分组算法、任务面板和长驻 runtime 由后续团队补齐。

---

## 0. 目标边界

### 本计划要交付什么

一个最小但真实可用的 `/team` 骨架：

1. 用户显式输入 `/team ...` 或 `/team max ...`。
2. 系统把输入转换为团队模式工作流提示，而不是误当未知 slash command 拦截。
3. 主控基于现有 `delegate_batch` / `patcher` / `reviewer` / `adversarial_verifier` 基础设施拆出有限任务。
4. write worker 先以“补丁/差异产物 + 主控集成”为落地模型，不强行承诺 worker 自动提交。
5. 验收阶段显式接入 Review Discipline / Review Squadron 思路。

### 本计划不强行完成什么

这些先留给后续团队增量补：

- Markdown 计划到完整 DAG 的严格依赖解析。
- 智能任务分组算法。
- 天梁专属 profile 的完整人格/prompt 体系。
- 强制 flash 路由的最终模型策略。
- 多 worker 自动合并/自动提交闭环。
- 实时 TaskBoard TUI 面板。
- 长驻 runtime pool / HTTP task ingress（这是 standing collaborator spec 的范围）。

---

## 1. 已核实的代码事实

| 事实 | 证据 | 对实施的影响 |
|------|------|-------------|
| 未识别 slash command 会返回 `null` 被拦截 | `src/tui/slash-commands.ts:172-179` | `/team` 首步必须接入 slash resolver，否则用户无法自然触发。 |
| 现有 `/plan` 已是 workflow prompt 入口 | `src/tui/__tests__/slash-commands.test.ts:73-116` | `/team` MVP 应复用 workflow prompt 模式，而不是一开始新增复杂 TUI。 |
| `delegate_batch` 请求 schema 只有 objective/kind/profile/files/symbols | `src/tools/delegate-batch.ts:25-35` | MVP 不把 DAG dependencies 塞进公开工具参数；依赖可先由主控串行/分批处理。 |
| `WorkOrder` 已有 `dependencies` 字段 | `src/agent/work-order.ts:183-185`、`src/agent/work-order.ts:221`、`src/agent/work-order.ts:259` | 后续可把依赖从 team parser 传到 WorkOrder，但不是 Phase 1 必需项。 |
| `WorkOrderQueue` 已做依赖检查和文件冲突检查 | `src/agent/work-queue.ts:49-51`、`src/agent/work-queue.ts:63-70` | 后续 DAG/冲突细化应复用队列，不要重写调度核心。 |
| write worker 使用 `hands` 路径 + worktree 隔离 | `src/agent/profile-registry.ts:127-132`、`src/agent/hands-session.ts:46-53` | MVP 可复用 `patcher` 作为“天梁执行者”的工程载体。 |
| `hands-session` 目前收集 diff artifact 后清理 worktree | `src/agent/hands-session.ts:91-128` | 不应在 MVP 文案里承诺 worker 已自动提交/合并。主控需要显式集成 diff。 |
| model card 默认把 flash 推荐给 summarization/compaction，不推荐 patch | `src/main.tsx:453-479`、`src/agent/work-order.ts:272-284` | “天梁=flash”不能靠当前默认自动成立；需要配置路由或后续 per-profile routing。 |
| ReviewRouter 现在主要在 fix commit 的 deliver_task gate 触发 | `src/agent/deliver-task.ts:403-423` | `/team` 的验收不能只依赖提交消息；需要显式 review workflow。 |
| reviewDepth 已跨 delegate 传播 | `src/agent/coordinator.ts:30-37`、`src/agent/coordinator.ts:258` | team 内部 review/patch 循环必须继续传递 reviewDepth，避免递归审查。 |

---

## 2. 架构切分

### 2.1 Phase Skeleton

```
/team 输入
  │
  ▼
Slash workflow resolver
  │  输出团队模式 brief prompt
  ▼
主控 v4-pro
  │  读计划 / 拆任务 / 决定是否分批
  ▼
现有 delegate_batch
  │
  ├─ patcher-as-天梁：执行单个明确任务，返回 diff artifact
  ├─ reviewer / adversarial_verifier：独立审查或验证
  └─ doc_scout / code_scout：补充调研
  │
  ▼
主控集成 diff + 运行验证 + deliver_task
```

### 2.2 最小数据模型

Phase 1 只需要一个内部轻量模型，不需要一次性落完整 DAG：

```ts
interface TeamTaskDraft {
  id: string              // T1 / Step 6a / 自生成稳定 id
  title: string
  objective: string
  files: string[]         // 可为空；为空时不并行写，只做主控/只读调研
  profile: 'patcher' | 'reviewer' | 'code_scout' | 'doc_scout' | 'adversarial_verifier'
  kind: 'patch_proposal' | 'review' | 'code_search' | 'doc_research' | 'verify'
  verification: string[]  // 人类可读验证要求
}
```

后续团队再扩展：

```ts
interface TeamTask extends TeamTaskDraft {
  dependsOn: string[]
  groupId?: string
  mergePolicy?: 'manual' | 'auto_cherry_pick' | 'smart_rebase'
  reviewTier?: 'L1' | 'L2' | 'L3'
}
```

---

## 3. 阶段任务

## Phase 1 — `/team` slash workflow 骨架

**目标**：用户输入 `/team ...` 不再被未知 slash command 拦截，并生成清晰的团队模式执行 brief。

### Task 1.1 — 添加 `/team` 和 `/team max` resolver

修改：

- `src/tui/slash-commands.ts`
- `src/tui/__tests__/slash-commands.test.ts`

要求：

1. `/team <task or plan path>` 返回 workflow prompt。
2. `/team max <task>` 返回 max 模式 workflow prompt。
3. `/team` 空输入由 `handleSlashCommand` 给 usage，不进入 agent。
4. prompt 明确：
   - 先读关联 plan/spec/code。
   - 标准模式优先从用户计划拆任务。
   - max 模式先做多视角规划再执行。
   - 默认最多 2-3 个并行执行 worker。
   - 不承诺 worker 自动提交；worker 返回 diff/patchSummary，由主控集成。

测试：

```bash
npm exec -- tsx --test src/tui/__tests__/slash-commands.test.ts
```

验收：

- `/team docs/superpowers/plans/foo.md` prompt 包含 `delegate_batch`、`patcher`、`review`、`verification evidence`。
- `/team max refactor loop` prompt 包含 planning workers 和执行 workers 的阶段说明。
- `/team` 空输入显示 usage。

### Task 1.2 — 帮助文本加入 `/team`

修改：

- `src/tui/slash-commands.ts`
- `src/tui/__tests__/slash-commands.test.ts`

要求：

- `/help` 列出：`/team <task|plan>`、`/team max <task>`。

验收：

- 现有 `/help` 测试更新并通过。

### Phase 1 不做

- 不新增 `teamOrchestrate` 工具。
- 不新增 TeamBoard。
- 不新增 DAG parser。
- 不改 coordinator 并发逻辑。

---

## Phase 2 — Team task draft parser（弱解析）

**目标**：把 Markdown 计划粗略拆成 `TeamTaskDraft[]`，但不强求依赖图正确。

### Task 2.1 — 新增 `src/agent/team-plan.ts`

新增纯函数：

```ts
export function parseTeamTaskDrafts(markdown: string): TeamTaskDraft[]
```

最小规则：

1. 识别标题：`Task N`、`Step 6a`、`### T1`。
2. 提取同一段落中的文件路径：`src/...`、`docs/...`。
3. 没有文件路径时 `files: []`。
4. 默认：
   - 含“审查/review/验收” → `profile: 'reviewer'`, `kind: 'review'`
   - 含“验证/test/tsc” → `profile: 'adversarial_verifier'`, `kind: 'verify'`
   - 其他实现任务 → `profile: 'patcher'`, `kind: 'patch_proposal'`

测试：

- `src/agent/__tests__/team-plan.test.ts`

验收：

- 能解析 `loop-split-v3.md` 风格的 Step 6a-6f 标题。
- 不解析依赖也算通过。
- 对空文档返回 `[]`，不抛异常。

### Task 2.2 — 安全降级策略

要求：

- `files.length === 0` 的 patcher 任务不得自动并行执行；必须回到主控要求补 scope。
- 同文件多 patcher 任务默认串行，不做行级并发。
- 文件冲突仍交给 `WorkOrderQueue.hasFileConflict`，不要另写冲突系统。

---

## Phase 3 — `teamOrchestrate` 核心编排函数（非工具）

**目标**：提供可测试的编排骨架；先不暴露为工具。

### Task 3.1 — 新增 `src/agent/team-orchestrator.ts`

核心接口：

```ts
export interface TeamOrchestratorDeps {
  delegateBatch: DelegateBatchCoordinator['delegateBatch']
}

export interface TeamRunInput {
  mode: 'standard' | 'max'
  objective: string
  planMarkdown?: string
  maxParallel?: number
}

export interface TeamRunSummary {
  mode: 'standard' | 'max'
  planned: TeamTaskDraft[]
  dispatched: number
  blocked: string[]
  packet: string
}

export async function runTeamSkeleton(
  input: TeamRunInput,
  deps: TeamOrchestratorDeps,
): Promise<TeamRunSummary>
```

MVP 行为：

1. standard 模式：若有 `planMarkdown`，调用 `parseTeamTaskDrafts()`。
2. max 模式：先返回一个 planning brief，暂不自动派 planner worker；后续再补多视角规划。
3. 只派发 `files.length > 0` 的任务。
4. 同文件 patcher 任务只取第一批，剩余放入 `blocked`，提示后续串行执行。
5. 调用 `delegateBatch`，policy 默认 `all_required` 或 `primary_decides` 由实现者按现有聚合策略选择；MVP 推荐 `all_required`，避免部分 worker 失败被掩盖。

测试：

- `src/agent/__tests__/team-orchestrator.test.ts`

验收：

- 能把 3 个 disjoint-file patcher 任务转成 3 个 DelegationRequest。
- 同文件任务只派一个，其余进入 blocked。
- max 模式不误派执行 worker。

### Phase 3 不做

- 不处理 `dependsOn`。
- 不自动 merge diff。
- 不自动 commit。
- 不接 TUI 面板。

---

## Phase 3.5 — 依赖划分、任务分组、视角合并（下一批天梁执行规格）

**目标**：在不碰自动 merge / TUI 面板的前提下，把 `/team` 从“能派 worker 的骨架”推进到“能形成可靠执行波次”的 planning core。

### 前置依赖

| 依赖 | 状态 | 说明 |
|------|------|------|
| Slash workflow + skeleton orchestrator | ✅ 已有 | `/team` 入口、弱 parser、`runTeamSkeleton` 已可作为基础。 |
| `TeamTaskDraft` 扩展为 `TeamTask` | 待做 | 增加 `dependsOn`、`riskTier`、`touchSet`、`groupId`、`routeHint`。 |
| 任务分组函数 | 待做 | 纯函数输入 `TeamTask[]`，输出 waves/groups；不直接调 worker。 |
| 视角计划 schema | 待做 | `/team max` 三视角 worker 必须输出同构结构，避免自由文本难合并。 |
| 视角合并函数 | 待做 | 天权主图 + 天府风险门 + 天璇反证/备选，生成 `unified_plan`。 |
| model route hint | 待做 | max 规划默认强模型；执行阶段才允许 cheap/flash。 |

### 任务分组规则（第一版）

先做确定性规则，不做复杂优化：

1. **硬依赖边**：显式 `dependsOn`、测试依赖实现、生成物依赖消费者。
2. **文件冲突边**：两个 patcher 修改同一文件 → 默认串行；只读 review/scout 不阻塞 patcher。
3. **风险边**：涉及 auth/security/concurrency/persistence/public API/config/schema 的任务标为 high risk，高风险 patcher 不与同模块 patcher 并行。
4. **波次生成**：拓扑排序成 `Wave[]`；每个 wave 内最多 2-3 个 patcher，review/scout 可额外并行。
5. **降级策略**：无法解析依赖时不要猜并行；放入 `blocked` 或单独 serial wave。

建议类型：

```ts
interface TeamTask extends TeamTaskDraft {
  dependsOn: string[]
  riskTier: 'low' | 'medium' | 'high'
  touchSet: string[]
  groupId?: string
  routeHint?: 'planner_strong' | 'review_strong' | 'executor_cheap' | 'executor_strong'
}

interface TeamWave {
  id: string
  tasks: TeamTask[]
  reason: string
  parallelLimit: number
}
```

### `/team max` 视角输出 schema

max 模式不是让三个 worker 自由发挥，而是让三种视角填同一张表：

```ts
interface TeamPerspectivePlan {
  perspective: 'tianquan' | 'tianfu' | 'tianxuan'
  summary: string
  tasks: TeamTask[]
  dependencyNotes: Array<{ from: string; to: string; reason: string }>
  risks: Array<{ taskId?: string; severity: 'low' | 'medium' | 'high'; claim: string; mitigation: string }>
  verification: Array<{ taskId?: string; command: string; expected: string }>
  blockers: string[]
  alternatives: Array<{ title: string; tradeoff: string; recommendation: 'accept' | 'defer' | 'reject' }>
}
```

### 视角合并规则

不要只把三个 worker 文本拼接，也不要直接 `primary_decides` 吞掉少数意见。合并分三层：

1. **天权为主图**：任务拆解、依赖方向、执行顺序以天权输出为主。
2. **天府加门禁**：风险、验证命令、回归测试、review tier 由天府覆盖或提升；天府提出 high risk 时不得静默降级。
3. **天璇做反证/备选**：天璇发现的盲区进入 `alternatives` 或 `blockers`；只有满足“可验证、低破坏、收益明确”才并入主图。

合并输出必须包含：

- `accepted`: 被并入统一计划的建议。
- `rejected`: 明确拒绝的建议和理由。
- `deferred`: 有价值但不进入本轮执行的建议。
- `conflicts`: 三视角之间的冲突点，需要主控裁决。

推荐合并算法：

1. normalize task id/files/title。
2. 以天权 tasks 建初始 graph。
3. 把天府风险映射到 task；提升 `riskTier` 和 verification。
4. 把天璇 alternatives 逐项分类为 accepted/deferred/rejected。
5. 对同文件 patcher 加串行边。
6. 输出 `TeamWave[]`，再交给执行阶段。

### max 规划模型策略

`/team max` 的规划 worker **不用 flash**。理由：规划阶段决定任务边界和风险门，错误会被执行阶段放大；便宜模型适合执行清晰 spec，不适合生成 spec。

推荐 route hint：

| 阶段 | 星域/角色 | routeHint | 默认模型策略 |
|------|-----------|-----------|--------------|
| max 规划 | 天权 planner | `planner_strong` | primary / 强推理 OpenAI-compatible 模型 |
| max 风险 | 天府 risk reviewer | `review_strong` | 稳定强模型 / reviewer 模型 |
| max 反证 | 天璇 adversarial planner | `planner_strong` | 强推理或创意模型，不用 flash |
| 执行 | 天梁 patcher | `executor_cheap` 或 `executor_strong` | 低风险可 cheap/flash，高风险用 strong |
| 验收 | 天府/Review Squadron | `review_strong` | 强模型 + evidence mandate |

当前项目已支持多模型 OpenAI-compatible provider，因此第一版不要硬编码模型名；只传 `routeHint`，由 config 映射到 provider/model。缺失配置时 fallback 到 primary，**不要 fallback 到 flash for max planning**。

### 给天梁的可执行任务包

| Task | 文件 | 内容 | 验证 |
|------|------|------|------|
| 3.5a | `src/agent/team-plan.ts` | 扩展 `TeamTaskDraft` → `TeamTask` 类型，新增 risk/touch/route 字段，保持兼容 | `team-plan.test.ts` |
| 3.5b | `src/agent/team-grouping.ts` | 新增纯函数 `groupTeamTasks(tasks, options): TeamWave[]`，实现同文件串行 + maxParallel | 新建 `team-grouping.test.ts` |
| 3.5c | `src/agent/team-perspectives.ts` | 定义 `TeamPerspectivePlan`，新增 schema/normalizer | 新建 `team-perspectives.test.ts` |
| 3.5d | `src/agent/team-merge.ts` | 实现天权主图 + 天府风险 + 天璇 alternatives 的 deterministic merge | 新建 `team-merge.test.ts` |
| 3.5e | `src/agent/team-orchestrator.ts` | `runTeamSkeleton` 改为先 group waves；max 模式只派 planning workers，不派 patcher | `team-orchestrator.test.ts` |

---

## Phase 4 — 执行集成：从 slash prompt 过渡到内部编排

**目标**：当 Phase 2/3 稳定后，让 `/team` prompt 明确调用 `runTeamSkeleton` 对应的 agent 流程；如需工具化，再新增 `team_orchestrate` tool。

### Task 4.1 — 决策点：工具还是纯 agent workflow

推荐顺序：

1. 先保持 slash workflow prompt（Phase 1）。
2. 如果手动执行稳定，再新增 `team_orchestrate` tool。
3. 工具化时必须注册到 `src/main.tsx`，并按新工具规则补测试。

工具 schema 草案：

```ts
{
  mode: 'standard' | 'max',
  objective: string,
  planPath?: string,
  maxParallel?: number
}
```

### Task 4.2 — 若新增工具，必须满足

- `planPath` 走 path validation。
- 只读取项目内 Markdown。
- 输出 `ToolResult`，content 包含 planned/dispatched/blocked。
- 不直接写文件。
- 不直接 commit。

测试：

- `src/__tests__/team-orchestrate-tool.test.ts` 或镜像源文件位置。

---

## Phase 5 — 验收与 Review Squadron 显式接入

**目标**：`/team` 的最终交付不能只靠“worker 说完成”。

### Task 5.1 — 标准验收流程

每个 `/team` run 结束后，主控必须执行：

1. `diff` 审查所有变更。
2. 跑覆盖变更文件的 targeted tests。
3. 跑 `npx tsc --noEmit`。
4. 若变更 ≥4 文件 / 跨模块 / 架构改动，显式走 L3 Squadron。
5. 若是 fix 类修复，保留现有 ReviewRouter deliver_task gate。
6. deliver_task 提交前必须有命令 + 观察输出证据。

### Task 5.2 — 不依赖 fix commit gate 的 team review

问题：现有 ReviewRouter 主要由 `fix` commit message 触发。

补法：

- `/team` 主控流程在 deliver 前主动调用 review workflow。
- 或新增 `reviewDepth=0` 的显式 `review_squad`/`team_review` 阶段。
- 不把“非 fix commit”默认当免审。

验收：

- feature/refactor 类 `/team` 任务也能触发 L2/L3 审查。
- `reviewDepth` 在子 worker 中保持 >0，避免递归。

---

## Phase 6 — 天梁 profile 与多模型路由（后置）

**目标**：把“天梁=精准执行”和“规划/审查使用强模型”从 prompt 约定变成配置能力。执行 worker 可按任务风险选择 flash/cheap model；`/team max` 的规划 worker 默认不用 flash。

### Task 6.1 — 先用 patcher，不急着新 profile

MVP 执行 worker 直接用：

```ts
profile: 'patcher'
kind: 'patch_proposal'
```

objective 前缀写清：

```text
你是天梁执行者。只执行本 task，不扩展范围，不重写计划。
```

原因：

- `patcher` 已是 `hands`，有 read/write/test 工具。
- `patcher` 已走 worktree 隔离。
- 新 profile 不是骨架必需。

### Task 6.2 — 后续再加 `tianliang_executor`

新增 profile 时再做：

- `src/agent/profile-registry.ts`
- `src/agent/__tests__/profile-registry.test.ts`
- 可选 `.rivet/agents/tianliang_executor.md`

要求：

- role: `hands`
- allowedTools: 同 patcher
- prompt 强约束“不规划、不扩展、不自我审查”

### Task 6.3 — 多模型路由策略

当前默认 model card 不会把 patcher 自动路由到 flash。后续路线：

1. 用户配置 `config.workers.routing`，把低风险 patch/refactor 任务映射到便宜模型。
2. 新增 per-profile routing：`tianliang_executor -> flash/cheap executor`。
3. `/team max` 的规划 worker 明确不用 flash：天权/天府/天璇规划阶段应使用主模型或配置中的强推理 OpenAI-compatible 模型。
4. 视角规划可走多模型 OpenAI-compatible provider：例如天权=primary reasoning，天府=stability/review model，天璇=creative/adversarial model。不要把三视角规划降成同一个 flash worker。

验收：

- 测试覆盖：没有指定模型/无凭证时自动 fallback，不阻塞 `/team`。
- 不牺牲验证：便宜模型执行后仍由主控/ReviewRouter 验收。
- max 规划请求能携带 `profile/modelRoute` 或等价 routing hint；默认不选择 flash。

---

## Phase 7 — 合并与提交闭环（后置高风险）

**目标**：把 worker diff 从 artifact 变成可安全合入主工作区的变更。

### 现状约束

`hands-session` 当前生命周期是：create worktree → run agent → collect diff → cleanup worktree。它没有在 coordinator 内自动 cherry-pick 到主工作区。

### Task 7.1 — 先手动集成 diff

MVP：

- worker 返回 diff artifact。
- 主控读 diff。
- 主控用正常 edit/hash_edit/write_file 集成。
- 主控运行验证。
- 主控 deliver_task commit。

### Task 7.2 — 后续接 MergeProtocol

后续团队可接：

- `src/agent/merge-protocol.ts`
- `src/agent/merge-queue.ts`
- `src/agent/worktree-coordinator.ts`

要求：

1. 先确保 worker branch/worktree 在 merge 完成前不被删除。
2. 失败时保留 patch 文件和冲突报告。
3. 不允许静默丢弃 worker diff。
4. 自动合并只处理 green/yellow；orange/red 升级给主控。

---

## 4. 推荐提交拆分

| Commit | 范围 | 文件 |
|--------|------|------|
| 1 | `/team` slash workflow 骨架 | `src/tui/slash-commands.ts`, `src/tui/__tests__/slash-commands.test.ts` |
| 2 | team plan draft parser | `src/agent/team-plan.ts`, `src/agent/__tests__/team-plan.test.ts` |
| 3 | team orchestrator skeleton | `src/agent/team-orchestrator.ts`, `src/agent/__tests__/team-orchestrator.test.ts` |
| 4 | review workflow 显式接入 | `src/agent/review-router.ts` 或新 `team-review.ts` + tests |
| 5 | 可选 team_orchestrate tool | `src/tools/team-orchestrate.ts`, `src/main.tsx`, tests |
| 6 | 可选 天梁 profile/路由 | `src/agent/profile-registry.ts`, config/tests |
| 7 | 可选 merge protocol 接线 | `src/agent/*merge*`, `hands-session/coordinator` tests |

每个 commit 完成后至少运行：

```bash
npx tsc --noEmit
npm exec -- tsx --test <对应测试文件>
```

文档-only commit 可跳过 TypeScript/test，但提交说明必须注明 docs-only。

---

## 5. 骨架版成功标准

第一版 `/team` 不以“能自动完成大型重构”为成功标准，而以以下标准为成功：

1. `/team` 和 `/team max` 有稳定入口。
2. 主控能生成明确的团队执行 brief。
3. 可用现有 delegate infra 派出有限 worker。
4. 不把依赖、合并、提交这些高风险步骤伪装成已解决。
5. 每个 worker 的结果都有 evidenceStatus / diff / verification 记录。
6. 主控最终验收必须有实际命令与观察输出。

---

## 6. 给执行团队的开放补位点

团队可以并行补以下内容：

- A 线：Markdown parser 更强规则（dependencies、task group、verification block）。
- B 线：`teamOrchestrator` 与 `delegateBatch` 的 request mapping。
- C 线：Review Squadron 显式入口。
- D 线：天梁 profile + per-profile routing。
- E 线：TaskBoard TUI。
- F 线：MergeProtocol 接线。

这些线互不要求同日完成。核心骨架只要求 Phase 1-3 先闭环。

---

## 7. 最小执行顺序

推荐先排：

1. Phase 1：`/team` slash workflow。
2. Phase 2：弱 parser。
3. Phase 3：非工具 orchestrator skeleton。
4. 用一个小型 docs/code 任务手动跑通。
5. 再决定是否工具化、profile 化、面板化。

不要从 DAG、TaskBoard、自动 merge 开始；那会把风险堆在最难验证的地方。

---

## 8. 天权补充：P0 前置依赖与下一批实施切分

> 来源：天权 2026-06-07 规划评审
> 原则：先结构化计划，再分组执行，再视角合并，再自动化合并。不提前碰自动 merge / TUI 面板。

### 8.1 P0 四前置依赖

以下四件事必须先于 Phase 3.5 的完整实现，但可以与 Phase 1-3 并行启动。

#### P0-1：TeamPlan 结构化 schema

现在 `team-plan.ts` 只是弱解析 Markdown。下一步需要定义稳定中间格式：

```ts
interface UnifiedTeamPlan {
  mission: string
  mode: 'standard' | 'max'
  tasks: TeamTask[]
  groups: TeamGroup[]
  verification: VerificationGate[]
  risks: RiskItem[]
  decisions: PlanDecision[]
  nonGoals: string[]
}
```

核心：让 `/team` 不再依赖"自然语言计划看起来对"，而是把 planner 输出收敛成机器可检查结构。

#### P0-2：DelegationRequest dependency 透传

现状：`WorkOrder` 已有 `dependencies`，`WorkOrderQueue` 也会检查依赖；但 `DelegationRequest` / `delegate_batch` 入口没有透传 dependencies。

补法：

```ts
interface DelegationRequest {
  // ...existing fields...
  dependencies?: string[]
  groupId?: string
}
```

并在 `coordinator.ts` 创建 `createReadOnlyWorkOrder`/`createWriteWorkOrder` 时传进去。

这一步是 DAG 的前置，但不要求马上做复杂 DAG。

#### P0-3：Profile / model 路由前置

`/team max` 规划阶段不用 flash。原则：

- `/team max` 规划阶段：强模型 / 主模型 / 用户配置的 OpenAI 多模型。
- `/team` 执行阶段：天梁 executor 可以 flash / 便宜模型。
- 审查阶段：不能 flash-only，至少 adversarial verifier 用强一点或可配置模型。

配置示例：

```yaml
workers:
  profileRouting:
    tianquan_planner:
      provider: openai
      model: gpt-4.1
    tianfu_risk:
      provider: deepseek
      model: deepseek-v4-pro
    tianxuan_scout:
      provider: openai
      model: o3
    tianliang_executor:
      provider: deepseek
      model: deepseek-chat-flash
```

优先级：`profileRouting > capability routing > current recommendModelForTask`。

不破坏现有多模型 OpenAI 支持。

#### P0-4：Team review gate

现在 ReviewRouter 主要挂在 `deliver_task` 的 fix commit gate 上。但 `/team` 不是只有 fix，很多是 feature/refactor。

team 模式需要显式验收阶段：

```
execute groups
  → collect diffs
  → targeted tests + tsc
  → team review route
  → deliver_task
```

不应该只靠 commit message 是否含 `fix:`。

### 8.2 分组策略补充

#### source + test 属于同一逻辑单元

不要把 `src/foo.ts` 和 `src/__tests__/foo.test.ts` 拆给两个 executor。这应该是一个 task。

#### 每组显式并行上限

```ts
const maxWriteWorkers = 2
const maxReadWorkers = 3
```

先稳，后续再放大。即使理论上能跑 5 个 write worker。

### 8.3 下一批实现切分（天权建议）

在 Phase 1-3 骨架完成后，按以下顺序推进：

#### Commit A：TeamPlan schema + parser 强化

文件：
- `src/agent/team-plan.ts`
- `src/agent/__tests__/team-plan.test.ts`

交付：
- `TeamTask`
- `TeamGroup`
- `UnifiedTeamPlan`
- weak markdown → structured plan
- dependencies 字段先支持但不要求完美解析

#### Commit B：DelegationRequest dependency 透传

文件：
- `src/agent/coordinator.ts`
- `src/agent/work-order.ts`
- `src/tools/delegate-batch.ts`
- tests

交付：
- request 可以带 `dependencies`
- WorkOrderQueue 真正能消费 team 依赖
- 不改变现有 delegate_batch 默认行为

#### Commit C：team grouping

文件：
- `src/agent/team-grouping.ts`
- `src/agent/__tests__/team-grouping.test.ts`

交付：
- 纯函数 `groupTeamTasks(tasks, options): TeamWave[]`
- 同文件 write task 默认串行
- source + test 绑定同一 task
- maxWriteWorkers / maxReadWorkers 常量
- 行级并发以后再做

#### Commit D：max planner fanout（视角系统）

文件：
- `src/agent/team-perspectives.ts`
- `src/agent/team-merge.ts`
- `src/agent/__tests__/team-perspectives.test.ts`
- `src/agent/__tests__/team-merge.test.ts`

交付：
- `TeamPerspectivePlan` schema
- 天权主图 + 天府风险门禁 + 天璇反证/备选的 deterministic merge
- 合并不是平均，是裁决

#### Commit E：team orchestrator 升级

文件：
- `src/agent/team-orchestrator.ts`
- `src/agent/__tests__/team-orchestrator.test.ts`

交付：
- `runTeamSkeleton` 改为先 group waves
- max 模式只派 planning workers，不派 patcher
- 非 max 模式直接走 standard execute path

### 8.4 关键约束（天权强调，不妥协）

- 同文件 write task 默认串行。行级并发以后再做。
- worker 不直接提交。先返回 diff/patchSummary，主控集成和 deliver_task。
- `/team` 的验收独立于 `fix:` commit gate。feature/refactor 也必须有 review path。

### 8.5 天权建议的下一步

最值得做的是：

> TeamPlan schema + grouping + max planner fanout

不要先做自动 merge，也不要先做 TUI 面板。那两个会把复杂度提前引爆。
