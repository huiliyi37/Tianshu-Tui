# Meridian Code Graph — 技术架构文档

## 概述

Meridian 是一个增量式代码图索引系统，在 agent 读写文件时自动构建项目的结构关系图（import/export、函数调用），并通过 spreading activation 算法为 LLM 提供结构化的上下文发现能力。

## 核心设计原则

- **增量构建**：仅在文件被读/写时解析，content-hash 去重避免重复工作
- **零配置**：无需用户手动触发，hook 自动驱动
- **Token 预算**：输出受 token budget 约束，保证不超出上下文窗口
- **持久化**：SQLite 存储，跨 session 复用已有索引

## 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│                        main.tsx                              │
│  _meridianIndexerRef = new MeridianIndexer(cwd)             │
│  reg.register(createRepoGraphTool(() => _meridianIndexerRef))│
│  AgentLoop config: { meridianIndexer }                      │
└──────────────┬──────────────────────────────┬───────────────┘
               │                              │
               ▼                              ▼
┌──────────────────────────┐   ┌──────────────────────────────┐
│   repo_graph tool        │   │   meridian-hook (postTool)   │
│   (src/tools/repo-graph) │   │   (src/agent/hooks/meridian) │
│                          │   │                              │
│  execute() →             │   │  read_file  → indexFile()    │
│    indexer.query(file)   │   │  write/edit → invalidateFile()│
└──────────┬───────────────┘   └──────────────┬───────────────┘
           │                                   │
           ▼                                   ▼
┌─────────────────────────────────────────────────────────────┐
│                  MeridianIndexer (facade)                    │
│                  src/repo/meridian-indexer.ts                │
│                                                             │
│  • indexFile(path) — parse + 1-hop expand imports           │
│  • invalidateFile(path) — re-parse on write                 │
│  • query(seed, opts) — graph traversal + ranked output      │
└────────┬────────────────────┬───────────────────────────────┘
         │                    │
         ▼                    ▼
┌────────────────────┐  ┌─────────────────────────────────────┐
│  meridian-parser   │  │         meridian-db (SQLite)         │
│  (tree-sitter)     │  │                                     │
│                    │  │  files: path, hash, imports, ts      │
│  parseTypeScript   │  │  symbols: name, kind, line, file    │
│  File() →          │  │  edges: from_sym → to_sym, kind     │
│  { symbols,        │  │                                     │
│    edges,          │  │  needsParse(path, hash) → bool      │
│    imports,        │  │  upsertFile(parseResult)             │
│    hash }          │  │  getEdgesFrom/To(file)              │
└────────────────────┘  │  getAllFiles() / getStats()          │
                        └─────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────┐
│              meridian-graph (spreading activation)           │
│              src/repo/meridian-graph.ts                      │
│                                                             │
│  buildRepoMap(db, seedFile, { maxHops, decay, maxTokens })  │
│                                                             │
│  算法：                                                      │
│  1. seed file score = 1.0                                   │
│  2. BFS 沿 edges 扩散，每跳 score *= decay                   │
│  3. 按 score 降序排列文件                                     │
│  4. 逐文件输出 symbols 直到 token budget 耗尽                 │
│                                                             │
│  返回: { entries: [{filePath, score, symbols}],              │
│          graphSize, totalSymbols }                           │
└─────────────────────────────────────────────────────────────┘
```

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/repo/meridian-types.ts` | 共享类型定义 |
| `src/repo/meridian-parser.ts` | tree-sitter 解析器，提取 symbols/edges/imports |
| `src/repo/meridian-db.ts` | SQLite 持久化层，content-hash 增量更新 |
| `src/repo/meridian-graph.ts` | Spreading activation 图遍历 + token budget |
| `src/repo/meridian-indexer.ts` | Facade：组合 parser + db + graph |
| `src/agent/hooks/meridian-hook.ts` | postTool hook，驱动自动索引 |
| `src/tools/repo-graph.ts` | `repo_graph` tool 定义 |
| `src/repo/__tests__/meridian-*.test.ts` | 单元测试 (17 cases) |

## 数据流

```
User asks question about code
        │
        ▼
Agent calls read_file("src/foo.ts")
        │
        ▼
postTool hook fires ──→ indexer.indexFile("src/foo.ts")
        │                       │
        │                       ├─ hash check (skip if unchanged)
        │                       ├─ tree-sitter parse → symbols + edges
        │                       ├─ upsert to SQLite
        │                       └─ 1-hop: resolve imports → index them too
        │
        ▼
Agent calls repo_graph(from_file: "src/foo.ts")
        │
        ▼
indexer.query("src/foo.ts", { maxTokens: 2000 })
        │
        ├─ get edges from/to "src/foo.ts"
        ├─ BFS spreading activation (3 hops, decay 0.5)
        ├─ rank files by accumulated score
        ├─ collect symbols per file until token budget
        │
        ▼
Returns ranked file list with symbols to LLM context
```

## 关键设计决策

### 1. 增量 vs 全量索引
选择增量：只在 agent 实际接触文件时索引。优点是零启动延迟，缺点是首次查询可能图不完整。通过 1-hop expand（自动索引 import 的文件）缓解。

### 2. Spreading Activation vs PageRank
选择 spreading activation：从 seed 文件出发，沿边扩散分数。比 PageRank 更适合"从当前文件出发找相关代码"的场景，且无需全图迭代。

### 3. SQLite vs 内存
选择 SQLite：跨 session 持久化，大项目不会 OOM。better-sqlite3 同步 API 简化了代码。

### 4. tree-sitter vs regex
选择 tree-sitter：准确提取 AST 级别的 symbols 和调用关系。WASM 加载一次后解析极快（<5ms/file）。

### 5. 独立 repo_graph tool vs 增强 repo_map
保留原有 `repo_map`（文件树），新增 `repo_graph`（结构图）。两者互补：repo_map 给全局视图，repo_graph 给局部深度。

## 配置参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxHops` | 3 | BFS 最大跳数 |
| `decay` | 0.5 | 每跳分数衰减系数 |
| `maxTokens` | 2000 | 输出 token 预算 |

## 迭代方向

1. **多语言支持**：加载不同 tree-sitter WASM（Python, Go, Rust）
2. **LSP 集成**：用 LSP 的 references/definitions 补充 edge 信息
3. **热度权重**：结合 `recordAccess` 时间戳，最近访问的文件 score 加权
4. **自动注入**：在 system prompt 中自动注入当前文件的 top-3 相关文件摘要
5. **跨 session 共享**：多 session 共享同一 SQLite db（已支持，通过 .rivet 目录）
