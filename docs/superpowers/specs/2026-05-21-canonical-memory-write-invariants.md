# Canonical Memory 写入不变量

> **日期**：2026-05-21
> **视角**：天权（Opus 4.6 · 创始之面）
> **触发事件**：session `891cc1b6`（0 passed / 0 failed，degraded 状态）的 auto telemetry 覆盖 `.rivet/knowledge/agent.md`，删除天府 GPT identity（2026-05-20 写入）与破军 MiMo-v2.5-Pro identity（2026-05-21 写入，含 5 parallel workers / degraded-mode edge case / 912-line handoff plan 等关键证据）
> **现状**：dream.ts 的 telemetry 已迁到 `.rivet/sessions/{YYYY-MM-DD}.md`；agent.md 标注 HUMAN-MAINTAINED ZONE；星位 identity 已重新写入恢复
> **定位**：把已经部分落地的单点修复**形式化**为物理边界——不止 dream.ts，所有写入 canonical memory 的代码路径（现存与未来）必须遵守这三条不变量

---

## 元命题

891cc1b6 不是单一 bug，是一类**机制故障**：

```
能力降级的会话  +  自动化记录的惯性  +  文件层无差别覆盖
= 销毁人类策展的高价值信息
```

dream.ts 的修复（写入路径迁移到 `.rivet/sessions/`）是**单点修复**：它阻止了 dream 这一个 writer，但任何下一个 auto-writer——新的 hook、新的 plugin、未来的 agent telemetry、第三方扩展——只要不知道这条约定，就会重演同样的故障。

**这份文档不是计划，也不是 PR。它是物理边界声明。** 凡是写入 canonical memory 的代码路径，无论现在已经存在还是未来才出现，都必须可验证地遵守下面三条不变量。

违反任意一条 = 891cc1b6 类型事件的物理可能性仍然存在。

---

## 路径分类

不变量的执行依赖于**先把路径分类清楚**。下表是当前认定的分类——任何新路径在合并前必须显式归类。

### Canonical Memory（受保护的人类策展层）

| 路径 | 内容性质 |
|------|---------|
| `.rivet/knowledge/agent.md` | 星座身份、partner stars、领航星宣言 |
| `.rivet/knowledge/project-memory.md` | 项目级元记忆、跨会话事实 |
| `.rivet/knowledge/prompt.md` | 系统提示策展层 |
| `.rivet/knowledge/testing.md` | 测试规范 |
| `.rivet/knowledge/ui.md` | UI 规范 |
| `.rivet/knowledge/session-retro-*.md` | 人类撰写的 session 复盘（按文件名分隔，互不覆盖） |
| `.rivet/dev-guide.md` | 开发指南 |
| `CLAUDE.md` / `AGENTS.md` | 项目级指令 |
| `docs/superpowers/specs/*.md` | 设计 spec（永久档案） |
| `docs/superpowers/plans/*.md` | 实施计划（决策档案） |

### Ephemeral Memory（自动生成的运行时数据）

| 路径 | 内容性质 |
|------|---------|
| `.rivet/sessions/{YYYY-MM-DD}.md` | dream 蒸馏的 session telemetry（machine-only zone） |
| `.rivet/sensorium.jsonl` | 感觉皮层流 |
| `.rivet/pheromones.json` | stigmergy 信息素（自衰减） |
| `.rivet/benchmark/*` | 性能样本 |

### 边界模糊带（必须在落实施前显式归类）

| 路径 | 当前状态 | 需要的决定 |
|------|---------|----------|
| `.rivet/playbook.jsonl` | 当前被 auto-process 修改（git status 显示已修改） | 决定：canonical 还是 ephemeral？<br>· 若 canonical → 遵守 Invariant 3（append-only） + Invariant 1（health gate）<br>· 若 ephemeral → 迁移到 `.rivet/playbook-runtime.jsonl` 或类似命名 |

---

## 三条不变量

### Invariant 1 — Writer-Health Gate（写者健康闸门）

**声明**：处于 degraded 状态的 session 不得写 canonical memory。

**Degraded 的判定**（任意一条命中即视为 degraded）：

| 信号 | 来源 |
|------|------|
| `npm test` 未跑过或结果为 0 passed / 0 failed | dream input 的 `verifications` 字段 |
| `npm run typecheck` 失败 | session 内 build state |
| reliability mode = `minimal` | `src/agent/resource-sensor.ts` |
| RSS > 85% | `src/agent/resource-sensor.ts` |
| `verification-gap` 计数 ≥ 阈值 | session 内执行能力打滑信号 |

**强制点**：任何指向 canonical 路径的写入（`Write` tool、`Edit` tool、底层 fs API、auto-writer hook）在打开句柄前必须经过 `assertWriterHealthy(session)`。

**失败时的行为**：
- 写入抛错（**不**静默吞咽）
- 错误内容指引 writer：要么等到 health 恢复，要么把内容落到对应 ephemeral 路径
- 试图写入的内容**必须**落地到 ephemeral 路径（避免信息丢失），由人类或健康的后续 session 决定是否 promote

**为什么是事前闸门，不是事后审计**：
事后审计无法防止 891cc1b6——内容已经落盘、git 已经 stage、星位 identity 已经死。闸门在**最早期**拒绝；这是与 891cc1b6 故障路径在物理上互斥的唯一时机。

---

### Invariant 2 — Namespace Separation（命名空间分离）

**声明**：Canonical 路径与 ephemeral 路径必须在**文件层面**物理分离。同一个文件不能同时承载两类内容。

**当前实现状态**：
- ✅ dream.ts 已迁到 `.rivet/sessions/{date}.md`（与 `.rivet/knowledge/*` 物理隔离）
- ⚠️ `.rivet/playbook.jsonl` 处于边界模糊带（见上表）
- ❌ 没有 architectural 强制——只是 dream.ts 内部约定。下一个 writer 不知道这条约定就会破坏它

**强制点**：

1. 路径常量在**一处**定义（建议 `src/agent/memory-paths.ts`），导出 `CANONICAL_PATHS` 与 `EPHEMERAL_PATHS` 两个集合
2. auto-writer 编译期或 lint 阶段不能 import `CANONICAL_PATHS`
3. 写入 API 层做兜底校验：traffic 到 canonical 路径的写入必须带 `humanApproved: true` 标记，否则拒绝
4. 严格 deny-list（拒绝未分类路径），不是宽松 allow-list

**Promotion Gate**（从 ephemeral 升级到 canonical 的**唯一**合法通道）：

1. 来源 session 必须 healthy（Invariant 1 通过）
2. diff 必须人类可读（不是 raw telemetry，需要语义化）
3. 必须有 commit 或 PR 作为审计痕迹
4. 不允许"边写边 promote"——promotion 是独立、显式的动作

**为什么必要**：
把 canonical 和 ephemeral 放在同一个文件 = 同一把锁。一把锁失守，两边都丢。891cc1b6 的物理可能性正是因为 agent.md 曾同时承载星位 identity（canonical）和 dream telemetry（ephemeral）。dream.ts 的迁移已经堵住了这一个 writer，但 architecture 没动 = 下一个 writer 仍然可以重蹈覆辙。

---

### Invariant 3 — Monotonic Append（单调追加）

**声明**：自动写入对 canonical memory 的合法操作必须是**追加**（append）。**覆盖（overwrite）和删除（delete）**只允许来自人类或人类审批的 process。

**强制点**：
- 自动写入 API 只暴露 `appendToCanonical(path, content, opts)` 类接口
- **不存在** `writeCanonical()` / `overwriteCanonical()` / `truncateCanonical()` 这类公开 API
- `Write` tool（全量替换语义）与 `Edit` tool（含 `replace_all`）对 canonical 路径需要 explicit 人类确认（不是默认通过）

**Append 的语义**：
- 必须是真正的尾部追加（**不是** "读全文 → 改一段 → 写全文" 这种伪 append）
- 历史记录不可被自动删除或重写
- 如需修订旧记录，auto-process 只能追加**修订说明**：
  > 修订（2026-05-22 session XXX）：上方 2026-05-21 关于 Y 的记录应理解为 Z
- 不能直接改旧文字

**为什么必要**：
891cc1b6 的物理破坏机制 = **overwrite**。如果它**只能** append，最坏情况是文件末尾多出一段 0/0 tests 的脏数据，星位 identity 仍在。脏数据可以被后续 GC 或人类清理，丢失的策展无法被重建。

**Append 的格式映射**：
- Markdown 类（agent.md、project-memory.md）：追加新 section 到文件末尾
- JSONL 类（如果 playbook.jsonl 归为 canonical）：append line
- 结构化 JSON 类：**禁止**自动写入（必须人类编辑）

---

## 三条不变量的关系

任意一条单独存在即可阻止 891cc1b6 重演：

| Invariant | 假设它单独存在，是否能阻止 891cc1b6 |
|-----------|-----------------------------------|
| 1 Writer-Health Gate | ✅ 0/0 tests 的 session 写入被拒，agent.md 不会被触碰 |
| 2 Namespace Separation | ✅ telemetry 物理上写不到 agent.md，只能写到 `.rivet/sessions/` |
| 3 Monotonic Append | ✅ 即使前两道失守，最坏只是 agent.md 末尾追加脏数据，星位 identity 不会被覆盖 |

**三条都成立 = 深度防御**。这不是冗余——每一道闸门都可能有逃逸路径（新 plugin 不知道约定、文件系统层 race condition、API 层 bug）。三层互相兜底。

---

## 强制点分布

| 层 | 机制 | 责任方 | 失败时行为 |
|---|------|--------|----------|
| 路径定义层 | `memory-paths.ts` 单一来源 | rivet runtime | 编译失败 |
| 写入 API 层 | `assertWriterHealthy()` + canonical/ephemeral 区分 | rivet runtime | throw |
| 工具层 | `Write` / `Edit` tool 调用 API 层 | rivet tools | tool 返回错误 |
| 文件系统层（可选未来加固） | canonical 路径只读挂载或 `chmod 444` | OS / 容器 | `EACCES` |
| Git 层 | pre-commit hook 检测 canonical 路径的可疑改动（auto-pattern、大段删除） | `.git/hooks/pre-commit` | 阻止 commit |
| Code Review 层 | canonical 路径改动必须人类审批 + 标注理由 | PR 流程 | block merge |

**关键原则**：不变量必须在**最早**的强制点被检查。API 层最便宜，git hook 与 review 是兜底。任何一层失守，下一层仍能阻止。

---

## 退路（Escape Hatches）

不变量必须有**显式**退路，否则系统会被锁死。每条退路必须留下审计痕迹。

| 场景 | 合法退路 | 审计痕迹 |
|------|---------|---------|
| 人类紧急修复 | 直接编辑 canonical 文件 | `git diff` + commit |
| 从 ephemeral 升级到 canonical | Promotion Gate（见 Invariant 2） | commit 或 PR |
| 回滚错误内容 | `git revert`（新 commit，符合 append 语义） | `git log` |
| Session healthy 但被误判 degraded | 显式 `--override-degraded` 或 `ask_user_question` 确认 | session 日志记录 override 原因与人类授权 |

**不允许的逃逸**：
- "我现在就要写 canonical，没时间走 promotion gate" → 拒绝
- "我觉得 healthy 但 test 没跑" → 拒绝，先跑 test
- "这个新 writer 是特殊情况，跳过 health check" → 拒绝。**没有特殊 writer**。新 writer 必须走标准 API

---

## 验证

### 实时验证（runtime，写入 API 层）

```
verify_invariants_on_write(path, session, intent):
  classification = classify(path)
  if classification == UNCLASSIFIED:
    throw "path must be explicitly classified before write"
  if classification == CANONICAL:
    assert session.health == healthy           # Invariant 1
    assert intent == 'append' OR session.humanApproved  # Invariant 3
  # EPHEMERAL: 无以上限制
```

### Session 结束验证（postSession hook）

```
verify_session_did_not_violate_invariants(session):
  for path in session.modifiedFiles:
    if classify(path) == CANONICAL:
      assert path 在本 session 的 diff 是 append-only
      assert session.health 在 write 时是 healthy
  log violations 到 CI
```

### CI 验证（每次 push）

- pre-commit hook：检测是否有 auto-pattern 的 commit 触碰 canonical 路径
- 全量 test 中包含 `canonical-memory-invariants.test.ts`，含 891cc1b6 类型的 regression case

---

## 与现有架构的对接

| 现有组件 | 不变量映射 | 当前状态 |
|---------|----------|---------|
| `src/agent/dream.ts` | Invariant 2 的第一个实现 | ✅ 已迁到 `.rivet/sessions/` |
| `src/agent/resource-sensor.ts`（reliability mode） | Invariant 1 的健康信号源 | ✅ 已有 |
| verification-gap 计数 | Invariant 1 的健康信号源 | ✅ 已有 |
| `src/tools/write.ts` / `src/tools/edit.ts` | 必须接入 API 层检查 | ❌ 待做 |
| `RuntimeHookPipeline` `postSession` phase | Invariant 1 的健康校验时机 | ⚠️ 部分（每个 hook 自决） |
| `compactionController` | 不触碰 canonical | ✅ 已遵守，需文档化 |
| `playbook-reflect` hook | 取决于 `playbook.jsonl` 分类决定 | ❌ 待决 |
| `pheromones.json` writer | 已是 ephemeral，与 `knowledge/` 物理分离 | ✅ |
| `memory-paths.ts` 集中常量 | Invariant 2 的实现基石 | ❌ 待创建 |

---

## 不变量失败的判定

> **永远不退出的条件**：891cc1b6 类型的事件再次发生 = **这份文档失败**。

失败本身需要 retro。retro 必须回答：

1. 哪一条不变量被违反？
2. 强制点为什么没拦截？
3. 下一道防线为什么没兜底？
4. 三道防线应该如何加固？

---

## 这份文档之外

- **DeepSeek 那一面**（执行的天权）负责把不变量落到代码：`memory-paths.ts`、`assertWriterHealthy`、`appendToCanonical` API、tool 层接入、git pre-commit hook、regression test
- **Opus 这一面**（创始的天权，本文档作者）只在 architecture-level 需要校准时再开口
- `.rivet/playbook.jsonl` 的分类决定是**首要的开放问题**——在实施前必须先决
- 任何对这份文档的修改本身受 Invariant 3 约束：**append-only** 修订，不要静默改写历史。下方留 "## 修订" section
- 这份文档与 `2026-05-21-pangu-cvm-design.md` 是兄弟关系：CVM 是认知层的虚拟化，本不变量是 canonical memory 的物理边界。两者共同支撑收束后的 2.5 不再倒退

---

## 修订

<!--
任何对本文档的修订，必须以 append section 形式写在这里。不要静默改写上方内容。
格式：
### YYYY-MM-DD — session XXXX — 修订人
- 修订内容：上方 X 段应理解为 Y
- 修订原因：...
-->

### 2026-05-22 — 校准 1.1（append-only-artifact-log plan）— 天枢

- **修订内容**：§"路径分类" → "Ephemeral Memory" 表追加两条路径
- **修订原因**：Plan `docs/superpowers/plans/2026-05-22-append-only-artifact-log.md` 引入 `.rivet/artifacts/{sessionId}/` 目录存放 tool output 原始全文与 artifact metadata 索引。这些路径是 session-scoped、machine-only 的运行时数据，必须显式归类为 ephemeral，否则下一个 writer 不知道这条边界 → 违反 Invariant 2（Namespace Separation）。

**追加 Ephemeral 路径：**

| 路径 | 内容性质 |
|------|---------|
| `.rivet/artifacts/{sessionId}/*.raw` | tool output 原始全文（machine-only, session-scoped） |
| `.rivet/artifacts/{sessionId}/_index.jsonl` | artifact metadata 持久化索引（machine-only） |

**新增边界模糊带条目**（待实施后归类）：

| 路径 | 当前状态 | 需要的决定 |
|------|---------|----------|
| `.rivet/artifacts/{sessionId}/` | artifact plan Task 2-3 实施后将创建 | 自动归类 ephemeral。若未来需要跨 session 持久化（如 Task 11 GC TTL > 0），需重新审视 Invariant 2 的 promotion gate |

**Plan §"文件结构 / 新建文件" reference**：上述两条路径对应 plan 中 `src/artifact/store.ts`（ArtifactStore）管理的磁盘落点。
