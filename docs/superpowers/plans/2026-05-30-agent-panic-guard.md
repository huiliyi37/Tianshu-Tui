# Agent 故障态恐慌防护 实现计划

> **面向 AI 代理：** 使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。

**目标：** doom-loop 触发时阻止 agent 恐慌性破坏工作区（git stash 等），正常态零干扰。

**架构：** 两层机械防御——故障态门禁（doom-loop 触发后 stash 需审批）+ 可逆兜底（stash 前自动写 safety ref）。复用已有 doom-loop / reliability-mode 基础设施，不新增阈值。

**技术栈：** TypeScript strict、node:test + assert/strict。

---

## Scope Check

本计划只做三个独立改动，不改动现有 reliability-mode 行为：

| Phase | 改动 | 影响面 |
|-------|------|--------|
| P1 故障态门禁 | `assessToolRisk` 对 doom-loop 更精准（只对破坏性 git 升 high）+ `tool-pipeline` 加保护模式强制审批 | `approval-risk.ts`、`tool-pipeline.ts` |
| P2 可逆兜底 | `git.ts` stash 前写 `refs/kiro-safety/last-stash` | `git.ts` |
| P3 超时守门 | `withToolTimeout` 入口加 `Number.isFinite` | `tool-pipeline.ts` |

---

## 调研背书

### `assessToolRisk` doom-loop 行为（approval-risk.ts:96-103）

**当前：** doom-loop blocked → 所有工具 level='high'，包括 read_file。太激进。
**修改：** doom-loop blocked → 仅破坏性 git 动作升 'high'，其余保持原风险等级。doom-loop warn 行为不变。
**调用方：** `tool-pipeline.ts:436`（审批门禁）、`execution-trust-closure.test.ts`。修改行为须更新对应测试断言。

### git tool stash action（git.ts:163-177）

**当前：** `requiresApproval` 仅对 commit 返回 true。stash/stash_pop 在 auto-safe 下直接放行。
**入口：** stash 仅通过 git tool 的 `stash` action 执行（bash 路径已被 `BASH_WRITE_PATTERNS` 覆盖）。
**P2 插入点：** `runGit(['stash', ...])` 前先 `git stash create` + `git update-ref refs/kiro-safety/last-stash <sha>`。

### `withToolTimeout` 超时值来源（tool-pipeline.ts:529）

**当前：** `toolDef?.timeoutMs?.(params) ?? DEFAULT_TOOL_TIMEOUT_MS`。NaN/Infinity 会静默被 setTimeout 规整为 1ms。
**修改：** 在 `withToolTimeout` 入口加 `Number.isFinite(timeoutMs) && timeoutMs > 0` 守卫，不合法值直接用默认值。

---

## 任务

### 任务 P1：故障态门禁 — doom-loop 时 stash 强制审批

**文件：**
- 修改：`src/agent/approval-risk.ts`（`assessToolRisk` 的 doom-loop 段 + 新增 `isDestructiveGitAction`）
- 修改：`src/agent/tool-pipeline.ts`（审批门禁加保护模式检查）
- 修改：`src/agent/__tests__/approval-risk.test.ts`（更新 doom-loop blocked 断言）

**步骤：**

- [ ] **1.1** 在 `approval-risk.ts` 加 `isDestructiveGitAction(toolName, input)` 纯函数——检测 git tool 的 stash/stash_pop 和 bash 的 git stash/checkout/restore/reset/rm。
- [ ] **1.2** 改 `assessToolRisk`：doom-loop blocked 不再无条件设 level='high'，改为仅 `isDestructiveGitAction` 时升 'high'，其余保持原有风险判定。
- [ ] **1.3** 更新 `approval-risk.test.ts`：原来 `read_file + blocked → high` 的断言改为不升 high。
- [ ] **1.4** 在 `tool-pipeline.ts` 审批门禁加保护模式：`doomLevel === 'blocked' && isDestructiveGitAction` → 强制 `shouldAsk = true`。
- [ ] **1.5** 运行测试：`npx tsx --test src/agent/__tests__/approval-risk.test.ts && npx tsc --noEmit`。
- [ ] **1.6** Commit: `feat(agent): protection mode — force approval for destructive git during doom-loop (P1)`

### 任务 P2：可逆兜底 — stash 前写 safety ref

**文件：**
- 修改：`src/tools/git.ts`（stash action 执行前插 safety ref 写入）
- 修改：`src/tools/__tests__/git.test.ts`（验证 safety ref 存在）

**步骤：**

- [ ] **2.1** 在 `git.ts` stash action 的 `runGit(['stash', ...])` 前：先 `spawnSync('git', ['stash', 'create'])` 拿 commit sha，再 `runGit(['update-ref', 'refs/kiro-safety/last-stash', sha])`。失败不阻塞（非关键路径）。
- [ ] **2.2** git.test.ts 加用例：执行 stash 后 `git show-ref refs/kiro-safety/last-stash` 存在且指向有效 commit。
- [ ] **2.3** 运行测试并 commit: `feat(git): write safety ref before stash for reversible recovery (P2)`

### 任务 P3：超时守门 — `Number.isFinite` 防御

**文件：**
- 修改：`src/agent/tool-pipeline.ts`（`withToolTimeout` 函数入口）

**步骤：**

- [ ] **3.1** `withToolTimeout` 开头加：`if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) timeoutMs = DEFAULT_TOOL_TIMEOUT_MS`。
- [ ] **3.2** typecheck + 构建验证通过。
- [ ] **3.3** Commit: `fix(tools): guard against NaN/Infinity timeout in withToolTimeout (P3)`

---

## 验证

```bash
npx tsc --noEmit
npx tsx --test src/agent/__tests__/approval-risk.test.ts
npx tsx --test src/tools/__tests__/git.test.ts
```

---

## 自检

- P1 覆盖 doom-loop → 破坏性 git 审批门禁（spec 动1）
- P2 覆盖 stash 前 safety ref（spec 动2）
- P3 覆盖 timeout 入参守门（spec 配套）
- 无 TODO/待定/后续实现
- 不引入新阈值，复用已验证 doom-loop 信号

---

计划已保存到 `docs/superpowers/plans/2026-05-30-agent-panic-guard.md`。两种执行方式：
1. **子代理驱动（推荐）** — 每个任务调度一个新的子代理，任务间进行审查。
2. **内联执行** — 在当前会话中使用 executing-plans 逐任务执行。

选哪种方式？
