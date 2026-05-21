# Wave 1 任务文档：Error Recovery Pipeline

> 任务编号：W1-05
> 优先级：高
> 预估：单 session，1.5 小时
> 前置依赖：无

## 目标

当工具执行失败时，天枢应自动分类错误、尝试恢复、必要时降级。用户不应看到"bash 报错了，我再试一次"的低效循环。

## 背景

当前行为：工具失败后 `isError: true` 返回给模型，模型自行决定重试。问题：
- 模型可能无限重试同一个失败命令（doom loop）
- 模型可能不知道某些错误有标准修复方式（如 EACCES → sudo 或换路径）
- 没有重试次数限制
- 没有降级策略（如 tsc 失败 → 只跑相关文件的 typecheck）

已有基础：
- `src/agent/failure-classifier.ts` — 测试失败分类 + 修复建议
- `src/agent/trace-store.ts` — doom loop 检测（toolFingerprints）
- `src/tools/output-store.ts` — 三层输出（raw/compressed/summary）

## 架构设计

```
src/agent/
├── error-recovery.ts        新建 — ErrorRecoveryPipeline
├── error-taxonomy.ts        新建 — 错误分类体系
└── __tests__/
    ├── error-recovery.test.ts
    └── error-taxonomy.test.ts
```

### 错误分类体系

```typescript
export type ErrorCategory =
  | 'permission'      // EACCES, EPERM → 建议换路径或提权
  | 'not-found'       // ENOENT, command not found → 建议安装或检查路径
  | 'syntax'          // SyntaxError, parse error → 建议检查生成的代码
  | 'type'            // TypeScript type error → 建议读取相关类型定义
  | 'network'         // ECONNREFUSED, timeout → 自动重试 with backoff
  | 'resource'        // ENOMEM, disk full → 降级或停止
  | 'test-failure'    // 测试断言失败 → 委托 failure-classifier
  | 'lint'            // eslint/prettier 错误 → 自动修复
  | 'unknown'         // 无法分类 → 交给模型处理

export interface ErrorClassification {
  category: ErrorCategory
  retryable: boolean
  maxRetries: number
  suggestedAction: string
  degradePath?: string  // 降级方案描述
}
```

### Recovery Pipeline

```typescript
export interface RecoveryResult {
  recovered: boolean
  action: 'retried' | 'degraded' | 'escalated' | 'abandoned'
  attempts: number
  finalOutput?: string
}

export function createErrorRecoveryPipeline(config: {
  maxRetries: number        // 默认 2
  retryDelayMs: number      // 默认 1000
  enableAutoDegradegrade: boolean  // 默认 true
}): ErrorRecoveryPipeline
```

### 集成点

在 `src/agent/tool-pipeline.ts` 的 `executeToolUse` 中，当 `harnessResult.isError` 时：

```typescript
if (harnessResult.isError) {
  const classification = classifyError(harnessResult.content)
  if (classification.retryable && retryCount < classification.maxRetries) {
    // 自动重试（可能带修改）
  } else if (classification.degradePath) {
    // 降级执行
  } else {
    // 返回错误 + 分类信息 + 建议给模型
    finalContent = enrichErrorWithSuggestion(harnessResult.content, classification)
  }
}
```

## 实现计划

### Task 1: 错误分类器

创建 `src/agent/error-taxonomy.ts`：
- `classifyError(output: string): ErrorClassification`
- 基于正则匹配 + 关键词检测
- 覆盖常见的 Node.js/系统/编译错误

### Task 2: Recovery Pipeline

创建 `src/agent/error-recovery.ts`：
- `createErrorRecoveryPipeline(config)`
- `pipeline.attempt(toolName, input, executor): RecoveryResult`
- 重试逻辑：相同命令 + exponential backoff
- 降级逻辑：lint 错误 → 自动 `--fix`；tsc 错误 → 只检查当前文件

### Task 3: 集成到 tool-pipeline

修改 `src/agent/tool-pipeline.ts`：
- 在 `harnessResult.isError` 分支中调用 recovery pipeline
- 将 classification 信息附加到返回给模型的 content 中
- 记录 recovery 尝试到 trace-store

### Task 4: 与 doom loop 检测协同

修改集成逻辑：
- 如果 trace-store 检测到 doom loop（同一 tool+target 重复 ≥ 3 次），跳过自动重试
- 直接 escalate 给模型，附带"你已经尝试了 N 次，考虑换一种方式"

### Task 5: 测试

- 分类器测试：覆盖每种 ErrorCategory 的典型输出
- Pipeline 测试：重试成功、重试失败降级、不可重试直接返回
- 集成测试：doom loop 场景下不重试

## 验证

```bash
npx tsc --noEmit
npx tsx --test src/agent/__tests__/error-taxonomy.test.ts
npx tsx --test src/agent/__tests__/error-recovery.test.ts
```

## 不做的事

- 不做跨 turn 的错误记忆（后续迭代，可结合 stigmergy）
- 不做用户可配置的重试策略（先硬编码合理默认值）
- 不自动 sudo（安全风险）
- 不修改模型的错误处理行为（只增强信息，不替代模型决策）
