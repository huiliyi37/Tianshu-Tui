# Project Memory Signal vs Noise：知识回收机制分析

> 日期：2026-05-27  
> 背景：讨论 `.rivet/knowledge/project-memory.md` 是否需要继续保留、如何避免把低级执行噪音注入 prompt。  
> 状态：分析记录，供后续针对性设计/实现讨论使用。

## 1. 结论

当前 Project Memory / Dream 机制的方向是有价值的：天枢需要跨 session 的项目级记忆。但现有回收对象层级过低，主要收集 session telemetry，而不是高价值知识。

现状更像是在记录：

- 修改了哪些文件；
- 读了哪些文件；
- 用了哪些工具；
- 测试是否通过；
- 某次 session 是否 unverified；
- 某些短句 decision。

这些信息回答的是“昨天做了什么”，不是“我们因此看清了什么”。

对清醒状态下的天枢来说，普通失败、工具轨迹和未验证状态大多是短半衰期信号。执行时遇到失败会很快换路，状态系统/验证门禁也会提示。把这些低级失败长期写入并注入 prompt，反而会形成无效噪音。

更高价值的记忆来自 scout 发现、头脑风暴收敛、设计原则、架构不变量和领航星偏好。

一句话：

> Project memory 不应该回收“执行痕迹”，应该回收“未来遇到相似局面时如何判断”。

## 2. 当前机制观察

### 2.1 生成链路

`src/agent/dream.ts` 的 `persistDream()` 会在 session 结束时把 `distillSession()` 生成的条目写入：

```text
.rivet/knowledge/project-memory.md
```

当前模板主要包含：

```md
### YYYY-MM-DD — session <id>

**Modified** (...): ...
**Read** (...): ...
**Tests**: ...
**Tools used**: ...
- Decision: ...
```

触发门槛很低：只要 `filesModified.length > 0` 就可能写入。

### 2.2 注入链路

`src/prompt/volatile-snapshot.ts` / `src/prompt/volatile.ts` 会读取 `.rivet/knowledge/*.md`，并把内容作为：

```xml
<project-memory>...</project-memory>
```

注入到 stable volatile block。`project-memory.md` 会被优先排序。

这意味着它会影响 prompt prefix，并长期占用注意力预算。

### 2.3 recall 路径

`src/tools/recall.ts` 也会搜索 `.rivet/knowledge/*.md`。

这条路径更适合大多数项目记忆：保留在知识库中，按需召回，而不是每轮默认注入。

## 3. 为什么当前内容是噪音

### 3.1 低级失败模式半衰期很短

普通失败包括：

- 某次测试没跑；
- 某次类型错误；
- 某个 worker blocked；
- 某次命令失败；
- 某次 JSON/schema 输出不完整；
- 某次工具参数错误。

这些信息不是长期知识。天枢在执行过程中有足够反馈回路：工具错误、测试输出、状态提示、verification gate、ownership gate。清醒状态下反复看到这些低级失败，会像让一个成熟工程师每天先读一遍“昨天曾经敲错命令”。

### 3.2 工具轨迹不是知识

`Tools used: bash×25, todo×2, edit_file×2...` 这类统计一般不改变未来判断。它可能对审计有用，但不应进入高权重项目记忆。

### 3.3 修改文件列表价值有限

`Modified` / `Read` 列表可以帮助追踪 session，但不是设计洞察。它们适合 session log、handoff 或 git history，不适合作为默认 prompt memory。

### 3.4 未筛选记忆会稀释真正重要的信息

如果 project-memory 被低级 telemetry 填满，真正重要的 scout 收敛洞察反而被挤出 2KB/4KB 注入预算。

这会造成反向效果：记忆越多，模型越难看到真正有用的部分。

## 4. 什么才是高价值记忆

从近期设计文档看，高价值内容通常不是执行流水，而是以下几类。

### 4.1 Scout 收敛洞察

例如 `docs/superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md` 的核心结论：

> 子代理协同的核心不是更多并发，而是 typed work order/result packet 加主控验收边界。

这类洞察能长期影响架构取舍，值得保存。

### 4.2 架构不变量

例如：

> SessionContext 是 mutable shared state，worker 不能共享 primary session。

这是未来实现 worker、delegate、multi-agent 相关功能时不能违反的边界。

### 4.3 概念重构

例如 `docs/superpowers/specs/2026-05-16-rivet-evolutionary-tui-memory-design.md` 中的判断：

> 真正的“记忆”不是 storage，而是 selection。没有 selection 的存储只是档案柜。

这能改变问题定义，因此属于长期记忆。

### 4.4 设计原则

例如 `docs/superpowers/assets/2026-05-19-tianxuan-design-notes.md`：

> 协同的本质不是共享记忆，而是在正确的时机传递正确粒度的信息。

这比任何单次失败记录更有迁移价值。

### 4.5 领航星偏好

本次讨论形成的偏好：

> 低级失败模式和执行流水对清醒状态下的天枢是噪音；长期记忆应优先保存 scout 发现、头脑风暴收敛洞察、设计原则与架构不变量。

这是长期行为偏好，值得被 future agent 看到。

## 5. 记忆分层建议

| 层级 | 内容 | 默认去向 | 是否进入 project-memory |
|---|---|---|---|
| L0 执行痕迹 | Modified / Read / Tools used / ordinary unverified | session log / git history | 否 |
| L1 局部修复 | 某次 bug 修法、某次命令问题 | docs/analysis 或 issue note | 默认否 |
| L2 结构发现 | 代码 seam、架构约束、系统性风险 | project-memory / docs brief | 是 |
| L3 设计原则 | scout 收敛、跨领域类比、长期判断准则 | project-memory / specs / briefs | 强是 |
| L4 领航星偏好 | 长期协作偏好、价值排序 | project-memory / AGENTS/.rivet 视情况 | 是 |

当前 Dream 机制主要回收 L0，偶尔碰到 L1。目标应转向 L2/L3/L4。

## 6. 写入标准

写入 `.rivet/knowledge/project-memory.md` 前，应至少满足一个条件：

1. **Convergence Insight**  
   多个 scout、多轮推理或复盘收敛出的核心洞察。

2. **Architectural Invariant**  
   未来实现时不能违反的架构约束。

3. **Selection Rule**  
   帮助未来做取舍的判断规则。

4. **Conceptual Reframe**  
   把问题从低层转到高层的新框架。

5. **Navigator Preference**  
   领航星明确表达的长期偏好。

6. **Reusable Design Pattern**  
   可迁移到多个模块/任务的设计模式。

反向排除条件：

- 只说明“做过什么”；
- 只说明“失败过什么”；
- 只说明“跑了什么工具”；
- 只说明“哪些文件被改”；
- 只对当前 session 有意义；
- 已经能由 git history、test output、delivery gate 或 session transcript 表达。

## 7. 推荐条目格式

建议把 project-memory 从 session telemetry 改为 curated memory：

```md
### YYYY-MM-DD — Memory Selection Principle

**Kind**: navigator_preference / convergence_insight / architectural_invariant

**Claim**: Project memory should preserve high-level scout findings and design principles, not low-level execution traces.

**Why it matters**:
Low-level failures are short half-life signals. Tianshu usually recovers through tool feedback, state hints, and alternate paths. Re-injecting them into prompt creates noise.

**Applies when**:
- deciding what to write into `.rivet/knowledge/project-memory.md`
- designing Dream/session-end distillation
- deciding whether a failure pattern deserves long-term memory

**Evidence**:
- `docs/superpowers/specs/2026-05-17-project-memory-dream-design.md`
- `docs/superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md`
- `docs/superpowers/assets/2026-05-19-tianxuan-design-notes.md`

**Do not store**:
Modified files, tools used, ordinary test failures, transient worker blocked events.
```

这种格式直接回答“未来怎么判断”，而不是“过去发生了什么”。

## 8. 对 Dream 机制的改造方向

### 8.1 停止自动写 L0 流水账

`filesModified.length > 0` 不应再作为写入长期项目记忆的充分条件。

自动写入应改为：没有高价值 claim 就不写。

### 8.2 引入记忆价值评分

可以引入简单分类：

```ts
type MemoryValue =
  | 'discard'
  | 'session_log_only'
  | 'analysis_candidate'
  | 'project_memory'
```

判断维度：

- 是否跨任务可复用；
- 是否是设计原则；
- 是否来自多 scout 收敛；
- 是否是领航星长期偏好；
- 是否会改变未来决策；
- 是否只是工具/测试噪音。

只有 `project_memory` 可以进入 `.rivet/knowledge/project-memory.md`。

### 8.3 Prompt 默认不注入整份 project-memory

即使 project-memory 变高质量，也不应无限注入。更合理的策略：

- `.rivet/knowledge/*.md` 作为 recall 可检索知识库；
- prompt 只注入极短 curated index，或默认不注入；
- 当前任务相关时再由 `recall` 主动检索；
- 高价值 scout 发现可提升到 `docs/superpowers/briefs/` 或专门 memory index。

### 8.5 已定运行时契约

Project memory 的默认访问路径改为：

```text
.rivet/knowledge/*.md
  → 不进入 volatile prompt
  → recall(query) 按需检索
```

这保持 curated memory 的长期价值，同时避免每轮请求携带低相关知识、影响 prefix cache 稳定性。需要跨 session 项目判断时，agent 应主动调用 `recall`，而不是依赖启动时注入。

### 8.6 自动写入标准修订

`dream.ts` 的自动写入门槛改为必须显式命中以下五类之一：

1. convergence insight
2. architectural invariant
3. selection rule
4. conceptual reframe
5. reusable design pattern

个人偏好、领航星偏好、普通失败、文件改动列表、工具使用统计都不作为自动写入 project-memory 的充分条件。偏好类信息如果确实需要长期保留，应走人工策展或正式文档路径，不由 Dream 自动沉淀。

### 8.7 Worker 评价与路由问题延期

本轮用子代理试执行 recall-only 计划时得到一个初步判断：只读 reviewer / scout 价值较高，patcher 与 batch patch 目前不稳定。观察到的问题包括：

- `delegate_batch` 在多 patcher 并发时超时，缺少部分结果可见性；
- patcher worker 的 `edit_file` 可能被 approval 拒绝，导致写任务 blocked；
- worker 当前可能偏向 DeepSeek Flash 路由，与 GPT 系列路由/输出契约存在兼容不稳定风险。

评价体系和 worker 路由修复不进入本轮 memory 改造提交，后续单独设计。当前推荐用法是：主会话执行关键 patch，worker 负责只读 review、code search、风险发现和验证建议。

### 8.4 自动 Dream 与人工策展分离

建议拆分：

```text
自动 session digest      → .rivet/sessions/ 或 session sidecar，不进 prompt
人工/高价值 curated memory → .rivet/knowledge/project-memory.md，可进 git/recall
长期规范化知识          → docs/analysis / docs/superpowers/briefs / specs
```

## 9. 当前建议

对当前 dirty 的 `.rivet/knowledge/project-memory.md`：

- 不建议直接提交自动追加的流水账；
- 不建议删除整个机制；
- 建议后续将其重写为 curated memory；
- 当前这次讨论本身可整理成一条高价值 Navigator Preference / Memory Selection Principle。

对后续实现：

1. 先记录本分析文档，作为讨论基线；
2. 再决定是否重写 `.rivet/knowledge/project-memory.md`；
3. 然后再改 `dream.ts` 的写入门槛；
4. 最后调整 prompt 注入策略，避免每轮灌入低相关知识。

## 10. 核心判断

> 有用记忆不是“发生过什么”，而是“未来遇到相似局面时，应该如何判断”。

因此：

```text
低级失败：发生过什么 → 丢弃
工具流水：做过什么 → 丢弃
测试结果：当时是否通过 → 除非是基线，否则丢弃
scout 发现：看清了什么 → 保留
设计原则：以后怎么判断 → 保留
用户偏好：什么方向重要 → 保留
架构不变量：什么不能违反 → 保留
```

---

## 11. 已定实施计划与运行时契约 (2026-05-27)

实施计划：`docs/superpowers/plans/2026-05-27-项目记忆按需召回.md`

### 11.1 已定运行时契约

Project memory 的默认访问路径改为：

```text
.rivet/knowledge/*.md
  → 不进入 volatile prompt
  → recall(query) 按需检索
```

这保持 curated memory 的长期价值，同时避免每轮请求携带低相关知识、影响 prefix cache 稳定性。需要跨 session 项目判断时，agent 应主动调用 `recall`，而不是依赖启动时注入。

### 11.2 Dream 写入已改造

`src/agent/dream.ts` 已从 session telemetry（`filesModified > 0` 即写入）改造为 curated memory gate：

- 只有匹配 §6 写入标准中至少一个 criterion 的 explicit decision 才触发写入
- 写入内容不包含 Modified/Read/Tests/Tools used 流水统计
- 排除 Navigator preference（按当前产品决策，个人偏好不由 Dream 自动写入）
- 写入格式遵循 §7 的 curated memory 条目格式

### 11.3 完成状态

| 变更 | 文件 |
|---|---|
| prompt 层移除 `<project-memory>` 注入 | `src/prompt/volatile.ts` |
| snapshot 层移除 knowledge 启动读取 | `src/prompt/volatile-snapshot.ts` |
| Dream 写入改为 curated gate | `src/agent/dream.ts` |
| 测试锁定"不进 prompt、但 recall 可检索" | `volatile.test.ts`, `volatile-snapshot.test.ts`, `recall.test.ts`, `dream.test.ts` |
| project-memory.md 更新为 curated 格式 | `.rivet/knowledge/project-memory.md` |
