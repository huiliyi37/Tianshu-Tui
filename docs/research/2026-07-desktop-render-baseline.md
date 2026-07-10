# 桌面端渲染调度基线（渲染调度专项 Wave 0）

> 专项：桌面端渲染与调度架构迭代（继 2026-07-10 流式性能/可靠性两个专项之后）。
> 前置基线：[2026-07-10-desktop-stream-perf-baseline.md](./2026-07-10-desktop-stream-perf-baseline.md)
> （Markdown 管道 full vs tail-only，13.7x，本文档不重复）。
> 机器：darwin arm64（banxia 本机），Node 24。2026-07-11 建档。

## 指标规格与实现锚点

打点基建：`desktop/src/state/perf-budget.ts`（ring buffer 200 样本/指标，p50/p99/max）。
覆盖层：`desktop/src/components/PerfOverlay.tsx`，**开发模式** Cmd+Shift+P（Windows:
Ctrl+Shift+P）呼出。生产构建零开销：所有记录路径在 `import.meta.env.DEV` 上早退，
Vite 静态替换后被 minifier 剥为死代码。

| 指标 | 采集方式 | 平台 | 目标值 |
|------|---------|------|--------|
| FPS（流式期） | rAF 帧间隔（overlay 可见时启动） | 全平台 | 稳定 30+ |
| longtask（>50ms 脚本块） | `PerformanceObserver` type `longtask` | 仅 Chromium（WebView2/dev 浏览器）；WKWebView 未实现，特性检测静默缺席 | p99 < 16ms 的帧内无 longtask |
| `filteredBlocks` 重算 | `perfBegin/perfEnd`（ThreadView useMemo 内） | 全平台 | p99 < 2ms |
| `modeBlocks` 重算 | 同上 | 全平台 | p99 < 2ms |
| `groupBlocks` 重算 | 同上 | 全平台 | p99 < 5ms |
| 流式尾段 Markdown 渲染 | `<Profiler id="tailMarkdown">` actualDuration（精确圈定尾段子树，不串入同 commit 的兄弟工作） | 全平台（dev） | p99 < 8ms |
| JS heap | `performance.memory.usedJSHeapSize` 5s 采样 | 仅 Chromium；macOS 用 Activity Monitor/Instruments 手测补充 | 千条消息 < 200MB |

`loopLagP99Ms`/`loopLagMaxMs`（sidecar 事件循环，`/health` 已有）作为服务端互补视角，
不在 overlay 重复。

## 已采集基线

### sidecar SSE 序列化（Node 24，微基准）

重放路径每事件一次 `JSON.stringify`（`sse-stream.ts:send`）。量级实测：

| 事件形态 | 单次 stringify |
|---------|---------------|
| 典型 text_delta（~300B payload） | ~0.5µs |
| 大 tool_result（20KB payload） | ~16µs |

**结论**：5000 事件全量重放的纯序列化成本仅 ~3-10ms —— 此前"数百 ms 级 loopLag"
的真因不是 stringify 本身，而是**单 tick 内同步跑完整个循环**（5000 次 send + 写队列
膨胀 + 无 yield 饿死其他连接的 keepalive）。Wave 1 的分批 yield（200/批 + cork）修的
正是调度问题而非序列化问题；raw-line 直传（免二次 stringify）收益上界即上表量级，
**优先级降低，暂不做**。

集成测试量级（`session-replay-batch.test.ts`）：5000 事件 in-process 重放全程 ~24ms
（含 mock 写入），25 个批次间 yield。

### 前端渲染指标（待手测采集）

浏览器侧指标需要交互式 dev 环境（真实流式会话 + overlay），无法 headless 采集。
采集步骤：

1. `cd desktop && npm run dev`（或 tauri dev），开一个真实会话
2. Cmd+Shift+P 呼出 overlay，触发一条长回复（>16K 字符，含代码块）
3. 流式全程记录 overlay 的 p50/p99/max，回填下表

| 指标 | p50 | p99 | max | 采集日期 |
|------|-----|-----|-----|---------|
| FPS | 待采集 | | | |
| longtask（仅 Windows/dev 浏览器） | 待采集 | | | |
| filteredBlocks | 待采集 | | | |
| modeBlocks | 待采集 | | | |
| groupBlocks | 待采集 | | | |
| tailMarkdown | 待采集 | | | |
| jsHeapMB（仅 Windows/dev 浏览器） | 待采集 | | | |

## Wave 3 门禁判定规则

计划（`桌面端渲染调度迭代计划`）约定：**派生计算总和**（filteredBlocks + modeBlocks +
groupBlocks，p99 口径）在流式期占每帧预算（16.7ms）**> 30%** 才启动 Wave 3 调度架构
改造（速率组 + groupBlocks 增量化）；单指标不达标但总和超标同样触发（瑶光反证条款）。
低于门禁 → Wave 3 取消，收益已由 Wave 1/2 兑现。

## 与既有基线的关系

- Markdown 管道（parse 层）基线与 wave 对照 → `2026-07-10-desktop-stream-perf-baseline.md`
- 本文档聚焦 parse 之外的剩余成本：派生计算（groupBlocks 链）、React commit（tailMarkdown
  的 actualDuration 含 reconcile）、脚本长任务与内存水位
