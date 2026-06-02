# Harness Engineering 技术简历 — 项目经历

> 以下内容基于真实项目经验撰写，使用行业通用术语描述。
> 项目名称和品牌信息已脱敏处理。

---

## 项目：终端 AI Agent 运行时（独立开发，2026.05 – 至今）

### 一句话描述

从零独立设计并实现了一个完整的终端 AI Coding Agent，覆盖 Agent Loop、Context Engineering、Multi-Provider Streaming、Sub-Agent Orchestration、Verification Pipeline、TUI Rendering 六大子系统，52K 行源码 + 56K 行测试，442 个测试文件。

---

### 核心技术架构

```
┌──────────────────────────────────────────────────────────┐
│                    Terminal UI (React)                    │
│  流式渲染 · Markdown · Thinking Block · Tool Cards · Pager│
├──────────────────────────────────────────────────────────┤
│                   Agent Loop (Turn-based)                 │
│  Convergence Detection · Doom Loop Recovery · Vigor      │
│  Cognitive Mirror · Delivery Gate · Task Contracts        │
├─────────┬──────────┬───────────┬──────────┬──────────────┤
│  Prompt │   Tool   │   API     │ Compact  │   Context    │
│ Engine  │ Pipeline │ Clients   │ Engine   │   Memory     │
│ (frozen │ (42 tools│(3 providers│(6 strats │(claims +    │
│ +dynamic│  sandboxed│ SSE stream│ semantic │  project    │
│  blocks)│  exec)   │ + retry)  │ prune)   │  memory)    │
├─────────┴──────────┴───────────┴──────────┴──────────────┤
│               Sub-Agent Orchestration                     │
│  Delegate Task · Batch Workers · Ownership Ledger         │
├──────────────────────────────────────────────────────────┤
│               Verification & Delivery                     │
│  Evidence Tracking · Attribution · Scoped Commit Gate     │
└──────────────────────────────────────────────────────────┘
```

### 各子系统关键技术决策

#### 1. Context Engineering — Frozen/Dynamic Split Architecture

**问题**：LLM API 的 prefix cache 要求历史消息字节完全一致，但 Agent 每轮都需要更新动态上下文（git status、tool history、认知状态等）。

**方案**：设计了 Frozen Base + Dynamic Appendix 双层架构：
- **Frozen Base**（~40% context）：system prompt + 启发式规则 + 项目记忆 + 种子胶囊。Session 内不变，prefix cache 全量命中。
- **Dynamic Appendix**（~10% context）：附加在每个 user message 尾部，随用户输入自然刷新。历史 user message 的 frozen 内容字节不变。

**成果**：经过四轮架构迭代（Standalone Appendix → Cache-Friendly Ordering → Frozen Appendix → 稳态验证），prefix cache 命中率从 **56% → 99.6%**。每轮 API 调用平均节省 ~40% input token 成本。

**关键洞察**：prefix cache 是字节级的，不是语义级的。系统的行为由比特决定，不由你的意图决定。缓存优化必须在字节对齐层面思考。

#### 2. Agent Loop — 收敛检测与退化恢复

**问题**：LLM Agent 容易陷入重复行为循环（反复调用同一工具、反复得出同一结论），浪费 token 且无产出。

**方案**：实现了多信号收敛检测器：
- **Tool Fingerprint**：对连续 turn 的工具调用序列做指纹匹配，检测重复模式
- **Oscillation Penalty**：当检测到在两个策略间反复切换时施加衰减信号
- **Doom Loop Recovery**：当重复模式被确认，自动注入策略切换建议
- **Vigor Engine**：跟踪执行能量（tonic/phasic/curiosity），能量过低时触发收敛动作

**成果**：Agent 在复杂任务中的无效循环率从"经常发生"降低到"几乎不发生"。收敛检测器能在 3-5 个 turn 内识别并打断循环。

#### 3. Multi-Provider Streaming — 统一 SSE 抽象

**问题**：不同 LLM 提供商的 SSE 流格式、错误码、重试语义各不相同。

**方案**：
- 定义了统一的 `StreamClient` 接口（OpenAI / Anthropic / Codex 三种实现）
- 实现了 `StructuredRetryEngine`：按 HTTP 状态码分类（5xx 重试、4xx 不重试、401 立即终止、413 context overflow 特殊处理）
- 实现了 `maxTotalDurationMs` 全局超时上限，防止 provider 无响应时无限重试
- 实现了 `AbortSignal` → `ReadableStream.cancel()` 的接线，确保用户中断时 SSE reader 立即释放

**规模**：42 个工具（bash、文件读写、grep、glob、git、edit、LSP、web fetch、delegate、deliver 等），每个工具 definition + execute 分离。

#### 4. Sub-Agent Orchestration — 多工作线程并行

**问题**：复杂任务需要并行探索多个方向，但子 Agent 的文件归属和副作用隔离是难题。

**方案**：
- **Ownership Ledger**：每个文件有明确的归属者（session ID），只有归属者可以修改
- **Delegate Task**：单个子任务委派，隔离 worktree 执行
- **Delegate Batch**：2-5 个独立子任务并行执行，支持 majority/all_required/first_success 等聚合策略
- **Delivery Gate**：提交前自动检查文件归属验证 + 内聚性检查，跨区域批量提交会被拒绝

#### 5. Context Compaction — 六策略分层压缩

**问题**：长 session 的 context window 会耗尽，但压缩不能丢失关键信息。

**方案**：
- **Semantic Prune**：按语义相关性评分裁剪历史消息
- **Micro Compact**：单条消息内的微压缩（去除冗余格式、缩短 tool output）
- **Stale Round Detection**：自动识别并裁剪过时的对话轮次
- **Agent Diet**：动态调整 volatile block 的信息密度
- 压缩前后保留关键 claim（决策、验证事实、项目规则），通过 context memory 系统跨 session 持久化

#### 6. Verification Pipeline — 交付门禁

**问题**：Agent 自己写的代码需要自己验证，但验证结果可能不可靠。

**方案**：三级验证体系：
- **Level 1 — TypeCheck**：编译通过是最低门槛
- **Level 2 — Related Tests**：只跑与改动相关的测试
- **Level 3 — Full Suite**：完整测试套件
- **Evidence Tracking**：每次验证结果记录为 evidence，附带置信度
- **Attribution**：验证失败时自动归因到具体文件，区分"己方文件失败"和"外部文件失败"

#### 7. Prompt Engineering — 结构化提示词引擎

**问题**：提示词需要在稳定（cache friendly）和动态（信息新鲜）之间平衡。

**方案**：三层提示词架构：
- **Static Block**：角色定义、工具约束、安全守则。编译时确定，永不改变。
- **Volatile Block**：git status、工作集、认知状态、项目记忆。Session 级缓存，按需刷新。
- **Dynamic Appendix**：实时上下文（行为镜面、策略切换、跨 session 事件）。每 user message 刷新。

---

### 项目规模

| 指标 | 数值 |
|------|------|
| 源码行数 | 52,003 行（不含测试） |
| 测试行数 | 56,521 行 |
| 测试文件 | 442 个 |
| Agent 子系统 | 159 个文件 |
| 工具数量 | 42 个 |
| Hook 数量 | 19 个 |
| API 客户端 | 3 个（OpenAI/Anthropic/Codex 兼容） |
| 总提交数 | 1,529 |
| 近 2 周提交 | 519 |
| 提交分布 | feat / fix / docs / test / refactor / perf (结构化 conventional commits) |

### 技术栈

- **Runtime**: Node.js 22, TypeScript strict (`noUncheckedIndexedAccess`)
- **TUI**: Ink 6 (React for Terminal), 自定义流式渲染引擎
- **API**: OpenAI 兼容 SSE streaming, Anthropic native, Codex OAuth
- **Test**: node:test + node:assert/strict
- **Build**: tsup (ESM bundle)
- **架构模式**: interface + plain objects (no classes for data), async/await, hook-based pipeline

---

### 与 JD 的对应关系

| JD 要求 | 对应经验 |
|---------|---------|
| Agent Loop | turn-based loop + convergence detection + doom loop recovery |
| KV Cache / Context Engineering | frozen/dynamic split architecture, 99.6% prefix cache hit rate |
| Tool Use | 42 tools, sandboxed execution, definition/execute separation |
| Reasoning | thinking block streaming + cognitive mirror + vigor engine |
| Planning | task contract + decomposition + multi-step execution tracking |
| Sub-Agent | delegate_task + delegate_batch + ownership ledger + delivery gate |
| Multi-Agent | coordinator + worker session + aggregation policies |
| Prompt Engineering | 3-layer prompt engine (static/volatile/dynamic) |
| Memory | context claims + project memory + playbook + cross-session events |
| MCP | LSP 集成 (goto_definition, find_references) |
| Harness Engineering | 整个系统就是 Harness——模型之外的一切 |

---

### 核心工程方法论

1. **不猜，先读**：改代码前先读现有代码理解上下文，grep 调用方，blame 改动人
2. **缓存是字节级的**：优化必须在对齐层面思考，不是语义层面
3. **最好的方案往往是最小的**：第四轮缓存优化只改了 30 行代码
4. **实证比审美重要**：当证据否定假设时，放下它
5. **承认天花板**：有些限制是物理的（exact-prefix cache 的位置敏感性），需要换维度思考
6. **持续微小改进**：P0→P1→P1b→P1c，每次改动不大，合在一起改变了整个架构

---

### 可以深入讨论的技术话题

- Prefix Cache 的字节级优化策略（exact-prefix vs semantic cache）
- Agent 收敛检测的多信号融合方法
- Context Window 的分层管理策略
- Sub-Agent 的文件归属和副作用隔离
- SSE 流的可靠中断和清理
- 结构化重试引擎的错误分类和策略选择
- Context 压缩中的信息保留和损失权衡
- Agent 的自省能力（cognitive mirror, behavior mirror）
