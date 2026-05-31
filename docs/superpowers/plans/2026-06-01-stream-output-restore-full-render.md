# StreamOutput 恢复全量渲染设计方案

## 问题

当前 `src/tui/stream.tsx` 使用 tail window 裁切（`lines.slice(-maxLines)`），流式过程中 agent 回复大部分内容被代码主动吞掉，用户只能看到底部一小块。

## 历史对比

| 版本 | stream.tsx | 行为 |
|------|-----------|------|
| 5月19-21日 | `<Text>{text}</Text>` 全量渲染，21行 | 内容自然流动，Ink 处理溢出 |
| 5月31日（当前） | `useViewportLines` + tail window，52行 | 主动裁切，显示 "(… N earlier lines)" |

## 为什么加了 tail window

`80ba857` commit 说明：
> a bordered box forces Ink to re-measure the whole block every delta, so long fast streams (DeepSeek) jitter

`6cc6105` commit 说明：
> When total dynamic zone height ≥ terminal rows, Ink's cursor-up differential rendering overflows → entire screen flickers

## 性能评估：去掉 tail window 是否安全

### 已有的性能保护层（不依赖 tail window）

1. **`RenderBatcher`**（`src/tui/render-batch.ts`）— microtask 级别合并多个 SSE delta 为单次 setState，减少 React 重渲染频率。
2. **`appendStreamWindow`**（`src/tui/stream-window.ts`）— 字符级硬上限 `LIVE_STREAM_MAX_CHARS = 50_000`，超出从头部截断。它是 state/内存安全阀，不是行数或 Yoga layout 安全阀；50k chars 仍可能对应数百到上千行。
3. **`Markdown` 组件 memo**（`src/tui/markdown-render.tsx:514`）— `memo` + `useMemo(() => parseBlocks(text), [text])`，相同 text 不重新解析。但流式期间 `text` 每次变化，memo 不能避免每次增量后的 O(n) 解析。
4. **无 border box** — 已在 `80ba857` 去掉，不会触发 Ink 整块重测量。

### flicker 的真正触发条件

Ink flicker 发生在：**动态区总行数 > 终端行数** 时，cursor-up 差分渲染溢出。

但 19-21 号版本没有 flicker 问题，因为：
- 当动态区内容超出终端高度时，Ink 只渲染底部 termRows 行（这是当时观察到的 Ink 行为）
- 真正导致 flicker 的是**多个组件同时占用大量行数**（StreamOutput + 多个 ToolCard + ThinkingCollapser 同时展开）

**审查修正**：这条论证只能说明“去掉 tail window 有历史先例”，不能证明当前实现必然安全。当前项目是 Ink 6，且动态区还包含 liveTools、ThinkingCollapser、GlanceBar、InputBar 等组件；一旦 `StreamOutput` 全量渲染 50k chars，动态区总高度仍可能远超终端行数。因此本方案应视为 UX 修复 + 风险可控尝试，而不是已被数学证明的 flicker 修复。

### 当前架构 vs 19-21号的差异

| 因素 | 19-21号 | 当前 |
|------|---------|------|
| ToolCard 数量 | 单个 live | 多个 live（delegate_batch） |
| ThinkingCollapser | 无高度限制 | 有独立 cap |
| Markdown 渲染 | 无（纯 `<Text>`） | 有（`parseBlocks` + memo） |
| RenderBatcher | 无 | 有（microtask 合并） |
| 字符硬上限 | 无 | 50k chars |

**关键发现**：19-21号没有 Markdown 渲染，是纯 `<Text>{text}</Text>`。当前版本用 `<Markdown text={...} />`，每次 text 变化都要 `parseBlocks`。这是性能差异的真正来源——不是行数多少，而是 Markdown 解析开销。

## 方案

### 推荐方案：去掉行级 tail window，保留字符硬上限

```tsx
// stream.tsx — 恢复全量渲染
export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  const theme = getTheme()
  if (!text) return null

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={theme.assistantColor} bold>{gutterGlyph('assistant')}</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Markdown text={text} />
          {isStreaming && <Text>{'▊'}</Text>}
        </Box>
      </Box>
    </Box>
  )
})
```

**安全性论证（带边界）**：
- `appendStreamWindow` 已在 app.tsx 层将 `streamingText` 限制在 50k chars，避免无界 React state 增长
- `RenderBatcher` 合并高频 delta，实际 React 重渲染频率低于 SSE 事件频率
- 无 border box，Ink 不做被边框包住的大块整体重测量
- `Markdown` 有 memo/useMemo，但流式 text 每次变化仍会重新解析；它不是流式期间的主要保护层
- 50k chars 是字符安全阀，不是 UI 行数安全阀；长列表/表格/多段 markdown 仍可能生成大量 React/Yoga 节点

**结论**：推荐方案能修复“流式内容被主动吞掉”的 UX bug，但 flicker/卡顿需要用长文本、长 markdown 列表、多 live tool 并发场景实测确认。

### 风险：Markdown 解析在超长文本时的开销

50k chars 的 `parseBlocks` 在每次 text 变化时执行。这是 O(n) 操作。

当前 `Markdown` 组件还有一个细节风险：`useMemo(() => parseBlocks(text), [text])` 在 `hasMarkdown(text)` fast path 判断之前执行。也就是说，即使文本没有任何 markdown，组件仍会先跑 `parseBlocks`，再返回纯 `<Text>{text}</Text>`。这会削弱纯文本流式输出的性能优势。

**优先缓解 A：把 Markdown fast path 前置**

```tsx
export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
  const { columns } = useTerminalSize()
  const hasMd = hasMarkdown(text)
  const blocks = useMemo(() => hasMd ? parseBlocks(text) : [], [text, hasMd])

  if (!text) return null
  if (!hasMd) return <Text>{text}</Text>

  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((block, i) => renderBlock(block, i, columns))}
    </Box>
  )
})
```

> React hooks 顺序注意：`useMemo` 不能放在条件 return 之后导致不同 render 的 hook 数量变化。上面示例保留固定 hook 顺序，并避免纯文本路径执行 `parseBlocks`；若要连纯文本路径的 `useMemo` 空调用都避免，应拆分为外层 `Markdown` + 内层 `MarkdownBlocks` 组件。

**更彻底写法（推荐实现形态）**：

```tsx
export const Markdown = memo(function Markdown({ text }: MarkdownProps) {
  if (!text) return null
  if (!hasMarkdown(text)) return <Text>{text}</Text>
  return <MarkdownBlocks text={text} />
})

const MarkdownBlocks = memo(function MarkdownBlocks({ text }: MarkdownProps) {
  const blocks = useMemo(() => parseBlocks(text), [text])
  const { columns } = useTerminalSize()
  return (
    <Box flexDirection="column" gap={1}>
      {blocks.map((block, i) => renderBlock(block, i, columns))}
    </Box>
  )
})
```

这样纯文本流式输出不会每帧跑 block parser，只有真正 markdown 文本进入解析路径。

**优先缓解 B：如果实测仍卡顿，流式期间用纯 Text**

如果实测发现卡顿，可以只在流式结束时用 Markdown 渲染，流式中用纯 `<Text>`：

```tsx
{isStreaming ? <Text>{text}</Text> : <Markdown text={text} />}
```

这是 19-21号的原始做法（纯 Text 流式 + Static 里 Markdown 渲染），性能最优。代价是流式期间没有即时 markdown 样式，完成后会发生一次格式化切换。

### 补充风险：live 全文可见不等于历史全文可见

本方案只修复 live `StreamOutput` 被主动裁切的问题。当前归档后的 `AssistantMessage` 仍有静态历史裁切逻辑（`MAX_STATIC_LINES` + `earlier lines omitted`），所以用户可能看到：

1. 流式过程中全文自然滚动可见；
2. 回合结束后，消息进入 `<Static>` 历史区并被静态消息组件按尾部窗口裁切。

这不是本方案的回归，但需要在验收时明确边界：**“全文可见”指 live streaming 阶段；历史区完整回放属于另一个问题。**

### 实测矩阵

普通单测很难证明 Ink flicker，因为它依赖真实终端高度、cursor diff、输出速度和多个动态组件的组合。上线前至少手动验证：

| 场景 | 目的 | 期望 |
|------|------|------|
| 纯文本 50k chars | 验证无 markdown 解析压力时的自然滚动 | 无明显卡顿；不出现 earlier lines live 提示 |
| markdown 列表 1000 行 | 验证大量 block/node 情况 | 无持续 flicker；输入区仍可响应 |
| 长代码块 | 验证 `renderCodeBlock` 60 行 cap 生效 | 代码块内部截断，不拖垮布局 |
| 多个 live ToolCard + 长 StreamOutput | 验证动态区高度叠加 | 不出现整屏闪烁；GlanceBar/InputBar 不被长期撕裂 |
| 回合结束归档 | 验证 live → Static 切换 | live 不闪白；若 Static 裁切，提示语清晰 |

### 清理项

去掉 tail window 后可删除：
- `src/tui/dynamic-budget.ts`（已删除）
- `stream.tsx` 中的 `useViewportLines` / `useTerminalSize` import
- `StreamOutput` 的 `liveToolCount` prop

## 验收标准

1. 流式过程中 agent 回复全文可见（终端自然滚动，不出现 live `"… N earlier lines"` tail-window 提示）
2. 50k chars 纯文本长回复不触发明显 Ink flicker（RenderBatcher + 字符硬上限保护）
3. 1000 行 markdown 列表、多 live ToolCard 并发场景完成手动验证；若卡顿/闪烁，启用“流式纯 Text、完成后 Markdown”的回退方案
4. 回合结束后归档到 Static 的裁切行为被明确接受；若要求历史全文可见，应另开 `AssistantMessage`/pager 方案
5. typecheck 通过，现有测试通过

## 文件变更

| 文件 | 变更 |
|------|------|
| `src/tui/stream.tsx` | 去掉 tail window 逻辑，恢复全量渲染 |
| `src/tui/app.tsx` | 去掉传给 StreamOutput 的 `liveToolCount` prop（如果有） |
| `src/tui/markdown-render.tsx` | 建议前置纯文本 fast path，避免无 markdown 文本每帧执行 `parseBlocks` |

## 天璇审查补记

按“温跃层”视角，本方案真正的边界不在“是否全量渲染”这一条硬线，而在三层混合区：

1. **字符安全 vs 行数安全**：`appendStreamWindow` 保护 state，不保护 terminal rows。
2. **历史经验 vs 当前架构**：19-21号纯 Text 的稳定经验不能完全外推到 Ink 6 + Markdown + 多动态组件。
3. **流式 UX vs 渲染成本**：全文可见修复了吞内容 bug，但把风险从“内容不可见”移动到“长 markdown 解析/布局成本”。

因此推荐落地策略是：先合并 UX 修复和 Markdown fast path；把“流式纯 Text”保留为清晰回退路径；用实测矩阵决定是否启用回退，而不是提前为未知 flicker 牺牲全文可见。
