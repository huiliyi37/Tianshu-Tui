# T2 · 复盘事实沉积：稳定态设计的 5/18–5/19 证据

> 2026-05-22
> 来源：2026-05-18 至 2026-05-19 的 StarFlow、TUI 2.2、Wave7、工作流对齐复盘。
> 目的：把已验证过的工程事实提炼成稳定态设计的可召唤依据，避免每次重新读大量复盘。

---

## 1. 计划不是唯一权威

事实来源：StarFlow v2 闭环、工作流对齐复盘。

原则：计划优先，但代码事实、设计成功标准、测试验证共同裁决。

退行风险：agent 把 plan 当唯一权威，照任务列表做完，却遗漏设计文档里的关键成功标准。

归位：每个重要任务要对齐：

```text
设计要求 → 计划任务 → 实现证据 → 验证证据
```

---

## 2. 设计要求覆盖矩阵是防伪完成机制

事实来源：2026-05-19 工作流迭代复盘。

事件：设计文档要求 DelegationCoordinator hands worker 使用 claim 检查，但计划只实现了 ClaimRegistry 表和 API，未接入实际执行链路。

复盘命名：造了锁但没人用。

原则：typecheck + tests 通过不等于设计要求满足。集成验证必须逐条检查设计成功标准。

---

## 3. 执行者与审查者必须切换

事实来源：2026-05-19 工作流迭代复盘。

执行者关注“怎么做”，审查者关注“做了没有”。用户说“继续”时，agent 不能自动进入下一个任务惯性；应先检查还有什么没做完。

稳定态含义：IMPLEMENT → REVIEW → VERIFY → HANDOFF 是必要节律。

---

## 4. Subagent 不可用是降级，不是失败

事实来源：StarFlow v2 闭环复盘。

事件：worker 因 provider key / JSON 格式问题不可用，primary 不信任 worker 输出，改为独立完成并标记降级。

原则：子代理失败不等于任务失败。应标注降级，继续安全可验证部分。

---

## 5. 工具现实优先于注入上下文

事实来源：StarFlow v2 复盘中的 volatile git status stale 问题；后续 openai worktree 不完整事件再次验证。

原则：注入上下文是线索，不是现实替代品。实时工具结果和文件系统状态优先。

---

## 6. Runtime artifact 需要明确归属

事实来源：StarFlow v2 复盘 `.rivet/pheromones.json` 未跟踪；openai 合并时 `.rivet/artifacts` 被误跟踪 338 个文件。

原则：运行态文件默认不归业务 commit，除非明确作为文档/证据资产提交。

归属星轨必须记录：哪些是业务变更，哪些是运行痕迹，哪些要 stash，哪些可丢。

---

## 7. 健康收缩不同于锚点坍缩

事实来源：TUI 2.2 Vigor Runtime 复盘。

健康收缩：读完全局后主动降低风险，例如先 pure core，暂不大爆炸改 loop，暂不实现高风险 Soft Landing。

锚点坍缩：未完成问题建模，只抓用户关键词，迅速给出最小实现。

判断标准：收缩前是否理解了全局、风险、层级、后续演进路径。

---

## 8. 新 runtime 生理机制应先 pure core

事实来源：TUI 2.2 Vigor Runtime 复盘。

成功规约：

```text
pure core → hook wrapper → runtime registration → telemetry → behavior
```

稳定态实现应继承此规约。HEARTH 先 anchor graph / invariant pure core；Songline 先 obligation/world-season skeleton；不要先接主循环。

---

## 9. 同名抽象不等于同一层抽象

事实来源：TUI 2.2 hook 设计复盘。

已有 `src/hooks/registry.ts` 服务外部工具/用户 hook；Vigor 选择内部 runtime hook，避免混淆外部 hook 与生理 hook。

稳定态含义：Anchor、claim、hook、memory、season 等词在不同层级可能含义不同，不能因同名就复用。

---

## 10. 只读观察也是交付

事实来源：Wave7 `/plan` 工作流闭环执行记录。

Wave7 任务没有重写 runtime，而是确认闭环、验证 helper、补充文档、阅读 Wave8 并给风险观察。

原则：agent 不必每次都改代码才算有用。只读审查、状态补齐、风险观察本身可以是交付。

---

## 11. Targeted tests 与全量失败需要归因

事实来源：Wave7 复盘。

事件：targeted tests 通过，全量 typecheck 失败来自并发 Wave8 未跟踪测试文件，不归因于本任务。

原则：测试失败要归属到 owner / 文件 / 任务。工作区的脏不是自我的脏。

---

## 12. 复盘应沉积成 brief，而不是常驻上下文

这些事实来自复盘原文，但不应把所有复盘常驻在 prompt。原文保留为证据，brief 提供高频可召唤公理。

