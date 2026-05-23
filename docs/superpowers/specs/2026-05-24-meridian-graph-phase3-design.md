# 经脉图 Phase 3 设计 — 影响分析 + 多语言 + Worker 亲和

> 日期：2026-05-24
> 前置：P1（结构索引）+ P2（行为学习）已落地

## 设计目标

P3 从"被动索引"进化为"主动分析"：
1. **影响半径** — 改了 A 文件，自动告诉 agent 哪些文件可能受影响
2. **测试关联** — 知道改了哪个函数该跑哪个测试
3. **多语言支持** — Python/Go/Rust 基础解析
4. **Worker 亲和** — 多 worker 场景下每个 worker 的 repo_graph 自动偏向其 domain

## 竞品启发（code-review-graph）

从 code-review-graph 吸收的设计：
- **影响半径**：递归 CTE 沿 edges 反向 BFS，找到所有"依赖于变更文件"的文件
- **TESTED_BY 边**：通过 import 关系 + 文件命名规则推断测试覆盖
- **边置信度**：区分 EXTRACTED（AST 确定）vs INFERRED（启发式推断）

不吸收的：
- Leiden 社区检测 — 需要 igraph/NetworkX，太重
- 28 个 MCP tools — 我们保持 1 个 `repo_graph` tool，通过参数区分模式
- Embeddings/语义搜索 — 需要外部模型，不符合离线约束

## 架构演进

```
P2: seed → spreading activation + co-edit edges + file boost → ranked list
P3: seed → spreading activation + impact radius + test edges + worker bias → ranked list
                                        ↑                ↑              ↑
                                   新增 impact mode   新增 TESTED_BY   新增 worker affinity
```

---

## 模块设计

### 1. 影响半径分析 (`meridian-impact.ts`)

**核心问题**：agent 改了 `src/auth/login.ts`，哪些文件可能受影响？

**算法**：反向 BFS — 从变更文件出发，沿 edges 的**反方向**扩散（谁 import 了我？谁 call 了我？）

```typescript
export interface ImpactResult {
  /** 直接依赖变更文件的文件 */
  direct: string[]
  /** 间接依赖（2-3 hop）的文件 */
  transitive: string[]
  /** 应该运行的测试文件 */
  tests: string[]
  /** 总影响文件数 */
  totalImpact: number
}

export function analyzeImpact(
  db: MeridianDb,
  changedFiles: string[],
  opts?: { maxHops?: number; includeTests?: boolean }
): ImpactResult
```

**实现策略**：
- 方案 A：SQLite recursive CTE（code-review-graph 的做法，性能好但 SQL 复杂）
- 方案 B：应用层 BFS（复用现有 `getEdgesTo` 反向遍历）
- **选择 B**：代码简单，图规模小（<5000 nodes），性能足够

**集成点**：
- `repo_graph` tool 新增 `mode: "impact"` 参数
- `meridian-hook` 在 write/edit 后自动计算影响半径，注入 tool result

### 2. 测试关联边 (`TESTED_BY`)

**推断规则**（边置信度 = INFERRED）：
1. 文件 `src/foo.ts` → 测试 `src/__tests__/foo.test.ts` 或 `test/foo.test.ts`
2. 文件 `src/foo.ts` → 测试中 `import { ... } from '../foo'` 的文件
3. 文件 `src/foo.ts` → 测试中调用了 `foo` 导出函数的文件

**存储**：复用 edges 表，`kind = 'tested_by'`，`weight` 表示置信度（1.0=确定, 0.7=推断, 0.4=模糊）

**触发时机**：
- indexFile 时，如果文件是测试文件（匹配 `*.test.*` / `*.spec.*`），解析其 imports 建立 TESTED_BY 边
- indexFile 时，如果文件是源文件，查找对应测试文件并建立反向边

### 3. 多语言支持

**策略**：渐进式，不阻塞 P3 核心功能

| 语言 | tree-sitter WASM | 优先级 | 提取能力 |
|------|-----------------|--------|----------|
| Python | tree-sitter-python | P3 | functions, classes, imports |
| Go | tree-sitter-go | P3 | functions, types, imports |
| Rust | tree-sitter-rust | P4 | functions, structs, use |
| Java | tree-sitter-java | P4 | classes, methods, imports |

**实现**：
- `meridian-parser.ts` 重构为 dispatcher，根据文件扩展名选择语言
- 每种语言一个 `parse<Lang>File()` 函数，输出统一的 `ParseResult`
- WASM 按需加载（首次遇到 .py 文件时才加载 python WASM）

### 4. Worker 亲和

**场景**：HEARTH 多 worker 架构中，worker-A 负责 auth 模块，worker-B 负责 UI 模块。各自的 `repo_graph` 查询应自动偏向自己的 domain。

**实现**：
- 每个 worker 维护自己的 `access_log` session_id
- `getFileBoost` 增加 worker affinity 维度：本 worker 访问过的文件 boost 更高
- 通过 `MeridianIndexer` 构造函数传入 `workerId`

```typescript
constructor(cwd: string, opts?: {
  stateDir?: string
  stigmergy?: StigmergyStore
  workerId?: string  // P3: worker affinity
})
```

**权重**：
- 本 worker 访问过的文件：boost × 1.5
- 其他 worker 访问过的文件：boost × 0.8（略降，避免重复工作）

### 5. 边置信度

**扩展 edges 表**：

```sql
ALTER TABLE edges ADD COLUMN confidence TEXT DEFAULT 'extracted';
-- 'extracted' = AST 确定 (weight 1.0)
-- 'inferred' = 启发式推断 (weight 0.7)
-- 'ambiguous' = 模糊匹配 (weight 0.4)
```

**应用**：spreading activation 时，`edge.weight *= confidenceMultiplier[edge.confidence]`

---

## 实施路径

### Week 1：影响半径 + 测试关联

- [ ] `src/repo/meridian-impact.ts` — 反向 BFS 影响分析
- [ ] `src/repo/meridian-db.ts` — `getReverseDependents(filePath)` 方法
- [ ] `src/tools/repo-graph.ts` — `mode: "impact"` 参数
- [ ] 测试关联推断逻辑（命名规则 + import 分析）
- [ ] `meridian-hook.ts` — write/edit 后自动计算影响半径
- [ ] 测试：影响半径准确性、测试关联正确性

### Week 2：多语言 + 边置信度

- [ ] `meridian-parser.ts` 重构为 language dispatcher
- [ ] `parsePythonFile()` — functions, classes, imports
- [ ] `parseGoFile()` — functions, types, imports
- [ ] edges 表增加 confidence 列 + migration
- [ ] spreading activation 应用置信度权重
- [ ] 测试：Python/Go 文件解析、置信度排序

### Week 3：Worker 亲和 + 集成

- [ ] access_log 增加 session_id/worker_id 列
- [ ] `getFileBoost` 增加 worker affinity 维度
- [ ] HEARTH worker 创建 MeridianIndexer 时传入 workerId
- [ ] 端到端测试：多 worker 场景下 repo_graph 结果差异化
- [ ] 性能基准：1000 文件图的 impact 分析 < 50ms

---

## 成功标准

| 指标 | 目标 |
|------|------|
| 影响半径准确率 | 变更文件的直接依赖 100% 覆盖 |
| 测试关联准确率 | 命名规则匹配 > 90%，import 匹配 > 80% |
| 多语言覆盖 | Python + Go 基础解析可用 |
| Worker 亲和 | 同 domain 文件排名提升 > 30% |
| 性能 | impact 分析 < 50ms / 1000 nodes |

## 退出条件

| 风险 | 退出策略 |
|------|----------|
| 反向 BFS 在大图上太慢 | 限制 maxHops=2，或切换到 SQLite recursive CTE |
| Python/Go WASM 加载太慢 | 延迟加载 + 首次解析异步化 |
| Worker affinity 引入噪声 | 降低 affinity 权重或禁用 |
| TESTED_BY 推断误报太多 | 只保留命名规则匹配，去掉 import 推断 |

---

## 与 code-review-graph 的定位区分

| | code-review-graph | 经脉图 |
|---|---|---|
| 部署 | 外部 MCP server | agent 内嵌 |
| 索引时机 | 全量扫描 + watch | 按需（agent 触碰时） |
| 图规模 | 全项目 | 仅触碰的文件（20-200/1000） |
| 查询方式 | 28 个独立 tools | 1 个 tool + mode 参数 |
| 行为学习 | 无 | co-edit + heat + pheromone |
| 适用场景 | 代码审查（全局视图） | 编码 agent（局部深度） |

**结论**：两者互补而非竞争。经脉图的优势是"工作即索引"+ 行为学习，code-review-graph 的优势是全量覆盖 + 社区检测。P3 从后者吸收影响半径和测试关联，但保持轻量内嵌的定位。
