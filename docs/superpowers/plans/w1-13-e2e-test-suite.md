# Wave 1 任务文档：E2E Test Suite

> 任务编号：W1-13
> 优先级：高
> 预估：单 session，1.5 小时
> 前置依赖：#02 (multi-provider), #03 (install)

## 目标

模拟完整用户 session 的端到端测试：安装 → 配置 → 任务执行 → 验证 → 对话 → 退出。确保产品级可靠性。

## 设计

### 测试场景

| # | 场景 | 覆盖 |
|---|------|------|
| 1 | 首次启动 + 配置 | setup wizard 完整流程 |
| 2 | 简单任务（创建文件） | 工具执行 + 验证 |
| 3 | 复杂任务（修改多文件） | 多工具协调 + compaction |
| 4 | 错误恢复 | 工具失败 → 自动重试 → 成功 |
| 5 | 长 session（20 轮） | 内存稳定 + 无退化 |
| 6 | Chat mode 切换 | /chat → 对话 → /task → 任务 |
| 7 | Session 中断 + 恢复 | persist → kill → resume |
| 8 | 多 session 并行 | 文件锁 + 无冲突 |

### 测试架构

```
src/__e2e__/
├── helpers/
│   ├── mock-api.ts        Mock LLM API（预设响应序列）
│   ├── test-project.ts    创建临时测试项目
│   └── session-driver.ts  驱动 AgentLoop（headless 模式）
├── scenarios/
│   ├── first-run.e2e.ts
│   ├── simple-task.e2e.ts
│   ├── complex-task.e2e.ts
│   ├── error-recovery.e2e.ts
│   ├── long-session.e2e.ts
│   ├── chat-mode.e2e.ts
│   ├── session-resume.e2e.ts
│   └── multi-session.e2e.ts
└── run-e2e.ts             E2E 测试入口
```

### Mock API 设计

不调用真实 LLM API。使用预设的响应序列：

```typescript
const mockResponses: MockResponse[] = [
  { 
    // 第一轮：模型决定读取文件
    content: [{ type: 'tool_use', name: 'read_file', input: { file_path: 'src/main.ts' } }]
  },
  {
    // 第二轮：模型决定编辑文件
    content: [{ type: 'tool_use', name: 'edit', input: { ... } }]
  },
  {
    // 第三轮：模型输出结果
    content: [{ type: 'text', text: '已完成修改。' }]
  },
]
```

### Session Driver

headless 模式驱动 AgentLoop，不渲染 TUI：

```typescript
const driver = createSessionDriver({
  mockApi: createMockApi(responses),
  projectDir: tmpDir,
  config: { provider: 'mock', mode: 'task' },
})

await driver.sendMessage('创建一个 hello.ts 文件')
const result = await driver.waitForCompletion()

assert(existsSync(join(tmpDir, 'hello.ts')))
assert.equal(result.turns, 3)
assert.equal(result.toolCalls, 2)
```

## 实现计划

### Task 1: Mock API

创建 `src/__e2e__/helpers/mock-api.ts`：
- 实现 StreamClient 接口
- 按序列返回预设响应
- 支持 SSE 流式模拟

### Task 2: Test Project Helper

创建 `src/__e2e__/helpers/test-project.ts`：
- 创建临时目录
- 初始化 git repo
- 写入基础文件（package.json, tsconfig.json, src/main.ts）
- 清理函数

### Task 3: Session Driver

创建 `src/__e2e__/helpers/session-driver.ts`：
- 创建 AgentLoop（headless 模式）
- sendMessage / waitForCompletion / getMessages
- 内存监控（每轮记录 RSS）

### Task 4: 场景测试

实现 8 个场景测试文件。每个测试：
- 创建测试项目
- 配置 mock 响应
- 驱动 session
- 断言结果（文件变化、轮数、内存、错误）

### Task 5: CI 脚本

创建 `scripts/e2e.sh`：
```bash
npx tsx --test src/__e2e__/scenarios/*.e2e.ts
```

## 验证

```bash
npx tsc --noEmit
npx tsx --test src/__e2e__/scenarios/*.e2e.ts
```

## 不做的事

- 不调用真实 LLM API（mock only）
- 不测试 TUI 渲染（headless 模式）
- 不做性能断言（在 #12 中做）
- 不做 flaky test 重试机制（先保证确定性）
