# Guided Memory Retrieval — 分层记忆与使用方案

> 状态：方案补档 + 已落地收束记录 | 日期：2026-06-01 | 背景：避免“全量注入污染 prompt”和“纯按需 recall 又没人读”两个极端。

## 0. 结论

记忆系统不能依赖 agent 自觉想起 recall，也不能把所有历史记忆常驻注入 prompt。

最终形态是：

```text
常驻最小地图 + 高信号小预算注入 + 按需召回 + 敏感区域 preflight + 子代理知识包
```

一句话：**memory 不是档案柜，也不是 prompt 垃圾桶；memory 是由架构强制引导的检索路径。**

## 1. 问题定义

### 1.1 纯 recall-only 的失败模式

如果 `.rivet/knowledge/project-memory.md` 和 `memory.jsonl` 都只靠 agent 主动 recall，会出现：

- 新会话不知道有哪些历史架构决策；
- 子代理只拿到窄任务，不会主动读 memory；
- agent 不知道该用什么关键词 recall；
- 代码能改，但不了解项目结构、历史取舍和禁区；
- 已经讨论过的架构边界被重复推翻。

### 1.2 全量注入的失败模式

如果把所有 project memory 默认注入 prompt，会出现：

- prefix cache 频繁失效；
- 低价值执行流水污染注意力；
- 单次失败、工具轨迹、file observation 挤掉真正重要的决策；
- memory 越多，模型越难看见关键约束。

所以当前系统采用中间路线：**guided retrieval**。

## 2. 记忆分层

| 层级 | 名称 | 内容 | 是否进 prompt | 是否提交 git | 读取方式 |
|------|------|------|---------------|--------------|----------|
| L0 | 常驻项目地图 | `AGENTS.md`、`.rivet.md`、必要时 manifest 检索规则 | ✅ 小而稳定 | ✅ | volatile snapshot / prompt |
| L1 | Tier 1 结构化记忆 | 高置信 `decision` / `project_rule` / `user_constraint` | ✅ 2K chars 上限 | ❌ `memory.jsonl` 不提交 | `loadProjectMemory()` |
| L2 | Tier 2 结构化记忆 | `file_observation`、`verification_fact`、`failure_pattern`、低置信条目 | ❌ | ❌ | `recall` 搜索 `memory.jsonl` |
| L3 | Curated project memory | 人工/高价值 Markdown 记忆，架构不变量、设计原则 | ❌ | ✅ 可显式提交 | `recall` 搜索 `.md` |
| L4 | 正式项目规范 | `.rivet/rules/*.md`、`AGENTS.md`、`.rivet.md`、docs briefs/specs | ✅/按需 | ✅ | prompt / manifest / recall |

## 3. 文件职责

### 3.1 `.rivet/knowledge/memory.jsonl`

定位：**本地机器结构化记忆缓存**。

特点：

- 由工具和 agent 自动写入；
- 同一 worktree 的多个会话可共享；
- 不适合多人协作时直接进 git；
- 已加入 `.gitignore`；
- 通过 `project-memory-loader.ts` 分层读取；
- Tier 1 可小预算注入；Tier 2 通过 `recall` 检索。

提交策略：**不提交**。

### 3.2 `.rivet/knowledge/project-memory.md`

定位：**人工策展的长期项目记忆**。

适合记录：

- 架构不变量；
- 设计原则；
- 多轮讨论收敛出的判断；
- 会改变未来 agent 决策的规则；
- 重要方案的取舍依据。

不适合记录：

- 本轮改了哪些文件；
- 工具调用流水；
- 一次性测试失败；
- 低级执行状态；
- 未筛选的 commit 列表。

提交策略：**可提交，但必须人工/agent 二次筛选后提交**。

### 3.3 `.rivet/knowledge/manifest.md`

定位：**敏感区域检索地图**，不是记忆正文。

作用：告诉 agent 在改 prompt / identity / memory / recall / verification / ownership 等敏感区域前，应该读哪些文档。

提交策略：**可提交**。这是项目规则的一部分。

### 3.4 `docs/analysis/*.md` / `docs/superpowers/plans/*.md`

定位：**证据、分析、计划、执行闭环记录**。

适合记录长分析和方案，不应该全部常驻 prompt。需要时由 manifest / recall / 人工路径定位。

## 4. 当前已落地状态

| 项目 | 状态 | 证据 |
|------|------|------|
| `memory.jsonl` 本地 cache，不提交 | ✅ 已落地 | `.gitignore` + `runtime-ignore.test.ts` |
| `recall` 搜索 `memory.jsonl` | ✅ 已落地 | `src/tools/recall.ts` + `recall.test.ts` |
| `project-memory.md` 不默认注入 | ✅ 已落地 | `volatile.test.ts` / `volatile-snapshot.test.ts` 既有测试 |
| Tier 1 loader 小预算注入 | ✅ 已落地 | `src/context/project-memory-loader.ts` |
| remember scope=project 写入 memory.jsonl | ✅ 已落地 | `src/tools/remember.ts` |
| tool-pipeline project claim 写入 memory.jsonl | ✅ 已落地 | `src/agent/tool-pipeline.ts` |
| 子代理自动知识包 | ❌ 未落地 | 见 §8 后续任务 |
| 敏感区域 preflight 自动化 | ❌ 未落地 | 见 §8 后续任务 |
| Project memory loader/writer 专门测试 | ❌ 未落地 | 见 §8 后续任务 |

## 5. 使用规则

### 5.1 新会话 / 大任务

最小启动地图：

```text
AGENTS.md
.rivet.md
repo_map / inspect_project
```

如果任务涉及敏感区域，必须读：

```text
.rivet/knowledge/manifest.md
```

再按 manifest 的 `load_when` 读取对应文档。

### 5.2 修改 memory / recall / prompt 前

必须检查：

```text
.rivet/knowledge/manifest.md
docs/analysis/2026-06-01-project-memory-architecture-conflict.md
docs/superpowers/plans/2026-06-01-project-memory-system.md
```

并核对真实代码：

```text
src/context/project-memory-loader.ts
src/context/project-memory-writer.ts
src/tools/recall.ts
src/prompt/volatile-snapshot.ts
src/prompt/volatile.ts
```

### 5.3 何时使用 recall

遇到以下情况应主动 recall：

- 用户提到“之前讨论过”、“上次方案”、“记忆”、“架构决策”；
- 修改 prompt / memory / recall / verification / ownership；
- 当前任务可能有历史坑；
- 子代理结果与已知设计冲突；
- 需要判断某条规则是否已有先例。

示例：

```text
recall(query="project memory")
recall(query="verification supersession")
recall(query="TUI freeze")
recall(query="prefix cache")
```

## 6. 子代理使用规则

不要指望 worker 自己知道项目历史。主 agent 委托前必须给 worker 一个任务知识包。

### 6.1 任务知识包模板

```text
目标：...
相关区域：src/context/, src/tools/recall.ts
必须阅读：
- AGENTS.md
- .rivet.md
- .rivet/knowledge/manifest.md
- docs/analysis/2026-06-01-project-memory-architecture-conflict.md
- src/context/project-memory-loader.ts
已知约束：
- project-memory.md 是 curated recall-only
- memory.jsonl 是本地 structured cache，不提交
- Tier 1 仅 decision/project_rule/user_constraint 且 confidence >= 0.9
输出要求：
- 只读核查 / 风险 / 建议，不修改文件
```

### 6.2 worker 适合做什么

适合：

- code search；
- doc research；
- review；
- verify；
- 风险枚举。

谨慎：

- patcher；
- batch patch；
- 跨多个子系统的架构改动。

原因：patcher worker 历史上存在 approval / worktree / 输出契约稳定性问题。关键 patch 仍建议主会话执行。

## 7. 不做什么

### 7.1 不做全量 project memory 注入

`project-memory.md` 不进入 volatile prompt。它是 curated 知识库，不是每轮上下文。

### 7.2 不把所有 commit fact 直接变成 Tier 1 decision

原 `2026-06-01-project-memory-system.md` 中 P5 提议 `commitFact scope: session → project`。该方向需要收窄。

原因：不是每个 commit 都会改变未来判断。很多 commit 只是 typo、测试修复、局部 UI 调整。

更稳的后续方案：

- commit fact 可进入 recall-only；
- 只有明确架构决策 / 用户约束 / 项目规则才进入 Tier 1；
- 不因 `confidence=0.95` 自动污染 prompt。

### 7.3 不升级 file_observation 到项目级默认注入

file observation 太局部、数量太多，只适合 session 或 recall-only。

### 7.4 不做向量数据库 / LLM 知识抽取

当前条目规模小、结构化程度高，JSONL + substring recall 足够。

### 7.5 不立即做主屏全虚拟化

TUI 当前已有 Pager overlay 和 Static 裁剪。主屏 SplitPane / VirtualList 是独立 UX 任务，不应混入 memory 收束。

## 8. 后续任务

### P0：补 project-memory loader/writer 测试

文件：

```text
src/context/__tests__/project-memory-loader.test.ts
src/context/__tests__/project-memory-writer.test.ts
```

覆盖：

- malformed JSONL 跳过；
- Tier 1 kind + confidence 过滤；
- 2K char budget；
- `loadAllProjectMemoryEntries()` 返回 Tier 1 + Tier 2；
- append + compact 去重；
- 超过 200 条裁剪。

### P1：敏感区域 preflight 自动化

目标：修改以下区域前，提示或自动要求读取 manifest：

```text
src/prompt/
src/context/
src/tools/recall.ts
src/agent/dream.ts
src/agent/delivery-gate*.ts
src/agent/ownership*.ts
.rivet/knowledge/
```

可落地路径：

- prompt 规则加强；
- tool-pipeline pre-check；
- reviewer checklist；
- deliver gate warning。

### P1：delegate knowledge packet

目标：在 `delegate_task` / coordinator 层，根据任务关键词和目标文件自动附加相关文档路径。

第一阶段可只做 memory/prompt/recall 区域：

```text
if objective or files mention memory/recall/prompt:
  include manifest + architecture conflict doc + project-memory-system plan
```

### P2：commit fact 策略重审

不要直接把所有 commit fact 升级为 Tier 1。

推荐新策略：

```text
commit fact 默认 recall-only
架构性 commit 由模型/用户显式 remember 为 decision/project_rule
```

### P2：verification supersession 另开任务

这是交付门问题，不混入 memory 本计划。

参考：

```text
docs/tasks/verification-supersession.md
```

## 9. 验收标准

当前已完成的最小闭环：

- `memory.jsonl` 不再污染 git status；
- `memory.jsonl` 可被 recall 搜索；
- `project-memory.md` 仍可作为 curated memory 显式提交；
- 文档明确 memory 分层、提交边界、使用规则；
- 后续任务清楚列出，不混淆 memory 与 delivery gate / TUI 虚拟化。

## 10. 当前提交记录

已完成提交：

```text
e46defe chore(memory): ignore local structured memory cache
b31b518 fix(memory): make recall search structured project memory
```

本方案文档用于补齐上述实现的架构说明，避免后续 agent 只看到代码而不知道为什么这样分层。
