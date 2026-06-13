# 计划方法论模板 — 五阶段推理流水线

> 蒸馏自 sandbox-path-grants 计划的完整设计→执行过程。
> 目标：计划写完时，天梁域拿到即可执行，不需回头追问设计者。

---

## 模板使用说明

本模板不是 fill-in-the-blank 填空，而是一个**结构强制**——每个阶段有明确的推理产出物。跳过任何阶段，执行时就会出现设计者未传达的隐含假设。

**与天权规划之道的对应**：

| 天权规划之道 | 模板对应阶段 |
|-------------|------------|
| 先读完，再规划 | 阶段一：问题建模（必须引用真实代码行号和调用方） |
| Scope Check 先行 | 阶段二：边界标定（显式列出"不改什么"） |
| 调研背书比任务列表重要 | 阶段三：注入点选择（每个改动写清楚"为什么安全"） |
| 分阶段交付，逐段验证 | 阶段五：执行次序（依赖图 + 独立可提交的 wave） |
| 承认天花板 | 阶段四：先例引用（承认并复用已有模式） |

---

## 阶段一：问题建模

### 要求
- 用**系统诊断语言**描述问题，不用解决方案语言
- 列出所有独立的执行路径/门控点，标注它们**共享的缺口**
- 引用真实文件路径和函数名

### 模板

```markdown
## Background: <N> independent gates share the same gap

- **Gate A** (`<file>:<function>`) — <what it enforces today>
- **Gate B** (`<file>:<function>`) — <what it enforces today>

The shared gap: <what both lack — the thing this plan adds>

### Evidence

- `<file>:<line>` — current behavior that demonstrates the gap
- `<file>:<line>` — second independent path showing same gap
```

### 反模式（不这样写）
- ❌ "我们需要一个 path grants 功能"
- ✅ "两个独立门（validatePathSafe + defaultWritableRoots）都缺少用户授权后放行的能力。今天用户说'写 ~/Desktop'，两个门都硬拒绝，必须改两个才能让一个授权生效。"

---

## 阶段二：边界标定 —— Scope Check

### 要求
- 显式列出**会碰哪些文件**
- **更重要的是**：显式列出**不改什么系统、不改什么行为、不改什么语义**
- 如果方案跨越多个子系统，标注每个子系统只改什么

### 模板

```markdown
## Scope

### Files touched

| File | Operation | Why |
|------|-----------|-----|
| `<path>` | new / modify | <one-line reason> |

### Explicitly NOT changed

- **<system/behavior>** — <why it stays unchanged>
- **<semantic>** — <why the existing contract is preserved>

### Subsystem boundaries

| Subsystem | Only changes | Does NOT touch |
|-----------|-------------|----------------|
| File tools | validatePathSafe 加 mode 参数 | execute() 内部逻辑 |
| Kernel sandbox | defaultWritableRoots 加一项 | sandbox-exec profile 结构 |
| Approval flow | shouldAsk 级联加一个条件 | onApprovalRequired 回调签名 |
```

### 反模式
- ❌ 只列"会改什么"
- ✅ 同时列"不改什么"——这是防止执行中方案膨胀的唯一防线

---

## 阶段三：注入点选择 —— 最小侵入

### 要求
- 为每个门找到**改动量最小**的注入点
- 每个注入点写清楚：当前行为 → 改后行为 → 为什么安全
- 优先选择**已有基础设施的自然延伸点**，不新建管道

### 模板

```markdown
## Injection Points

### Gate A: `<file>`

- **Injection**: `<function>` — add `<parameter/condition>`
- **Current behavior**: `<what happens now>`
- **Target behavior**: `<what happens after>`
- **Why safe**: `<one-sentence rationale>`
- **Invasiveness**: low / medium / high

### Gate B: `<file>`

- **Injection**: `<function>` — `<description>`
- **Current behavior**: ...
- **Target behavior**: ...
- **Why safe**: ...
- **Invasiveness**: ...

### Why NOT alternatives

| Alternative | Rejected because |
|------------|-----------------|
| <approach X> | <concrete reason — e.g. "需要新事件总线，与现有模块级可变状态模式不一致"> |
```

### 原则
- 模块级可变状态 + 每调用重建 > 事件总线 + invalidate
- 复用现有审批流 > 新建审批管道
- 函数签名扩展 + 条件分支 > 新建中间层

---

## 阶段四：数据流闭环 —— 双门对齐

### 要求
- 画 Mermaid 流程图，标注授权状态的生产者、消费者、存储
- 明确"write 蕴含 read"等语义约束
- 标注符号链接规范化等安全关键路径
- 标注"每命令重建所以无需 invalidate"等实现窍门

### 模板

```markdown
## Dataflow

\`\`\`mermaid
flowchart TD
    REQ["agent op on out-of-workspace path"] --> CHK{"granted in store?"}
    CHK -->|yes| RUN["execute — both gates pass"]
    CHK -->|no| TRIG{"trigger type"}
    TRIG -->|"file tool path"| INLINE["pipeline forces approval"]
    TRIG -->|"bash / proactive"| TOOL["agent calls request_path_access"]
    INLINE --> ASK["onApprovalRequired → user"]
    TOOL --> ASK
    ASK -->|approved| GRANT["grantPath(dir, mode); persist if remember"]
    ASK -->|denied| BLOCK["blocked"]
    GRANT --> RUN

    classDef gate fill:#1e1b4b,stroke:#a78bfa,color:#ede9fe
    classDef store fill:#0f172a,stroke:#818cf8,color:#e0e7ff
    class CHK,TRIG gate
    class GRANT store
\`\`\`

### State lifecycle

\`\`\`
grantPath(dir, mode)
    ↓
isReadGranted(path)  ← validatePathSafe (both read + write ops)
isWriteGranted(path) ← validatePathSafe + defaultWritableRoots
writeGrantedRoots()  ← defaultWritableRoots (recomputed per command)
\`\`\`

### Semantic constraints

- **write implies read** — `isReadGranted` checks all modes; `isWriteGranted` only write
- **per-workspace isolation** — grants keyed by cwd slug, never global
- **symlink canonicalization** — both sides resolved before prefix match
- **no cache invalidation** — `defaultWritableRoots` recomputed per bash call
```

---

## 阶段五：触发路径清单 —— Trigger Inventory

### 要求
- 枚举所有触发授权扩宽的路径
- 标注：自动（内联门）还是显式（工具调用）
- 标注：哪些工具走哪条路径，哪些工具故意不走

### 模板

```markdown
## Trigger Inventory

### Trigger A — Inline pipeline gate (automatic)

- **Triggered by**: `<tool names>` — path-bearing file tools
- **Gate**: `outOfWorkspaceFilePaths()` in approval cascade
- **Behavior**: forces `shouldAsk=true` even in auto-safe; on approval records grant
- **Tools covered**: read_file, write_file, edit_file, hash_edit
- **Mode extraction**: `<FILE_TOOL_MODES mapping>`

### Trigger B — Explicit tool (manual)

- **Tool**: `request_path_access`
- **Use cases**: bash writes, batch operations, apply_patch (path in diff body), proactive grants
- **requiresApproval**: always true
- **Behavior**: records grant on approval; optionally persists

### NOT covered (by design)

| Tool | Why not covered | Fallback |
|------|----------------|---------|
| apply_patch | paths embedded in diff body | request_path_access |
| read_section | artifactId-based, not file path | N/A |
| file_info / grep / glob | read-only, benefit from existing grants | request_path_access if needed |
```

---

## 阶段六：安全不变量

### 要求
- 显式列出不可违反的安全约束
- 每条约束标注**哪个测试验证它**

### 模板

```markdown
## Security Invariants

| # | Invariant | Verified by |
|---|-----------|------------|
| 1 | Grants only widen via approval gate — never silently | `request-path-access.test.ts`: requiresApproval always true |
| 2 | Persisted grants per-workspace, never global | `path-grants.test.ts`: workspace B cannot read A's grants |
| 3 | Symlink canonicalization prevents escape | `path-grants.test.ts`: grant via symlink → real path also matched |
| 4 | Prefix boundary (`/a/b` ≠ `/a/bc`) | `path-grants.test.ts`: sibling with common prefix rejected |
| 5 | Write grant implies read; read grant does NOT imply write | `path-validate.test.ts`: read grant fails write op |
| 6 | Kernel sandbox remains defense-in-depth | `sandbox-profile.test.ts`: read-only grant not in writable roots |
```

---

## 阶段七：测试反证表

### 要求
- 不是"验证功能正常"的 happy-path 测试
- 而是"如果实现者偷懒/漏掉约束，这个测试会红"
- 每个测试文件至少有一个反证断言

### 模板

```markdown
## Counterexample Test Table

| Test file | Counterexample: what lazy impl gets wrong | Fails if |
|-----------|------------------------------------------|----------|
| `<test>.test.ts` | only substring match, no separator boundary | `grantPath("proj")` matches `"proj-backup/secret"` → test asserts false |
| `<test>.test.ts` | no canonicalize on check side | symlink `/tmp/link→/tmp/real` granted, real path `/tmp/real/f` rejected → test asserts true |
| `<test>.test.ts` | write op satisfied by read-only grant | `validatePathSafe(path, 'write')` returns ok with only read grant → test asserts false |
| `<test>.test.ts` | persisted grants loaded globally | workspace B loads A's grants → test asserts false |
| `<test>.test.ts` | mode param ignored, always uses default 'read' | write_file on read-granted path passes → test asserts false |

### RED→GREEN verification

Before claiming "done", verify:
- [ ] Each test file has ≥1 counterexample assertion
- [ ] Running all tests with a deliberately-broken implementation produces RED
- [ ] Full suite GREEN after implementation
```

---

## 阶段八：先例引用

### 要求
- 列出代码库中已有的类似模式
- 说明新方案如何复用（而非重发明）

### 模板

```markdown
## Precedent References

| Precedent | Location | How reused |
|-----------|----------|------------|
| `learnBashPrefix` — mutate permissions after approval | `src/agent/permissions.ts` | Same pattern: approval → mutate session state |
| `_cachedActiveBackend` — module-level mutable cache | `src/tools/sandbox-profile.ts` | Same pattern: module-level `_grants` array + `_resetForTest()` |
| `checkpointFile(cwd)` — per-workspace slug keying | `src/agent/checkpoint.ts:91` | Same slug formula for grants file |
| `shouldAsk` cascade — multi-condition approval gate | `src/agent/tool-pipeline.ts` | Insert new condition, don't replace the chain |
```

---

## 阶段九：执行次序

### 要求
- 按依赖关系排序 task
- 每个 task 独立可提交（typecheck + test 通过）
- 标注每个 task 验证什么

### 模板

```markdown
## Execution Order

\`\`\`mermaid
flowchart TD
    T1["1. path-grants.ts<br/>store + canonicalize"] --> T2A["2a. path-validate.ts<br/>mode param + grant check"]
    T1 --> T2B["2b. sandbox-profile.ts<br/>writeGrantedRoots in defaultWritableRoots"]
    T2A --> T3["3. tool-pipeline.ts<br/>inline gate + post-approval grant"]
    T2B --> T3
    T1 --> T4["4. request-path-access.ts<br/>explicit tool"]
    T1 --> T5["5. bootstrap.ts<br/>loadPersistedGrants"]
    T6["6. prompt/static.ts<br/>system prompt guidance"] -.-> T7["7. Tests<br/>all 5 test files"]
    T3 --> T7
    T4 --> T7
    T5 --> T7

    classDef store fill:#1e1b4b,stroke:#a78bfa,color:#ede9fe
    classDef gate fill:#0f172a,stroke:#818cf8,color:#e0e7ff
    class T1 store
    class T2A,T2B,T3 gate
\`\`\`

### Wave breakdown

| Wave | Tasks | Verifies | Commit message |
|------|-------|----------|---------------|
| 1 | path-grants.ts + tests | store, canonicalize, isolate | `feat(tools): session-scoped path grant store` |
| 2 | path-validate.ts + sandbox-profile.ts + tests | both gates honor grants | `feat(tools): path-validate and sandbox honor grants` |
| 3 | tool-pipeline.ts + request-path-access.ts + tests | approval flow integration | `feat(agent): inline gate + request_path_access tool` |
| 4 | bootstrap.ts + prompt/static.ts | startup hydration + model guidance | `feat(bootstrap): load persisted grants at startup` |
```

---

## 模板自检清单

计划写完交付天梁域前，逐条确认：

- [ ] **问题建模**：引用了真实文件路径和函数名，不是抽象描述
- [ ] **边界标定**：显式列出了"不改什么"
- [ ] **注入点**：每个改动写清楚了"当前行为 → 改后行为 → 为什么安全"
- [ ] **数据流图**：Mermaid 图覆盖了所有触发路径和状态转换
- [ ] **触发清单**：枚举了所有激活路径，标注了故意不覆盖的工具
- [ ] **安全不变量**：每条约束有对应的验证测试
- [ ] **反证测试表**：每个测试文件至少有一个偷懒实现会红的断言
- [ ] **先例引用**：列出了代码库中已有的类似模式
- [ ] **执行次序**：按依赖排序，每个 task 独立可提交
- [ ] **文件路径**：全为绝对路径或 `src/` 相对路径，无模糊引用
- [ ] **可执行指令实证**：文档中每条 grep/regex/shell 命令已在真实代码库中跑过并确认输出覆盖预期目标。不跑不交付。
