# Wave 1 任务文档：Subagent Orchestration Phase 1

> 任务编号：W1-11
> 优先级：高
> 预估：单 session，2 小时
> 前置依赖：无
> 参考设计：`docs/superpowers/specs/2026-05-16-rivet-subagent-orchestration-design.md`

## 目标

实现只读 worker dispatch：主 AgentLoop 将探索性任务（搜索代码、读取文件、分析结构）委派给 headless worker session，结果合并回主 session。

## 背景

已有基础：
- `src/tools/delegate-task.ts` / `delegate-batch.ts` — 委派工具已存在
- `src/model/capability.ts` — `recommendModelForTask()` 纯函数
- `src/agent/context.ts` — SessionContext（需隔离）
- `.rivet/dev-guide.md` 中的 Phase 1 Hard Constraints 已定义

## 架构设计

### 核心约束（不可违反）

1. **SessionContext 隔离** — worker 消息永远不进入主 session
2. **只读 worker** — 工具白名单：read_file, grep, glob, diff, inspect_project, repo_map, related_tests
3. **Schema-valid 结果** — WorkerResult 必须通过 zod 验证
4. **主权在主** — 只有主 AgentLoop 决定最终行动
5. **Prefix cache 共享** — worker 使用相同 system prompt
6. **Budget gate** — 1-2 个工具调用能完成的任务不委派

### 数据流

```
主 AgentLoop
  │
  ├─ 模型输出 tool_use: delegate_task({ task, scope })
  │
  ├─ Budget gate: 任务是否值得委派？
  │   └─ 不值得 → 直接在主 session 执行
  │
  ├─ 创建 WorkerSession（独立 SessionContext）
  │   ├─ 共享 system prompt（prefix cache）
  │   ├─ 只读工具白名单
  │   ├─ 独立消息历史
  │   └─ token 预算限制（max 50K input）
  │
  ├─ Worker 执行（headless，无 TUI）
  │   ├─ LLM 调用 → 工具执行 → 循环
  │   └─ 达到预算或完成 → 返回 WorkerResult
  │
  └─ 结果合并回主 session
      └─ WorkerResult 作为 tool_result 返回给主模型
```

### WorkerResult Schema

```typescript
const WorkerResultSchema = z.object({
  status: z.enum(['completed', 'budget_exceeded', 'failed']),
  summary: z.string().max(2000),
  findings: z.array(z.object({
    file: z.string(),
    relevance: z.enum(['high', 'medium', 'low']),
    content: z.string().max(500),
  })).max(10),
  toolCalls: z.number(),
  tokensUsed: z.number(),
})
```

## 实现计划

### Task 1: WorkerSession

创建 `src/agent/worker-session.ts`：
- 独立 SessionContext（不共享主 session 消息）
- 共享 PromptEngine 的 system prompt（prefix cache）
- 只读工具注册（白名单过滤）
- token 预算限制（超出时强制停止）
- headless 执行（无 TUI callbacks）

### Task 2: Budget Gate

创建 `src/agent/dispatch-gate.ts`：
- `shouldDispatch(task: string, scope: string): boolean`
- 规则：如果任务描述暗示 ≤ 2 个工具调用 → 不委派
- 规则：如果当前 context 压力 > 0.8 → 不委派（省资源）

### Task 3: 重构 delegate-task 工具

修改 `src/tools/delegate-task.ts`：
- 调用 WorkerSession 而非现有逻辑
- 返回 WorkerResult 的 summary + findings
- 超时保护（60s）

### Task 4: 结果合并

在 tool-pipeline 中：
- WorkerResult 经过 zod 验证
- summary 作为 tool_result content 返回
- findings 中 high relevance 的内容展开，low 的只保留文件名

### Task 5: 测试

- WorkerSession 隔离测试（消息不泄漏到主 session）
- Budget gate 测试
- WorkerResult schema 验证测试
- 超时测试
- 只读白名单测试（worker 不能执行 bash/write/edit）

## 验证

```bash
npx tsc --noEmit
npx tsx --test src/agent/__tests__/worker-session.test.ts
npx tsx --test src/agent/__tests__/dispatch-gate.test.ts
```

## 不做的事

- 不做并行 worker（Phase 1 只支持串行单 worker）
- 不做 worker 间通信
- 不做写操作 worker（只读）
- 不做模型路由（worker 使用与主 session 相同的模型）
- 不做 worker 结果缓存
