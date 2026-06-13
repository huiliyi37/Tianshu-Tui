# T11 子代理深化与竞品差距 MVP — 工作阶段记录

> 2026-06-13 · `t9-ui-refactor` 分支  
> **状态：✅ R1 + R3 全部落地并分组提交；R2 为分析 plan（无独立代码 commit）**  
> 关联 plan：`.cursor/plans/sub-agent_workflow_optimization_41c7fb84.plan.md`、`.cursor/plans/competitive_gap_analysis_18321911.plan.md`

---

## 0. 一句话

本轮在三段 plan 驱动下完成：**Flash 子代理军团 + 韧性层（R1）** → **竞品五差距分析（R2）** → **五差距 MVP 骨架 + bootstrap/loop 集成（R3）**，共 **12 个 feature/test commit**（R1 六 + R3 六），typecheck 零错，新增测试 ~77。

---

## 1. Plan 轮次总览

| 轮次 | Plan 名称 | 性质 | Todo | 状态 | Commits |
|------|-----------|------|------|------|---------|
| **R1** | Sub-agent Workflow Optimization | 实现 | 7/7 | ✅ | 6 |
| **R2** | Competitive Gap Analysis | 分析 + 路线图 | 5 项差距定义 | ✅ 文档 | 0 |
| **R3** | Competitive Gap Implementation | 实现 | 5/5 (P0–P4) | ✅ | 6 |

**会话主线**：R1 实现 → 分组提交 → R2 竞品分析 → R3 按 P0–P4 实现 → 再分组提交。

---

## 2. R1：子代理工作流深度优化

**Plan 目标**：Flash 成本优势、worker 韧性、结构化通信、TUI 可观测、自动委派。

### 2.1 任务清单（7/7）

| Todo ID | 内容 | 关键交付 |
|---------|------|----------|
| flash-profiles | 6 Flash profiles + tierLock | `lint_fixer`, `test_scaffolder`, `import_organizer`, `doc_syncer`, `type_fixer`, `format_checker` |
| circuit-breaker | closed/open/half-open | `worker-circuit-breaker.ts` → `coordinator.ts` |
| worker-checkpoint | abort 保存 / resume 注入 | `worker-session.ts` — `WorkerCheckpoint` |
| mailbox-protocol | 结构化消息 | `worker-mailbox.ts` — finding/request/artifact/progress/escalation |
| tui-worker-panel | 实时进度 + 断路器 | `worker-panel.tsx`, `worker-panel-model.ts` |
| auto-delegate | edit 后 Flash 派发 | `auto-delegate.ts` |
| resilience-tests | 59 测试 | 5 个新 test 文件 |

### 2.2 提交记录

```
f6685b71  feat(agent): Flash army — 6 tier-locked worker profiles + tierLock
202325bd  feat(agent): circuit breaker + worker checkpoint + coordinator integration
b98ab260  feat(agent): structured mailbox protocol
7a978755  feat(tui): worker status panel
9d7725b9  feat(agent): auto-delegation heuristics for post-edit Flash dispatch
d6d61075  test(agent): 59 tests for sub-agent workflow optimization
```

### 2.3 关键设计决策

- **断路器范围**：仅对 `tierLock` 的 Flash army 计数失败；`code_scout` 等仍保留 Flash→Pro 升级链，避免 coordinator T3 测试回归。
- **协作层未重写**：`team-orchestrator`、`collaboration-protocol`（语义锁、死锁检测、merge queue）保持，在其上叠加韧性层。
- **Profile 总数**：9 原有 + 6 Flash = **15 built-in worker profiles**。

### 2.4 已知待接线（实现已有、集成待确认）

| 项 | 说明 |
|----|------|
| auto-delegate | `dispatcher-hook` + `agent.autoDelegate` 配置是否默认开启 |
| worker-panel | Ink `app.tsx` / T9 ANSI 双路径是否已挂载 |
| mailbox | coordinator → worker session `send()` 全路径 |

---

## 3. R2：竞品差距分析（纯规划）

**Plan 目标**：对照 Cursor / Claude Code / Codex / Jules，识别 5 大缺口并排优先级。

| 优先级 | GAP | 核心缺口（分析时） |
|--------|-----|-------------------|
| P0 | 任务规划 | 无 TaskGraph、无 plan-execute-refine |
| P1 | Skill/Plugin | 无 `.rivet/skills`、无用户 hooks、无生态 |
| P2 | 语义搜索 | 无 embedding/RAG、无 @mention |
| P3 | 跨会话记忆 | 无观察→持久化→注入闭环 |
| P4 | 安全沙箱 | RecoveryJournal 写端未接、bash 无隔离 |

**产出**：`.cursor/plans/competitive_gap_analysis_18321911.plan.md`（分析文档，无独立代码 commit）。

**推荐后续优先级（plan 原文）**：

```
P0 → P1 → P2 → P3 → P4
（自主规划 + skill 生态 = 用户感知最强缺口）
```

---

## 4. R3：竞品差距 MVP 实现（P0–P4）

**Plan 目标**：按 R2 路线图落地 MVP，并完成 bootstrap / loop / prompt 集成。

### 4.1 P0 — Task Planning Engine

| 模块 | 文件 | 职责 |
|------|------|------|
| TaskGraph | `src/agent/task-graph.ts` | DAG 验证、拓扑排序、wave 分组 |
| TaskPlanner | `src/agent/task-planner.ts` | 启发式目标分解 |
| PlanExecutor | `src/agent/plan-executor.ts` | wave 执行 + 失败 refine |
| Tool | `src/tools/plan-task.ts` | `plan_task` — 生成 / 可选 execute |

### 4.2 P1 — Skill / Hook 系统

| 模块 | 文件 | 职责 |
|------|------|------|
| Skill loader | `src/skills/skill-loader.ts` | `.rivet/skills/*.md` + trigger 匹配 |
| User hooks | `src/hooks/user-hooks-runner.ts` | `.rivet/hooks.json` → shell |
| Bridge | `src/agent/hooks/user-hooks-bridge.ts` | RuntimeHookPipeline 接入 |

### 4.3 P2 — 语义搜索 + @mention

| 模块 | 文件 | 职责 |
|------|------|------|
| BM25 | `src/search/text-index.ts` | 纯 TS，无 embedding 模型 |
| Index | `src/search/semantic-index.ts` | 全库 rebuild + `.rivet/semantic-index.json` |
| Tool | `src/tools/semantic-search.ts` | `semantic_search` |
| Mention | `src/tui/mention-parser.ts` | `@file:` / `@folder:` / `@symbol:` |

### 4.4 P3 — 跨会话记忆

| 模块 | 文件 | 职责 |
|------|------|------|
| Store | `src/memory/observation-store.ts` | `~/.rivet/memory/<hash>/observations.jsonl` |
| Extractor | `src/memory/observation-extractor.ts` | postTurn 自动提取 |
| Rules | `src/memory/rule-generator.ts` | 重复 3 次 → `.rivet/rules/auto-*.md` |
| Hook | `src/agent/hooks/memory-learning-hook.ts` | 运行时学习 |

### 4.5 P4 — 安全与恢复

| 模块 | 文件 | 职责 |
|------|------|------|
| Stack | `src/agent/recovery-stack.ts` | journal 列表 + track |
| Undo | `src/tools/undo.ts` | restore 时写 recovery journal |
| Bash | `src/tools/bash.ts` | `RIVET_BASH_SANDBOX=1` → firejail/bwrap |
| Slash | `src/tui/slash-commands.ts` | `/verify` 展示 recovery stack |

### 4.6 集成 commit（e0c20805）

| 文件 | 变更 |
|------|------|
| `bootstrap.ts` | 注册 `semantic_search` / `plan_task`；`loadProjectSkills` |
| `loop.ts` | 每轮注入 skill / memory / @mention；memory + user hooks deps |
| `prompt/engine.ts` + `volatile.ts` | `skillAdvisoryBlock` / `crossSessionMemoryBlock` / `mentionContextBlock` |
| `create-runtime-hooks.ts` | memory-learning + user-hooks bridge |

### 4.7 提交记录

```
6d3b24cf  feat(agent): TaskGraph planner + plan_task tool
05fb81f3  feat(skills): .rivet/skills loader + user hooks.json runner
84c58aab  feat(search): BM25 semantic index + semantic_search + @mention
c62e1d3b  feat(memory): cross-session observation store + learning hook
ccffec52  feat(safety): recovery journal + bash sandbox + undo tracking
e0c20805  feat(agent): wire skills/memory/search/planning into bootstrap and loop
```

### 4.8 MVP 诚实边界（非竞品 parity）

| 能力 | 已有 | 尚未达到 |
|------|------|----------|
| 任务规划 | 规则启发式 DAG + `plan_task` | LLM 规划、scout 前置、与 `team_orchestrate` 深合并 |
| 语义搜索 | BM25 本地索引 | 真 embedding、fs watch 增量、Meridian 联动 |
| 记忆 | 关键词 recall + auto-rule | claude-mem 级观察质量、与 claim-store 统一 |
| 沙箱 | 可选 firejail/bwrap | macOS 默认无隔离、`write_file` 未接 journal |
| Skills | trigger 匹配注入 | 社区包安装、`.rivet/commands/*.ts` slash 层 |

---

## 5. 分支上同期相关提交（Plan 外但同线）

| Commit | 内容 |
|--------|------|
| `a6381683` | Intent Mode Flexibility + TaskDepthLayer |
| `35e309e8` | Cross-session structured handoff + domain routing |
| `0bc95462` | handoff-persist domain routing tests |
| `5be56161` / `9f2ea11d` | kimi-for-coding contextWindow / reasoning_effort 修正 |

---

## 6. 测试与验证

| 轮次 | 新增测试 | 说明 |
|------|----------|------|
| R1 | ~59 | circuit breaker、mailbox、auto-delegate、checkpoint 等 |
| R3 | ~18 | task-graph、task-planner、skill-loader、BM25、mention、memory、bash-sandbox、recovery-stack |
| **合计** | **~77** | |

**验证命令**：

```bash
npm run typecheck          # 零错
node --import tsx --test src/agent/__tests__/task-graph.test.ts \
  src/agent/__tests__/task-planner.test.ts \
  src/skills/__tests__/skill-loader.test.ts \
  src/search/__tests__/text-index.test.ts \
  src/tui/__tests__/mention-parser.test.ts \
  src/memory/__tests__/observation-store.test.ts \
  src/tools/__tests__/bash-sandbox.test.ts \
  src/agent/__tests__/recovery-stack.test.ts
```

---

## 7. 能力版图（Post-T11）

```
AgentLoop
├── DelegationCoordinator → Flash Army (×6) + 9 legacy profiles
├── TeamOrchestrator (wave + collaboration-protocol)
├── DeliveryGateV2 + ReviewRouter
├── TaskGraph + plan_task (R3 P0)
├── .rivet/skills + hooks.json (R3 P1)
├── BM25 semantic_search + @mention (R3 P2)
├── Observation memory + auto-rules (R3 P3)
└── Recovery journal + bash sandbox (R3 P4)
```

**扩展点目录**：

- `.rivet/skills/*.md` — skill 模板
- `.rivet/hooks.json` — 用户生命周期脚本
- `.rivet/rules/auto-*.md` — 记忆重复自动规则
- `.rivet/semantic-index.json` — BM25 索引元数据
- `~/.rivet/memory/<project-hash>/observations.jsonl` — 跨会话观察

---

## 8. 下一步工程重点（交后续 plan）

### A. R3 深化（最高优先级）

1. `plan_task` ↔ `team_orchestrate` 统一；refine 用真实 coordinator 结果。
2. 语义索引 fs watch + Meridian chunk 对齐。
3. Observation 与 claim-store / project-memory Tier1 统一，避免三套记忆。
4. `edit_file`/`write_file` 写 recovery；macOS sandbox fallback。

### B. R1 接线收尾

5. auto-delegate 默认策略 + config 文档。
6. Worker panel Ink + T9 ANSI 双路径挂载。
7. Mailbox coordinator → worker `send()` 全路径。

### C. T9 UI Backlog（见 `t9_ui收束与优先级backlog.md`）

8. P2 M5：Ink → ANSI 灰度、删 `.tsx`。
9. P2 Cockpit：6 面板 ANSI renderer。
10. P3 TodoStore 子进程单例。

### D. Harness 护城河

11. Prefix 稳定性审计（dynamic appendix 新增 block 对 cache 影响）。
12. Delivery gate / 训练模式退化态（关联既有 plan）。

---

## 9. 文档与 Plan 索引

| 文档 | 路径 |
|------|------|
| R1 plan | `.cursor/plans/sub-agent_workflow_optimization_41c7fb84.plan.md` |
| R2/R3 plan | `.cursor/plans/competitive_gap_analysis_18321911.plan.md` |
| R1 plan 副本 | `docs/teamtask/天枢子代理工作流优化_6035537b.plan_副本.md` |
| T9 UI backlog | `docs/teamtask/t9_ui收束与优先级backlog.md` |
| 本文 | `docs/teamtask/T11-子代理深化与竞品差距MVP-工作阶段记录.md` |

---

## 10. 变更日志

| 日期 | 动作 |
|------|------|
| 2026-06-13 | 初稿：R1/R2/R3 三轮 plan 工作总结 + commit 索引 + 待办 |
