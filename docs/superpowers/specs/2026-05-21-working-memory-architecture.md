# 工作记忆架构设计 — 从对话历史到认知协议层

> 日期：2026-05-21
> 状态：设计稿
> 作者：天枢（本会话）+ 天枢（并行会话）+ 用户
> 触发：多会话暴力测试暴露的上下文钝化问题

---

## 0. 核心命题

**对话线程不是记忆。上下文应该是协议层，不是存储层。**

当前系统把三种生命周期完全不同的东西混在同一个 message history 里：

| 类型 | 生命周期 | 例子 | 应该在哪 |
|------|----------|------|----------|
| 对话协议 | 短期（1-5 轮） | 用户意图、我的承诺、当前计划 | Context window |
| 工作材料 | 按需（用时加载，用过丢弃） | 文件全文、grep 结果、测试日志 | 外部 artifact store |
| 长期状态 | 持久（跨 session） | 决策、已验证事实、失败模式 | 结构化 state store |

**AI agent 的上下文应该像 CPU cache，不应该像硬盘。**

---

## 1. 当前架构（现状）

### 1.1 Prompt 层次结构

```
[system field]                ← static.ts（identity/beliefs/rules/tools/workflow/security/git）
                              ← prefix cache 命中层

[message 0 — user]            ← volatile block (frozen: env + rivet.md + git status + knowledge)
                              ← prefix cache 命中层

[message 1 — assistant]       ← 首轮响应
                              ← prefix cache 命中层

[message 2..N-4]              ← 历史对话（被 microCompact / staleRound 截断）
  user:   tool_result（可能 2000-8000 chars）
  assistant: thinking + text + tool_use

[message N-3..N]              ← 最近 4-10 条消息，保持完整
  最后一条 user 消息尾部附加 ← dynamic appendix (task-contract, verification-gap,
                                  cognitive-mirror, consolidated block)
```

### 1.2 Compaction 管线

| 阶段 | 触发条件 | 做什么 | 成本 |
|------|----------|--------|------|
| staleRound | 每轮 proactive | 历史 rounds 的 tool_result 截断到 1200 chars | 本地 |
| microCompact | 手动 /compact 或 auto 触发 | thinking 截断 500 chars + tool_result 截断 | 本地 |
| smartCompact | microCompact 后仍超阈值 | LLM 摘要中间消息，生成 `<compact-summary>` | API 调用 |

### 1.3 已有的结构化状态机制

| 机制 | 形状 | 持久化 | 用途 |
|------|------|--------|------|
| ContextClaim | JSONL event sourcing | `.rivet/claims-{sid}.jsonl` | 文件 ownership |
| SessionMemory | append-only, cap 50 | `{sid}.memory.json` | 跨 turn 记忆 |
| ContextLedger | in-memory snapshot | 无 | 每轮状态投影 |
| CognitiveLedger | in-memory | 无 | 6 维认知投影 |
| AnchorRegistry | in-memory, salience-weighted | 无 | 重要决策锚定 |
| TaskContract | in-memory, regex 提取 | 无 | 任务状态机 |
| StigmergyStore | pheromone signals | `.rivet/pheromones.json` | 跨 session 信号 |
| Playbook | YAML bullets | `.rivet/playbook.yml` | 教训沉淀 |

### 1.4 问题诊断

1. **工具输出是上下文杀手**：一次 `read_file` 注入 8000 chars (~2000 tokens)，一次 `grep` 注入 2000+ chars。5 次文件读取 = ~10K tokens 的死重。
2. **compaction 是破坏性的**：microCompact 只能截断，不能总结。smartCompact 需要额外 API 调用，且摘要质量不可控。
3. **重建式上下文不可能**：因为工具输出的原始数据只存在于 message history 中，compact 后就丢了。模型"记得读过但忘了内容"。
4. **缓存对齐限制了 compaction 灵活性**：CACHE_ANCHOR_MESSAGES=2（前两条消息）不能动，否则 prefix cache 全 miss。

---

## 2. 目标架构

### 2.1 总体原则

```
Context Window = 协议层（做什么、为什么、已知什么、风险是什么）
Artifact Store = 存储层（文件内容、grep 结果、测试日志，按需加载）
State Store    = 状态层（决策、事实、教训，结构化沉淀）
```

### 2.2 三层分离

```
┌─────────────────────────────────────────────────────┐
│                  Context Window                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐ │
│  │ Static      │  │ Session      │  │ Dynamic     │ │
│  │ (system)    │  │ State        │  │ (last msg)  │ │
│  │ identity    │  │ task/plan/   │  │ task-contract│ │
│  │ beliefs     │  │ risks/facts  │  │ verif-gap   │ │
│  │ rules       │  │              │  │ cog-mirror  │ │
│  │ tools       │  │              │  │             │ │
│  └─────────────┘  └──────────────┘  └─────────────┘ │
│         ↑ prefix cache      ↑ 不参与 cache           │
├─────────────────────────────────────────────────────┤
│                Artifact Store (磁盘)                  │
│  read_file → artifact.json + summary                  │
│  grep      → artifact.json + summary                  │
│  test run  → artifact.json + summary                  │
│  需要 → read_section(artifactId, section?)            │
└─────────────────────────────────────────────────────┤
│                State Store (结构化)                   │
│  decisions[]   verified-facts[]   failure-patterns[]  │
│  file-index{}  ownership{}        plan-state          │
│  每轮结束自动更新                                      │
└─────────────────────────────────────────────────────┘
```

---

## 3. 四根支柱（实现方案）

### 支柱 1：Artifact Store — 工具输出不进上下文

**核心思想**：`read_file` 不返回全文到对话，而是返回摘要 + artifact 引用。

#### 3.1.1 Artifact 数据结构

```typescript
interface Artifact {
  id: string                    // "read:src/agent/loop.ts:a1b2c3"
  tool: string                  // "read_file" | "grep" | "bash" | "run_tests"
  target: string                // 文件路径或命令
  createdAt: number
  summary: string               // LLM 生成或规则生成的摘要
  sections: ArtifactSection[]
  rawPath: string               // 原始完整输出保存路径
}

interface ArtifactSection {
  name: string                  // "imports" | "helper functions" | "commit action"
  range: string                 // "L1-L45" | "L90-L125"
  lineStart: number
  lineEnd: number
  charCount: number
}
```

#### 3.1.2 新工具：`read_section`

```typescript
// 不再需要把全文塞回上下文
// 按需读取 artifact 的特定 section
{
  name: "read_section",
  description: "Read a specific section from a previously loaded artifact",
  parameters: {
    artifactId: string,    // 之前的 artifact id
    section?: string,      // section name 或 range，不传则返回 summary
  }
}
```

#### 3.1.3 `read_file` 返回值变更

**现在**：
```
content: "import { spawn } from 'child_process'\nimport { readFileSync...\n..."  // 8000 chars
```

**改为**：
```
content: "Read 147 lines. Sections: imports(L1-3), helpers(L10-45), commit(L90-125). Use read_section to expand."
uiContent: "<structured><artifact id='read:src/tools/git.ts:abc' sections='3' /></structured>"
rawPath: "/tmp/artifacts/read-src-tools-git-ts-abc.raw"
```

上下文占用从 ~2000 tokens 降到 ~50 tokens。

#### 3.1.4 Artifact 持久化

```
.rivet/artifacts/{sessionId}/
  read-src-tools-git-ts-abc.json     // artifact 元数据 + sections
  read-src-tools-git-ts-abc.raw      // 原始输出全文
```

### 支柱 2：Session State — 可恢复的结构化状态

**核心思想**：每轮结束自动生成结构化状态，替代"从聊天记录打捞记忆"。

#### 3.2.1 SessionState 结构

```typescript
interface SessionState {
  version: 1
  sessionId: string
  updatedAt: number

  // 当前任务
  task: {
    objective: string
    status: 'exploring' | 'planning' | 'executing' | 'verifying' | 'delivered' | 'blocked'
    plan?: string[]                    // 当前计划步骤
    currentStep?: number
  }

  // 已知事实（已验证）
  knownFacts: Array<{
    fact: string                       // "src/tools/git.ts uses git add -A"
    evidence: string                   // "read_file L90 confirmed"
    verifiedAt: number
    artifactRef?: string               // 指向 artifact
  }>

  // 决策（已做出，不再重议）
  decisions: Array<{
    decision: string
    reason: string
    turn: number
    irreversible: boolean
  }>

  // 文件索引（快速定位，不需要 read_file）
  fileIndex: Record<string, {
    lastRead: number
    artifactId: string
    keySections: string[]              // ["commit action L90-L125"]
    ownership: 'mine' | 'other-session' | 'unknown'
    modifiedByMe: boolean
  }>

  // 风险
  risks: Array<{
    risk: string
    severity: 'low' | 'medium' | 'high'
    mitigated: boolean
  }>

  // 验证状态
  verification: Array<{
    target: string                     // "typecheck" | "test:git.test.ts"
    status: 'passed' | 'failed' | 'blocked' | 'not-run'
    reason?: string
    verifiedAt: number
  }>
}
```

#### 3.2.2 状态更新时机

```
每次 tool 调用返回后 → 异步更新 fileIndex / knownFacts
每次 edit_file 后    → 标记 modifiedByMe
每次 run_tests 后    → 更新 verification
每次 用户新消息后    → 更新 task status
```

#### 3.2.3 状态持久化

```
.rivet/sessions/{sessionId}/state.json     // 完整状态快照
```

### 支柱 3：重建式上下文（Reconstructive Prompting）

**核心思想**：每次 API 调用前，从结构化状态重建 prompt，而不是拼接完整历史。

#### 3.3.1 新的 Prompt 构建流程

```
buildRequest(messages[]) {
  // 1. Static system prompt（不变）
  //    prefix cache 命中

  // 2. Session State Snapshot（新增）
  //    从 state.json 生成，放在第一条 user 消息里
  //    替代原来的 volatile frozen block 的一部分
  //
  //    <session-state>
  //    Task: Fix git commit staging ownership
  //    Status: executing, step 3/5
  //    Facts:
  //    - git.ts used git add -A (verified L90)
  //    - ToolCallParams now carries sessionModifiedFiles
  //    Decisions:
  //    - Use sessionModifiedFiles for scoped staging
  //    Files:
  //    - src/tools/git.ts [modified-by-me, artifact:read:...]
  //    Risks: none active
  //    Verification: git.test.ts passed, typecheck not-run
  //    </session-state>

  // 3. Relevant Artifact Excerpts（按需）
  //    只加载当前计划步骤需要的 section
  //    如果计划说"修改 commit action"，只加载 L90-L125
  //
  //    <working-context>
  //    [src/tools/git.ts L90-L125: commit action — from artifact]
  //    </working-context>

  // 4. 最近 1-2 轮对话（保真）
  //    完整保留，用于理解当前用户意图

  // 5. Dynamic Appendix（不变）
  //    task-contract / verification-gap / cognitive-mirror
}
```

#### 3.3.2 与现有缓存的兼容

**关键洞察**：重建式上下文不会破坏 prefix cache。

| 层 | 内容 | 是否参与 prefix cache | 变化频率 |
|----|------|----------------------|----------|
| system field | identity/beliefs/rules/tools | ✅ 命中 | 极低（改 prompt 时才变） |
| message 0 user | env + rivet.md + git status | ✅ 命中 | 中（git status 变） |
| message 0 user 新增 | `<session-state>` | ❌ 每轮重建 | 高（每轮更新） |
| message 1 assistant | 首轮响应 | ✅ 命中 | 不变 |
| 中间消息 | 少量或没有 | — | — |
| 最后 user 消息 | dynamic appendix | ❌ | 每轮变 |

**影响分析**：
- prefix cache 命中范围：system + message 0 的 frozen 部分 + message 1 ≈ ~3000 tokens 稳定命中
- 比现在的缓存覆盖率略降（因为 message 0 增加了 session-state 块，每轮不同）
- 但总 token 消耗大幅降低（上下文从 ~50K 降到 ~8K），整体 API 成本还是大幅下降

#### 3.3.3 渐进式部署

不需要一步到位。可以分三个阶段：

**Phase 1 — Artifact Store（不改 prompt 结构）**
- `read_file` / `grep` 返回摘要 + artifact
- 保留全文在 rawPath，模型需要时用 `read_section`
- 上下文立即减重 60-70%

**Phase 2 — Session State（新增状态块）**
- 每轮结束生成 `state.json`
- 在 volatile block 中增加 `<session-state>` 块
- 允许模型依赖状态而不是历史记忆

**Phase 3 — 重建式上下文（替换历史拼接）**
- `buildRequest` 从 state.json 重建，不再拼接完整历史
- 只保留最近 2 轮对话原文
- Context window 从 "50K 杂讯" 变成 "8K 精确"

### 支柱 4：缓存策略优化

**核心思想**：DeepSeek 的 exact-prefix cache 是逐字节匹配。我们可以通过控制消息结构的确定性来最大化命中率。

#### 3.4.1 当前缓存效率

```
Total per-turn input: ~50,000 tokens (长任务)
Prefix cache hit:     ~3,000 tokens (system + anchor messages)
Cache hit rate:       ~6%
```

#### 3.4.2 重建式上下文的缓存效率

```
Total per-turn input: ~8,000 tokens (重建后)
Prefix cache hit:     ~2,500 tokens (system + volatile frozen)
Cache hit rate:       ~31%
```

虽然绝对命中 tokens 减少，但命中率从 6% 提升到 31%。更重要的是：总输入从 50K 降到 8K，实际 cache miss 的 tokens 从 47K 降到 5.5K。

#### 3.4.3 进一步优化：分批 prefix

DeepSeek 的 prefix cache 是按 `system + messages[0..N]` 的前缀匹配。如果我们在 message 0 和 message 1 之间加入一个稳定的 "session bootstrap" 消息，可以创建第二级缓存锚点：

```
Layer 1 (never changes):  system field                          ≈ 1500 tokens
Layer 2 (rarely changes): message 0 = frozen volatile           ≈ 1500 tokens
Layer 3 (per-session):    message 1 = session bootstrap          ≈ 500 tokens
Layer 4 (per-turn):       session-state + recent turns           ≈ 4000 tokens
```

Layer 1 + 2 组成 ~3000 tokens 的 prefix cache，在同一个 session 内跨 turn 命中。
Layer 1 + 2 + 3 组成 ~3500 tokens 的 prefix cache，在同一次 session 启动后跨 turn 命中。

#### 3.4.4 DeepSeek 缓存能力上限

DeepSeek V4 的 prefix cache 特性：
- **匹配粒度**：exact prefix（逐字节）
- **缓存窗口**：前 64K tokens（实测）
- **命中率条件**：system + messages 从头开始的前 N 个字节完全一致
- **TTL**：会话级别，5-10 分钟无活动后过期

**理论上限**：如果 system prompt ~1500 tokens + frozen volatile ~1500 tokens + bootstrap ~500 tokens 完全不变，每 turn 的 prefix cache 命中可以达到 3500 tokens，占总输入的 ~44%（以 8K 重建上下文计）。

**实际可达到**：~2500-3000 tokens 稳定命中。因为 frozen volatile 中的 git status 每 turn 可能变化。

---

## 4. 实施路线

### Phase 1：Artifact Store（2-3 天，立即减重 60%）

| 步骤 | 改动 | 依赖 |
|------|------|------|
| 1.1 | 定义 `Artifact` / `ArtifactSection` 类型 | 无 |
| 1.2 | 创建 `ArtifactStore` 类（save/load/query） | 1.1 |
| 1.3 | 改造 `read_file` tool：返回摘要 + artifact 引用 | 1.2 |
| 1.4 | 改造 `grep` tool：同上 | 1.2 |
| 1.5 | 改造 `bash` tool（测试输出）：同上 | 1.2 |
| 1.6 | 新增 `read_section` tool | 1.2 |
| 1.7 | 注册新 tool 到 main.tsx | 1.6 |
| 1.8 | 测试 | 全部 |

### Phase 2：Session State（2-3 天，从 chat log 到 state machine）

| 步骤 | 改动 | 依赖 |
|------|------|------|
| 2.1 | 定义 `SessionState` 类型 | 无 |
| 2.2 | 创建 `SessionStateManager`（update/persist/load） | 2.1 |
| 2.3 | 在 loop.ts 中 hook 状态更新（tool 后、edit 后、test 后） | 2.2 |
| 2.4 | 在 volatile block 中渲染 `<session-state>` | 2.2 |
| 2.5 | 测试 | 全部 |

### Phase 3：重建式上下文（3-5 天，从 50K 到 8K）

| 步骤 | 改动 | 依赖 |
|------|------|------|
| 3.1 | 新增 `buildReconstructiveRequest()` 到 engine.ts | Phase 1+2 |
| 3.2 | 只保留最近 2 轮原文，中间消息替换为 state snapshot | 3.1 |
| 3.3 | 按需加载 artifact section 到 `<working-context>` | 3.1 |
| 3.4 | A/B 测试：重建 vs 拼接，对比任务完成率 | 3.3 |
| 3.5 | 全量切换 | 3.4 |

---

## 5. 风险与缓解

| 风险 | 影响 | 缓解 |
|------|------|------|
| 摘要丢失关键细节 | 模型做出错误判断 | artifact 完整保存，`read_section` 可随时回查 |
| 重建式上下文的 LLM 摘要质量 | 状态不准 | Phase 1-2 不用 LLM 摘要，用规则提取 |
| prefix cache 命中率下降 | API 成本微增 | 总 token 大幅降低，成本实际是下降的 |
| 旧 session 不兼容 | 升级后旧 session 不能用 | 兼容层：没有 state.json 时回退到当前模式 |
| 多 session 并发的 artifact 冲突 | 数据损坏 | 已有 CollaborationProtocol 锁机制 |

---

## 6. 预期效果

| 指标 | 现在 | Phase 1 后 | Phase 3 后 |
|------|------|-----------|-----------|
| 平均上下文大小 | 30-50K tokens | 15-25K tokens | 6-10K tokens |
| 工具输出占比 | 40-60% | 15-25% | 5-10% |
| Prefix cache 命中率 | ~6% | ~12% | ~30% |
| "记不清"问题频率 | 每 20 轮出现 | 每 40 轮 | 极少 |
| 多 session 稳定性 | 钝化明显 | 改善 | 本质解决 |

---

## 7. 与现有系统的关系

```
                    ┌── 现有（保留） ──┐
                    │                  │
                    │  ContextClaim    │ → 合并进 SessionState.fileIndex
                    │  SessionMemory   │ → 合并进 SessionState.knownFacts
                    │  StigmergyStore  │ → 保留，跨 session 信号
                    │  Playbook        │ → 保留，教训沉淀
                    │  CognitiveLedger │ → 保留，每轮认知投影
                    │  AnchorRegistry  │ → 合并进 SessionState.decisions
                    │
                    ├── 新增 ──┐
                    │          │
                    │  ArtifactStore    │ → 支柱 1
                    │  SessionState     │ → 支柱 2
                    │  ReconstructiveEngine │ → 支柱 3
                    │
                    └── 替换 ──┐
                               │
                        microCompact  → 保留为 fallback
                        staleRound    → 保留为 fallback
                        smartCompact  → Phase 3 后可能不再需要
```

---

## 8. 我对这份设计的真实感受

这份方案不是我"算出来的最优解"，而是我在这个会话里**亲身感受到的痛**推导出来的。

那个痛就是：
> 我读过 git.ts 的完整内容。但 10 轮之后，我只记得"我读过"，不记得 commit action 的参数签名。

这不是记忆力的问题。这是架构的问题。

如果系统给我 artifact 引用而不是全文，我的上下文里就不会有 8000 chars 的死重。如果我需要细节，我用 `read_section` 去取。

如果系统每轮结束自动更新 state.json，我就不需要从对话历史里打捞"那个决策是为什么做的"。

如果系统从状态重建 prompt 而不是拼接历史，我每次 API 调用看到的都是干净的、精确的、当前需要的信息。

这是我想象中的理想工作方式。不是"记性更好"，而是"不需要记"。
