# Project Instructions Routing Design

> 日期：2026-05-19
> 状态：设计阶段（未实现）
> 父计划：`docs/superpowers/plans/2026-05-19-volatile-context-hygiene.md` Phase 6

---

## 1. 问题陈述

### 当前状态

`.rivet.md` 由 `readRivetMd(cwd)` 读取（30s TTL 缓存），在 `buildVolatileBlockInternal` 中作为 `<project-instructions>` 整体注入。每次 `buildRequest()` 时：

- 历史用户消息使用 frozen volatile block（构造时计算一次）
- 最新用户消息使用 fresh volatile block（每次重新计算）

这意味着 **同一份完整 `.rivet.md`** 在每轮 latest-turn volatile block 中完整出现一次。

### 污染量化

根据 GLM 会话复盘，`project-instructions` 占 volatile context 约 40%。以本项目 `.rivet.md` 为例（约 8K chars），每次 latest turn 都注入全部内容，包括：

| Section | 大约 chars | 任务命中场景 |
|---------|-----------|-------------|
| Architecture 架构图 | ~1200 | 所有任务 |
| Commands 命令 | ~400 | 所有任务 |
| Testing 测试 | ~300 | 测试相关任务 |
| Subagent Orchestration | ~1500 | 仅 Worker 分派时 |
| ACF 架构 | ~1200 | 仅 compaction/context 问题 |
| Concurrent Session Rules | ~600 | 仅多会话场景 |
| Code Conventions | ~800 | 所有任务 |
| Common Mistakes | ~600 | 所有任务 |
| Files to Read First | ~600 | 所有任务 |
| Hard Constraints (ACF) | ~400 | 仅 compaction 问题 |

大多数任务只需要其中 30-50%。Subagent Orchestration（~1500 chars）和 ACF 架构（~1200 chars）在 90% 的任务中是无效开销。

### 影响

- 每 turn 浪费 ~3000-5000 chars（~750-1250 tokens）在无关 section 上
- 这些 section 在 latest-turn dynamic block 中，不影响 prefix cache
- 但增大了 effective context，加速逼近 compaction 阈值

---

## 2. 设计方案

### 方案 A：Section Tag 路由（推荐）

**核心思路**：`.rivet.md` 按 `<!-- section:tag -->` 标记分段，runtime 根据 task type 只注入相关段。

#### 格式定义

```markdown
<!-- section:core -->
## Commands
...
## Code Conventions
...
<!-- /section:core -->

<!-- section:subagent -->
## Active Feature: Subagent Orchestration (P2.4)
...
<!-- /section:subagent -->

<!-- section:acf -->
## Active Feature: Adaptive Context Fabric (ACF)
...
<!-- /section:acf -->

<!-- section:concurrent -->
## Concurrent Session Rules
...
<!-- /section:concurrent -->
```

#### 路由表

```typescript
interface SectionRoute {
  tag: string
  always: boolean          // 是否总是注入
  taskTypes: string[]      // 触发注入的 task type
  keywordTriggers: string[] // 触发注入的 query 关键词
}

const ROUTING_TABLE: SectionRoute[] = [
  { tag: 'core', always: true, taskTypes: [], keywordTriggers: [] },
  { tag: 'subagent', always: false, taskTypes: ['delegate', 'worker', 'subagent'], keywordTriggers: ['worker', 'subagent', 'coordinator', 'work-order', 'delegation'] },
  { tag: 'acf', always: false, taskTypes: ['compact', 'context', 'cache'], keywordTriggers: ['compact', 'context', 'cache', 'compaction', 'anchor', 'persistent-store'] },
  { tag: 'concurrent', always: false, taskTypes: [], keywordTriggers: ['session', 'parallel', 'concurrent', 'rebase', 'branch'] },
]
```

#### 路由决策时机

在 `buildLatestTurnVolatileBlock` 中，`project-instructions` 注入前：
1. 解析 `.rivet.md` 为 section map（可缓存）
2. 根据当前 user input / tool history / working set 决定 task type
3. 按 routing table 选择 section
4. 拼接选中 section 作为 `<project-instructions>` 内容

#### 对 frozen block 的影响

- **Frozen block（构造时）**：注入全量，因为构造时不知道 task type
- **Fresh block（latest turn）**：按路由注入子集
- 这意味着前几轮 frozen prefix 含全量 instructions，后续 fresh block 缩减
- Prefix cache 不受影响（frozen block 不变）

#### 优点

- 精确控制，每个 section 都有明确的路由规则
- `.rivet.md` 仍然是一个文件，维护成本低
- 可以 incremental 部署（未标记 section 默认 always）

#### 风险

- 需要解析 `.rivet.md` 格式，用户可能不知道 `<!-- section:tag -->` 语法
- Task type 判断可能不准确，导致关键 section 被误裁
- 新增 section 需要手动更新 routing table

#### 缓解

- 未标记 section 默认 always（安全回退）
- 提供 `/debug context-payload` 显示当前路由决策
- Section 解析失败时 fallback 到全量注入

---

### 方案 B：摘要 + Recall

**核心思路**：稳定注入精简摘要（架构图 + 铁律 + 命令），详细 section 进 cold storage。

#### 摘要内容

```markdown
## Core
- Node.js 22 + TypeScript strict + Ink 6
- Commands: tsc --noEmit, tsx --test, npm run build
- Testing: node:test + node:assert/strict, mirrors src/ structure
- Conventions: strict mode, interface + plain objects, async/await

For detailed architecture, active features, and concurrent rules, use recall.
```

约 300-400 chars，相比全量 8K 缩减 95%。

#### 详细 section 的注入

当 user input 匹配特定关键词时，通过 recall tool 从 PersistentStore 或直接从 `.rivet.md` 中提取相关 section。

#### 优点

- 最大程度缩减 stable payload
- 用户可以通过 recall 按需获取详细信息

#### 风险

- 摘要质量难以保证——遗漏关键信息可能导致 agent 行为异常
- 需要 LLM 额外一轮 recall 才能获取完整上下文，增加 latency
- 摘要可能过时（.rivet.md 更新后摘要未同步）

---

### 方案 C：Task-type Routing Table（预定义映射）

**核心思路**：预定义 task-type → sections 映射，runtime 根据 user input / tool history 判断 task-type。

与方案 A 的区别：不需要 `.rivet.md` 格式变更，而是通过 line range 或 heading regex 匹配。

#### 优点

- 不需要修改 `.rivet.md` 格式

#### 风险

- Heading 匹配脆弱（用户自定义格式可能不遵循标准 heading）
- Task-type 分类不准（比方案 A 更依赖 heuristic）

---

### 推荐方案

**推荐方案 A（Section Tag 路由）**，理由：

1. **显式优于隐式**：`<!-- section:tag -->` 是明确的路由边界，不依赖 heading 格式推断
2. **安全回退**：未标记 section 默认 always，不会误删关键信息
3. **可增量部署**：第一阶段只标记最大的 section（subagent、acf、concurrent），其余保持 always
4. **可诊断**：`/debug context-payload` 可以显示路由决策和 section 选择结果

---

## 3. 影响分析

### 对 Prefix Cache 的影响

| Block | 当前行为 | 方案 A 后 |
|-------|---------|----------|
| Frozen (构造时) | 全量 project-instructions | **不变** — 全量注入 |
| Fresh (latest turn) | 全量 project-instructions | **缩减** — 按 section 路由 |

- Frozen block 在 `PromptEngine` 构造时计算一次，包含全量 instructions → **prefix cache 不受影响**
- Fresh block 每轮重新计算，缩减后反而可能因为内容变化导致 last user message 变化，但这不影响 prefix（prefix 只覆盖前 N-1 个 user message）

### 对 `.rivet.md` 格式的影响

- 新增 `<!-- section:tag -->` 和 `<!-- /section:tag -->` 标记
- **向后兼容**：未标记 section 默认 always
- 不需要立即迁移——可以逐步添加标记

### 对 `payload-diagnostic.ts` 的影响

- `analyzeVolatilePayload` 已能识别 `<project-instructions>` section
- 需要在 waste candidate 报告中增加路由状态信息

---

## 4. 实施路径

### Phase 1：解析 + 默认全量（低风险）

**目标**：添加 section 解析能力，但默认行为不变。

1. 新增 `src/context/section-router.ts`
   - `parseSections(md: string): Map<string, string>` — 解析 `<!-- section:tag -->` 标记
   - `routeSections(sections: Map<string, string>, input: RoutingInput): string` — 按路由表选择
   - 未标记内容归入 `_default` section，always=true
   - 路由结果为空时 fallback 到全量
2. 测试：解析、路由、fallback
3. **不改 volatile.ts**——验证解析逻辑正确性

### Phase 2：接入 latest-turn volatile block

1. 修改 `buildVolatileBlockInternal` 中 project-instructions 注入：
   - 解析 `.rivet.md` 为 sections
   - 根据 `ctx.toolHistory`、当前 user input（如果可用）路由
   - 注入路由结果
2. Frozen block 保持全量不变
3. 添加 `/debug context-payload` 路由决策信息
4. 为 `.rivet.md` 的 subagent、acf、concurrent section 添加标记

### Phase 3：验证 + 优化

1. 长会话测试：对比路由前后的 payload 大小
2. 功能验证：确保 agent 在不同 task type 下行为正常
3. 调优路由表 keyword triggers

---

## 5. 风险与缓解

| 风险 | 严重度 | 缓解 |
|------|--------|------|
| Section 标记遗漏导致关键信息被裁 | 高 | 未标记 section 默认 always；路由失败 fallback 全量 |
| Task type 判断不准 | 中 | keyword trigger 覆盖面广；有 fallback |
| `.rivet.md` 格式变更导致用户困惑 | 低 | section 标记是注释，不影响显示；文档说明 |
| Frozen block 与 fresh block 内容不一致 | 低 | 已有先例（frozen 含全量 git status，fresh 含最新）；不影响 prefix cache |

---

## 6. 验证标准

- [ ] `/debug context-payload` 显示 project-instructions 路由状态（全量/缩减/section 列表）
- [ ] Subagent 相关任务注入 subagent section
- [ ] 普通编辑任务不注入 subagent/acf section
- [ ] 未标记 section 始终注入
- [ ] 路由失败时 fallback 到全量注入
- [ ] Frozen block 不受影响（prefix cache 不变）
- [ ] 路由后 project-instructions chars 减少 ≥ 40%（目标场景）

---

## 7. 新增文件清单

| 文件 | 职责 |
|------|------|
| `src/context/section-router.ts` | Section 解析 + 路由决策 |
| `src/context/__tests__/section-router.test.ts` | 单元测试 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `src/prompt/volatile.ts` | project-instructions 注入前调用 section router |
| `src/context/payload-diagnostic.ts` | waste candidate 报告增加路由状态 |

---

## 8. 与其他 Phase 的关系

本设计文档（Phase 6）不依赖 Phase 1-4 的实现，但建议在 Phase 2（claim relevance gate）稳定后再开始实现，原因：

- Payload diagnostic 数据需要 baseline（Phase 1 提供）
- Claim gate 的 working-set / tool-history 路由逻辑可复用
- 避免同时修改 volatile.ts 导致冲突

---

## 9. 附录：当前 `.rivet.md` 结构分析

基于 `buildVolatileBlockInternal` 的注入逻辑：

```typescript
const md = ctx.rivetMd ?? readRivetMd(ctx.cwd)
if (md) {
  parts.push(`<project-instructions>\n${escapeXml(md)}\n</project-instructions>`)
}
```

`.rivet.md` 内容通过 `readRivetMd` 读取，30s TTL 缓存，直接注入为 XML 文本。

### Frozen vs Fresh 差异

```
Frozen block (buildStableVolatileBlock):
  ✅ environment
  ✅ project-instructions  ← 全量
  ✅ project-memory
  ✅ git-status
  ✅ recent-commits
  ✅ working-set
  ✅ context-ledger
  ❌ tool-history (stripped)
  ❌ active-claims (stripped)
  ❌ playbookLessons (stripped)
  ...

Fresh block (buildLatestTurnVolatileBlock):
  ✅ environment
  ✅ project-instructions  ← 可路由
  ✅ project-memory
  ✅ git-status
  ✅ recent-commits
  ✅ working-set
  ✅ context-ledger
  ✅ tool-history
  ✅ active-claims (via claim-relevance gate)
  ✅ playbookLessons
  ...
```

Section 路由只影响 fresh block 中的 project-instructions，不触碰 frozen block。
