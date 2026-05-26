# Outlines Index：渐进式披露文档给 AI Agent 的方法

> 来源：https://sspai.com/post/106979 — Blueeon（前小米技术总监，Linkly AI）
> 日期：2026-03-10
> 归档目的：作为天枢后续迭代的参考设计

## 1. 核心思想

**为每个文档建立一份结构化"名片"，让 AI 按 search → outline → read 的路径渐进式访问文档，而不是一次性灌入切碎的片段。**

一句话：给 AI 一张地图，而不是一本 1000 页的说明书。

## 2. 解决的问题

### 传统 RAG 的困境

RAG 把文档切成 chunk → 向量化 → 语义检索，存在根本缺陷：

1. **上下文丢失**：chunk 切碎后与前后文脱节
2. **不可控**：搜到的 chunk 不够用时，AI 无法"再多看一点"
3. **Token 浪费**：10 个 chunk 可能只有一个相关
4. **质量不稳定**：关键段落被切成两半后都检索不到
5. **语义丢失**：Rerank 模型无法捕捉专有名词

### Claude Code 的启示

Claude Code 不用 RAG，只用三个工具高效探索代码库：**Glob + Grep + Read**。

这是渐进式披露（Progressive Disclosure）：
- 先扫描文件名找到候选
- 打开文件快速浏览结构
- 确定哪一部分有用，精准阅读

**问题**：Glob+Grep 只适用于纯文本代码库。文档需要一个等价的"目录索引"。

## 3. Outlines Index 设计

为每个文档生成两部分结构化信息：

### Metadata（身份证）

- 标题（多级回退：文档元数据 → 首个标题 → 文件名）
- 作者、语言、字数
- 摘要（文档开头约 200 字）
- 关键词（自动提取）
- `brief` 标记（字数 < 500 时为 true）

### Outline（结构大纲）

- 章节标题 + 层级关系
- 每节的首句摘要 + 关键词
- 行号范围（如 `[L42-65, 24行]`）
- 树形结构存储

**关键：Outline 不存储原文，只存储导航信息。它是地图，不是领土。**

## 4. 三层渐进式披露

### Layer 1: search — 发现文档

```
> search("context engineering")

#1  Effective context engineering for AI agents
    doc_id: 1714 | type: md | words: 3,200 | has_outline: yes | relevance: 0.92
    snippet: "Context engineering is the art of..."
```

- 每个结果约 **50 tokens**，20 个结果约 **1000 tokens**
- AI 看到 `has_outline: yes` → 知道可以深入
- AI 看到 `brief: true` → 知道可以直接读全文，跳过 outline

### Layer 2: outline — 浏览结构

```
> outline(1714)

[1] Effective context engineering [L1-139]
  [1.2] Context vs prompt engineering [L16-27]
  [1.3] Why it matters [L28-41]
  [1.4] The anatomy of context [L42-65]
  [1.5] Context retrieval [L66-127]
```

- 每个文档约 **200-500 tokens**
- 行号范围直接对应 read 参数

### Layer 3: read — 精准阅读

```
> read(1714, offset=42, limit=24)

42 | ## The anatomy of effective context
43 | Effective context has several key properties...
```

- 只读需要的部分

**真实案例对比**：

| 方案 | Token 消耗 | 信息质量 |
|------|-----------|---------|
| Outlines Index | ~3400 tokens | 精确、有完整上下文 |
| 传统 RAG | ~5000+ tokens | 随机切碎、可能漏掉关键段落 |

## 5. 关键设计细节

### brief 标记

文档 < 500 字时 `brief: true`。AI 看到后跳过 outline 直接 read 全文。
**把决策权交给 AI，不硬编码在代码里。**

### 大纲生成策略

| 格式 | 策略 | 质量 |
|------|------|------|
| Markdown | 解析 `#` 标题 | 高 |
| PDF（有书签）| 提取 Bookmark 树 | 高 |
| DOCX | 解析 Heading 样式 | 高 |
| PDF（无书签）| 启发式规则 | 中 |
| 纯文本 | ALL CAPS / 编号模式 | 中或无 |

### Budget 策略（大纲输出可控）

1. 完整输出（含摘要和关键词）
2. 去掉摘要（只保留标题和行号）
3. 降低层级（从 L5 开始逐级去掉）
4. 硬截断（最终兜底）

### 向量化策略

**Embedding 对象不是原文，而是 Outline Index 本身。**

一个文档只生成一个向量。10000 文档 = 10000 向量 ≈ 30MB 存储。
不只是省空间 — Outline 浓缩了文档核心语义，向量质量反而更高。

### 双路检索

- **BM25 全文搜索**：精确关键词（技术术语、专有名词不可替代）
- **向量语义搜索**（基于 Outline 向量）：跨语言能力
- 两路通过 **RRF（Reciprocal Rank Fusion）** 融合
- 渐进可用：BM25 立即可用，向量索引后台构建完成后自动上线

## 6. 与天枢的关联

### 当前天枢已有的能力

天枢当前已经有类似的渐进式探索工具链：

```
inspect_project → repo_map(shallow) → repo_map(path, deep)
                                       → read_file(关键文件)
                                       → repo_graph(关联分析)
                                       → grep/glob(精确搜索)
```

### 可以借鉴的方向

1. **repo_map 增加语义摘要**：不只展示文件名和大小，还可以展示模块的一句话摘要（类似 Outline 的 Metadata）
2. **AGENTS.md 作为 Outlines Index**：我们刚创建的 AGENTS.md 本质上就是项目的 Outline — 指向更深层文档的地图
3. **read_file 的 offset/limit 已经支持**：Layer 3（read）能力已经具备
4. **repo_graph 的关联分析**：比单纯的 search 更强 — 基于结构依赖而非关键词

### 关键差异

| 维度 | Outlines Index | 天枢现状 |
|------|---------------|---------|
| 索引对象 | 非结构化文档（PDF/DOCX/MD） | 代码仓库 |
| 检索方式 | BM25 + 向量语义 | glob + grep + 代码图 |
| 大纲生成 | 文档标题层级 | 目录树 + 文件大小 |
| 适用场景 | 知识库、文档管理 | 代码开发 |

天枢的核心场景是代码开发，glob+grep+代码图 已经是代码领域的最佳实践。
Outlines Index 的思路更适合未来扩展到「项目知识库」场景（如设计文档、API 文档、会议记录等非代码内容）。

## 7. 开放设计问题（待你设计）

1. **天枢是否需要向量化索引？** 当前 grep/glob 对代码已经够用，但如果项目有大量设计文档/文档？
2. **AGENTS.md 是否需要自动生成？** 目前手写 96 行，如果项目结构变化，是否需要自动更新？
3. **repo_map 是否需要增加 metadata 层？** 比如每个目录/文件的一句话摘要？
4. **Outline 预算策略是否适用于 repo_graph？** 大型项目中关联文件可能很多，需要类似的降级策略？
