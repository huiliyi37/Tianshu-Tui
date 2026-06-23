# Dispatcher Hook 改造：执行器 → 委派顾问（advisory-ization）

> 2026-06-23。把 `afterPerception` 阶段的 `task-dispatcher` hook 从「背着模型自动派 worker」改成「向模型建议显式委派」。

## 背景

`createDispatcherHook`（`src/agent/hooks/dispatcher-hook.ts`，`afterPerception` 阶段）会在每个 turn 感知后：
1. 取当前 `TaskContract`，过门槛（actionable + 词数/scope 复杂度）；
2. `decomposeByDataContract(contract)` 按数据流把目标拆成多个跨域子任务；
3. 若拆出 >1 个子任务，则**直接** `coordinator.delegate(req)` 逐个派 worker。

它由 `create-runtime-hooks.ts` 在 `deps.autoDelegate` 存在时装配，而 `autoDelegate` 仅当 `config.agent.autoDelegateEnabled === true`（默认 false）才装配——是系统级 opt-in。

## 问题（为什么改）

旧实现作为「执行器」有三处结构性问题：

1. **背着模型行动**：hook 在模型不知情时自行 `coordinator.delegate()` 派 worker。模型的对话历史里凭空多出 worker 结果，决策权被夺走，违背「委派应是模型的显式动作」。
2. **丢依赖**：`decomposeByDataContract` 算出的 `dependsOn` 依赖箭头在转成 `DelegationRequest[]` 时被丢弃，逐个 `delegate()` 单发，无法表达「B 先于 A」，也用不上 coordinator 的依赖队列。
3. **prefix-cache 风险**：在主路径外旁路注入 worker 调用与结果，扰动会话历史，威胁前缀缓存稳定性（本项目核心优化）。

## 改造（怎么做）

把 hook 从 actor 改成 advisor——只**建议**，不行动：

- 删掉对 `coordinator` 的依赖（`DispatcherHookDeps.coordinator` 移除），以及 `inferWorkOrderKind` / `inferWorkerProfile` / `matchDomain` / `shouldDelegateObjective` 等仅用于自行构造 `DelegationRequest` 的死代码。
- 拆分逻辑保留（`decomposeByDataContract` 仍算子任务与依赖箭头）。
- 拆出 >1 子任务时，改为向 **AdvisoryBus** 提交一条结构化建议（带 `priority`/`category: 'delegation'`/`ttl`/`key` 去重），把依赖箭头编码进文案（`A←[B]` 表示 A 依赖 B，B 先跑），建议模型**显式调 `delegate_batch` 并按箭头传 `dependencies`**。
- 仍发 `task-decomposed` 的 UI phase-change 信号（无 advisoryBus 时退化为仅发信号）。
- 去重/冷却语义保留：每个 contract 至多建议一次（`advisedIds`），`cooldownTurns`（默认 3）限制建议频率。

这样委派决策回到模型手里，依赖关系经 `delegate_batch` 进入 coordinator 既有的**依赖队列 / 文件冲突串行化 / 结果聚合**，且注入走 AdvisoryBus 统一收编的 system-reminder 通道，不旁路扰动历史。

## 接线

| 文件 | 改动 |
|------|------|
| `src/agent/advisory-bus.ts` | `AdvisoryCategory` 增 `'delegation'` |
| `src/agent/hooks/dispatcher-hook.ts` | 执行器 → 顾问；移除 coordinator 依赖与死代码；改提交 advisory |
| `src/agent/create-runtime-hooks.ts` | 装配时透传 `advisoryBus: deps.advisoryBus` 给 `createDispatcherHook` |

## 行为约束

- **系统级 opt-in 不变**：hook 仅当 `config.agent.autoDelegateEnabled === true`（默认 false）才装配；`DispatcherHookDeps.enabled === false` 是注册后的 per-instance 本地 kill-switch。
- **只读建议**：建议只读探查用 `code_search` profile；写操作仍需模型显式 `delegate_task`。
- 无 `advisoryBus` 时优雅退化为只发 UI 信号，不报错。

## 测试

`src/agent/__tests__/dispatcher-hook.test.ts`（8 用例）：覆盖无 contract / 非 actionable / 复杂度不足 / 单域不建议、多域提交 advisory（而非行动）、依赖箭头出现在文案、每 contract 仅建议一次、phase-change 信号。
