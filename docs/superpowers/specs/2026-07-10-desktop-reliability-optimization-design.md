# 桌面端可靠性与性能综合优化 · 深度头脑风暴结果

> 2026-07-10 · deep-brainstorm 三轮演化（变异→选择→适应）+ 3+1 scout 反证
> 碎片池: `.superpowers/brainstorm/2026-07-10-desktop-optimization-fragments.json`

## 背景

- **用户需求**：继续优化桌面端——性能、内存、工作流、渲染、网络层；最近常见报错是「瞬时中断」（澄清：横幅类症状已少见，主要遗留是工具层偶发丢工具结果，已修多轮，这次整体审视）；尽可能最大提升，参考其他行业。
- **项目上下文**：Tauri 2（WebView + Rust shell）+ Node sidecar 单进程（agent loop 与 HTTP/SSE 同进程）。本轮之前已完成流式渲染四波优化（稳定段冻结、delta 合并、切片订阅、measureElement 节流）。
- **调研摘要**：
  - 代码扫描：五大隐患——事件循环阻塞掐死 SSE 心跳、重连同步全量 replay events.jsonl、Rust 监督只认进程退出、六连接预算顶格、错误吞没；内存无界点（sessions Map、已建 agent 不被 LRU 驱逐）。
  - 外行业：四领域收敛——故障是预期事件（hls.js 自愈梯子）、连续怀疑度替代固定超时（Cassandra phi 检测器）、单调序号让重连廉价（Linear syncId）、活性证明来自工作路径本身（systemd sd_notify WATCHDOG=1）。
  - 技术文档：localhost 六连接限制无法用 HTTP/2 规避（webview 拒绝 h2c）；后台窗口 rAF 完全停发；Node 事件循环健康标准做法 = monitorEventLoopDelay p99 告警 + worker 池。
  - **反证审计（关键）**：
    - P1 事实：agent 与 sidecar 同进程，重启杀死全部在途 run（rehydrate 标 aborted，无自动续跑）。
    - P2 反驳：tool_result 同步 fan-out 到 SSE，不走 delta 缓冲；丢失更可能来自 ①客户端 rAF 积压 ②崩溃前 100ms 持久化窗口（注释声称的 `flushEventBuffer` 全库不存在）③SSE 半死连接撑到 90s idle。
    - P3 反驳：连接预算已被 MAX_LIVE=5 + hub 复用工程化压在 ≤6，第 7 条排队不失败；「中控台卸主线程流」注释与实现不符（未实现）。
      注：订阅归属在 `WorkspaceSurface.tsx:50`（顶层无条件 `useSessionEvents(activeId)`），不在 ThreadView——mission 打开只卸载 ThreadView 子树，WorkspaceSurface 与订阅始终存活，且 `setSurface` 不清 `activeSessionId`（`store.tsx:123-124`）。曾有评审误判为「ThreadView 卸载即拆流」，已核实驳回。
    - P5 事实：事件循环活性心跳机制不存在，现有 watchdog 方向相反（sidecar 查父进程）。
    - P6 事实：hub 的 flush 只挂 rAF，无 visibilitychange/setTimeout 兜底；后台窗口 pending 无界堆积，审批/完成通知无限期滞后——用户感知等同「断流/丢结果」。

## 三轮思考过程

### 第一轮：变异

五个方案占据不同生态位：

| 方案 | 生态位 | 一句话 |
|------|--------|--------|
| V1 主流 | 监督重启 | sidecar 从事件循环内向 Rust 发活性心跳，phi 式分级判定，挂死自动重启 |
| V2 邻近 | 根因清剿 | 对已被代码证实的丢失路径逐一手术（即时刷盘/rAF 兜底/异步 replay/approval 修复/错误浮出） |
| V3 空位 | 本地优先日志 | IndexedDB 事件日志作 UI 真相源，重连/重启退化为增量追赶 |
| V4 突变 | 可续跑运行时 | agent run 检查点化，重启后自动续跑在途 turn |
| V5 补充 | 传输合并 | 多路 SSE 合并为单条多路复用通道 |

创始假设修正：「瞬断是网络问题」→ 实为进程内调度 + 客户端调度问题；「监督=重启」→ 重启代价极高须分级；「服务端丢事件」→ 症状可能纯前端（事件都在，UI 冻结）。

适应度函数：硬约束 = 不破坏 prefix cache / 不改 SSE resume 语义 / 在途 run 不被无差别杀；加分 = 单点改动覆盖多症状、可用现有测试基建验证；减分 = 新基础设施、触碰 agent loop 语义、收益依赖未证实故障模式。

### 第二轮：选择

- **灭绝 V5**（传输合并）：收益前提「连接耗尽致故障」被 P3 反驳，第 7 条连接排队而非失败。回收特征：per-session cursor 协议设计留档；「中控台卸流」作为低成本项吸收。
- **灭绝 V3**（本地优先日志）：高成本 + 与主诉因果链弱（since 续传已覆盖重连场景）。回收特征：「UI 真相源与传输解耦」思想通过强化 hub 实现；冷启动瞬时可读列远期。
- **灭绝 V4**（可续跑运行时）：agent loop 语义改造成本与回归风险超出本专项。回收特征：弱化版「重启后一键续跑」（rehydrate 检测 wasRunning → 事件流插入可操作卡片）。
- **存活 V2**（根因清剿）：全部修复锚定 file:line 证据，成本最低，且铺设遥测地基。**最强竞争者。**
- **存活 V1 收窄版**（检测→分级→谨慎重启）：唯一覆盖「进程活着但挂死」盲区；单独先上 V1 是局部最优陷阱（无数据定阈值，重启还杀 run），必须后置于 V2 的遥测。

第二轮新发现：
1. `run().finally` 无条件 `rejectAllPending('aborted')`——正常完成也可能把挂起 approval 当 deny（独立 bug，实施前先写复现测试验证）。
2. 「注释声称的行为不存在」出现两处（`flushEventBuffer`、中控台卸流）——文档漂移本身是一类风险，修复时同步修注释。

### 第三轮：适应

- **套路清除**：「加看门狗自动重启」在 agent-in-process 架构里 = 用大中断治小中断，重启必须是梯子最后一级且有在途 run 保护；「上 WebSocket/HTTP2」同为套路，连接层已被证明不是瓶颈。
- **扩展适应**（已有资源新用途）：
  1. 已有 `cpu-pool` 工作线程池 → 重连时 events.jsonl 解析复用；
  2. 已有 parent-PID watchdog 通道模式 → 父→子活性探测的实现参考；
  3. 已有 /health 4s 轮询 → 免费搭载 loopLag 字段，前端零新连接获得活性信号；
  4. 已有 sidecar-restart 事件标记 → 扩展为「一键续跑」入口（V4 回收特征）；
  5. 刚落地的 delta 合并缓冲已把 flush 语义统一在 `append()` → 即时刷盘改造有清晰挂点。
- **收敛洞察（架构原则）**：V1/V2/V4 收敛于「故障要在它发生的层被看见」——刷盘窗口、rAF 停转、事件循环挂死此前都不可见。与四行业结论「活性证明来自工作路径本身」一致：**可观测性先于自动化处置**。

## 最终方案

**V2 全量 + V1 收窄版（检测→分级→谨慎重启）+ 三个回收特征（一键续跑 / 卸中控台主流 / cursor 协议留档）**

### Phase 1 — 根因清剿（~2-3 天，独立可交付）

| # | 改动 | 锚点 | 验证 |
|---|------|------|------|
| 1 | 验证并修 `run().finally` 无条件 `rejectAllPending('aborted')`（正常完成不应 deny 挂起 approval）。独立 bug，零基础设施依赖，放第一位 | `src/server/session-manager.ts:1102-1104` | 先写复现测试确认语义，再修 |
| 2 | 关键事件（tool_result/status/approval/error）到达时调用 `flushSession(sessionId)` 立即落盘（批量单次 `appendFileSync`，同 tick 突发天然合并；如实测突发写仍可感知，可退为关键事件 10ms 微窗口）；非关键仍走 100ms/50 行缓冲；把 `session-persistence.ts:37` 注释声称的行为变成真的。成本注记：`appendFileSync` 是 write 而非 fsync（几十 µs 量级），威胁模型为进程崩溃（page cache 幸存），无需 fsync 级持久性 | `src/server/session-persistence.ts:62-91` | 单测：append 关键事件后同步可读盘上尾行；模拟 kill -9 尾部完整 |
| 3 | hub flush 调度加后台兜底：rAF + ~250ms setTimeout 双保险，visibilitychange 时立即 flush；pending 加上限护栏 | `desktop/src/state/session-event-hub.ts:105-118` | 单测模拟 rAF 停转：事件仍在限时内折叠；通知路径不冻结 |
| 4 | 错误浮出：`sse-stream` 写失败通知 manager 清订阅；`loadEvents` 失败不再降级为空数组静默 replay，改为可见错误事件 | `src/server/sse-stream.ts:28-32`、`session-manager.ts:796` | 单测：写失败后订阅被清；load 失败 UI 可见 |

成功标准：kill -9 后 events.jsonl 尾部完整；后台挂起 10min 恢复后通知照常。
退出条件:  rAF 兜底引入渲染抖动 → 退回仅 visibilitychange。

### Phase 2 — 活性信号 + 重连廉价化（~3 天）

| # | 改动 | 锚点 | 验证 |
|---|------|------|------|
| 5 | `monitorEventLoopDelay` 常驻采样；/health 响应带 `{ loopLagP99, running }`；前端把「reconnecting + loopLag 高」区分显示为「服务繁忙」而非「连接中断」 | `src/server/health-route.ts`、`desktop/src/state/queries.ts:72` | 人为阻塞事件循环 30s：前端显示繁忙而非断流 |
| 6 | 重连 replay 廉价化：未加载 session 的 events.jsonl 改异步读 + 复用 cpu-pool 解析；大会话按 seq 截尾读 | `src/server/session-persistence.ts:250-273`、`src/workers/cpu-pool.ts` | 大 events.jsonl 重连 p95 < 500ms，期间 SSE ping 不停 |

退出条件：loop-lag 采样开销 >1% CPU → 降采样。

### Phase 3 — 分级监督 + 内存（~1 周）

| # | 改动 | 锚点 | 验证 |
|---|------|------|------|
| 7 | Rust 分级监督梯子：try_wait 之外周期读 /health（工作路径内心跳），连续异常 → emit degraded（UI 黄条）→ 无在途 run 自动重启 → 有在途 run 征询用户；重启预算沿用 3 次/10min | `desktop/src-tauri/src/lib.rs:1352-1430` | SIGSTOP 模拟假死：60s 内 UI 分级提示；正常长推理不误报 |
| 8 | 重启后一键续跑，三件套缺一不可：① 新事件类型（如 `resume_offer`，不复用 status 事件糊过去）；② 前端 event-reducer 消费该类型生成可操作卡片；③ 服务端续跑入口——`run(id, prompt)` 现签名要求 prompt（`session-manager.ts:1045`），需支持「续跑」语义（复用最后一条用户消息或注入 sidecar-restart 恢复提示，跳过新 initial prompt）。**缓存亲和硬约束**：续跑必须沿用会话重启前的模型与星域（record 持久化的 `model`/`domain`），严禁静默回退默认模型（如 v4-pro）——跨模型续跑会重建整条前缀缓存，成本高于续跑收益本身。原模型不可用时的行为分两档：用户配置了 `resume.fallbackModel` → 用该模型续跑并在卡片上明示「模型已切换，缓存将重建」；未配置 → 不提供自动续跑，卡片降级为「开新会话重读上下文」入口。fail-closed：模型/星域信息缺失或对不上时同样走降级档 | `session-manager.ts:657-724,1045`、`desktop/src/state/event-reducer.ts` | 重启后 UI 出现续跑卡片，点击后对话以原模型+原星域继续；模拟原模型不可用：无 fallback 配置时只出现新会话入口，绝不落到默认模型 |
| 9 | 内存：归档会话从 sessions Map 卸载；空闲 agent TTL 释放；中控台打开时真正卸载主线程流（让 `MissionControlSurface.tsx:39-41` 注释成真） | `session-manager.ts:622,832-842`、`desktop/src/surfaces/WorkspaceSurface.tsx:50` | 24h 长驻 RSS 增长有界；中控台开启时持久连接 ≤5 |

退出条件：分级监督误报率高（正常推理被判 degraded）→ 提高阈值或改 phi 式自适应窗口。

## 风险与应对

| 脆弱点 | 应对 |
|--------|------|
| 分级监督阈值无生产数据支撑，首版可能误报 | Phase 1/2 先铺遥测；阈值从实测分布推导；首版只提示不自动重启 |
| 即时 flush 增加磁盘 IO 频率 | 仅关键事件触发 `flushSession`（批量单次 write，非逐条），delta 类仍走缓冲；`appendFileSync` 为 write 非 fsync，单次几十 µs，并行工具突发实测总量 ~1-2ms；若可感知则退为 10ms 微窗口 |
| hub 双保险 flush 可能与虚拟列表 measure 节流互相放大抖动 | 后台兜底 interval 取 250ms（远粗于 rAF），前台仍以 rAF 为主 |
| Phase 3 触碰 Rust 侧，回归面大 | 梯子每级独立开关；沿用现有 3 次/10min 重启预算与 sidecar-gave-up 兜底 |

## 下一步

Phase 1 第一个动作：为 `session-manager.ts:1102-1104` 的 `run().finally` 无条件 `rejectAllPending('aborted')` 写复现测试——构造「run 正常完成时仍有挂起 approval」的场景，确认其被误 deny 后修复。独立 bug，零依赖，修完即可验证。
