> **Status: ARCHIVED** — 2026-06-19 (审计/复盘文档)

# Tool Group 生产化 — 天璇·瑶光方法补充

> 基于天璇（跨域共振·反证纪律·温跃层）和瑶光（复现即证·归族·中性归因·落地核对）的方法论，
> 对上一轮评估的 8 项缺口做深层补充，并给出可落地的反证测试表与归族结论。

---

## 一、天璇：跨域共振 — 三个无关领域的碎片

### 碎片 1：Git Interactive Rebase

`git rebase -i` 把连续 commit 折叠为一行 `pick` + 多行 `fixup`/`squash`。这与 tool group 同构：

| Git Rebase | Tool Group |
|-----------|------------|
| commit hash | toolUseId |
| `pick` = 保留独立 | non-collapsible tool = 独立卡片 |
| `fixup` = 合并到上一个 | collapsible tool = 并入组 |
| `reword` = 改摘要 | `buildSummaryText` = 组摘要 |
| 展开查看详情 | ctrl+o 展开组 |

**共振点**：Git 的 fold 逻辑不是"同 author"或"同 date"，而是**连续序列 + 用户意图标记**。我们的 group 逻辑同样是"连续 collapsible 序列"，非"同 tool 族"。这个底层同构验证了计划的"统一 read+search 单组"方向。

### 碎片 2：Shell Job Control

`jobs` / `fg` / `bg` 按 PID 跟踪并行进程：

| Shell Job Control | Tool Group Buffer |
|-------------------|-------------------|
| PID | toolUseId |
| `jobs` 列出所有作业 | `pendingTools` Map |
| `fg %1` 前台指定作业 | `attachResult(buffer, id)` |
| 作业完成后从表移除 | terminal result → delete from pendingTools |

**共振点**：Shell 不会用"进程名"匹配作业——两个 `curl` 同时跑，靠 PID 区分。这直接否定了当前 `handleToolResult` 用 `toolName` 匹配 entry 的做法。**id 绑定不是优化，是正确性前提。**

### 碎片 3：Browser DevTools Network Tab

Network 面板将并行请求按时间排序，同类请求（如所有 `.js`）有视觉分组但保留独立条目。关键设计：

- 摘要行显示请求数 + 总耗时 + 总大小
- 展开后每条请求独立可查
- **已完成和进行中的请求视觉区分**（spinner vs checkmark）

**共振点**：我们的 `CollapsedReadSearchGroup` 需要区分 `completed` 和 pending 的 entry——进行中的显示 spinner，已完成的显示结果行数。这比原计划的 `completed: boolean` 更进一步：需要 **render-time 状态区分**。

### 收敛

三个独立领域指向同一模式：**identity-keyed accumulation → summary row → expand-to-detail**。计划的核心方向（id 绑定 + 统一组 + ctrl+o 展开）是三域收敛的结果，不是某一个领域的类比。这个方向的置信度很高。

---

## 二、天璇：反证纪律 — 杀死最兴奋的假设

### 假设 1：「统一 read+search 单组始终更好」

**反证**：Agent 经常产出这种模式：
```
read_file A    (t=0s)
grep "foo"     (t=1s)   ← 基于 A 的内容决定搜什么
read_file B    (t=2s)   ← 基于 grep 结果读另一个文件
```

如果这三者在一组，scrollback 显示：
```
● Searched 1 pattern, read 2 files · 3s
  ⎿  src/A.ts (200L)
  ⎿  "foo" in src/
  ⎿  src/B.ts (150L)
```

用户看到这个摘要时需要**反向解析**才能理解 agent 的逻辑链（先读→再搜→再读）。而分两组：
```
● Read src/A.ts · 0.5s               ● Searched "foo", read 1 file · 2.5s
  ⎿  200L                               ⎿  "foo" in src/
                                         ⎿  src/B.ts (150L)
```

**结论**：反证成立——统一组在"探索型"调用序列中更好，但在"推理链"序列中更差。但我们**不做拆分**。理由：
1. 区分"探索型"和"推理链"需要语义理解，超出纯函数能力
2. 用户可以用 ctrl+o 展开查看完整序列
3. 折中方案（按时间间隔分组）引入不必要的复杂度

**反证结果**：假设存活（有瑕疵但选择承担），记录为已知取舍。

### 假设 2：「lastCollapsedGroup 足够用」

**反证**：用户看到组摘要，想展开 3 个 turn 前的某个组——lastCollapsedGroup 模式做不到。这是否 unacceptable？

**验证**：当前 `lastTruncatedTool` 有同样的限制——只能展开最近一条被截断的工具。在实际使用中，用户通常想展开的是"刚刚看到的那条"，而不是"3 个 turn 前的"。所以 last-N（N=1）的窗口在终端 TUI 的交互范式下是合理的。

**反证结果**：假设存活。但添加一个防御：如果用户在 ctrl+o 展开后又按 ctrl+o（没有新的截断组），给一个 dim 提示 `(nothing to expand)` 而非静默吞键。

### 假设 3：「纯函数测试足够覆盖」

**反证**：纯函数测试只能验证"给定输入产生给定输出"，无法验证"app.ts 在正确的时机调用了正确的函数"。需要一个集成测试：模拟 AgentCallbacks 序列，断言 scrollback 内容和 live region 状态。

**反证结果**：假设不完全成立。需补充至少一个集成测试（见下文瑶光第 1 条）。

---

## 三、天璇：温跃层感知 — 层间边界比层本身更有趣

### 温跃层 1：`tool-group.ts` ↔ `app.ts`

当前 `tool-group.ts` 定义了 `ToolGroup` 类型和 `formatToolGroup` / `shouldFlushGroup` / `canCollapse` 等函数。`app.ts` 持有 buffer 并驱动刷新。

**温跃层发现**：buffer 管理逻辑（push entry / find by id / attach result / flush decision）嵌在 `app.ts` 的私有方法中，与渲染逻辑和事件处理混在一起。这层边界目前是模糊的。

**天枢设计**：在两层之间插入一个独立的 **`CollapsedReadSearchBuffer`**（纯数据结构 + 方法），放在 `collapsed-read-search.ts` 中：

```typescript
// collated-read-search.ts 新增

export class CollapsedReadSearchBuffer {
  private group: CollapsedReadSearchGroup | null = null

  pushUse(entry: CollapsedReadSearchEntry): void { ... }
  attachResult(id: string, content: string, isError?: boolean): CollapsedReadSearchEntry | null { ... }
  shouldBreak(toolName: string): boolean { ... }
  flush(): CollapsedReadSearchGroup | null { ... }
  getActive(): CollapsedReadSearchGroup | null { ... }
}
```

这层插入的好处：
- `app.ts` 从"管理 buffer 状态"变成"调用 buffer API"
- buffer 逻辑可以独立测试（不依赖 TuiApp 实例化）
- 未来如果有第二个渲染目标（如 web UI），buffer 可以直接复用

### 温跃层 2：scrollback 渲染 ↔ live 渲染

当前 `formatToolGroup` 同时服务 scrollback（通过 `flushToolGroup`）和可能的 live 聚合。但两者语义不同：

| 维度 | Scrollback | Live |
|------|-----------|------|
| 内容 | 已完成 entry 的完整摘要 | 进行中 entry 的进度 |
| 截断 | 展开/折叠切换 | 固定 1-2 行 |
| 交互 | ctrl+o 展开 | 纯展示 |
| 刷新 | 一次性 flush | 每 120ms 重绘 |

**天枢设计**：拆分为两个渲染函数：
- `formatCollapsedReadSearchScrollback(group, expanded?)` — 用于 flush 到 scrollback
- `formatCollapsedReadSearchLive(group)` — 用于 live region 聚合行

---

## 四、瑶光：复现即证 — RED→GREEN 测试表

当前 `tool-group.test.ts` 的测试是：
```typescript
assert.ok(typeof ToolGroup === 'function' || typeof ToolGroup === 'object')
```

这是"绿非证明"的标本——测试绿了但什么都没验证。以下给出**能打红错误实现**的测试矩阵：

### 纯函数测试（collapsed-read-search.test.ts）

| 测试 | RED 条件 | 覆盖的偷懒实现 |
|------|---------|-------------|
| `isCollapsibleTool('read_file')` → true | 返回 false | 忘记注册 read_file |
| `isCollapsibleTool('write_file')` → false | 返回 true | 误将 write 纳入折叠 |
| `isCollapsibleTool('read_policy')` → true | 返回 false | 未覆盖 G2 扩展工具 |
| `shouldBreakGroup('write_file')` → true | 返回 false | write 没打断组 |
| `shouldBreakGroup('read_file')` → false | 返回 true | 同族误打断 |
| `attachResult(group, id, content)` 命中正确 entry | 写到错误 entry | **位置匹配而非 id 匹配**（核心 bug） |
| `attachResult(group, unknownId, ...)` → null | 静默写入某个 entry | id 不存在时的兜底逻辑 |
| `buildSummaryText` 混合组显示两种统计 | 只显示一种 | 未处理 read+search 混合 |
| `buildSummaryText` 仅统计 completed entry | 统计了未完成的 | G4 修复的回归 |
| `buildSummaryText` 0 个 completed → 显示 "…" | 显示空字符串或崩溃 | 空组边界 |

### 集成测试（app-tool-group.test.ts）

| 测试 | RED 条件 | 覆盖的偷懒实现 |
|------|---------|-------------|
| `read×3 + write`：write 到达时 flush 3 条 read 的组 | 组未 flush 或内容缺失 | 打断逻辑未触发 |
| `read(id=A) + read(id=B) 并行，result(A) 到达`：只有 A 标记 completed | B 也被标记 | **name 匹配而非 id 匹配**（核心 bug） |
| `read + grep + read` 统一组摘要含 "Searched 1, read 2" | 分成两组 | 未统一 read+search |
| collapsible terminal result 后 `pendingTools` 无该项 | 仍存在 | **G3 泄漏** |
| non-collapsible tool 打断时未完成 entry 不计入摘要 | 计入了 | G4 回归 |
| abort 后 group buffer 被 flush + 清空 | 残留 | abort 未清理 |
| ctrl+o 展开 lastCollapsedGroup 显示完整内容 | 仍折叠或报错 | 组展开未实现 |

---

## 五、瑶光：归族 — 这不是一个 bug，是一族 bug

### bug 族识别

当前 `handleToolResult` 用 `toolName` 匹配 entry：
```typescript
const entry = this.toolGroupBuffer.entries[this.toolGroupBuffer.entries.length - 1]
if (entry && entry.toolName === name) { ... }
```

这是 **"并发场景下用非唯一标识符匹配"** 族的一个实例。在整个代码库中检索同族模式：

| 位置 | 匹配方式 | 风险 |
|------|---------|------|
| `app.ts:handleToolResult` → toolGroupBuffer | `entries[last].toolName === name` | **已知 bug** |
| `app.ts:pendingTools` | `Map<id, meta>` | ✅ 正确 |
| `app.ts:toolAccumulator` | `Map<id, text>` | ✅ 正确 |
| `approval-risk.ts` (agent) | 传入 id 匹配 | ✅ 正确 |

**归族结论**：只有一处同族缺陷——`toolGroupBuffer` 的 entry 匹配。修复这一个位置就消除了整族。

### 逆向归族：反模式

这族 bug 的反模式是：**在并发流中不使用唯一标识符，而是用属性值（name/type/index）做匹配**。

预防规则（记入 `.rivet/knowledge/testing.md` 或代码注释）：
> 任何 `Map<id, T>` 或用数组 `find` 通过非 id 字段匹配的代码，在并发场景下是 bug。用 `toolUseId` 做唯一 key。

---

## 六、瑶光：中性归因 — 不说"写错了"，说"模式不匹配并发"

当前代码不是"写错了"——它在**顺序工具调用**的假设下是正确的。问题在于 agent 模型可以并行发出多个同族工具，而 TUI 层的匹配逻辑没有跟随这个进化。

这个归因很重要：不是指责实现者，而是指出**系统的一个层（agent）进化了，另一个层（TUI buffer）没跟上**。修复是对齐，不是纠错。

---

## 七、瑶光：方案 GREEN ≠ 落地 GREEN — 逐条核对清单

上一轮评估（方案 GREEN）和实际落地之间需要这道闸。每条 amendment 必须有对应的代码 grep 验证：

| # | Amendment | 落地判据 | 验证命令 |
|---|-----------|---------|---------|
| G1 | 文件重命名为 `collapsed-read-search.ts` | 新文件存在 + 旧文件有 `@deprecated` | `ls src/tui/format/collapsed-read-search.ts` |
| G2 | 工具分类覆盖 read_policy 等 7 个 | `isCollapsibleTool` 对每个返回 true | `grep "read_policy\|read_section\|file_info\|repo_map\|repo_graph\|related_tests\|inspect_project" src/tui/format/collapsed-read-search.ts` |
| G3 | pendingTools 泄漏修复 | collapsible result 后 `pendingTools.delete(id)` 被执行 | grep `pendingTools.delete` 在 handleToolResult 的 collapsible 分支 |
| G4 | 未完成 entry 不参与摘要 | `buildSummaryText` 过滤 `!entry.completed` | grep `completed` 在 buildSummaryText 中 |
| G5 | live 聚合行 | `renderLive()` 中有 collapsible/non-collapsible 分流 | grep 聚合逻辑在 renderLive |
| G6 | ctrl+o 组展开 | `expandLastCollapsedGroup` 方法存在 | grep `expandLastCollapsedGroup` |
| G7 | 测试迁移 | 新测试文件存在 + 旧 Ink 测试删除 | `ls src/tui/__tests__/collapsed-read-search.test.ts` |
| G8 | 流式 chunk 入 live 聚合 | `toolAccumulator` 内容参与 live 聚合行渲染 | grep `toolAccumulator` 在 live 聚合逻辑中 |

**自反**：上述逐条核对就是我（天枢）审自己的方案时用的。提交前每条跑一遍。

---

## 八、最终执行计划修正（融合天璇·瑶光方法后）

从上一轮评估的 7 步执行优先级，修正为：

| 序号 | 内容 | 方法来源 |
|------|------|---------|
| 1 | 新建 `collapsed-read-search.ts`：类型 + `CollapsedReadSearchBuffer` 类 + 纯函数 | 天璇温跃层 1 |
| 2 | 纯函数测试（含 RED 条件表全部 10 条） | 瑶光复现即证 |
| 3 | 修 `app.ts`：切换到新 buffer、id 绑定、pendingTools 泄漏修复 | G3 止血 |
| 4 | 集成测试（含 RED 条件表全部 7 条） | 瑶光复现即证 |
| 5 | `renderLive()` 分流 collapsible/non-collapsible | 天璇温跃层 2 |
| 6 | `expandLastCollapsedGroup` + `formatCollapsedReadSearchScrollback(expanded: true)` | G6 |
| 7 | 旧文件 deprecation re-export + 清理 | G1 |
| 8 | typecheck + 全量测试 + 落地核对（逐条 grep） | 瑶光方案≠落地 |

---

## 九、归族预防规则

写入 `.rivet/knowledge/testing.md`：

```markdown
## 并发匹配反模式

**模式**：在并发流中用非唯一标识符（name/type/index）匹配实体。
**症状**：并行同族工具的结果绑定到错误 entry。
**修复**：始终用 `toolUseId`（由 API 返回的唯一标识符）做 key。
**自查**：`grep "\.find\(.*===\|\.filter\(.*===\|entries\[.*\]\.\w+Name" src/tui/` 应返回零结果。
**首次发现**：2026-06-14，`app.ts:handleToolResult` 中 toolGroupBuffer entry 匹配。
```

---

## 十、一句话

天璇的跨域碎片收敛确认了方向，反证杀死了美化假设；瑶光的 RED→GREEN 测试表和逐条落地核对把"方案 GREEN"变成了"代码真兑现"的验证闭环。计划现在已经不是 6/10——补上这些之后，可以开始写第一行代码了。
