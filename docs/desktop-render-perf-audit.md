# 桌面端渲染性能审查

> 审查时间：2026-06-16 · 审查范围：`desktop/src/` 渲染管线 · 基线：HEAD `e112ef1c` + 工作区未提交改动

## 渲染管线现状

```
SSE 事件流
  ↓
use-session-events.ts    rAF 批处理（~16ms 合并所有事件为单次 dispatch）  ✅ 已优化
  ↓
event-reducer.ts         useReducer → 新 state 引用（shallow copy）
  ↓
ThreadView.tsx           rendered = groupBlocks(view.blocks)  →  blocks.map → Block / ToolGroup
  ↓
Block 组件               普通函数，无 React.memo
  ↓
Markdown.tsx             React.memo(by source) → react-markdown + remark-gfm + rehype-highlight 全量解析
```

事件层已经做了正确的 rAF 批处理（`use-session-events.ts:39-48`），瓶颈不在事件分发频率，而在渲染端。

---

## 问题 1：Block 组件未 memo

**位置**：`desktop/src/surfaces/ThreadView.tsx`

```tsx
// 当前代码（行 ~188）
function Block({ block, isStreaming }: { block: ConvoBlock; isStreaming?: boolean }) {
  // ... 根据 block.kind 渲染不同 UI
}
```

### 机制

`useReducer` 的 `eventReducer` 在每次 dispatch 后返回新 state 引用（`{...state, lastSeq: ev.seq}`），ThreadView 作为消费者重渲染。重渲染时 `rendered.map(...)` 遍历所有 item，每个 item 调用 `<Block block={item.block} .../>`。

因为 Block 是普通函数组件（没有 `React.memo`），React 每次 reconciliation 都会重新执行 Block 的函数体——即使该 block 的内容没有变化。

### 影响量化

| 会话消息数 | 流式期间每帧执行 Block 函数次数 | 帧预算消耗 |
|-----------|-------------------------------|-----------|
| 10 条 | ~10 次 | 可忽略 |
| 30 条 | ~30 次 | 轻微 |
| 50 条 | ~50 次 | 明感触卡 |
| 100+ 条 | ~100+ 次 | 严重掉帧 |

**具体表现**：流式回复期间（agent 正在输出文字），每 ~16ms 就有一次 dispatch → ThreadView 重渲染 → 所有历史 Block 重新执行函数体。即使历史消息内容完全没变，React 也要遍历每个 Block 的虚拟 DOM 树做 diff。

### 与 Markdown 的叠加效应

Block 内部调用 `<Markdown source={block.text} />`。Markdown 有 `React.memo`（按 source 文本比较），所以历史 block 的 Markdown 不会重新解析。**但 Block 函数体本身仍然会执行**——只是 Markdown 子树的 reconciliation 被 memo 跳过了。这意味着：

- Block 函数执行开销（条件判断、JSX 构造）仍然每帧全量发生
- 只有 Markdown 解析（最重的部分）被 memo 挡住了

**结论**：Markdown 的 memo 部分缓解了问题，但 Block 层的 reconciliation 开销在长会话下仍然随消息数线性增长。

---

## 问题 2：消息列表无虚拟化

**位置**：`desktop/src/surfaces/ThreadView.tsx:148`

```tsx
{rendered.map((item) =>
  item.kind === 'tools' ? (
    <ToolGroup key={item.key} items={item.items} />
  ) : (
    <Block key={item.block.key} block={item.block} ... />
  ),
)}
```

### 机制

所有历史消息（`view.blocks`）全部渲染到 DOM。没有 react-window / react-virtual 或任何窗口化机制。`grep` 确认项目无虚拟化依赖。

### 影响量化

| 会话规模 | DOM 节点估算 | 影响 |
|---------|-------------|------|
| 短会话（10 条消息） | ~200-500 节点 | 无感 |
| 中等会话（50 条，含工具调用） | ~2000-5000 节点 | 滚动轻微卡顿 |
| 长会话（100+ 条，含代码块/工具输出） | ~5000-15000 节点 | 滚动卡顿、内存占用高 |
| 超长会话（200+ 条） | ~10000+ 节点 | 初始渲染慢、滚动明显卡顿 |

**具体表现**：
1. **初始渲染**：打开一个长会话时，所有消息一次性渲染到 DOM，可能导致短暂白屏
2. **滚动**：浏览器需要管理大量 DOM 节点的布局计算，滚动帧率下降
3. **内存**：每个 DOM 节点及其关联的 React fiber 对象占用内存，长会话下累积

### 与问题 1 的叠加

没有虚拟化 + 没有 Block memo = 每帧不仅执行所有 Block 函数，还维护所有 Block 的 DOM 节点。两个问题叠加导致长会话流式渲染开销 O(n) per frame。

---

## 问题 3：Markdown 流式全量重解析

**位置**：`desktop/src/components/Markdown.tsx:57`

```tsx
export const Markdown = React.memo(MarkdownImpl, (a, b) => a.source === b.source)
```

### 机制

流式期间最后一个 assistant block 的 text 每个 rAF 帧增长（`event-reducer.ts:126`：`next.blocks[last].text += text`）。Markdown 的 memo 比较器检测到 source 变化，触发 `ReactMarkdown + remark-gfm + rehype-highlight` 三阶段全量重解析。

### 影响量化

| 累积回复长度 | 单次解析耗时（估算） | 流式期间累计 CPU |
|------------|-------------------|----------------|
| 500 字 | ~1-2ms | 低 |
| 2000 字 | ~5-8ms | 中等 |
| 5000 字 | ~15-25ms | 高，可能挤占帧预算 |
| 10000+ 字 | ~30-50ms+ | 严重，每帧解析耗时接近或超过 16ms 帧预算 |

**具体表现**：agent 回复越长，每帧 Markdown 解析越慢。到回复后期（累积数千字），单帧解析就可能超过 16ms，导致可感知的卡顿。代码块高亮（rehype-highlight）是主要开销来源。

### event-reducer 原地修改的连带效应

```typescript
// event-reducer.ts:124-126
next.blocks[next.blocks.length - 1]!.text += text  // 原地修改！
```

`next` 只浅拷贝了 state（`{...state, lastSeq: ev.seq}`），`next.blocks` 与 `state.blocks` 是同一数组引用。原地修改意味着所有历史 block 对象引用不变——这对 memo 友好（历史 block 的 source 不变），但违反 reducer 纯函数约定。如果未来给 Block 加 memo 并以 block 引用做比较，原地修改会导致最后一个 block 的 memo 判断不一致。

---

## 缓解因素（已有优化）

1. **rAF 批处理**（`use-session-events.ts`）：SSE 事件按帧合并，避免 per-token dispatch。这是正确的批处理策略，**瓶颈不在事件层**。

2. **Markdown memo**（`Markdown.tsx:57`）：历史消息的 Markdown 不会重新解析。只有正在流式增长的最后一个 block 每帧重新解析。

3. **ToolGroup 合并**（`ThreadView.tsx:214`，工作区新增）：连续工具调用合并为一个 ToolGroup 渲染，减少了渲染项数量。

---

## 修复建议（按优先级）

### P0：Block + ToolGroup + ToolRow 加 React.memo

```tsx
// ThreadView.tsx
const Block = React.memo(BlockImpl, (a, b) =>
  a.block === b.block && a.isStreaming === b.isStreaming
)
```

前提：event-reducer 的 text_delta 路径需改为不可变更新（否则 block 引用每次都变，memo 失效）：

```typescript
// event-reducer.ts — 改前
next.blocks[next.blocks.length - 1]!.text += text

// 改后
const lastIdx = next.blocks.length - 1
next.blocks = [...next.blocks]
next.blocks[lastIdx] = { ...next.blocks[lastIdx]!, text: next.blocks[lastIdx]!.text + text }
```

效果：流式期间只有最后一个 block 重渲染，历史 block 全部被 memo 跳过。从 O(n) per frame 降为 O(1) per frame。

### P1：Markdown 流式预览降级

流式期间用纯文本渲染（`<pre>` 或轻量 inline），turn 结束后一次性 Markdown 渲染。避免每帧全量重解析。

```tsx
function StreamingText({ source, done }: { source: string; done: boolean }) {
  if (!done) return <pre className="md-streaming">{source}</pre>
  return <Markdown source={source} />
}
```

### P2：消息列表虚拟化

引入 `@tanstack/react-virtual`（轻量，~2KB）或 `react-window`。只渲染可视区域 + 上下缓冲行的 DOM 节点。

效果：DOM 节点数从 O(n) 降为 O(viewport)，长会话滚动和初始渲染都不再随消息数增长。

### P3：ToolRow 展开截断

```tsx
// ToolGroup.tsx — 当 block.text 超阈值时截断
{open && <pre className="tool-body">{body.length > 10000 ? body.slice(0, 10000) + '\n…（截断）' : body}</pre>}
```

---

## 总结

| 问题 | 当前严重度 | 触发条件 | 修复后效果 |
|------|-----------|---------|-----------|
| Block 未 memo | 高（长会话） | 50+ 条消息流式时 | memo 后 O(1) per frame |
| 无虚拟化 | 高（长会话） | 100+ 条消息时 | 虚拟化后 DOM O(viewport) |
| Markdown 流式重解析 | 中高（长回复） | 单条回复 2000+ 字时 | 预览降级后 O(1) per frame |
| reducer 原地修改 | 低（当前无 bug） | 给 Block 加 memo 后暴露 | 不可变更新的前置条件 |

**核心判断**：对于短会话（<30 条消息）当前实现流畅无感。问题在长会话场景（50-100+ 条消息 + 长 agent 回复）下才会明显感知。如果桌面端定位为重度编码工具（长会话是常态），P0 和 P1 应优先处理。
