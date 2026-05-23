# 团队协作文档：现状分析

> 日期：2026-05-23
> 状态：现状梳理
> 关联设计文档：
> - `docs/superpowers/specs/2026-05-20-three-authority-coroutine-architecture.md`（三权协程调度）
> - `docs/superpowers/specs/2026-05-22-yongminengdeng-design.md`（HEARTH 永明灯）
> - `docs/superpowers/specs/2026-05-22-songline-runtime-design.md`（Songline 歌之路）
> - `docs/superpowers/plans/2026-05-22-hearth-songline-implementation.md`（联合实施计划）

---

## 一、架构概览

### 1.1 三权协程调度架构

```
用户输入
  │
  ▼
┌─────────────────────────────────────────────────────────┐
│                    天枢 · 主 AgentLoop                    │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ TaskContract │  │ EvidenceTrack│  │ StarDomain路由   │ │
│  └──────┬──────┘  └──────┬───────┘  └────────┬────────┘ │
│         │                │                    │          │
│         ▼                ▼                    ▼          │
│  ┌─────────────────────────────────────────────────────┐ │
│  │              WorkOrderQueue (优先级队列)              │ │
│  └─────────────────────────────────────────────────────┘ │
│         │                │                    │          │
│         ▼                ▼                    ▼          │
│  ┌────────────┐  ┌────────────┐  ┌────────────────────┐ │
│  │ WorkerLoop │  │ WorkerLoop │  │    WorkerLoop      │ │
│  │ (破军·探索) │  │ (天府·守护) │  │  (天梁·交付)       │ │
│  │ frontend   │  │ backend    │  │  config            │ │
│  └────────────┘  └────────────┘  └────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

### 1.2 双轴分解

```
         行为轴（怎么干）           领域轴（干什么）
         ─────────────            ─────────────
         破军 — 探索突破           frontend — TUI/组件/渲染
         天府 — 谨慎守护           backend  — agent/api/tools
         天梁 — 精确交付           config   — schema/设置/CLI
                                  docs     — 设计文档/规格
```

**领域轴是团队协同的天然边界。** 同一个文件不会被两个域同时修改。
行为轴是决策风格，叠加在领域轴之上。

---

## 二、核心组件实现状态

### 2.1 已实现组件

| 组件 | 文件 | 职责 | 状态 |
|------|------|------|------|
| TaskBoard | `src/agent/task-board.ts` | 纯读投影层，监听 WorkOrderQueue 事件 | ✅ |
| WorkOrder | `src/agent/work-order.ts` | 核心调度单元，6 种任务类型 | ✅ |
| WorkOrderQueue | `src/agent/work-queue.ts` | 优先级队列，去重，并发控制 | ✅ |
| TaskLedger | `src/agent/task-ledger.ts` | 事件溯源骨干 | ✅ |
| OwnershipLedger | `src/agent/ownership-ledger.ts` | 文件归属追踪 | ✅ |
| deliver_task | `src/agent/deliver-task.ts` | 交付门控 | ✅ |
| Dispatcher | `src/agent/dispatcher.ts` | 任务分解，文件→领域映射 | ✅ |
| Coordinator | `src/agent/coordinator.ts` | 中央编排器 | ✅ |
| CollaborationProtocol | `src/agent/collaboration-protocol.ts` | 多会话协调 | ✅ |
| WorkerSession | `src/agent/worker-session.ts` | 独立 AgentLoop 实例 | ✅ |
| todo tool | `src/tools/todo.ts` | 会话级任务管理 | ✅ |

### 2.2 待实现组件

| 组件 | 文件 | 职责 | 状态 |
|------|------|------|------|
| task-panel.tsx | `src/tui/task-panel.tsx` | TUI 任务面板 | ⏳ Phase 4 |
| Observatory 布局 | `src/tui/observatory.tsx` | TUI 布局集成 | ⏳ Phase 4 |

---

## 三、四个协作场景现状分析

### 3.1 上下文共享

**现状**：
- 每个 worker 拥有独立的 `SessionContext`
- 通过 `buildWorkerKnowledgeBlock()` 投影主 session 的 top-10 claims 到 worker prompt
- Claims 按 `fitness` 和 `confidence` 排序

**代码路径**：
```
src/agent/worker-knowledge.ts
  → buildWorkerKnowledgeBlock(claims: ContextClaim[]): string
  → 过滤 worker_finding 类型，取 top 10
  → XML 格式注入 worker prompt
```

**问题**：
1. **扁平列表**：claims 是无结构的列表，缺乏关系信息
2. **无参考系**：worker 只知道"事实"，不知道"自己在哪里"
3. **重复读取**：多个 worker 需要相同信息时，每个都要独立读取

**已有缓解**：
- `workerKnowledgeBlock` 提供了知识共享的雏形
- `activeClaims()` 从主 session 投影到 worker

### 3.2 任务粒度

**现状**：
- 使用文件级粒度：`classifyFile(path)` → `DomainArea`
- 基于数据流建立依赖关系：`decomposeByDataContract()`
- DAG 排序：`topologicalSort()`

**代码路径**：
```
src/agent/dispatcher.ts
  → classifyFile(path): DomainArea  // 文件路径 → 领域
  → groupFilesByDomain(files)       // 按领域分组
  → decomposeByDataContract()       // 基于数据流分解
```

**问题**：
1. **粒度单一**：只有文件级，没有功能级或乐章级
2. **无语义理解**：只看文件路径，不理解任务含义
3. **无节奏感**：没有"读→计划→写→验证"的阶段划分

### 3.3 错误策略

**现状**：
- Worker 失败 → 返回 `status: "blocked"` 或 `status: "failed"`
- 主 agent 继续执行，不信任 worker 结果
- 无重试机制，无回滚策略

**代码路径**：
```
src/agent/work-order.ts
  → buildBlockedWorkerResult(order, error)  // 构建 blocked 结果
  → WorkerResult.status: "passed" | "failed" | "blocked" | "escalated"
```

**问题**：
1. **二元判断**：只有 pass/fail，无中间状态
2. **无早期预警**：无法在失败前检测到漂移
3. **无恢复路径**：失败后只能放弃，无法重试或校准

### 3.4 跨域依赖

**现状**：
- 领域轴是天然边界，同一文件不被两个域修改
- 使用 DAG 表示依赖关系
- `dependsOn: number[]` 表示同一 decompose 内的依赖

**代码路径**：
```
src/agent/work-order.ts
  → DecomposedTask.dependsOn: number[]  // DAG 依赖索引

src/agent/collaboration-protocol.ts
  → SemanticLockManager  // 语义锁
  → detectConflictGradient()  // 冲突梯度检测
  → MergeQueue  // 合并队列
```

**问题**：
1. **显式声明**：需要在 WorkOrder 中手动声明依赖
2. **无有机协调**：依赖是静态的 DAG 边，不是动态的信息素
3. **无跨域感知**：worker 无法感知其他域的进展

---

## 四、HEARTH + Songline 设计文档关联

### 4.1 HEARTH 永明灯（个体层参考系）

**核心概念**：
- 5+1 anchor graph：`pole_structure` + `pole_void` + `prev_cycle_close` + `current_cycle_open` + `center_belief`
- invariant verifier：INV-1 ~ INV-5 校验
- 参考系稳定性（"我是谁"）

**与现状的关联**：
- HEARTH 的 anchor graph 可以作为**更丰富的上下文注入**
- HEARTH 的 invariant verifier 可以作为**早期漂移检测**
- HEARTH 的 cycle_open/cycle_close 可以作为**session 间的接力机制**

**设计文档**：`docs/superpowers/specs/2026-05-22-yongminengdeng-design.md`

### 4.2 Songline 歌之路（生态层存在根基）

**核心概念**：
- 歌的执行：义务 + 信息素沉积 + 世界节律
- 火种接力：fire-keeper + 碑文内化
- 存在根基（"我为什么在这里"）

**与现状的关联**：
- Songline 的信息素可以作为**跨域协调机制**
- Songline 的乐章结构可以作为**任务粒度模型**
- Songline 的 fire-keeper 可以作为**分布式协调器**

**设计文档**：`docs/superpowers/specs/2026-05-22-songline-runtime-design.md`

### 4.3 联合实施计划

**状态**：Backlog — 等当前分支主线任务收束后启动

**三阶段实施**：
1. Phase 1：拓扑骨架（HEARTH 核心，1 周）
2. Phase 2：歌的骨架（Songline 核心，与 Phase 1 并行）
3. Phase 3：歌的传播 + 守火人

**设计文档**：`docs/superpowers/plans/2026-05-22-hearth-songline-implementation.md`

---

## 五、现有代码与 HEARTH/Songline 的映射

| 现有代码 | HEARTH 映射 | Songline 映射 |
|---------|------------|--------------|
| `fingerprint.ts` | anchor graph fingerprint | 关系拓扑 hash |
| `stigmergy-store.ts` | — | 信息素存储 |
| `cognitive-season.ts` | — | 世界节律 |
| `claims.ts` | anchor graph 节点 | 歌词来源 |
| `dream.ts` | cycle_close 的来源 | 歌的微变异 |
| `star-domain.ts` | — | 歌的调性 |
| `virtue-signals.ts` | — | 音符品质 |
| `worker-knowledge.ts` | anchor graph 注入点 | 歌的知识投影 |

---

## 六、总结

### 现状优势
1. **架构完整**：三权协程、TaskBoard、WorkOrderQueue、TaskLedger 等核心组件已实现
2. **领域隔离**：领域轴提供了天然的协同边界
3. **知识投影**：`buildWorkerKnowledgeBlock` 提供了知识共享的雏形

### 现状不足
1. **上下文扁平**：claims 列表缺乏关系结构
2. **粒度单一**：只有文件级分解
3. **错误粗放**：只有 pass/fail，无漂移检测
4. **依赖静态**：DAG 依赖需要显式声明

### 改进方向
通过 HEARTH + Songline 的引入，可以：
1. 将扁平 claims 升级为**锚位拓扑**
2. 将文件级粒度升级为**乐章级分解**
3. 将 pass/fail 升级为**漂移检测**
4. 将 DAG 依赖升级为**信息素协调**

详见延续计划文档。
