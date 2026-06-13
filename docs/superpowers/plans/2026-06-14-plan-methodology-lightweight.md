# 计划模板（轻量版）— 单模块重构 / 内聚变更

> 从[完整版模板](2026-06-14-plan-methodology-template.md)缩减而来。
> 适用场景：单文件或单模块重构、纯函数抽取、数据模型变更、向后兼容的接口调整。
> 不适用场景：跨多 enforcement point 的安全/权限/沙箱变更（用完整版）、跨子系统协议变更。

---

## 与完整版的差异

| 完整版阶段 | 轻量版处理 |
|-----------|-----------|
| 一：问题建模 | **保留** — 简化为"当前症状 + 根因" |
| 二：边界标定 | **保留** — 但重点从"不改什么安全门"转为"不改什么调用方" |
| 三：注入点选择 | **合并**入阶段三（改动设计） |
| 四：数据流闭环 | **合并**入阶段三（改动设计）— 单模块不需要双门对齐 |
| 五：触发路径清单 | **降为可选** — 只在有多条激活路径时写 |
| 六：安全不变量 | **降为可选** — 只在触及安全关键代码时写 |
| 七：测试反证表 | **保留** — 反证思维对任何变更都有价值 |
| 八：先例引用 | **保留** — 引用已有模式降低认知负荷 |
| 九：执行次序 | **保留** — 依赖排序仍是防止返工的关键 |

---

## 阶段一：问题诊断

### 模板

```markdown
## Diagnosis

### Current symptoms

- **Symptom A**: <observable misbehavior — what the user/agent sees>
  - Evidence: `<file>:<line>` or test that demonstrates it
- **Symptom B**: <if multiple>

### Root cause

<Why this happens. Reference the specific code path — function name, condition, missing case.>

### Success criteria

- [ ] <verifiable condition 1>
- [ ] <verifiable condition 2>
```

### 反模式
- ❌ "代码不够好，需要重构"
- ✅ "`handleToolResult` 第 1230 行 collapsible tool 提前 return，从未执行 `pendingTools.delete(id)`，导致 live 区永远显示已完成工具的执行卡片"

---

## 阶段二：边界与消费者影响

### 要求
这是单模块重构**最容易跳但最关键**的阶段。不列消费者清单 = 合并后消费者构建失败。

### 不可删的最小步骤（2026-06-14 补强）

> ⚠️ 以下步骤即使在轻量版中也**不可跳过**——它是原则 A（双门模型）的最小防御。

**Grep 同一 guard 的所有调用路径**：如果改动涉及任何 guard/validate/check/sandbox/permission 函数，必须 grep 所有调用该 guard 的路径。这防止"看起来只碰了一个门，实际有第二个门被漏掉"的静默失效。

```bash
# 示例：改 path-validate.ts 时必须执行
grep -r "validatePathSafe\|validatePath\b" src/ --include="*.ts" -l
```

如果 grep 结果跨多个 enforcement 子系统（tools/ + agent/），应升级为完整版模板。

### 模板

```markdown
## Scope & Consumer Impact

### Files touched

| File | Operation | Why |
|------|-----------|-----|
| `src/foo/bar.ts` | modify — rename export X → Y | core change |
| `src/baz/qux.ts` | modify — update import | consumer |
| `src/foo/__tests__/bar.test.ts` | modify — update test imports | test |

### Consumer inventory（调用方清单）

grep 所有导入/调用目标符号的地方，不要靠记忆。

| Consumer | What it uses | Impact |
|----------|-------------|--------|
| `src/tui/engine/app.ts:1230` | `ToolGroup`, `canCollapse`, `groupFamily` | 导入路径 + 函数名变更 |
| `src/main-ansi.ts:89` | `formatToolCard` (from tool-group) | re-export 链变更 |
| `src/tui/__tests__/tool-group.test.ts` | old component test | 删除或重写 |

### Explicitly NOT changed

- **<export/behavior>** — <why it stays, who depends on it>
- **<semantic contract>** — <e.g. "ToolResult 类型不变，只改内部实现">
```

### 反模式
- ❌ 只列自己要改的文件
- ✅ grep 所有消费者，列出每一个受影响的外部文件

---

## 阶段三：改动设计

### 要求
合并了完整版的"注入点选择"+"数据流闭环"。单模块不需要画多门之间的状态同步图，但需要：
1. 当前行为 → 改后行为
2. 为什么安全 / 为什么不破坏消费者
3. 如果涉及类型/接口变更，画出新旧结构对比

### 模板

```markdown
## Change Design

### 3.1 数据模型（如有变更）

\`\`\`
旧：
  ToolGroup { family, entries, ... }
  groupFamily(toolName) → 'read' | 'write' | ...

新：
  CollapsedReadSearchEntry { id, kind, completed, content }
  CollapsedReadSearchGroup { kind: 'read+search', entries }
  classifyCollapsibleKind(toolName) → 'read' | 'search' | null
\`\`\`

### 3.2 纯函数抽取（如有）

| 函数 | 输入 → 输出 | 从哪拆出 | 原因 |
|------|------------|---------|------|
| `isCollapsibleTool(name)` | `string → boolean` | `app.ts:handleToolResult` | 可单测 |
| `buildSummaryText(group)` | `Group → string` | `app.ts:renderScrollback` | 可单测 + 复用 |

### 3.3 改动点明细

| # | File | Current | Target | Why safe |
|---|------|---------|--------|----------|
| 1 | `tool-group.ts` | `canCollapse(family)` | → `isCollapsibleReadSearch(name)` | 纯重命名，行为不变 |
| 2 | `app.ts:1230` | `if (canCollapse(family))` | → `if (isCollapsibleReadSearch(name))` | 调用方适配 |
| 3 | `app.ts:1245` | `pendingTools` 泄漏 — 提前 return 未 delete | → 补充 `pendingTools.delete(id)` | 修复现有 bug |
| 4 | `app.ts:renderLive` | 无条件遍历 pendingTools | → 先分类 collapsible/nonCollapsible | 新增 live 聚合 |

### 3.4 向后兼容策略（如适用）

\`\`\`
Phase 1: 新建 collapsed-read-search.ts（全部新代码）
Phase 2: tool-group.ts 中 re-export 新函数别名 + @deprecated 标记
Phase 3: app.ts 切换为新文件
Phase 4: 确认无其他消费者后删除旧文件
\`\`\`
```

---

## 阶段四：反证测试

### 要求
与完整版相同——每个测试文件至少有一个"偷懒实现会红"的断言。

### 模板

```markdown
## Counterexample Tests

| Test file | Counterexample: lazy impl gets wrong | Fails if |
|-----------|--------------------------------------|----------|
| `collapsed-read-search.test.ts` | `classifyCollapsibleKind` 只 cover grep/glob，忘了 repo_map | `repo_map` 分类为 null 而预期为 'search' |
| `collapsed-read-search.test.ts` | `attachResult` 用 toolName 匹配而非 toolUseId | 两个并行 read_file 结果错绑到对方 entry |
| `app-tool-group.test.ts` | flush 时包含未完成的 entry | `buildSummaryText` 统计了 `completed: false` 的 entry |
| `app-tool-group.test.ts` | collapsible tool 结果到达后 pendingTools 未清理 | 两次 render 之间 pendingTools size 未减少 |

### Pre-existing tests (must stay GREEN)

| Test file | Tests | Status |
|-----------|-------|--------|
| `src/tui/__tests__/app.test.ts` | 35 tests | must not regress |
```

---

## 阶段五：执行次序

### 模板

```markdown
## Execution Order

\`\`\`mermaid
flowchart TD
    T1["1. 新建纯函数 + 类型<br/>collapsed-read-search.ts"] --> T2["2. 修复 pendingTools 泄漏<br/>app.ts bug fix"]
    T1 --> T3["3. 切换 app.ts<br/>新类型 + live 聚合"]
    T1 --> T4["4. 新建测试<br/>collapsed-read-search.test.ts"]
    T3 --> T5["5. 集成测试<br/>app-tool-group.test.ts"]
    T6["6. 旧文件 deprecation<br/>tool-group.ts → @deprecated"] --> T7["7. 删除旧文件"]
    T5 --> T6

    classDef new fill:#1e1b4b,stroke:#a78bfa,color:#ede9fe
    classDef fix fill:#0f172a,stroke:#818cf8,color:#e0e7ff
    class T1,T4 new
    class T2 fix
\`\`\`

### Wave breakdown

| Wave | Tasks | Verifies | Commit |
|------|-------|----------|--------|
| 1 | 新建 `collapsed-read-search.ts`（纯函数 + 类型） | 独立 typecheck | `refactor(tui): extract collapsed-read-search pure functions` |
| 2 | 修复 `app.ts` pendingTools 泄漏 | bug fix, test GREEN | `fix(tui): pendingTools leak in collapsible tool results` |
| 3 | 切换 `app.ts` + 新建测试 | typecheck + tests | `refactor(tui): switch to collapsed-read-search pipeline` |
| 4 | 旧文件 deprecation → 删除 | 确认无消费者 | `chore(tui): remove deprecated tool-group module` |
```

---

## 可选附录

### 附录 A：触发路径（仅在多激活路径时写）

```markdown
## Trigger Paths

| Trigger | Activation | Behavior |
|---------|-----------|----------|
| `onToolUse` — collapsible tool | `isCollapsibleReadSearch(name)` → true | push entry, do NOT render card |
| `onToolUse` — non-collapsible tool | `isCollapsibleReadSearch(name)` → false | flush group first, then render card |
| `onToolResult` — streaming chunk | `isError === undefined` | accumulate in toolAccumulator |
| `onToolResult` — terminal result | `isError !== undefined` | attach content to entry |
| `renderLive` | every frame | aggregate collapsible pending → single line |
```

### 附录 B：安全不变量（仅在触及安全关键代码时写）

```markdown
## Security Invariants

| # | Invariant | Verified by |
|---|-----------|------------|
| 1 | <constraint> | <test that enforces it> |
```

---

## 轻量版自检清单

计划交付天梁域前：

- [ ] **问题诊断**：引用了真实代码行号，症状可复现
- [ ] **消费者清单**：grep 过所有调用方，不是凭记忆列的
- [ ] **改动设计**：每条改动有"当前→目标→为什么安全"
- [ ] **向后兼容**：如果涉及重命名/删除导出，有迁移窗口策略
- [ ] **反证测试**：至少有一个"偷懒实现会红"的断言
- [ ] **执行次序**：依赖排序，每 wave 独立可提交
- [ ] **不改什么**：显式列出保持不变的合约/导出
