# Code Review: agent-panic-guard (P1/P2/P3)

**Reviewed**: 2026-05-30
**Commits**: de27325 (P1), 5b8b8ea (P2), 2c2364c (P3)
**Plan**: docs/superpowers/plans/2026-05-30-agent-panic-guard.md
**Decision**: REQUEST CHANGES

## Summary
P2(safety ref)和 P3(timeout 守门)正确、完整、可合并。**P1(protection mode)的核心机制是死代码**——它依赖的执行路径在 doom-loop blocked 态下被一个早于它的无条件 early-return 抢先拦截,导致 protectionMode 永不可达,且测试只覆盖纯函数、未覆盖 pipeline 集成,缺陷被漏过。

## Findings

### CRITICAL
None.

### HIGH

**H1 — P1 的 protectionMode 是不可达死代码** (`tool-pipeline.ts:455`)
`doomLevel === 'blocked'` 在 `tool-pipeline.ts:421-433` 已**无条件 early-return**(拦截工具、返回 error,不分工具类型),该 early-return 早在 `12c51d1` 就存在(P1 之前)。P1 新增的 protectionMode 检查在行 455、`assessToolRisk` 的破坏性 git 升 high 在 `approval-risk.ts:110-115`,都位于该 return 之后 → blocked 态执行流永远到不了。
- 实际后果有两面:
  1. P1 的 protectionMode / "破坏性 git 升 high" 逻辑**从不执行**。
  2. blocked 态下 `git stash` 实际被行 432 **完全拦截**(返回 error,根本不执行 stash)——比 P1 意图的"强制审批"更强。所以**用户诉求其实已被既有 early-return 满足**,但不是通过 P1 声称的机制。
- P1 唯一真实生效的改动:`assessToolRisk` 在 blocked 态对非破坏性工具的 level 从 `high` 降为 `medium`。但该返回值在 blocked 态下不被审批门禁消费(行 421 已 return),仅记入 `latestRisk`(行 441)用于遥测 → 影响面仅遥测记录的 risk 等级。
- **建议**:三选一 — (a) 若既有 early-return 已满足诉求,删除 P1 的 pipeline/risk 改动,避免死代码与误导;(b) 若要让破坏性 git 走"审批"而非"硬拦截"(给用户确认而非直接 error),需在行 421 的 blocked 分支内**前置** isDestructiveGitAction 判断,让破坏性 git 改走审批门禁而非 early-return;(c) 明确记录 early-return 才是真实拦截层,P1 仅作纵深防御。需你定语义。

**H2 — P1 缺少 pipeline 层集成测试** (`approval-risk.test.ts`)
新增测试仅覆盖 `isDestructiveGitAction` 和 `assessToolRisk` 两个纯函数。没有任何测试执行 `executeToolUse` 在 `getDoomLoopLevel()==='blocked'` 时对 `git stash` 的实际处置 → H1 的死代码缺陷正是因此被漏过。计划 task 1.4 声称"protection mode 强制 shouldAsk=true",但无测试验证该行为在管线中真实发生。
- **建议**:补一个集成测试,断言 blocked + git stash 在管线中的实际结果(当前是 early-return error;若按 H1(b) 修则应是 onApprovalRequired 被调用)。

### MEDIUM

**M1 — `assessToolRisk` 死返回值与 doom-loop 语义重复**
P1 在 `approval-risk.ts` 区分破坏性/非破坏性的 doom-loop 风险评级,但因 H1 这套区分在生产路径不被消费。属于"为不可达状态写逻辑"。随 H1 一并决策。

### LOW

**L1 — `getDoomLoopLevel()` 重复调用** (`tool-pipeline.ts:418,440,455`)
同一执行路径调用三次。建议复用行 418 的 `doomLevel` 局部变量(行 440/455 直接用 `doomLevel`),减少调用、保证一致性。

**L2 — P1 bash 正则可被空白绕过** (`approval-risk.ts:80`)
`/\bgit\s+(?:stash\b|...)/` 要求 git 与子命令间有空白。`git  stash`(多空格)OK;但形如 `git-stash` 别名或 `g stash`(alias)不被捕获。doom-loop 防护场景下可接受(bash 路径另有 BASH_WRITE_PATTERNS 兜底),仅记录。

## Validation Results

| Check | Result |
|---|---|
| Type check (`tsc --noEmit`) | Pass |
| Tests — approval-risk (73) | Pass |
| Tests — git (16) | Pass |
| Tests — execution-trust-closure (4) | Pass |
| Lint | Skipped (无独立 lint 脚本) |
| Build | Skipped (typecheck 已覆盖) |

## Files Reviewed
- `src/agent/approval-risk.ts` — Modified (P1)
- `src/agent/tool-pipeline.ts` — Modified (P1+P3)
- `src/agent/__tests__/approval-risk.test.ts` — Modified (P1)
- `src/tools/git.ts` — Modified (P2)
- `src/tools/__tests__/git.test.ts` — Modified (P2)
- `docs/superpowers/plans/2026-05-30-agent-panic-guard.md` — Added

## P2 / P3 评估(通过)
- **P2** `git.ts:50-57` `createSafetyRef`:`git stash create` + `update-ref`,best-effort try/catch 不阻塞主路径,空工作区有 `!create.stdout.trim()` 守卫,两处 stash(scoped/全量)都插入,有测试验证 ref 存在。正确完整。
- **P3** `tool-pipeline.ts:62-65` isFinite + `>0` 守卫:精确覆盖 NaN/Infinity/负/0/undefined,落到 DEFAULT。正确。唯一小遗憾:无单测(计划 task 3 未要求测试),但逻辑平凡、风险低。
