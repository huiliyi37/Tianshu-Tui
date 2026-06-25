# Claude Code → 天枢：可借鉴的优化机会

> 基于 `docs/research/2026-06-25-claude-code-agent-workflow-task-to-execution.md` 的分析
> 和 Claude Code 源码（`/Users/banxia/app/opencode/claude-code-haha`）的交叉验证
> 审查域：天权（称量架构合理性）

## 总览：六维对照矩阵

| 维度 | Claude Code | 天枢 | 差距等级 |
|------|-------------|------|----------|
| 子 agent 模型 | 递归 `query()`，同进程 | 独立 worker 会话，独立 JSONL/memory | 设计取舍，非差距 |
| 流式工具执行 | `StreamingToolExecutor` 边收边执行 | 等模型输出完再执行工具 | **高 — 可直接借鉴** |
| 压缩管线 | 四级串行，token 逐级传递 | 三级，类似但缺少 snip + collapse | 中 — 可增强 |
| 错误恢复 | state transition 状态机 | 推测为 try/catch 重试 | 中 — 需验证 |
| 输入预处理 | 多级流水线（slash/img/RAG/hooks） | 有限预处理 | 中 — 可借鉴 |
| 权限模型 | `canUseTool` per-tool，子 agent 替换 | approval mode + tool validation | 低 — 已有对应 |

---

## 机会 1：流式工具执行 [高优先级]

### Claude Code 的做法

`StreamingToolExecutor`（`src/services/tools/StreamingToolExecutor.ts`）在 LLM 流式输出期间就开始执行工具：

```
LLM 输出 tool_use_1 (read_file)  → 立即入队，如果是并发安全的，立即开始执行
LLM 输出 tool_use_2 (grep)       → 同上，和 tool_use_1 并行
LLM 输出 tool_use_3 (bash)       → 非并发安全，等待前两个完成
LLM 输出完毕                     → 最后消费未完成的结果
```

关键判断：`toolDefinition.isConcurrencySafe(parsedInput)` — 每个工具声明自己的并发安全性。

### 天枢的现状

天枢的工具执行在 LLM 完整输出后批量进行（`src/tools/` pipeline + `src/agent/tool-execution.ts`）。这意味着：如果模型输出 3 个 `read_file` + 1 个 `bash`，用户需要等 LLM 完整输出（比如 5 秒）+ 所有工具串行执行（比如 4 秒）= 9 秒。而 Claude Code 的做法是 LLM 输出和工具执行在时间上重叠，实际感知延迟 ≈ max(LLM 输出时间, 工具执行时间) ≈ 5 秒。

### 可借鉴方案

1. 在天枢的 `TurnStreamController`（已支持流式接收）中，当解析到完整的 `tool_use` block 时立即入队到新组件 `StreamingToolExecutor`
2. 为每个工具定义 `isConcurrencySafe(input)` — 只读工具（read_file、grep、glob、semantic_search、file_info）返回 true，写工具（edit_file、write_file、bash）返回 false
3. 并发安全的工具并行执行，非并发安全的工具等前序完成
4. 并行上限参考 Claude Code 的 10（`CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY`）

**代价**：
- 新增组件约 200-300 行，增加复杂度
- 需要工具注册表支持 `isConcurrencySafe` 声明
- 写工具在并发执行只读工具时不能执行，但可以在只读工具完成后立即开始（不等 LLM 输出完毕）

---

## 机会 2：压缩管线增强 [中优先级]

### Claude Code 的做法

四级串行压缩管线：

```
snipCompact (裁剪冗余片段)
  → microcompact (按 tool_use_id 缓存编辑结果)
    → contextCollapse (折叠连续窗口)
      → autocompact (全量 summary)
```

前一级释放的 token 数传入后一级的阈值判断。snipCompact 是特性门控的（`feature('HISTORY_SNIP')`）。

### 天枢的现状

天枢有 `src/compact/`：trim（裁剪历史）、micro-compact（工具结果替换）、threshold（自动压缩阈值）。缺少：
- **contextCollapse**：折叠连续的上下文窗口（折叠掉无用的中间轮次）
- **token 逐级传递**：前一级的节省量是否传递到后一级的阈值判断？

### 可借鉴方案

1. 检查天枢的 compact 执行顺序是否已经是串行管线（`trim → micro-compact → threshold`），如果不是，调整为串行
2. 确保 token 节省量在各级间传递（`compact-attribution.ts` 已有部分支持，检查其完整性）
3. 考虑加入 context collapse（如果是中间轮次的连续只读工具调用，可以折叠）

---

## 机会 3：输入预处理增强 [中优先级]

### Claude Code 的做法

`processUserInput()` 多级流水线：

```
用户输入 → 图片处理 → slash 命令检测 → Ultraplan 路由 → 
附件注入（RAG + IDE 选区 + @mention） → UserPromptSubmit hooks
```

### 天枢的现状

天枢的输入预处理相对简单——主要在 `main.ts` 和 `app.ts` 的 `onSubmitCallback` 中处理。`IntentRetrievalRouteController` 有意图路由功能，但没有 RAG 附件注入和 user hooks。

### 可借鉴方案

1. **附件注入**：在用户输入提交前，基于输入内容做 RAG 检索相关记忆/规划文件，注入为额外上下文消息（Claude Code 的 `getAttachmentMessages` 模式）
2. **UserPromptSubmit hooks**：允许配置钩子在提交前注入额外上下文或阻断（已有 runtime hooks 基础设施，可以扩展）

---

## 机会 4：子 agent 上下文共享 [低优先级 — 设计取舍]

### 差异

Claude Code 的子 agent 是**同进程递归调用** `query()`——共享文件状态缓存、共享 abortController、无序列化开销。天枢的 worker 是**独立会话**——独立 JSONL、独立 memory、独立 pheromone，通过 coordinator/meridian 间接通信。

### 分析

这是设计取舍而非缺陷。天枢的独立会话模型有以下优势：
- worker 崩溃不影响主会话
- 跨进程可并行（真正的并发，而非 event loop 并发）
- 隔离性更好（worker 的 token 消耗有独立预算）

Claude Code 的同进程模型优势：
- 零序列化开销（不需要 JSON 序列化/反序列化 messages）
- 文件状态共享（worker 看到的文件系统和主 agent 完全一致）
- abort 传播简单（共享 AbortController）

### 可借鉴方案

不需要改变模型，但可以借鉴 Claude Code 的**异步子 agent 的独立 AbortController** 设计——当前天枢的 worker 是否在父级中断时被正确清理？检查 `work-order.ts` 中的 abort 信号传播。

---

## 机会 5：工具执行结果缓存 [低优先级]

### Claude Code 的做法

`microcompact` 按 `tool_use_id` 缓存编辑结果——同一轮中重复的 read_file/grep 调用用上一次的结果替代，减少 API token 消耗。

### 天枢的现状

天枢的 `compact/` 中已有 micro-compact 机制，但需要验证是否按 `tool_use_id` 做缓存命中。

---

## 优先级排序

| # | 机会 | 预期收益 | 实现复杂度 | 建议 |
|---|------|----------|------------|------|
| 1 | 流式工具执行 | 感知延迟降 30-50% | 中（~300 行） | **优先** |
| 2 | 压缩管线串行化 | token 使用更精确 | 低（~50 行验证/调整） | 其次 |
| 3 | 输入预处理增强 | 上下文相关性提升 | 中（~200 行） | 可排后 |
| 4 | worker abort 传播 | 健壮性 | 低（检查现有代码） | 顺手做 |
| 5 | 工具结果缓存按 ID | token 节省 | 低（验证现有） | 验证即可 |

机会 1 是唯一有明显性能差异的——从"等模型说完再干活"变成"边说边干"，直接压缩用户感知延迟。
