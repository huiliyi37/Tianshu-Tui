# 桌面端流式渲染性能基线（Wave 0）

> 专项：桌面端流式性能。复现脚本：`cd desktop && node --import tsx scripts/perf-stream-baseline.ts`
> 机器：darwin arm64（banxia 本机），Node 24。数据为 2026-07-10 采集。

## 测量对象

Markdown 管道成本（remark-parse + gfm + math + breaks + remark-rehype + katex，
与 `desktop/src/components/Markdown.tsx` 喂给 react-markdown 的插件链一致），
在模拟流式会话（48KB 长回复，35 字符/20ms delta，100ms UI tick）下对比：

- **full-reparse**：现状 —— 每 tick 重 parse 全量累积文本（`useThrottledStreamingSource` → `<Markdown source={全文}>`）
- **tail-only**：Wave 1 目标 —— 稳定段冻结，每 tick 只 parse 尾部 ~2KB

**未覆盖**：React reconciliation 与 WebView layout/paint（随 DOM 规模同向放大，
管道比值是端到端收益的下界）。WebView 侧 React Profiler 数据需手动采集，未纳入本基线。

## 结果

每 tick 管道成本（ms），随文档增长：

| 文档规模 | full-reparse | tail-only |
|---------|-------------|-----------|
| 4K chars | 63.2 | 13.3 |
| 8K chars | 74.6 | 18.3 |
| 16K chars | 108.3 | 13.4 |
| 32K chars | 259.2 | 10.2 |

全程累计管道工作量：**full = 61.9s，tail-only = 4.5s（13.7x）**。
以 100ms tick 预算衡量主线程占用：full 模式 **225%**（16K 起单次 parse 已超一个 tick，
中后期 UI 必然追不上流），tail-only 模式 **16.5%**。

SSE 帧数：现状 1374 帧（每 delta 一帧）；Wave 2 服务端 40ms 合并窗口下约 687 帧（2.0x）。
注意真实 provider 的 delta 频率高于本模拟（逐 token），实际合并倍率更高。

## 结论（验收基准）

1. 卡顿主因确认：全量重 parse 在 16K+ 文档上单次成本即超 tick 预算，成本随全文线性增长 → 越写越卡。Wave 1 的稳定段冻结把每 tick 成本钉在 O(tail)（~10-18ms），是本专项收益大头。
2. Wave 2 合并主要降低 SSE/JSON/rAF 事件处理频次，对 parse 成本无直接影响（前端 `coalesceDeltas` 已合并同帧 delta）。
3. Wave 4 收尾时复跑同一脚本 + 手动 WebView profile 对比。
