# StarFlow v2 闭环接线复盘 · 2026-05-18

> 来源：天枢 2.0 首个任务执行过程中的用户反馈 + agent 自省  
> 关联设计：`docs/superpowers/specs/2026-05-18-starflow-v2-closed-loop-wiring-design.md`  
> 关联计划：`docs/superpowers/plans/2026-05-18-starflow-v2-closed-loop-wiring.md`  
> 实施提交：`d6c88a0 fix(starflow): wire closed-loop strategy consumers`  
> 状态：✅ 已实施并验证 — 1521 pass, 0 fail

---

## 背景

这是 TUI 2.0 时代的第一个执行任务：把 StarFlow v2 已有的 sensorium/strategy 感知层接成可靠闭环。目标不是新增宏大架构，而是修复 6 个“computed but never consumed”的最后一跳缺口：Stigmergy 衰减查询与清理、Theta-Gamma 实体检查、Dissipative Kick 效应器补齐，以及 contracting 阶段触发确认。

这次任务被用户评价为“完美、非常精准”，核心原因不是代码量，而是工作流首次完整呈现了 2.0 能力形态：**计划不是被机械执行，而是被验证、校准、风险修正后落地**。

---

## 任务结果

### 已交付

| 领域 | 结果 |
|------|------|
| Stigmergy | `loop.ts` 使用 `query()` 读取 decayed `currentStrength`，session start opportunistic `prune()` |
| Theta-Gamma | 新增 `theta-check.ts`，使用独立 `spawn('npx', ['tsc', '--noEmit', '--skipLibCheck'])` 做节律性类型检查 |
| Kick | `deadEndPaths` 持久化为 `dead-end` pheromone，`alternativeFrameworks` 注入 LLM 消息 |
| Contracting | 确认 `_hasEnteredHighComplexity` 已在前序提交完成，现有测试覆盖触发/跳过条件 |
| 文档 | 设计与计划文档一起提交，开源前再统一清理 docs 目录 |

### 验证

```bash
npx tsx --test src/context/__tests__/stigmergy.test.ts
# 21 passed

npx tsx --test src/agent/__tests__/dissipative-kick.test.ts
# 23 passed

npx tsx --test src/agent/__tests__/theta-check.test.ts
# 3 passed

npx tsx --test src/agent/__tests__/star-event.test.ts
# 25 passed

npx tsc --noEmit
# exit 0

npx tsx --test src/**/__tests__/*.test.ts
# 1521 passed, 0 failed
```

---

## 设计决策

### 1. 计划优先，但代码事实拥有最终裁决权

- **选择**：先读设计文档和实施计划，再读现有 `loop.ts` / `stigmergy.ts` / `dissipative-kick.ts` / `star-event.test.ts`，按实际状态决定实现范围。
- **替代方案**：严格照计划逐项实现，包括重复添加 contracting trigger 或重复测试。
- **影响**：避免重复实现，确认 contracting trigger 已由 `98dde25` 完成，只补真正断开的消费者。

### 2. Theta-Gamma 采用非阻塞、进程隔离的 best-effort 检查

- **选择**：`runThetaCheck()` 使用 child process 执行 `npx tsc --noEmit --skipLibCheck`，失败/超时/无可解析错误时返回空 errors，loop 中 fire-and-forget。
- **替代方案**：await tsc 结果阻塞 agent turn，或使用 TypeScript Compiler API 嵌入式检查。
- **影响**：主循环不会因 tsc 慢或崩溃而卡死；theta 信号作为“后台节律检查”而非强一致 gate。

### 3. Repair hint 复用现有 `type_error` failure class

- **选择**：theta 检测到类型错误后调用 `repairHintTracker.recordFailure(errFile, 'type_error')`。
- **替代方案**：照计划使用新字符串 `type-inconsistency`。
- **影响**：复用已有 `RepairHintTracker` 模板，避免引入未注册 failure class 造成低质量 fallback 提示。

### 4. Kick recentFailed 保守跟计划，不额外过滤非路径

- **选择**：从 `recentToolHistory` 收集 failed target 并传入 `buildKickActions()`，不新增 file-only 过滤。
- **替代方案**：只允许 `.ts` / 含路径分隔符的 target 入库。
- **影响**：保持与现有 bash dead-end 行为一致；长期语义债记录为后续 schema 演进问题。

### 5. Loop 级测试不强行扩张

- **选择**：用 `stigmergy`、`theta-check`、`dissipative-kick`、`star-event` 单元测试覆盖关键数据结构和纯函数，全量测试兜底中心 loop。
- **替代方案**：构造高成本 AgentLoop harness 集成测试。
- **影响**：保持任务低风险和可维护性，没有为了覆盖率引入脆弱测试夹具。

---

## 7 个风险修正点

这些风险点是本次“2.0 精准执行”的核心资产。它们不是泛泛的“可能有问题”，而是直接改变实现质量的工程判断。

| # | 风险点 | 原计划/隐患 | 修正 | 价值 |
|---|--------|-------------|------|------|
| 1 | `shell: true` | 增加 shell 注入面，与项目惯例不一致 | 去掉 `shell: true`，直接 `spawn('npx', args)` | 更安全、更贴合现有工具模式 |
| 2 | 只读 stderr | tsc/npx 在不同环境下可能把诊断输出到 stdout | 同时收集 stdout + stderr | 避免漏报类型错误 |
| 3 | spawn timeout | 原生 timeout 行为不可控 | 手写 timer，SIGTERM 后延迟 SIGKILL | 与 `bash`/`run-tests` 工具风格一致 |
| 4 | “No tsconfig” 测试语义 | 失败原因不稳定，可能只是无可解析 file error | 改成 non-project returns empty | 测试表达真实 contract |
| 5 | `type-inconsistency` | 非已有 failure class，无模板 | 使用 `type_error` | repair hint 质量更高 |
| 6 | recentFailed 过滤 | 过滤过严会偏离现有 bash dead-end 语义 | 保守跟计划，不新增过滤 | 不扩大 scope，不破坏一致性 |
| 7 | loop 级集成测试 | 高成本、易脆弱 | 单元测试 + 全量测试兜底 | 低风险验证闭环 |

用户最终判定：7 点全部有效，其中 1-5 采纳，6 保守跟计划，7 认可。

---

## 发现的问题

### 1. Subagent 当前不是可靠协作者

- **现象**：尝试启动 subagent 并行审查时，worker 出现 provider API key 缺失和 schema 返回失败：
  - `No API key configured for provider "codex"`
  - `Worker result did not contain a JSON object`
- **根因**：worker provider/profile 默认偏向 codex capable profile，但当前环境未配置可用 codex 凭证；同时 worker 输出契约失败后的诊断对 primary 不够友好。
- **修复**：本任务中 primary 不信任 worker 结果，继续独立完成。
- **预防**：后续应实现 worker provider unavailable 的显式降级，并增强 schema-failure 诊断。

### 2. Volatile git status 可能 stale

- **现象**：commit 后用户消息上下文中的 git status 一度仍显示旧 modified/untracked 状态。
- **根因**：volatile git status 使用缓存，和刚执行过的 git tool 结果可能存在时序差。
- **修复**：本任务中以最新 `git status` 工具结果为准。
- **预防**：关键 git 操作前后强制 fresh status，或在 volatile block 标注 `source=fresh|cached` 与 age。

### 3. Runtime artifact 进入未跟踪状态

- **现象**：`.rivet/pheromones.json` 出现在 git status 未跟踪文件中。
- **根因**：此前只 gitignore 了 `.rivet/sensorium.jsonl`，未覆盖 Stigmergy runtime artifact。
- **修复**：建议后续提交 `.gitignore` 增加 `.rivet/pheromones.json`。
- **预防**：新增 runtime 文件时同步更新 ignore 策略。

### 4. Theta check fire-and-forget 有观测缺口

- **现象**：theta check 不阻塞 loop，但也没有 in-flight guard 或 telemetry。
- **根因**：本次目标是填空体，不扩大到 pressure-control 或 telemetry 体系。
- **修复**：当前实现接受为低风险 best-effort。
- **预防**：后续可添加 `thetaCheckInFlight` 与 telemetry 字段：duration/errors/timedOut。

### 5. Stigmergy prune/query 存在轻微 race

- **现象**：session start 同时 fire-and-forget `prune()` 和 `query()`，query 可能先于 prune 完成。
- **根因**：为了不阻塞 run start，两个 I/O 都是后台执行。
- **修复**：当前影响很小，因为 query 已使用 decayed strength，旧条目强度极低。
- **预防**：可封装 `refreshPheromones({ pruneFirst: true })` 链式执行。

---

## 过程摩擦

### 1. Subagent 失败需要更像“降级”而不是“任务失败”

- **场景**：用户明确希望 2.0 使用更强工作流，agent 也按条件尝试 delegate，但 provider/schema 问题导致 worker 不可用。
- **影响**：如果 primary 盲信 worker，会污染判断；如果每次都展开错误，会干扰任务节奏。
- **改进方向**：delegate tool 应将 provider 缺失识别为 `skipped/unavailable`，并输出“primary should continue without delegation”。

### 2. 计划文档执行后没有自动写回结果

- **场景**：实施计划以 checklist 形式存在，但 commit 后仍处于计划态。
- **影响**：后续读者不知道计划是否已执行、验证结果是什么、实际偏离有哪些。
- **改进方向**：计划文档末尾追加 `Implementation Result`，记录 commit、验证、偏离计划的工程修正。

---

## 可复用模式

### 模式 1：计划驱动但 verify-first

- **Trigger**：用户给出实施计划。
- **Diagnosis**：先读计划与相关代码，标出“已实现 / 真缺口 / 计划偏差”。
- **Fix**：只实现真缺口；对计划中的不安全细节做显式工程修正。
- **适用场景**：所有 specs/plans 驱动的任务，尤其是中心 runtime 文件如 `loop.ts`。

### 模式 2：best-effort 后台检查

- **Trigger**：需要在 agent loop 中加入昂贵或不稳定的自检（tsc、lint、跨文件分析）。
- **Diagnosis**：如果同步 await，会牺牲交互延迟和鲁棒性。
- **Fix**：进程隔离 + timeout + fire-and-forget + repair hint/telemetry 消费。
- **适用场景**：Theta-Gamma、后台 consistency check、未来 pressure-control probes。

### 模式 3：风险修正表

- **Trigger**：agent 对计划提出多个工程风险修正。
- **Diagnosis**：用户逐项判定采纳/不采纳，避免 agent 擅自扩大 scope。
- **Fix**：将判定表写入复盘，成为后续任务的 decision memory。
- **适用场景**：用户与 agent 协作形成的高信号工程判断。

### 模式 4：runtime artifact 发现即 ignore

- **Trigger**：运行后 git status 出现 `.rivet/*` runtime 文件。
- **Diagnosis**：文件属于 agent 本地状态，不应进入开源代码库。
- **Fix**：精确 ignore 已知 artifact，而不是粗暴 ignore 整个 `.rivet/`。
- **适用场景**：sensorium、pheromones、sessions、trace 等本地运行态文件。

---

## 工作流优化建议

### P0：立即可做

1. `.gitignore` 增加 `.rivet/pheromones.json`。
2. 在闭环接线计划文档末尾追加 `Implementation Result`。
3. 调查 delegate worker provider fallback：codex 未配置时是否可自动使用当前 primary provider 或 cheap profile。

### P1：后续增强

1. `runThetaCheck()` 增加 `timedOut` 字段或 telemetry hook。
2. AgentLoop 增加 `thetaCheckInFlight`，避免重叠 theta check。
3. 封装 `refreshPheromones()`，消除 prune/query race 并减少重复代码。
4. volatile git status 增加 freshness 标记，commit/status 后主动刷新缓存。

### P2：结构性优化

1. Pheromone target schema 拆分：`target` + `targetKind: file|command|tool|unknown`。
2. `/retrospect` 工作流落地：复盘文档 → claim/project-memory 自动联动。
3. delegate worker schema failure 进入可诊断 repair loop，而不是只返回“不是 JSON”。

---

## 联动标记

- [x] 关联计划：`docs/superpowers/plans/2026-05-18-starflow-v2-closed-loop-wiring.md`
- [x] 关联设计：`docs/superpowers/specs/2026-05-18-starflow-v2-closed-loop-wiring-design.md`
- [x] promote 到 project-memory：建议在下一次 Dream 蒸馏时引用
- [ ] promote 为 claim（project_rule）
- [ ] 推动工作流优化 follow-up
