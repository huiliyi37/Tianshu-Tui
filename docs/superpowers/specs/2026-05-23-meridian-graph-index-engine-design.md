# 经脉图（Meridian Graph）索引引擎 — 深度头脑风暴结果

> 日期：2026-05-23
> 主题：天枢运行时原生代码索引引擎架构设计
> 方法：deep-brainstorm（9 scout + 1 反证 + 三轮演化）

## 背景

### 用户需求
天枢对 agent 识别建立文件索引的能力很弱。需要做当前运行态原生可集成的功能实现。

### 项目上下文
- 天枢现有索引：regex symbol-index（4 pattern）+ regex import-graph（文件级）
- code-review-graph MCP 是 Claude Code 宿主侧能力，天枢运行时不可用
- 已有 StigmergyStore（11 信号类型、指数衰减、postTool hook 沉积）
- prefix cache 是核心优化——system prompt 必须稳定
- 运行时规划：HEARTH + Songline 多 worker 架构（乐章级分解、信息素协调）

### 调研发现摘要

| 竞品 | 核心机制 | 天枢适配度 |
|------|----------|-----------|
| CodeGraph | tree-sitter WASM + SQLite FTS5 + worker thread + MCP | 高（同 Node.js 栈） |
| Aider repo-map | tree-sitter + PageRank(0.85) + binary search budget | 高（算法参考） |
| OpenWolf | 文件级 anatomy.md + hooks | 低（无结构理解） |
| Cursor | embeddings + Turbopuffer (SaaS) | 不适用（需外部服务） |
| Sourcegraph/SCIP | 编译器级精确 | 不适用（太重） |

跨领域灵感：
- 海马体索引理论：指针图，不存内容，<10MB/10K 文件
- Hebbian 学习：co-edit 文件加权，衰减，学习真实依赖
- 扩散激活：从编辑点向外传播，top-K 返回
- 分块（7±2）：压缩到 LLM 注意力范围
- 预测编码：预测下一个需要的文件，预加载
- Hilbert 曲线：保局部性的线性化，O(1) 查找
- 蚁群 stigmergy：已有基础设施可直接扩展

---

## 三轮思考过程

### 第一轮：变异

**生态位**：终端编码 agent / TypeScript / 离线 / 轻量 / prefix cache 兼容 / 已有 StigmergyStore

**选择压力**：启动 < 500ms、内存 < 100MB、增量 < 50ms/file、输出稳定、多 worker 兼容

**方案**：

- V1（主流）：全量结构索引 — 启动时 tree-sitter 全量解析 → SQLite → PageRank
- V2（邻近）：海马体双源索引 — 指针图 + 结构边 + 行为边 → spreading activation
- V3（空位）：零依赖 Stigmergy 扩展 — 增强 regex + 信息素排序
- V4（突变）：懒索引 — 按需解析，工作就是索引

**适应度函数**：硬约束=无外部依赖+不破坏 cache+一人可维护 / 加分=首查<200ms+复利+worker 兼容 / 减分=启动阻塞>3s+内存>200MB+native 编译依赖

### 第二轮：选择

**灭绝**：
- V3 — regex 4 pattern 天花板太低，新项目冷启动无信号
- V1 — 3-8s 启动阻塞违反硬约束，全量索引内容变化破坏 prefix cache

**存活**：
- V4（强）— 零启动成本、增量自然、与 postTool hook 完美契合、cache 安全
- V2（中）— 最终态最强，但依赖 V4 基础设施

**回收特征**：
- 从 V3：信息素作为排序信号 → 在 V4 中用 StigmergyStore decay 衰减历史权重
- 从 V1：PageRank + token budget binary search → 图足够大时局部计算

**反证 scout 关键发现**：
1. 双层在注入时坍缩为扁平文本 → 输出合并为单一排序
2. co-edit 噪声（config 文件）→ 黑名单过滤
3. 符号粒度 vs 文件操作 → 内部符号级，输出文件级

### 第三轮：适应

**套路清除**：
- "先全量索引再工作" — IDE 套路，terminal agent 要即时响应
- "需要 MCP server" — 天枢是 agent 本身，直接 import

**扩展适应**：
- postTool hook → 触发按需索引
- StigmergyStore decay → Hebbian 权重衰减
- import-graph 的 Map 结构 → 符号图邻接表
- CacheAdvisor.getArtifactThreshold() → token budget 信号

**收敛验证**：V2 和 V4 收敛到"索引是 agent 行动的副产品，不是前置条件"

---

## 最终方案：经脉图（Meridian Graph）

取名"经脉"：中医经络不是预先画好的路线图，是气血流过后留下的通路。

### 核心理念

**工作就是索引** — agent 不需要额外步骤来"了解项目"。每次 read_file 都在自动构建认知地图。

### 架构

```
Agent Loop
  │
  ├── postTool hook: "read_file" detected
  │     └── MeridianIndexer.indexFile(path)
  │           ├── tree-sitter parse (worker thread, WASM)
  │           ├── extract symbols + edges
  │           ├── 1-hop expand (parse direct imports)
  │           └── write to SQLite (async)
  │
  ├── postTool hook: "edit_file" / "write_file" detected
  │     └── MeridianIndexer.invalidateFile(path)
  │           ├── re-parse changed file
  │           └── update edges + bump Hebbian co-edit weights
  │
  ├── Tool: "repo_map" (agent-callable)
  │     └── MeridianGraph.query(fromPath, budget?)
  │           ├── spreading activation (2-3 hops, decay 0.5/hop)
  │           ├── merge structural edges + behavioral weights
  │           ├── rank by activation score
  │           ├── binary search tag count → fit token budget
  │           └── return ranked symbol list + context snippets
  │
  └── Session persistence: .rivet/meridian.db (SQLite)
        ├── symbols (id, name, kind, path, line, hash)
        ├── edges (source_id, target_id, kind, weight)
        └── access_log (symbol_id, timestamp, session_id)
```

### 关键设计决策

1. **不注入 system prompt** — repo_map 是 tool，agent 主动调用时才计算，不破坏 prefix cache
2. **按需而非全量** — 只索引 agent 实际触碰的文件（通常 20-50/1000）
3. **1-hop 预展开** — read_file 时同时解析 import 的文件，给下次查询提供 2-hop 覆盖
4. **co-edit 过滤** — config/package.json/lock 文件从 Hebbian 权重中排除
5. **符号粒度内部，文件粒度输出** — 图内部精确到符号，输出是文件路径 + 符号摘要

### 实施路径

**Phase 1（第 1 周）：按需 tree-sitter 解析 + 内存图**
- 安装 web-tree-sitter + tree-sitter-wasms（TypeScript only）
- src/repo/meridian-indexer.ts：单文件解析，提取 functions/classes/types/imports
- Worker thread 隔离，periodic reset 防 WASM 内存泄漏
- postTool hook 触发
- 成功标准：200 文件 < 2s，单文件 < 10ms
- 退出条件：WASM 兼容性问题 → 降级回增强 regex

**Phase 2（第 2 周）：SQLite 持久化 + repo_map tool**
- node:sqlite 创建 .rivet/meridian.db
- content hash 增量
- repo_map tool：spreading activation + token budget binary search
- 成功标准：agent 在理解阶段调用 repo_map 获得有用上下文
- 退出条件：node:sqlite FTS5 不完整 → LIKE 查询降级

**Phase 3（第 3 周）：行为学习 + worker 集成**
- Hebbian co-edit 权重 + StigmergyStore 集成
- Worker affinity（每个 worker 的 repo_map 自动 bias 向其 domain）
- access_log 跨 session 分析
- 成功标准：3 session 后 top-7 准确率 > 80%
- 退出条件：Hebbian 噪声无法过滤 → 回退纯结构排序

---

## 风险与应对

| 风险 | 应对 |
|------|------|
| 首次 session 图为空 | 1-hop 预展开 + fallback 到现有 regex import-graph |
| WASM 内存泄漏 | worker thread + 每 250 parse 重建 |
| node:sqlite experimental | better-sqlite3 作为 fallback |
| 大项目图太大 | MAX_NODES=5000 上限，只索引触碰的文件 |
| co-edit 噪声 | 黑名单（config/lock/generated） |
| 模型不调用 repo_map | 在 system prompt 的 tool description 中明确引导 |

---

## 下一步

Phase 1 的第一个具体动作：`npm install web-tree-sitter tree-sitter-wasms`，然后创建 `src/repo/meridian-indexer.ts` 实现单文件 tree-sitter 解析。
