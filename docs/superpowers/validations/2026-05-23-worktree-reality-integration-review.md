# Worktree Reality 接入 AgentLoop — 审查记录

日期：2026-05-23（初版）→ 2026-05-24（修复后更新）  
分支：`feat/tianshu-sycophancy-trap-2.5`

## 1. 审查范围

关联提交：

1. `f8b9c49` — `feat(prompt): add worktree-warning to dynamic appendix`（可能已被 rebase，hash 仅供参考）
2. `150769b` — `feat(agent): integrate worktree-reality detection into AgentLoop`
3. `f1c0469` — `test(agent): add integration tests for worktree-reality detection`

关联设计文档：

- `docs/superpowers/briefs/2026-05-23-T1-worktree-reality-integration-ready.md`
- `docs/superpowers/plans/2026-05-23-p0-worktree-reality-contract.md`

## 2. 审查结论

整体方向正确：

- `detectWorktreeReality()` 已进入 `AgentLoop.run()` live path。
- `<worktree-warning>` 已接入 prompt dynamic appendix。
- 未进入 static/frozen prompt，符合 prefix cache 约束。
- 首阶段只做 warning，没有扩展到 delivery gate 阻断，符合 brief 范围。

~~主要风险：~~

> ~~当前 AgentLoop 只从 `gitStatusCache` 提取 `branch`，没有提取/传入 `HEAD`。因此 Worktree Reality 最关键的 `HEAD mismatch -> red` 场景可能没有真正接入。~~

**已修复** — 见第 4 节。

## 3. 当前实现摘要

### Prompt dynamic appendix

位置：

- `src/prompt/volatile.ts`
- `src/prompt/engine.ts`
- `src/prompt/__tests__/volatile.test.ts`

行为：

- 新增 `worktreeReality` 相关字段。
- 当 worktree reality severity 非 green 时，渲染 `<worktree-warning>`。
- warning 位于 dynamic appendix，而不是 frozen/static block。

### AgentLoop detection（修复后）

位置：

- `src/agent/loop.ts`
- `src/prompt/volatile-git.ts`（新增 `getGitInjectedContext`）

当前逻辑：

```ts
const ctx = await getGitInjectedContext(this.cwd)
const injected: InjectedWorktreeContext | undefined = ctx
  ? { branch: ctx.branch, head: ctx.head }
  : undefined
const reality = await detectWorktreeReality(this.cwd, injected)
this.config.promptEngine.setWorktreeReality(reality)
```

catch 分支：

```ts
} catch {
  // Detection failure must not crash AgentLoop — clear stale warning
  this.config.promptEngine.setWorktreeReality(null)
}
```

## 4. 已修复的问题

### P1 — HEAD injected context 缺失 ✅ FIXED

**问题：** 原实现用 regex 从 `gitStatusCache` 的展示字符串中提取 branch，未提取 HEAD。导致 `detectWorktreeReality()` 中的 HEAD mismatch → red 规则永远不会触发。

**修复：**
- 在 `src/prompt/volatile-git.ts` 新增 `getGitInjectedContext(cwd)` 函数，直接运行 `git branch --show-current` + `git rev-parse HEAD`，返回结构化 `{ branch, head }`。
- `loop.ts` 改用此函数，不再 regex 解析展示字符串。
- HEAD mismatch 现在能正确触发 red severity。

### P2 — detection 失败后保留旧 warning ✅ FIXED

**问题：** catch 块为空，detection 抛错后 `promptEngine` 中保留上一轮的 `worktreeReality`，可能显示 stale warning。

**修复：** catch 中调用 `this.config.promptEngine.setWorktreeReality(null)` 清空旧状态。

### P3 — gitStatusCache contract 脆弱 ✅ FIXED

**问题：** 依赖 `Current branch: ...` 展示文本格式的 regex 解析。

**修复：** 新增独立的 `getGitInjectedContext()` 结构化 API，`loop.ts` 不再依赖 `gitStatusCache` 的字符串格式。已移除 `gitStatusCache` 的 import。

## 5. 验证记录

已执行：

```bash
npx tsc --noEmit                                    # 通过
npx tsx --test src/agent/__tests__/worktree-reality.test.ts   # 10/10 pass
npx tsx --test src/prompt/__tests__/volatile.test.ts          # 30/30 pass
npx tsx --test src/agent/__tests__/loop.test.ts               # 27/27 pass
```

覆盖的关键场景：

- `loop.test.ts` → "calls detectWorktreeReality and sets result on promptEngine" — 验证集成路径
- `worktree-reality.test.ts` → 测试 G "returns red on HEAD mismatch" — 验证 HEAD 比较逻辑
- `volatile.test.ts` → worktree-warning 渲染逻辑

## 6. 剩余迭代方向

### 可选增强 A：缓存 getGitInjectedContext

当前每次 `run()` 都执行两个 git 命令。如果 turn 频率高，可加 TTL 缓存（类似 `gitStatusCache`）。当前开销可接受（<10ms），暂不优化。

### 可选增强 B：cwd mismatch 升级为 red

Brief 中提到"如果实际场景中 cwd 不匹配意味着 agent 在错误仓库操作，后续可升级为 red"。当前保持 yellow，观察实际触发频率后决定。

## 7. 不建议扩展的范围

- 不要把 red warning 接入 delivery gate 阻断。
- 不要修改 static/frozen prompt。
- 不要重构 `src/agent/worktree-reality.ts` 核心 detection 逻辑（可以扩展输入类型）。
- 不要处理无关脏文件。
