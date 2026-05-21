# Wave 1 任务文档：Performance Baseline

> 任务编号：W1-12
> 优先级：中
> 预估：单 session，1 小时
> 前置依赖：无

## 目标

建立性能基线，确保天枢在生产使用中满足：
- 启动时间 < 2s
- 首 token 延迟 < 500ms（不含网络）
- 内存稳态 < 256MB
- 40 轮 session 后内存增长 < 50MB

## 设计

### 性能测试框架

创建 `src/__perf__/` 目录，使用 node:test + performance.now() 测量。

### 测量点

| 指标 | 测量方式 | 目标 |
|------|----------|------|
| 冷启动时间 | process.hrtime 从 main.tsx 入口到 TUI 渲染完成 | < 2000ms |
| 热启动时间 | 有 session 缓存时的启动 | < 1000ms |
| 首 token 延迟 | 从 buildRequest 完成到第一个 SSE chunk 到达 | < 500ms |
| 工具执行开销 | tool-pipeline 从接收到返回（不含实际工具执行） | < 10ms |
| Sensorium 计算 | computeSensorium 耗时 | < 1ms |
| Compaction 耗时 | maybeCompact 执行时间 | < 100ms |
| 内存基线 | 启动后空闲 RSS | < 80MB |
| 内存稳态 | 20 轮后 RSS | < 256MB |
| 内存增长率 | 每轮 RSS 增量 | < 2.5MB/turn |
| GC 暂停 | 最大 GC pause | < 50ms |

### 持续监控

在 `src/agent/loop.ts` 中已有 ResourceSensor。扩展为：
- 每轮记录 RSS、heapUsed、heapTotal
- session 结束时输出性能摘要到 `~/.tianshu/perf/<session-id>.json`

## 实现计划

### Task 1: 性能测试框架

创建 `src/__perf__/startup.perf.ts`：
- 测量冷启动（fork 新进程）
- 测量热启动（有缓存）
- 断言 < 2000ms / < 1000ms

### Task 2: 运行时性能测量

创建 `src/__perf__/runtime.perf.ts`：
- 模拟 20 轮对话（mock API 响应）
- 每轮测量：tool-pipeline 开销、sensorium 计算、compaction 耗时
- 测量内存增长曲线
- 断言不超过目标值

### Task 3: 内存泄漏检测

创建 `src/__perf__/memory-leak.perf.ts`：
- 模拟 40 轮对话
- 每 5 轮强制 GC（`--expose-gc`）
- 检测 heapUsed 是否持续增长
- 如果增长率 > 2.5MB/turn，标记为潜在泄漏

### Task 4: 性能摘要输出

修改 `src/agent/loop.ts`：
- session 结束时收集所有 ResourceSensor 快照
- 输出 JSON 摘要到 `~/.tianshu/perf/`
- 包含：总轮数、总耗时、峰值 RSS、平均轮耗时、compaction 次数

### Task 5: CI 集成脚本

创建 `scripts/perf-check.sh`：
```bash
node --expose-gc ./node_modules/.bin/tsx --test src/__perf__/*.perf.ts
```

## 验证

```bash
npx tsc --noEmit
node --expose-gc ./node_modules/.bin/tsx --test src/__perf__/startup.perf.ts
node --expose-gc ./node_modules/.bin/tsx --test src/__perf__/runtime.perf.ts
node --expose-gc ./node_modules/.bin/tsx --test src/__perf__/memory-leak.perf.ts
```

## 不做的事

- 不做 benchmark 对比（vs Claude Code 等）— 后续 Wave 2
- 不做性能优化（先测量，再优化）
- 不做 production profiling 工具（先用 node --prof）
