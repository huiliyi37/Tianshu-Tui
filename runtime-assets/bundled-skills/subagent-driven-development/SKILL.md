---
name: subagent-driven-development
description: "Use this when the work is large enough to delegate to subagents — multi-task implementation, refactors that touch several files, anything that benefits from running tasks in fresh contexts. Covers: when to split, how to write detail plans, how to brief subagents, how to verify their output. Invoke explicitly with /subagent-driven-development or load when planning multi-task implementation."
---
# Subagent-Driven Development

A practical workflow for delegating implementation to subagents while keeping the orchestrator (you) in charge of design, scope, and verification. Distilled from real successful runs.

**Core insight:** subagents work best when treated as smart colleagues with no prior context — give them everything they need, let them act on their own judgment within a clearly scoped task, then verify before moving on.

**Anti-pattern this skill prevents:** the orchestrator starts implementing in its own context, the context fills up with tool output and intermediate state, work gets sloppy, mistakes accumulate. Subagents reset context per task — use them.

---

## When to Use Subagents

Use subagents when **any** of these are true:

- **Multi-task work**: 3+ distinct tasks, each with their own test/impl/wire steps
- **Multi-file refactors**: changes that touch 4+ files in coordinated ways
- **Long-running implementation**: would fill orchestrator context past 50% before completion
- **Independent investigation**: need to read 10+ files to answer a question
- **Repeated TDD cycles**: 2+ test→impl→commit loops in a row

**Do NOT use subagents for:**
- Single small edits (just do it)
- Reading one specific file at a known path (use Read directly)
- Tasks that depend on conversation history the subagent won't have

### Scout vs Worker 决策

Subagents 分两种模式，按需升级：

| 场景 | 模式 | 工具集 | 文件权限 | profile |
|------|------|--------|----------|---------|
| 定位代码、grep、全局搜索、理解结构 | Scout（侦察） | read_file, glob, grep, diff, inspect_project, repo_map, related_tests | 只读 | `code_scout`, `doc_scout`, `planner` |
| 需要编辑文件、执行 patch、运行测试 | Worker（执行） | + edit_file, write_file, bash, run_tests | worktree 隔离读写 | `patcher`, `verifier` |

**升级流程：**
1. Scout 返回精确 patch 方案后，如果发现需要执行写操作 →
2. 用 `delegate_task(kind="patch_proposal", profile="patcher")` 升级为 worker
3. Worker 在 git worktree 中执行（隔离于主 session），完成后 diff 合并回主分支

**沙箱限制（根因分析）：**
Worker 的 `edit_file`/`write_file`/`bash` 可能在 host agent framework 的 subagent sandbox 中被拦截，返回 "requires user approval"。
这不是 Rivet work-order 权限问题 — `coordinator.ts` 已正确分类 `patcher`/`verifier` 为 `'hands'` 角色，通过 `runHandsSession` 创建隔离 worktree 并授权写工具。
沙箱拦截是 host 层安全策略。当前应对：worktree 隔离确保 worker 操作限制在独立分支，降低风险；若沙箱仍然拦截，需在 host 层配置豁免。

### 代理模式与写权限（快速参考）

调用 `delegate_task` / `delegate_batch` 时：

| kind | profile | 是否有写权限 | worktree 隔离 |
|------|---------|-------------|--------------|
| code_search | code_scout | ❌ 只读 | ❌ |
| doc_research | doc_scout | ❌ 只读 | ❌ |
| plan | planner | ❌ 只读 | ❌ |
| review | reviewer | ❌ 只读 | ❌ |
| verify | verifier | ✅ 读写 | ✅ worktree |
| patch_proposal | patcher | ✅ 读写 | ✅ worktree |



---

## The Six-Stage Workflow

```
1. INVESTIGATE → 2. SCOPE → 3. PLAN → 4. BRIEF → 5. VERIFY → 6. INTEGRATE
   (orchestrator)  (orch.)    (orch.)   (orch.→sub) (orch.)    (orch.)
```

### Stage 1: Investigate (orchestrator)

**Before writing any plan**, check the actual current state. Detail plans written from memory or stale overview docs cause wasted work.

Required investigation:
- `git log --oneline -10` to see recent commits relevant to the area
- `grep -rn "key_symbol" src/` to find production callers vs orphans
- Read the file you'll modify, **specifically the line range you'll touch**
- Read tests that exercise the area
- Check if "TODO" assumptions in old docs still apply

**Red flag:** if you can't answer "what does the current code do?" without speculation, investigate more. Speculation in plans → speculation in subagent prompts → wrong implementation.

**Real example from this codebase:** the 1389-line overview plan listed task 6 (fastRepair enrichment) and task 7 (Pheromone completion) as TODO. Investigation revealed both were already complete — task 6 by an earlier refactor, task 7 has been wired all along. **Skipped 2.5h of duplicate work.**

### Stage 2: Scope into Packages

Group related tasks into "packages" of 2-3 tasks each. Each package is one user-review boundary.

**Sizing rules:**
- A package fits in one detail-plan document under 700 lines
- A task within a package is 30-60 minutes of subagent work, 2-4 commits
- 2-3 tasks per package — not more (review fatigue), not fewer (overhead)

**Dependencies:**
- Mark packages P0 (blocking) → P1 → P2 → P3
- Tasks within a package can usually run sequentially with one subagent each
- If two tasks are independent, you can run them in parallel (multiple Agent calls in one message)

**Index document:** for any work spanning 3+ packages, write an index doc first (`YYYY-MM-DD-<feature>-index.md`) that lists all packages, dependencies, file paths to detail plans. This prevents losing track when running across multiple sessions.

### Stage 3: Write the Detail Plan

The detail plan is what the subagent reads. Quality of plan determines quality of work.

**Required sections (in order):**

1. **Header rules block** (top, in a blockquote)
   - "Use subagent-driven-development skill"
   - "STOP at the marker, do not continue past task boundary"
   - "TDD red→green commits required (test commit before impl commit)"
   - "Verify with `npx tsc --noEmit` at CLI, ignore IDE/LSP diagnostics"
   - "Each task is one or more independent commits, no batching"

2. **Position in index** — link to the index doc and state what package this is

3. **Goal statement** — 2-3 sentences, what changes and why

4. **Tech stack** — language, key libraries, test framework

5. **Pre-reading list** — file paths with **specific line ranges** the subagent must read. Do not say "read the file" — say "read X lines 145-180 to find the `recordRepairSuccess` method that has a silent cast to fix". The orchestrator already investigated; transfer that knowledge.

6. **Key architectural findings** — non-obvious things you learned in stage 1. Example:
   > `MistakeNotebook` has a private field named `entries` (Map). If you call your new export method `entries()`, it shadows the field. Name it `getAllEntries()` instead.

7. **For each task**: numbered steps with **checkbox syntax** `- [ ]`. Each step is one of:
   - "Edit file X at line Y" (with exact code if non-trivial)
   - "Run command Z" (with expected output for verification)
   - "Commit with message <exact string>"
   - "STOP marker" (🛑 emoji at task boundaries)

8. **Self-check checklist** at the end — bullet list the user verifies during review

9. **Out of scope** — bullet list of related work NOT in this package, with one-sentence reason each

**Anti-patterns in plan writing:**

❌ "Implement the feature" — no, list the exact steps
❌ "Use best practices" — no, specify which pattern from which existing file
❌ Code blocks pasted from memory — verify the actual current state matches
❌ "Around line X" without verifying — read the file, give exact line
❌ Putting impl + wire + commit in one step — separate them

✅ "Edit `src/foo.ts` line 145: change signature from `(s: string)` to `(r: ImmuneResponse)`. Existing test at `__tests__/foo.test.ts:42` passes string — update to `{ type: 'quarantine' }`."

### Stage 4: Brief the Subagent

Use the Agent tool. The prompt is 80% of subagent success.

**Required prompt sections:**

1. **Identity & boundaries** (first paragraph):
   > "You are executing **Task N only** from the plan at `<absolute path>`. Stop at the 🛑 STOP marker around line X. Do NOT start Task N+1."

2. **Critical rules block** — numbered list of non-negotiables:
   - Read plan first (Read tool, give the path)
   - TDD discipline (test commit before impl commit)
   - Each task is a separate commit, do not batch
   - Use `npx tsc --noEmit` at CLI; ignore IDE/LSP diagnostics
   - If approach fails twice, STOP and report rather than improvise

3. **Background context** (3-5 sentences):
   - What package this is, what came before (commit SHAs)
   - The two-or-three sub-parts of THIS task in plain prose
   - Any non-obvious dependency

4. **Pre-reading checklist** — same file paths and line ranges from the plan. Yes, repeat them. The subagent's first action should be Read calls to these locations.

5. **Critical implementation details** — 3-5 bullet points on things easy to get wrong. Examples from real prompts:
   - "Severity 0.6 cannot trigger activation alone — APC threshold is 1.2. Use 1.5 in tests, 0.7 in production where signals accumulate."
   - "The field is named `entries` already. Use `getAllEntries()` for the new method to avoid shadowing."
   - "Use top-level `import type { X } from './x.js'`, not inline `import('./x.js').X` — inline causes LSP false-positives per project rule (commit `3600a9b`)."

6. **Verification gates** — every command the subagent must run, with expected output:
   ```
   - `npx tsc --noEmit; echo "exit: $?"` — exit must be 0
   - `npm test` — only `startup-memory.test.ts` may fail (pre-existing); no new regressions
   - `grep -n "newSymbol" src/foo.ts` — must show 1 match at the new wire site
   ```

7. **Commit message strings** — give exact strings, not descriptions:
   ```
   - Test commit: `test(immune): assert injectSignal accepts external danger signals`
   - Impl commit: `feat(immune): add injectSignal method for external danger signal injection`
   ```

8. **Final report format** — what the subagent must report when done:
   - Commit SHAs (one per commit)
   - Test pass count
   - tsc exit code
   - Specific grep verifications
   - "STOP. Do not start Task N+1."

9. **Failure mode**: if X, Y, or Z goes wrong (list specific scenarios), STOP and report. Do not improvise.

10. **Working directory** at the bottom (absolute path).

### Stage 5: Verify Subagent Output

The subagent's report is what it intended to do, not necessarily what it did. Always verify before marking the task done.

**Required checks (orchestrator runs these in parallel):**

- `git log --oneline -<N>` — confirm the expected number of commits with expected messages
- `git diff --stat <prev-sha>..HEAD` — files changed match plan
- `git show --stat <impl-sha>` — the impl commit actually contains impl, not docs
- `npx tsc --noEmit; echo "exit: $?"` — must be exit 0
- Read the key wire site directly — confirm the integration is real, not just a comment
- `grep` the production caller — must show real call, not just type declaration

**If anything is off:**
- One small fix the subagent missed: edit it yourself, amend the commit, note the fix to the user
- Substantial deviation from plan: send a SendMessage to the same agent ID (continues with full context) explaining what to fix
- Fundamental misunderstanding: STOP, debug yourself or escalate to user. Do not blindly retry.

### Stage 6: Integrate Across Packages

After each package, update the index doc:
- Mark the package ✅ done with commit SHA range
- Note any deviations from plan and why
- If a later package is now unnecessary (investigation revealed work was done), mark it 🚫 cancelled with rationale

After all packages, write a summary message to the user:
- All commits in chronological order
- Mapping from original task numbers to actual commits
- Lessons learned (especially: which assumptions in the original overview turned out wrong)

---

## TDD Discipline Within a Task

Every implementation task follows red→green→refactor with **separate commits per phase**.

**Two-commit minimum per task:**
1. Test commit (failing test, demonstrates the gap)
2. Impl commit (test now passes, no other changes)

**Three-commit pattern for wire tasks:**
1. Test commit
2. Impl commit (the new function/method exists)
3. Wire commit (production caller actually invokes the new function)

**Why separate the wire commit:** the most common failure mode is "I added the function but never called it from anywhere real." A separate wire commit forces the orchestrator to verify a production caller exists. `git show <wire-sha>` should show changes to the existing caller's file, not just the new function's file.

**Anti-pattern this prevents:** large refactors where impl and wire are batched into one commit. Six months later you can't find when the wire was added, and the function looks like it was always called even though it was added orphan and the caller was retrofitted.

---

## Common Failure Modes & Fixes

### "Subagent invented a different design"

**Cause:** plan was vague ("implement persistence") instead of prescriptive ("add saveX/loadX methods to MeridianDb following the immune_memory pattern at lines 285-330").

**Fix:** rewrite the plan with the exact pattern to follow. Reference an existing file as the template.

### "Subagent's tests pass but the production code doesn't actually run the new code"

**Cause:** orchestrator didn't grep-verify the wire. Subagent wrote unit tests that pass independent of integration.

**Fix:** add to the plan: "Step N: grep `<symbol>` in production files (loop.ts, tool-pipeline.ts) to confirm at least one real caller exists. Cite line numbers in the report."

### "Subagent says `tsc passes` but IDE shows errors"

**Cause:** IDE/LSP cache lag. Subagent ran tsc at CLI which is fresh; IDE diagnostics are stale.

**Fix:** add to the prompt: "IGNORE all `<new-diagnostics>` system reminders during execution. Trust ONLY `npx tsc --noEmit` exit code at the CLI. The IDE will catch up after the next save."

### "Subagent re-tried a failing approach 3 times"

**Cause:** prompt didn't have a failure-mode escape hatch.

**Fix:** add to every prompt: "If an approach fails twice, STOP and report the diagnosis. Do not improvise a third attempt."

### "Subagent batched two tasks into one commit"

**Cause:** task boundaries weren't enforced.

**Fix:** the STOP marker (🛑) at every task boundary in the plan, and the prompt says "Stop at the 🛑 STOP marker around line X. Do NOT start Task N+1."

### "Subagent's plan adherence is strong but it missed a real bug in the plan"

**Cause:** subagent followed plan literally even when plan was wrong.

**Real example from this codebase:** plan specified severity 0.6 for a single danger signal in tests, but APC activation threshold is 1.2 — single signal at 0.6 cannot trigger activation, making the assertion impossible. Subagent identified this and used 1.5 in tests (with comment) while keeping 0.7 in production (where signals accumulate).

**Take this as a positive:** good subagents identify plan bugs. Encourage this in the prompt: "If the plan contradicts the actual code architecture (e.g., wrong line numbers, wrong type, wrong assumption), STOP and report. Do not blindly follow."

---

## Orchestrator Discipline

**Things the orchestrator (you) MUST do:**

- Investigate before scoping (Stage 1)
- Read every file you reference in a plan (with the specific line range)
- Verify subagent output before marking done (Stage 5)
- Update the index doc after each package (Stage 6)

**Things the orchestrator MUST NOT do:**

- Write detail plans from memory of an overview document
- Trust subagent reports without git/grep/tsc verification
- Bundle the next task's prompt before reviewing the current task's output
- Improvise mid-package without first updating the plan doc

**Cache discipline:**

- Each subagent gets a fresh context — they pay the prompt cache miss but free your context
- Multiple subagents on independent tasks: dispatch in parallel (one message, multiple Agent tool calls)
- Sequential subagents on dependent tasks: dispatch one at a time, verify each before launching the next

---

## Real-World Example: Immune System Completion

This codebase ran a 9-task immune system completion across 4 packages (May 2026). Outcome:

- **17 implementation commits**, **2-3 commits per task** (test/impl/wire pattern)
- **Package C cancelled (2.5h saved)** — investigation revealed tasks 6+7 were already complete
- **Two plan bugs caught by subagents** — severity threshold issues in tests
- **Total runtime ~30 min subagent execution + user review** vs estimated 8h
- **Zero new TypeScript errors** introduced; all wire integrations grep-verified

The key moves:
1. Investigation in stage 1 saved the entire 2.5h package C
2. Subagents caught plan bugs (severity 0.6 vs threshold 1.2)
3. Each task's wire commit was separate from impl, so wire integrity is grep-verifiable forever
4. Detail plans stayed under 700 lines per package — subagents could read them in one Read call

The artifacts:
- `docs/superpowers/plans/2026-05-24-immune-completion-index.md` (overview + cancellation rationale)
- `docs/superpowers/plans/2026-05-24-immune-pkg-{A,B,D}.md` (detail plans)

Use these as templates for future multi-package work.

---

## Quick Reference

**Stages:** Investigate → Scope → Plan → Brief → Verify → Integrate

**Plan size:** ≤700 lines per package, 2-3 tasks per package

**Task size:** 30-60 min subagent work, 2-4 commits

**Commits per task:** test → impl → (wire if integration) — never batch

**Verify:** git log + git diff --stat + tsc exit 0 + grep production callers

**STOP marker:** 🛑 at every task boundary in plan; subagent stops there

**Failure escape:** "if approach fails twice, STOP and report" — every prompt
