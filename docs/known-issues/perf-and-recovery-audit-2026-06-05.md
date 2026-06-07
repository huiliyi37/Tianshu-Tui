# Rivet 性能 & 错误恢复审计(网络层 / 中间层 / 压缩上下文会话层)

**日期:** 2026-06-05
**方法:** 3 个只读子代理并行审计,证据驱动,均带 file:line。本主代理综合排序。
**约束:** 全程只读,未改任何源码。
**证据类型:** baseline 静态读码 + git 谱系。标注「已观测真实缺陷」与「机制隐患」之分。

> **图谱 MCP 说明:** 三个代理均报告 code-review-graph 对本仓返回 0 节点(图谱未构建/未索引),
> 已按约定回退 Grep/Read。若要复核,先 `build_or_update_graph_tool` 重建图谱。

---

## 与当前在飞分支的关系(重要)

当前分支 `fix/stall-root-causes-abort-exit`,但**未提交改动只在 TUI 层**
(`src/tui/app.tsx`、`use-global-input.ts`、`esc-abort-steer-preserve.test.ts`、
`steer-buffer-on-error.test.ts` —— Esc abort + steer-buffer)。

结论:本审计的 agent 层发现(中间层 #1/#2 worker abort、#5 recovery-trigger)
**与当前工作区不冲突**,可独立推进。但分支名暗示 stall/abort/exit 主题,
落地前应核对该分支已提交部分是否已动 worker 信号链,避免与中间层 #1/#2 撞车。

`tool-execution.ts` 当前干净(任务描述的"正在改"不实)。真正在改的中间层相关文件是
`task-state.ts`/`turn-end.ts`/todo store(对应中间层发现 #7)。

---

## 跨层 Top 优先级(主代理综合)

### P0 — recovery 真实缺陷,影响正确性
1. **delegate worker 信号链断裂**(中间层 #1+#2)。worker 是进程内 `new AgentLoop`,
   父 `abortSignal` 不透传(`worker-session.ts:127-138`,worker 自建 controller `loop.ts:815`),
   父 abort 时 worker 空转到内部 180s timer 才停 —— **历史 zombie/卡死根因**。
   且 worker abort 走全局 `killAll`(`src/tools/process-tracker.ts:4,13` —— 模块级 `activeProcesses` Set,
   主代理已核实路径,代理报告误写为 `agent/`)可能误杀父进程子进程。
   → 需父 signal 透传 + per-loop 进程作用域隔离。**优先验证 + 修。**
2. **abort 被伪装成正常完成**(网络 #3)。`anthropic-client.ts:325` / `codex-client.ts:236`
   用户中断后 `break` 继续走到 `onStopReason('end_turn')`,把中断当正常 turn 落库/记账。
   OpenAI 路径(`openai-client.ts:358` throw AbortError)是对的。→ 三客户端统一抛 AbortError。
3. **canonical memory 并发丢条目**(压缩层 #6)。`project-memory-writer.ts:35,75` 裸
   `appendFileSync` + 读改写全量回写,无锁。CLAUDE.md 明确多会话共享 cwd →
   并发 `remember(project)` 交错丢条目,**违反 891cc1b6 事故的 atomic/monotonic 不变量**。

### P1 — recovery 隐患 / 死机制
4. **recovery-trigger 两条腿是死的**(中间层 #5)。`loop.ts:657-682` 的
   `repeated_interrupt`/`session_integrity` 输入硬编码 0/false,5 类触发中 2 类**永不 fire**。
   → 接真实 interrupt 计数 + orphan tool_use 检查(可从 `session.getMessages()` 算)。
5. **anthropic/codex 缺硬超时**(网络 #2)。仅 idle timer + `reader.cancel()`,
   OpenAI 自己的注释(`openai-client.ts:317`)说 keep-alive 挂起时 cancel 可能无效,
   故加了 10min 硬 abort;另两家缺这层 → keep-alive 被服务端挂住可能死锁。
6. **1M 窗口压缩无断路器**(压缩层 #2)。`compaction-controller.ts:233-249` 在
   75-86% 每 turn 调 `llmCompact`,失败无退避 → 反复发 750K-860K token 全量请求全浪费。
7. **DeepSeek tool-JSON-in-content 无消费者**(网络 #1)。`hasToolJsonInContentBug:true`
   仅被校验,SSE 解析从不读 → 若 V4 把 tool call 吐进 content,工具调用被静默丢弃→空转。
8. **会话恢复孤立 tool_call**(压缩层 #7)。`session-persist.ts:185-256` 丢损坏行后
   不校验 tool_call/tool_result 配对 → 残留孤立 tool_call,provider 可能拒整请求。

### P1 — perf 热路径(高频固定开销)
9. **stigmergy 每 postTool 全文件 I/O**(中间层 #3)。`stigmergy-hook.ts:89-108` +
   `stigmergy.ts:91-154`,每个 postTool 全文件 readFile+parse,每 deposit 又读全文件→写全文件,
   无内存缓存。一次 N 写 tool batch = N×(读+写)。→ StigmergyStore 加内存缓存 + 防抖落盘。
10. **每 turn 全量深拷贝+NFC 扫描请求体**(网络 #5)。`openai-client.ts:201`
    `sanitizeMessageContent` 递归重建整棵消息树,历史已 sanitize 过仍重复全量,
    开销随历史线性增长(1M 尤甚)。→ 只兜底新增/末条消息。
11. **token 估算系统性偏低**(压缩层 #1+#3)。`agent/context.ts` 只算裸正文,
    系统提示(~5K tokens)、frozen volatile 块、tool schema 全不计;`micro.ts:25-33`
    还丢 reasoning_content → 压缩/分裂触发系统性偏晚。→ 固定前缀开销加进基线。

### P2 — perf 可缓存重算 / 低风险
12. sensorimotor SHA-256 + sqlite INSERT 漏 defer(中间层 #4,`tool-history-recorder.ts:87-107`)。
13. 请求时剪枝每 turn 全量(网络/压缩,非 1M provider,`engine.ts:301-365`)。
14. RuntimeHookPipeline 9 hook 串行,纯诊断 hook 可并行(中间层 #9,`runtime-hooks.ts:198-215`)。
15. turn-end 每 turn 全量 extractTaskState/getEntries(中间层 #7,在飞改动相关)。
16. 每 turn 最多 6 次 git spawn(中间层 #8,`git-freshness.ts:54-69`),叠加 #1 放大 killAll 半径。
17. snapshot 每 tool 重建(中间层 #10);classifier 408/425 漏判 retryable(网络 #7);
    Codex 缺 thinking-stall 短超时(网络 #6);onRateLimit 丢 retry-after(网络 #4)。
18. SessionStateManager `getSnapshot()` 返回活引用,违反不可变铁律(压缩层 #8,`session-state.ts`)。

---

## 前缀缓存专项结论(压缩层代理)

**未发现击穿风险 —— 这一层很干净。** git-status / planModeState / 各类 hint 均已在
`volatile.ts:148-157` 的 `buildStableVolatileBlock` 显式剥离,volatile 块以 trailer 拼在
user 正文之后,historical 用 frozen 快照保逐字节一致,1M 窗口跳过 prune/mask/dedup。
唯一残留是 frozen 快照保留过期 git/session-state —— 这是 cache 稳定性对新鲜度的既定权衡,非 bug。
(与 memory 中 `cache-killer-git-status` 记录一致:git-status 已移出稳定区。)

---

## 完整发现表 · 中间层(10 条)

| # | 区域 | file:line | 优化机会 | 类型 | 风险 |
|---|---|---|---|---|---|
| 1 | delegate worker 隔离 | `loop.ts:558-561`+`worker-session.ts:127-138`+`src/tools/process-tracker.ts:4,13` | per-loop 进程作用域,worker 只杀自己 spawn 的 | recovery | 中 |
| 2 | 父→worker 信号传播 | `worker-session.ts:127-138`;`coordinator.ts:270-289`;`loop.ts:815` | 父 signal 透传进 worker AgentLoop | recovery | 中 |
| 3 | stigmergy hook I/O | `stigmergy-hook.ts:89-108`+`stigmergy.ts:91-154` | 内存缓存+防抖落盘 | perf | 中 |
| 4 | sensorimotor 同步阻塞 | `tool-history-recorder.ts:87-107` | 移入已有 setImmediate 块 | perf | 低 |
| 5 | recovery-trigger 盲输入 | `loop.ts:657-682` | 接真实 interrupt 计数+完整性检查 | recovery | 中 |
| 6 | recovery "手/记忆"缺失 | `reliability-mode.ts`+`loop.ts` | suggestedActions 执行器+crash breadcrumb | recovery | 中 |
| 7 | turn-end 每 turn 全量 | `turn-end.ts:32-48`+`task-state.ts`(在飞) | getEntries 取一次+脏标记重算 | perf | 低 |
| 8 | 每 turn git 子进程 | `loop.ts:1431`+`git-freshness.ts:54-69` | 缓存 tracked count+降频 | perf | 低 |
| 9 | hook pipeline 串行 | `runtime-hooks.ts:198-215` | 纯诊断 hook 标 parallelSafe 并行 | perf | 中 |
| 10 | snapshot 每次重建 | `tool-execution.ts:332-334`+`loop-factory.ts:103-119` | batch 内构造一次复用 | perf | 低 |

## 完整发现表 · 网络层(7 条)

| # | 区域 | file:line | 优化机会 | 类型 | 风险 |
|---|---|---|---|---|---|
| 1 | DeepSeek tool-JSON-in-content | `provider.ts:52`+`openai-client.ts`(无消费者) | flag 门控下兜底解析 content 里 tool JSON | recovery | 中 |
| 2 | 硬超时不对称 | `anthropic-client.ts:313-320`/`codex-client.ts:224-231` vs `openai-client.ts:317` | 补 AbortSignal.any 硬超时兜底 | recovery | 低 |
| 3 | abort 伪装正常完成 | `anthropic-client.ts:325`/`codex-client.ts:236` | break 改 throw AbortError | recovery | 低 |
| 4 | onRateLimit 丢 retry-after | `stream-client.ts:17`+`loop.ts:1544-1577` | 透传 retryDelayMs,turn 间按真实窗口背压 | recovery | 中 |
| 5 | 每 turn 全量 sanitize | `openai-client.ts:201`+`sanitize.ts:117-128` | 只兜底新增/末条 | perf | 中 |
| 6 | Codex 缺 thinking-stall | `codex-client.ts:215-216` | 移植 openai THINKING_STALL_TIMEOUT_MS | recovery | 低 |
| 7 | classifier 状态码盲区 | `error-classifier.ts:122-131` | 408/425 归 retryable | recovery | 低 |

## 完整发现表 · 压缩/上下文/会话层(8 条)

| # | 区域 | file:line | 优化机会 | 类型 | 风险 |
|---|---|---|---|---|---|
| 1 | token 估算缺前缀 | `agent/context.ts:88,125,145,155`+`engine.ts:388` | 固定前缀开销加进估算基线 | recovery+perf | 中 |
| 2 | 1M 压缩无断路器 | `compaction-controller.ts:233-249` | 补断路器+退避 | recovery+perf | 中 |
| 3 | 估算丢 reasoning | `compact/micro.ts:25-33` | reasoning_content 无条件累加 | recovery | 低 |
| 4 | appendix 循环不注入 | `engine.ts:182,229-237`+`loop.ts:1003` | cache-safe 尾部增量通道 | perf-waste | 中 |
| 5 | 请求时剪枝每 turn | `engine.ts:301-365` | 增量/仅新增消息上跑(非 1M) | perf | 中 |
| 6 | memory 并发丢条目 | `project-memory-writer.ts:35,75`←`remember.ts:85-87` | 文件锁+原子写,守 monotonic 不变量 | recovery | 中 |
| 7 | 恢复孤立 tool_call | `session-persist.ts:185-256` | 丢行后校验 tool_call/result 配对 | recovery | 中 |
| 8 | snapshot 活引用 | `session-state.ts:75,88,93,103,116` | getSnapshot 返回 freeze/深拷贝 | correctness | 低 |

---

## 需要 runtime 验证的点(汇总)

1. **worker 误杀**(中#1):父跑长 bash + delegate 超时 worker,看 worker 超时后父 bash 子进程是否被 killAll 误杀。
2. **worker 卡死**(中#2):delegate 长 worker 后父层 Ctrl+C,测 worker 是否空转到内部 timeout 才停。
3. **delegate-batch 信号竞态**(中,`coordinator.ts:455-472`):`Promise.all` 启动 maxWorkers 已是并发,
   与注释里"serial recursion 才安全"的警告矛盾,需确认 `config.abortSignal` finally 恢复是否被提前 race 重置。**优先。**
4. **DeepSeek tool-JSON 实际发生率**(网#1):抓一次 V4 把 tool JSON 吐进 content 的实样。
5. **anthropic/codex keep-alive 死锁**(网#2):服务端 accept 后不发 chunk 不断连,验 idle-timer cancel 能否解阻塞。
6. **OpenAI text block 落库**(网,需追):openai-client 从不 emit text block,只调 onTextDelta,
   验证持久化 assistant 文本是否依赖 collectedBlocks 的 text 块(疑 streamedText 旁路兜底)。
7. **memory 并发丢失**(压#6):同 cwd 起 2+ 会话并发 `remember(project)`,验 memory.jsonl 是否丢条目/半行。
8. **恢复配对断裂**(压#7):构造中段 checksum 损坏的 .jsonl,确认是否产生孤立 tool_call 被 provider 拒。
9. **token 低估幅度**(压#1):插桩对比真实 `usage.input_tokens` 与 `estimatedTokens` 随 turn 的差值曲线。
10. **1M 压缩重试风暴**(压#2):75-86% 区间故障注入,确认是否每 turn 重发全量请求。

---

## 不值得动的(三层代理一致判断 OK,勿重复造)

- retry-engine 退避(jitter+指数+全局预算+abort-aware,无泄漏)、AbortSignal 主链(fetch-timeout/abort-reader)、
  SSE 行缓冲(非 O(n²))、stableStringify(cache 字节稳定)、anthropic cache_control 四断点、
  dream-hook(已 setImmediate)、immune/P3 defer 块、coordinator wrapAbort listener 清理({once}+双路径)、
  fs-atomic temp+rename、git status 30s TTL、1M 跳过剪枝、compactOaiReasoning 不截断、降级阶梯本体
  (`reliability-mode.ts` 已实现且强制执行,roadmap"待排期"是陈旧的)。
