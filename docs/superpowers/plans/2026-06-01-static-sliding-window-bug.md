# 修复 <Static> 滑动窗口导致消息静默丢失

> **面向 AI 代理：** 使用 executing-plans 逐任务实现此计划。

**严重级别：** 高 — 用户可见的消息完全消失，无法通过滚动找回

**发现场景：** 长会话（200+ 条日志条目）中，agent 回复在流式显示后瞬间消失，滚动历史也无法找到

---

## 根因分析

### 核心机制

```
数据流: handleSubmit → agent.run() → onTextDelta → BlockWriter → textBatcher → streamBuf
                                                                                   ↓
归档流: onTurnComplete → pushAssistantEntry(streamBuf) → pushStaticBatch → historyBuffer
                                                                                   ↓
渲染流: historyVersion ↑ → historyItems → staticHistoryItems → <Static items={...}>
```

### Bug 定位

**文件：** `src/tui/app.tsx` + `src/tui/viewport.ts`

**问题链：**

1. `staticHistoryItems` 使用 `latestHistoryItems(historyItems, max=200)` 做滑动窗口截断
2. Ink 的 `<Static>` 组件用内部 `index` 追踪已渲染条目数：`itemsToRender = items.slice(index)`
3. 当 `historyItems.length` 超过 200 时，`staticHistoryItems` 始终为 200 条（丢弃最旧的）
4. `<Static>` 的 `useLayoutEffect(() => setIndex(items.length), [items.length])` 依赖 `items.length`
5. 当 `items.length` 从 200 → 200（条目被替换，长度不变），`index` 不更新
6. `itemsToRender = items.slice(200) → []` — **新条目永远不会被渲染**

### Ink Static 组件源码（node_modules/ink/build/components/Static.js）

```javascript
export default function Static(props) {
    const { items, children: render } = props;
    const [index, setIndex] = useState(0);
    const itemsToRender = useMemo(() => items.slice(index), [items, index]);
    useLayoutEffect(() => {
        setIndex(items.length);  // ← 只在 items.length 变化时触发
    }, [items.length]);
    // ...
}
```

### 复现条件

- 会话中累积 200+ 条日志条目（每轮 5-20 条，约 10-40 轮后触发）
- `viewportLines(termRows, 0.75, 40, 200)` 计算出的 maxItems = 200
- 触发后，**所有新的 Static 条目**（assistant 消息、tool 结果、system 消息）全部静默丢失

### 用户体验

1. agent 回复通过 `StreamOutput` 流式显示 ✓
2. `onTurnComplete` 触发：将文本归档到 `historyBuffer`，清除 `streamingText`，设置 `isStreaming=false`
3. `StreamOutput` 卸载（不再显示）
4. `<Static>` 应该渲染新条目，但因为 index bug，**什么都不渲染**
5. 用户看到消息"一瞬间消失"，滚动也无法找到

---

## 修复方案

### Task 1: 移除 staticHistoryItems 的滑动窗口截断

**原理：** Ink `<Static>` 只渲染 `items.slice(index)` 的增量部分，旧条目被跳过。
因此传入全部 `historyItems` 是安全的 — 旧条目不会重新渲染，只是占用数组内存。
环形缓冲区最大 1000 条（`HISTORY_MAX_ITEMS`），内存完全可接受。

**文件：** `src/tui/app.tsx`

**before:**
```tsx
const staticHistoryItems = useMemo(
  () => latestHistoryItems(historyItems, Math.max(1, viewportLines(termRows, 0.75, 40, 200))),
  [historyItems, termRows],
)
```

**after:**
```tsx
// No sliding window — pass all items. Ink's <Static> only renders items.slice(index),
// so old items are skipped. The sliding window caused a silent drop bug when
// items.length equaled the max (Static's index stayed stuck, new items never rendered).
// Ring buffer cap (HISTORY_MAX_ITEMS = 1000) bounds memory.
const staticHistoryItems = historyItems
```

**注意：** 如果 `staticHistoryItems` 在其他地方被引用用于高度计算，需要单独保留一个截断版本。检查所有引用点。

**提交：** `fix(tui): remove sliding window from Static items — prevents silent message loss in long sessions`

### Task 2: 清理未使用的 import

**文件：** `src/tui/app.tsx`

如果 `latestHistoryItems` 不再被使用，移除 import。如果 `viewport.ts` 中其他地方仍需要它，保留。

**提交：** 同 Task 1 或单独 `chore(tui): remove unused latestHistoryItems import`

---

## 验证

### 单元测试

```bash
npx tsc --noEmit
npm exec -- tsx --test src/tui/__tests__/*.test.ts
```

### 手动验证

1. 启动 session，运行 15+ 轮对话（确保 historyItems 超过 200）
2. 发送一条消息让 agent 回复
3. 确认回复在流式结束后仍然可见（在 Static 中显示）
4. 滚动上方确认之前的消息也都在

### 回归检查

- 确认短会话（< 200 条目）行为不变
- 确认 tool 结果仍然正确渲染
- 确认 thinking 消息仍然正确渲染
- 确认 turn summary 仍然正确渲染

---

## Self-Check

### Placeholder Scan
无 TODO/TBD/待定。

### 风险评估
- **风险：** 传递 1000 条 items 给 `<Static>` 的 `useMemo` 依赖检查
- **影响：** 每次 render 都会对 1000 条 items 做引用比较，开销可忽略（数组引用只在 historyVersion 变化时才变）
- **缓解：** useMemo 已缓存，只要 `historyItems` 引用不变就不会重算

### 相关文件清单

| 文件 | 变更 |
|------|------|
| `src/tui/app.tsx:212-215` | 移除 `staticHistoryItems` 的滑动窗口 |
| `src/tui/app.tsx:1357-1359` | 确认 `<Static items=...>` 使用正确的变量 |
| `src/tui/viewport.ts` | 可能清理 `latestHistoryItems`（如不再使用） |

---

## 补充：审查中发现的次要问题

以下问题在本次审查中发现但影响较低，单独记录：

### 次要问题 1: AssistantMessage 静态归档行数上限偏低

**文件：** `src/tui/assistant-message.tsx:21,32`
- `MAX_STATIC_LINES = 80`，`useViewportLines(0.6, 20, 80)`
- 对于长回复（如代码审查），只保留最后 80 行，前面内容显示 "(… N earlier lines omitted)"
- 用户滚动到该条目时无法看到完整内容
- **影响：** 低（丢失的内容在终端 scrollback 中可通过 pager 查看）
- **建议：** 考虑将 max 提高到 150-200，或添加"展开完整内容"交互

### 次要问题 2: 2.9 分支的 UI 对比差异

| 组件 | 2.9 分支 (tianshu-pangu-2.9.1) | main |
|------|------|------|
| WelcomeScreen | 纯文本 `rivet v2.9` | WALL-E ASCII 机器人 + 动画 stagger |
| GlanceBar | 简洁：model · phase · cache% · cost | 丰富：☆ domain · ⎇ branch · phase · cache% · cost · tokens · compact hint |
| UserMessage | 边框 `borderStyle="round"` | 无边框 gutter layout |
| AssistantMessage | 边框 `borderStyle="round"` + "Assistant" header | 无边框 gutter glyph `▸` |
| StreamOutput | 边框 + "Assistant" header + 光标 `▊` | 无边框 gutter + Markdown 渲染 + 光标 `▊` |
| ThinkingCollapser | 2-frame spinner (`⠋`/`⠙`) | Braille spinner (8-frame) |
| Static items | 无限制 | 滑动窗口 200 条 (bug) |

2.9 的 UI 更接近传统 TUI（边框、标题），main 的 UI 更接近 claude-code 风格（无边框、gutter glyph、更紧凑）。
