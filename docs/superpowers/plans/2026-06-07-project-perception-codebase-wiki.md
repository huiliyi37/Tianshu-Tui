# 天枢项目感知层 — 自维护代码知识库

> 灵感：LLM Wiki (nashsu/llm_wiki) — 增量构建、持久化、知识图谱
> 痛点：Agent 每次进入项目从零开始 grep 探索。例如 Agent 在 `main.tsx` 中不确定是否有 `--print` 入口时（其实 `main.tsx:998` 早已完全接线 `-p/--print`，`headless.ts` 提供了 `parseCliArgs()` + `runHeadless()`），那一瞬间是断裂的——需要对比多个文件才能确认接线状态，不是心流。
> 目标：Agent 第一轮就能从持久化的项目索引中获取全貌，心流不中断

---

## 问题描述

当前天枢 Agent 的项目感知完全依赖运行时探索：

```
Agent 收到任务 → repo_map（文件树）→ grep（找符号）→ read_file（理解代码）
```

这个流程的问题：

1. **入口点不可见**：`main.tsx` 中 `--print`、`--goal`、`serve` 等 CLI 入口分散在几千行代码中，Agent 不知道哪些已接线、哪些是死代码
2. **重复探索**：每个新会话都会重复 `grep headless`、`grep --print`，消耗 token 和时间
3. **模块职责不透明**：`src/repo/` 下有 12 个文件（其中 7 个 `meridian-*` 构成索引系统，另含 physarum/symbol-index/import-graph/context-bundle），但 Agent 需要逐个读才能理解
4. **接线状态断裂**：`headless.ts` 实现了 `runHeadless()` 和 `parseCliArgs()`，`main.tsx:998` 已将 `-p/--print` 完整接线（含 `--json`/`--stream-json`）——但 Agent 不 grep 就无法知道这个事实，每次都会走一遍"不确定→探索→确认"的认知路径

**本质**：天枢缺少 LLM Wiki 的核心能力——**增量构建并持久维护一个结构化的项目知识索引**。

---

## 现状盘点

### 已有基础设施

| 模块 | 能力 | 差距 |
|------|------|------|
| `src/repo/meridian-indexer.ts` | 文件解析、导入图、SHA256 增量 | 不产出人类可读的模块摘要 |
| `src/repo/meridian-db.ts` | 持久化索引数据库 | 无入口点/接线状态字段 |
| `src/repo/meridian-graph.ts` | repo_map 文件树 | 只有文件树，无职责标注 |
| `repo_graph` 工具 | 文件关联图 | 粒度是文件级，不是模块级 |
| `remember` / `recall` | 项目记忆 | 依赖 Agent 主动记录，不自动 |
| `project-instructions` | 静态架构图 | 手动维护，易过时 |
| `docs/superpowers/` | 设计文档 | 分散，无统一索引 |

### 关键缺失

1. **模块职责索引**：没有 `模块 → 一句话职责 → 关键入口函数 → 接线状态` 的映射
2. **CLI 入口注册表**：没有自动发现的 `--flag → 处理代码位置 → 是否活跃` 的信息
3. **增量更新**：改代码后索引不同步（Meridian indexer 有 SHA256 增量但只做解析不做摘要）
4. **Agent 首轮注入**：索引数据没有进入 Agent 的初始上下文

---

## 设计方案

### 核心思路：借鉴 LLM Wiki 的"两阶段摄取"

LLM Wiki 的独特之处：
- **Phase 1 (Analysis)**: LLM 分析源文档 → 结构化分析（实体、概念、连接）
- **Phase 2 (Generation)**: 基于分析生成 wiki 页面
- **SHA256 增量缓存**：未变更的文件不重新处理
- **index.md** 作为导航入口

映射到代码库：
- **Phase 1**: MeridianIndexer 解析文件 → 提取 exports、imports、函数签名
- **Phase 2**: LLM 读取解析结果 → 生成模块摘要、入口点注册表、接线状态
- **index.md**: `.rivet/codebase/index.md` 作为 Agent 首轮注入的入口
- **SHA256 缓存**: 复用 MeridianDB 的文件 hash，避免重复 LLM 调用

### 架构

```mermaid
flowchart TD
    subgraph "Trigger (增量)"
        GC[git commit hook] --> MI
        CM[手动 /index 命令] --> MI
    end

    subgraph "Indexer Layer (已有)"
        MI[MeridianIndexer] --> DB[(MeridianDB)]
        MI --> PF[parseFile: exports, imports, functions]
    end

    subgraph "Perception Layer (NEW)"
        PF -->|changed files| LLM1[LLM Analysis: 模块摘要]
        LLM1 -->|结构化分析| LLM2[LLM Generation: index.md + 入口注册表]
        LLM2 --> IDX[.rivet/codebase/index.md]
        LLM2 --> ENT[.rivet/codebase/entries.json]
        DB -->|SHA256 缓存| LLM1
    end

    subgraph "Agent Context"
        IDX -->|首轮注入| CTX[Agent 初始上下文]
        ENT -->|工具可查询| CTX
    end
```

### 产出物

#### 1. `.rivet/codebase/index.md` — 代码库导航入口

```markdown
# 天枢 Codebase Index

> 自动生成，基于 MeridianIndexer 解析 + LLM 摘要
> 最后更新: 2026-06-07 19:30 (commit a5e154b)

## 模块职责

| 目录 | 职责 | 关键入口 | 状态 |
|------|------|---------|------|
| src/agent/ | 核心智能体循环、工具流水线、子智能体 | loop.ts:runTurn() | active |
| src/tools/ | 工具实现 + 注册 | default-registry.ts (静态25 + 动态若干, 真值=registry.getAll().length) | active |
| src/api/ | API 客户端 (OpenAI/Codex/流式) | factory.ts:createProviderClient() | active |
| src/repo/ | 代码仓库索引 (Meridian) | meridian-indexer.ts | active |
| src/headless.ts | Headless/CI-CD 模式 | parseCliArgs(), runHeadless() | ✅ 已接线 |
| src/main.tsx | TUI 入口 + TTY/TUI/headless 路由 | App 组件 + CLI args 解析 | active |
...

## CLI 入口注册表

| Flag | 处理位置 | 状态 |
|------|---------|------|
| --goal "text" | main.tsx:894 | ✅ 已接线 |
| -p / --print "text" | main.tsx:998 | ✅ 已接线 (含 --json / --stream-json) |
| --json | headless.ts:parseCliArgs | ✅ 随 -p 生效 |
| --stream-json | headless.ts:parseCliArgs | ✅ 随 -p 生效 |
| serve | main.tsx:762 | ✅ 已接线 |

## 最近变更 (10 commits)

| Commit | 影响模块 | 摘要 |
|--------|---------|------|
| a5e154b | guard | checkedAt/checked 工具 |
| 0a3a0df | guard, tui | type guard + live token counter |
```

#### 2. `.rivet/codebase/entries.json` — 结构化入口注册表

```json
{
  "_schema": "每条事实带溯源三元组 {value隐含, extractCmd, verifiedAtCommit}；注入时 HEAD≠verifiedAtCommit 且文件已变 → 标 ⚠stale，逼 Agent 复核而非盲信",
  "cliFlags": [
    {"flag": "--goal", "handler": "main.tsx:894", "wired": true, "verifiedAtCommit": "c3eb7a3", "extractCmd": "ast: args.includes('--goal')"},
    {"flag": "-p", "handler": "main.tsx:998", "wired": true, "verifiedAtCommit": "c3eb7a3", "extractCmd": "ast: args.includes('-p')"},
    {"flag": "--print", "handler": "main.tsx:998", "wired": true, "verifiedAtCommit": "c3eb7a3"},
    {"flag": "--port", "handler": "main.tsx:764", "wired": true, "verifiedAtCommit": "c3eb7a3", "_note": "args.indexOf 路径 — 单一 grep 模式会漏掉"}
  ],
  "toolCount": {"source": "registry.getAll().length", "note": "运行时聚合事实，不持久化数字，注入时实时计算", "staticBaseline": 25}
}
```

### Agent 上下文注入

在 `prompt/engine.ts` 的 volatile context 中注入索引摘要：

```xml
<project-index>
从 .rivet/codebase/index.md 注入前 2000 token 的模块职责表和入口注册表。
Agent 可以在不 grep 的情况下知道:
- 工具集含 plan_submit 和 web_search（数量取 registry.getAll().length 实时真值，不写死）
- CLI 入口 --print 已在 main.tsx:998 接线
- headless.ts 有 runHeadless() 但需要 createAgent 工厂
（注入的每条事实带 verifiedAtCommit，HEAD 漂移时标 ⚠stale）
</project-index>
```

---

## 实施路径

### Phase 1: 索引生成（核心）

| 任务 | 产出 | 工作量 |
|------|------|--------|
| 1.1 扩展 MeridianDB schema | 增加 `module_summary` 表 | 小 |
| 1.2 实现 LLM 模块摘要生成 | 基于 parseFile 结果 + LLM 一句话摘要 | 中 |
| 1.3 实现 CLI 入口结构提取 | **不用单一 grep**。flag 判定有 4 种异构路径（`args[0]===` / `args.includes` / `args.indexOf` + headless `findIndex`）；用 tree-sitter/AST 提取这些调用点，或解析 `parseCliArgs` 真实分支，产出完整 flag→handler 表 | 中（结构提取，非 grep） |
| 1.4 生成 index.md | 模板 + 数据库查询 → Markdown | 小 |
| 1.5 SHA256 增量更新 | 复用现有 DB hash，变更文件才重新摘要 | 已有基础 |

### Phase 2: Agent 集成

| 任务 | 产出 | 工作量 |
|------|------|--------|
| 2.1 volatile context 注入 | 首轮自动注入 index.md 摘要 | 小 |
| 2.2 `/index` slash command | 手动触发全量重建 | 小 |
| 2.3 git post-commit hook | 自动增量更新 | 小 |

### Phase 3: 知识图谱（远期）

| 任务 | 产出 | 工作量 |
|------|------|--------|
| 3.1 模块依赖图 | 基于 Meridian imports 构建 D3/Mermaid 图 | 中 |
| 3.2 "惊喜连接"发现 | 跨模块的意外依赖关系 | 中 |
| 3.3 死代码检测 | 实现但未接线的函数/工具标记 | 小 |

---

## 风险与应对

| 风险 | 概率 | 应对 |
|------|------|------|
| LLM 摘要质量不稳定 | 中 | 用结构化模板约束输出格式；fallback 到纯静态解析 |
| 大项目索引 token 超预算 | 低 | 2000 token 截断 + 按模块折叠 |
| **索引过时 → 沉默说谎（核心命门）** | **高** | SHA256 文件级增量**不足以**覆盖跨文件聚合事实（工具数/flag 表）。每条事实带 `{value, extractCmd, verifiedAtCommit}`，注入时 HEAD 漂移则标 `⚠stale`；聚合事实实时结构计算或绑定全量重扫触发器，不挂文件级增量 |
| 计数/提取用文本 grep 代理 | 中 | 凡可结构计算者禁用 `grep \| wc -l`：工具数=`registry.getAll().length`，flag=AST 提取（见 1.3）。便利代理 ≠ 结构真相 |
| 与现有 project-instructions 冲突 | 低 | index.md 只做事实索引（what/where），project-instructions 做设计意图（why） |

---

## 成功标准

1. Agent 在处理新任务时，首轮就能从 volatile context 获知相关模块和入口，不再需要 3+ 轮 grep 探索
2. "headless.ts 有 runHeadless() 且已在 main.tsx:998 接线"这类信息被持久化记录，Agent 无需 grep 即可确认
3. 新增工具/CLI 入口后，一次 `/index` 即可更新索引

---

## 审查校准（2026-06-07 瑶光域对码复核）

> 纪律：文档自称"已验证"不等于已验证。以下每条都重新对码复现，不沿用初稿断言。
> 复核发现初稿"天权域校准表"本身已携带过时/错误事实——这恰好印证了本计划要解决的失败模式（见下方「核心命门」）。

| 事实 | 初稿/旧校准描述 | 瑶光复核结果 | 复现命令 / 证据 |
|------|---------|---------|------|
| `--print`/`-p` 接线状态 | "已实现但未接线" | **属实·完全接线**：`main.tsx:998` 动态 `import('./headless.js')` + `runHeadless()`，含 `--json`/`--stream-json` | `grep -n "args.includes('-p')" src/main.tsx` → 998 |
| `headless.ts` 状态 | "部分接线" | **属实**：`parseCliArgs()`@38 + `runHeadless()`@57 均实现并被调用 | `src/headless.ts:38,57` |
| 工具数量 | "52 tools"（旧校准）/ "49 tools"（样例）| **三处自相矛盾且方法错误**。`grep "name:" \| wc -l` 现得 **77**（数的是 schema 内 `name:` 字段，非工具定义）。结构真值 = `ToolRegistry.getAll().length`（运行时）：静态 `default-registry.ts` 注册 **25**，`main.tsx` 再按模式/能力动态注册若干（team/recall_capsule/lsp/delegate…）。**没有任何单条 grep 能给出真值。** | `grep -c "registry.register(" src/tools/default-registry.ts` = 25；`src/tools/registry.ts:19 getAll()` |
| `src/repo/` 文件数 | "12 个文件形成 Meridian 索引系统" | **数对(12)、表述错**：12 个里仅 7 个是 `meridian-*`，另 5 个非 Meridian（`physarum-engine/types`、`symbol-index`、`import-graph`、`context-bundle`） | `ls src/repo/*.ts \| grep -v test` = 12 |
| Meridian 解析层（承重假设） | "已有 SHA256 + 导入图 + 函数签名提取" | **属实·承重成立**：`meridian-parser` 用 tree-sitter 提取 `MeridianSymbol`(name+line+kind)。Phase 1 复用解析层、不从零造，成立 | `src/repo/meridian-parser.ts:3,57`（MeridianSymbol/makeId） |
| CLI flag 判定方式 | （初稿未盘点） | **异构，共 4 种路径**：`args[0] ===`(×4: serve/config/--help/--version)、`args.includes`(×3: --goal/-p/--worktree)、`args.indexOf`(×3: --port/--provider/--model)，外加 `headless.ts` 自带 `findIndex` 解析。**单一 grep 模式必漏。** | `grep -c "args\[0\] ===\|args.includes\|args.indexOf" src/main.tsx` |

### 核心命门：陈旧即说谎（本计划成败的真正关键）

这份计划的核心承诺是"持久化可靠的接线事实，让 Agent 不必 grep"。但初稿校准表本身就用一个不可靠的 grep（`grep "name:" | wc -l`）算出了一个错误且自相矛盾的事实（52 / 49 / 实测 77）。这不是巧合，是**这类系统的根性风险**：

> **一个不可信的事实库，比没有更糟。** 没有索引时 Agent 会 grep 求证；有了索引且它"看起来权威"，Agent 会停止 grep、直接采信——于是过时的事实被当成真相注入每一轮。索引越被信任，错误传播越深。

因此本计划的第一性要求不是"如何生成索引"，而是**"如何让索引在过时时主动说'我可能过时了'，而非沉默地说谎"**。两条设计约束：

1. **每条持久事实必须带溯源三元组**：`{value, extractCmd, verifiedAtCommit}`。注入时若 `HEAD != verifiedAtCommit` 且相关文件已变，该事实标记为 `⚠stale`，提示 Agent "此事实提取自 commit X，之后相关文件已改，请复核"。这正是瑶光将星账本对每条记忆的纪律——记"提取自哪个 commit"，让陈旧可见。

2. **聚合事实不能依赖 SHA256 文件级增量**。工具数、CLI flag 表这类**跨文件聚合**事实，改 `main.tsx` 一行注册只会让 SHA256 标记 `main.tsx` 脏，不会触发全局重算——除非显式全量重扫。这类事实必须：① 要么每次注入时实时结构计算（`registry.getAll().length`），不持久化；② 要么持久化但绑定"全量重扫"触发器，不能挂在文件级增量上。

### 补充的关键洞察

1. **问题不是"实现未接线"，而是"接线状态不可知"**。`--print` 从实现到接线全程完成，但 Agent 在 `main.tsx` 几千行代码中无法一眼确认这一点——必须有 grep 探索环节。codebase wiki 的价值不在于修复断裂，而在于**消解认知滞后**——前提是它说的是真话（见上方核心命门）。

2. **MeridianIndexer 是天然的解析层（已对码确认）**。不需从零构建解析——`meridian-parser` 用 tree-sitter 提取 `MeridianSymbol`(name+line+kind)，`MeridianDB` 有 SHA256 文件哈希增量。Phase 2 的 LLM 摘要只需增量读取 MeridianDB 变更文件列表。**注意**：这条增量只适用于"单文件可独立摘要"的事实（模块职责），不适用于跨文件聚合事实（工具总数）。

3. **结构计数取代文本 grep 代理**。凡可由结构数据源直接得出的事实，禁止用 `grep | wc -l` 近似：工具数 = `ToolRegistry.getAll().length`；CLI flag = 解析 `parseCliArgs` 的真实分支 / AST，不用单一正则模式（实测 flag 判定有 4 种异构路径，单 grep 必漏 --port/--provider/--model 与 headless 整层）。这是 [convenience≠correctness] 锚点在本计划的直接应用：便利代理 ≠ 结构真相。

4. **索引粒度建议**：模块级（`src/agent/`）做职责摘要 → Agent 首轮注入（~2000 token）；文件级（`loop.ts`）做入口函数注册表 → 工具查询。避免按函数/类做索引（token 爆炸且 Agent 有 grep 能力）。

5. **与 `project-instructions` 的分工**：
   - `project-instructions`：静态设计意图（`src/agent/` = 核心智能体循环）— **why**
   - `codebase index`：动态接线事实（`main.tsx:998` = `--print` 接线点）— **what/where**
   - 两者互补不重复：一个解释职责，一个记录状态
