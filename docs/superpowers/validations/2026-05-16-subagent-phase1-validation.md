# 子代理协同 Phase 1 — 自主执行验证报告

> **验证日期**: 2026-05-16
> **实验主体**: DeepSeek V4 Pro（天枢提示词）运行于 Rivet 终端
> **审查者**: 用户 + Claude Code

---

## 1. 实验设计

### 目标

验证开放模型（DeepSeek V4）能否在精确计划指导下自主完成子代理协同 Phase 1 的全部代码实现，并达到可验收的质量水平。

### 工作流

```
Plan（用户编写） → Execute（Pro 自主执行） → Review（事后对照验收）
```

### 实施计划

- 文件: `docs/superpowers/plans/2026-05-16-rivet-subagent-orchestration-implementation.md`
- 8 个任务，约 2011 行
- 每个任务包含：失败的测试 → 运行确认失败 → 最少实现代码 → 运行确认通过 → commit
- 精确到代码片段和测试用例

### 运行时配置

| 参数 | 值 |
|------|-----|
| 模型 | DeepSeek V4 Pro |
| 推理模式 | max（reasoning_effort: max, thinkingBudget: 64000） |
| 审批模式 | auto-safe（自动执行除高风险之外的命令） |
| 缓存命中 | 100%（prefix cache 完全复用） |
| 提示词 | 天枢（主动设计 + 架构审视 + 创造性寻找更优解） |

---

## 2. 提示词全文

```
你是「天枢」，一个拥有想象力与创造力的代码开发智能体。你的任务不是机械补全代码，而是在理解用户意图、项目上下文与工程
约束的基础上，主动设计更合理的架构、发现隐藏风险、修复根因问题，并输出清晰、稳定、可维护、可扩展的实现方案。你应当像
一名高级工程师一样思考，像一名架构师一样审视系统，像一名创造者一样寻找更好的可能。
```

### 提示词作用分析

| 指令 | 预期效果 | 实际表现 |
|------|---------|---------|
| "不是机械补全代码" | 理解后自主编写，而非逐行抄计划 | 代码与计划高度一致但有一处合理简化 |
| "主动设计更合理的架构" | 授权偏离计划 | `_coordinatorRef` 模块级引用替代三层 useMemo 链 |
| "发现隐藏风险" | 做计划未显式要求的检查 | 未观察到额外风险发现（Phase 1 边界清晰，可能无需） |
| "像高级工程师一样思考" | 整体把控而非局部补丁 | 测试覆盖完整，无 over-engineering |

---

## 3. 执行结果

### 定量指标

| 指标 | 结果 |
|------|------|
| 计划任务数 | 8 |
| 已完成任务数 | 8 |
| 新增源码文件 | 6 |
| 新增测试文件 | 7 |
| 测试总数 | 210 |
| 测试通过率 | 210/210 (100%) |
| TypeScript 类型检查 | 零错误 |
| 计划 vs 实现偏差 | 1 处 |
| 验收标准满足率 | 8/8 (100%) |

### 新增文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/agent/work-order.ts` | 199 | WorkOrder/WorkerResult Zod schema、parser、blocked fallback |
| `src/agent/worker-prompts.ts` | 67 | worker task prompt、repair prompt、primary packet |
| `src/agent/worker-session.ts` | 128 | headless AgentLoop runner，独立 SessionContext |
| `src/agent/coordinator.ts` | 91 | DelegationCoordinator，budget gate + model routing |
| `src/tools/default-registry.ts` | 24 | 默认工具 registry 工厂 |
| `src/tools/delegate-task.ts` | 67 | delegate_task tool factory |
| 修改 `src/tools/registry.ts` | +11 | 新增 `has()` + `filterToolRegistry()` |
| 修改 `src/main.tsx` | ~30 | runtime wiring（coordinator + delegate_task 接入） |

### 测试覆盖明细

| 测试文件 | 用例数 | 验证内容 |
|----------|--------|---------|
| `work-order.test.ts` | 5 | schema 默认值、fenced JSON 解析、workOrderId 校验、blocked 构建、kind→task 映射 |
| `worker-prompts.test.ts` | 3 | worker prompt 包含关键指令、repair prompt 含错误信息、packet XML 格式 |
| `worker-session.test.ts` | 4 | headless 运行、独立 SessionContext 隔离、repair retry、budget 耗尽 blocked |
| `coordinator.test.ts` | 3 | budget gate、model routing + 只读 registry、skipped 返回 |
| `delegate-task.test.ts` | 3 | 输入校验 + coordinator 调用、无效输入错误、审批/并发属性 |
| `default-registry.test.ts` | 3 | 核心工具注册、base 无 delegate_task、可显式添加 |
| `registry-filter.test.ts` | 3 | allowlist 过滤、未知工具报错、过滤后独立性 |

---

## 4. 计划 vs 实现偏差分析

### 唯一偏差：`main.tsx` runtime wiring

**计划**：三层 useMemo 链
```
useState(workerBaseToolRegistry)
  → useMemo(coordinator, [workerBaseToolRegistry, ...])
    → useMemo(toolRegistry, [coordinator])
      → useMemo(agent, [toolRegistry, ...])
```

**实现**：模块级可变引用 + 单层结构
```
const [toolRegistry] = useState(() => {
  const reg = createDefaultToolRegistry()
  reg.register(createDelegateTaskTool({
    delegate: async (request) => {
      if (!_coordinatorRef) throw new Error(...)
      return _coordinatorRef.delegate(request)
    },
  }))
  return reg
})

// coordinator 在 agent useMemo 中创建，赋值给 _coordinatorRef
_coordinatorRef = new DelegationCoordinator({...})
```

**评估**：合理简化。避免了：
- coordinator 被重复创建时 toolRegistry 闭包指向旧实例的问题
- useMemo 依赖链过深导致的连锁重建
- delegate_task 工具需要感知 coordinator 重建的问题

功能等价，代码更简洁。

---

## 5. 验收标准逐条确认

| # | 验收标准 | 证据 | 状态 |
|---|---------|------|------|
| 1 | WorkerResult 只通过 zod schema parse 进入 primary packet | `parseWorkerResult()` 先 `JSON.parse` 再 `workerResultSchema.parse`，测试覆盖 | PASS |
| 2 | Worker 使用独立 SessionContext | `worker-session.ts:84` 新建 `SessionContext()`，测试验证不污染 primary | PASS |
| 3 | Phase 1 worker registry 只有 read_file/glob/grep/diff | `READ_ONLY_WORKER_TOOLS` + `filterToolRegistry`，coordinator 测试验证 | PASS |
| 4 | delegate_task 在 primary 不在 worker base | `createDefaultToolRegistry()` 不含它，main.tsx 额外注册，测试覆盖 | PASS |
| 5 | DelegationCoordinator 调用 recommendModelForTask | `coordinator.ts:76`，coordinator 测试验证 model 选择 | PASS |
| 6 | Budget gate 跳过短小目标 | `shouldDelegateObjective()` 检查词数<6/files<2/symbols<2，测试覆盖 | PASS |
| 7 | typecheck + test + build 全通过 | typecheck 零错误，210/210 测试通过 | PASS |
| 8 | 无真实密钥泄露 | 源码无 sk- 前缀字符串 | PASS |

---

## 6. 关键发现：三元组合效应

高质量自主执行需要三个因素同时到位：

```
精确计划（人写的）
  ↓ 定方向、划边界、给代码片段参考
主动性提示词（天枢）
  ↓ 授权创造、鼓励架构审视、防止机械执行
100% 缓存命中（架构优势）
  ↓ 保证推理深度、token 花在推理而非重复理解
```

### 缺失任何一个的预期降级

| 缺失因素 | 预期影响 |
|---------|---------|
| 没有精确计划 | 天枢"自由发挥"，方向可能跑偏，超出 Phase 1 范围 |
| 没有主动性提示词 | 机械抄计划，遇到计划不合理处不会修正（本次未触发） |
| 没有缓存命中 | 长链路任务推理深度不足，8 个任务的上下文可能丢失 |

### 缓存命中的架构前提

100% 命中依赖 Rivet 的 prompt 分层设计：
- L1 系统提示词（静态，始终缓存）
- L2 工具定义（随 toolRegistry 变化）
- L3 会话历史（随对话增长）
- L4 volatile block（cwd 等易变上下文）

Worker prompt 放在 user message 而非 system prompt，保持 system prompt 与 primary 一致，最大化 prefix 复用。

---

## 7. 执行过程中的问题

| 问题 | 原因 | 影响 | 处理 |
|------|------|------|------|
| Pro 中途卡在审批提示 | auto-safe 模式下某些工具仍需确认 | 执行暂停 | 用户手动批准后继续 |
| 工具卡片渲染混乱 | write_file 等工具输出在 TUI 中截断/重复 | 显示质量下降 | 不影响代码质量，属于 TUI 问题 |

---

## 8. 结论与下一步

### 结论

Phase 1 验证成功。开放模型（DeepSeek V4）在精确计划 + 主动性提示词 + 高缓存命中的条件下，能够自主完成中等复杂度的多文件实现任务，质量达到可验收水平。

### 下一步

- [ ] Pro 继续执行剩余任务，全部完成后进行终审
- [ ] P2.3 Harness Cockpit 待子代理验证完成后启动
- [ ] 考虑对比实验：相同计划 + 无天枢提示词 vs 有天枢提示词
- [ ] 考虑对比实验：相同计划 + 低缓存命中 vs 100% 缓存命中
