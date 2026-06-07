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

## Phase 6 — 天梁 profile 与 flash 路由（后置）

**目标**：把“天梁=精准执行/低成本模型”从 prompt 约定变成配置能力。

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

### Task 6.3 — flash 路由不要硬编码

当前默认 model card 不会把 patcher 自动路由到 flash。后续有两种实现：

1. 用户配置 `config.workers.routing`，把 patch/refactor 任务映射到 flash profile。
2. 新增 per-profile routing：`tianliang_executor -> flash`。

验收：

- 测试覆盖：没有 flash/无凭证时自动 fallback，不阻塞 `/team`。
- 不牺牲验证：flash 执行后仍由主控/ReviewRouter 验收。

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
