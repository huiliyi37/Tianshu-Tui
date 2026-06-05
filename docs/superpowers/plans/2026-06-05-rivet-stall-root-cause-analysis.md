# Rivet 卡顿三线根因分析

> 日期: 2026-06-05
> 状态: Root-Cause Analysis — 排查完成，进入修复
> 触发: 用户要求"多场景深入排查胰腺癌这些问题，减少意外的卡顿"
> 方法: 主助手查 Thread 1(进程退出/孤儿)+ 两个 tracer agent 并行查 Thread 2/3，全部代码级验证

---

## 摘要

三个"卡顿"症状收敛到**同一个根因家族(abort 传播 + 资源回收)**：

| 线 | 症状 | 根因 | 置信 |
|----|------|------|------|
| 1 | 进程不退出 / PPID=1 孤儿 | exit 层已修；新增 MCP 孤儿 + shutdownCallback 无 try/catch 挂死 | 高 |
| 2 | delegate worker "No response 3m" | abortSignal 在 tool-execution.ts deps 边界被丢弃 → coordinator abort 全成死代码 | 0.8 代码确认 |
| 3 | todo 退回重做 | TodoStore 是 write-only 单例从无读回；compaction 丢 todo 消息后启发式重建 | 高 |

**关键洞察**：Thread 1 与 Thread 2 是同一 bug 的两层 —— exit 层(已修 killAllSync)+ 会话内 abort 传播层(Thread 2，本质未修)。worker 的 bash 子进程 `detached:true`，caller 超时后 worker 不被取消 → detached 子进程也不被取消 → 会话内孤儿累积(实测 9 个、两个 15h/22h、各 25% CPU），被误判为 Ink 卡屏。

---

## Thread 1 — 进程不退出 / 孤儿

**已到位**：`killAllSync()` 在 `gracefulShutdown` 末尾(main.tsx:141)无条件调；工具子进程(bash/grep/run-tests/diff/sandbox)全过 `track()`，killAllSync 能回收。

### 1A 高 · MCP 子进程退出时从不被强杀
- MCP server 由 SDK `StdioClientTransport` spawn(`src/mcp/manager.ts:163`)，不走 process-tracker → 不在 activeProcesses → killAllSync 反不到。
- `manager.shutdown()`(manager.ts:69-81)纯 async(`await Promise.all(transport.close())`)。
- gracefulShutdown 里 `void _mcpManager?.shutdown?.()`(main.tsx:137) fire-and-forget，紧接 `process.exit(0)`(142) → async close 被丢弃，MCP 子只收 stdin-EOF 无 SIGKILL。
- 不守规矩的 server(lark-mcp，1.17GB 孤儿)成 PPID=1 孤儿。
- **修复**：SDK 暴露 `get pid()`(node_modules/.../client/stdio.js:120)。gracefulShutdown 同步遍历 connections `process.kill(pid,'SIGKILL')`。

### 1B 高 · shutdownCallback 无 try/catch（挂死路径）
- `gracefulShutdown`(main.tsx:131-143)第 134 行 `shutdownCallback?.()` 未包裹。
- 回调(608-620)含 `persist.compactOai()`(同步 writeFileAtomicSync，ENOSPC/EACCES 会抛)、`persistFileHistory()`(同步)。
- 任一抛 → 第 141 killAllSync / 142 process.exit(0) 永不执行 → 进程挂死、子进程不回收。**磁盘满/权限异常下"卡死冻屏"的精确路径**。
- **修复**：try/catch 包裹 + killAllSync/exit 放 finally。

### 1C 中 · 死路径
- shutdownCallback 里 `killAll()`(main.tsx:610)在退出路径无效(setTimeout SIGKILL 永不触发)；真正干活的是 141 行 killAllSync。
- 注意 `loop.ts:560` abort() 里的 killAll() 是**正确的**(会话内中断进程不退，setTimeout 会触发)。

### 1D/1E 低
- serve(726/727)/worktree(742/743)模式信号处理器各自 exit 无 killAllSync。
- 除 oauth-auth(line 232 unref)外所有 setInterval 未 unref，但 process.exit 覆盖，仅在 1B 触发时叠加成挂死。

### 贯穿性好消息
openai/codex 流式客户端健壮：first-byte+read 双 idle timeout、10min 硬上限、thinking-stall 90s、wireAbortToReaderCancel。主 loop API 调用不会无限挂。

---

## Thread 2 — delegate worker 卡死("No response 3m")✅ 根因确认

**机制：worker 是 in-process，非子进程。**
`delegate-task.ts:96` coordinator.delegate → `coordinator.ts:356` runWorker → `worker-session.ts:127` 在同进程 new AgentLoop 跑 `agent.run()`。唯一真 OS 子进程是 worker 自己 bash 工具 spawn 的(`bash.ts:107` `track(spawn(...,{detached:true}))`)。

### 根因 H1（置信 0.8，代码确认）：abortSignal 在 deps 边界被丢弃
- loop 正确提供：`loop.ts:1641` `abortSignal: this.abortController.signal` 进 executeBatch 的 `input.abortSignal`。
- **断点**：`tool-execution.ts` 的 `makeDeps()`(140-178)和 `pipelineDeps`(196-234)**都不把 input.abortSignal 拷进 deps.abortSignal**。grep 全文 abortSignal 只 2 处：line 90 接口声明 + line 132 batch 边界检查。
- `ToolPipelineDeps.abortSignal` 是**可选字段**(`tool-pipeline.ts:103` 带 `?`)→ TS 不报错 → 静默通过。
- 下游 `tool-pipeline.ts:399/624` 读 deps.abortSignal(undefined)，`delegate-task.ts:105` 把 undefined 传 coordinator → `coordinator.ts:148` `if(abortSignal)` 跳过、`wrapAbort`(270-271)`if(!abortSignal) return p` 返回**不可取消的原始 promise**。整套 coordinator abort guard(186-193, 270-289)是死代码。
- **后果**：primary 180s tool-timeout fire 后，worker promise 被孤立但仍跑到自己内部 180s budget(`worker-session.ts:138`)+ 重试。这就是"No response 3m"。

### 修复
各加一行 `abortSignal: input.abortSignal` 到两个 deps 构造体。一次性 reactivate：worker 可取消、coordinator abort 死代码复活、per-tool withToolTimeout(`tool-pipeline.ts:73-83`)signal 接通。

### 与孤儿 bug 的连接
worker 的 bash 子进程 `detached:true`。caller-timeout 后 worker 不被取消 → 在跑的 detached bash 子进程也不被取消(bash 忽略 abort)→ 会话内孤儿累积。孤儿 bug 两层：exit 层(已修)+ 会话内 abort 传播层(本条，本质未修)。

---

## Thread 3 — todo 退回重做 ✅ 根因确认

### 根因 H1（置信高）：todo 列表没有权威重注入路径
- **写语义 = full-replace only**：`todo.ts:14-17` 仅 read/write 两臂联合，无 update/patch；`todo.ts:80` `store.write(data.todos)` 盲替；`todo-store.ts:20-26` `this.todos=[...parsed.data]` 整数组覆盖，无 by-id merge。
- **持久化 = 纯内存且 store 是孤儿**：`todo-store.ts:14` 私有数组，`todo.ts:19` 模块级单例；`session-persist.ts` 零 todo 引用 → resume 后空。`getTodos/setTodos`(todo.ts:21-27)**只有 .d.ts 引用，无任何 .ts source 调用** → store 是 write-only sink。
- **prompt 可见性 = 模型看不到权威列表**：`<task-progress>`(`volatile.ts:217-222`)由 `extractTaskState`(`turn-end.ts:32-33`)填充，它**不读 TodoStore**，而是启发式(`task-state.ts:15-43`)：completed=最近5次成功工具名、remaining=正则、current=最后 trajectory。与真实列表完全解耦。
- **compaction 丢消息**：`replaceWithCheckpoint`(`compaction-controller.ts:543-552`)丢弃原始 todo 消息，用启发式 handoff 替代。

### 放大器（非独立根因）
full-replace 写语义、无 completed→pending 回退守卫。

### 失败时间线
模型写 5 个 todo(3 done)→ compaction 丢弃 todo 工具消息 → handoff 用启发式重建(只有工具名+正则)→ 模型凭残缺记忆重建列表，把已完成项写回 pending → 重跑已完成工作。

### 修复
让权威列表跨压缩存活并重注入(compaction handoff 渲染 `store.read()` 真实列表)+ write 时加 completed→pending 回退守卫。注意 prefix cache 不变量——重注入放动态后缀不放锚点前。

---

## 修复优先级

| 优先级 | 修复 | 收益 | 风险 |
|--------|------|------|------|
| **P0** | Thread 2：两个 deps 构造体各加 `abortSignal: input.abortSignal` | 治 worker 卡死 + 会话内孤儿 + CPU 卡顿 | 极低(一行) |
| **P0** | Thread 1B：`shutdownCallback` 包 try/catch，killAllSync+exit 放 finally | 消除挂死冻屏路径 | 极低 |
| **P1** | Thread 1A：gracefulShutdown 同步遍历 MCP connections 拿 pid 强杀 | 消除 exit 时 MCP 孤儿 | 低 |
| **P1** | Thread 3：compaction handoff 渲染真实 todo 列表 + completed→pending 守卫 | 治 todo 退回做白工 | 中(保 cache 不变量) |

每项修复后跑 typecheck + 相关测试 + 全量回归。
