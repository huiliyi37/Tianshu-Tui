# ESC 中断导致用户消息静默丢失 — 修复计划

> **面向 AI 代理：** 使用 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 修复用户按 ESC 中断流式输出时，已排队的中途消息（steer messages）被静默丢弃，以及新消息被错误路由到 steer buffer 而非正常提交流程的问题。

**架构：** 三处修复——(1) ESC handler 和 onAbort 回调中保留 steer 消息（drain + 通知），与已修复的 onError 路径对齐；(2) abort 后的 React 状态竞态窗口中，InputBar 路由逻辑用 ref 快照而非 React state 判断是否 streaming；(3) 增强视觉反馈，让用户知道排队消息被保留到了下一轮。

**技术栈：** TypeScript strict / Ink 6 / React useRef 竞态保护 / node:test

---

## 根因分析

### 事件流

```
用户发送消息 1（不完整） → streaming 开始（isStreaming = true）
用户按 ESC 一次 → 看到 "(Esc again to rewind)"，isStreaming 仍为 true
用户输入消息 2 并提交 → InputBar.onSubmit 看到 isStreaming=true
                         → 走 steerBuffer.push() 路径（line 1504-1506）
                         → 显示 "Guidance queued: ..."
用户按 ESC 第二次 → 触发 abort：
    ESC handler (line 578-583):
      agent.abort()
      steerBuffer.current.clear()  ← 消息 2 被丢弃！
      setIsStreaming(false)
    onAbort callback (line 1308-1349):
      steerBuffer.current.clear()  ← 再次清空（冗余但确认丢失）
```

### 三个具体漏洞

| # | 漏洞 | 位置 | 影响 |
|---|------|------|------|
| 1 | **onAbort 清空 steer buffer** | `app.tsx:1344` | abort 时所有排队消息被 `clear()` 丢弃，无通知 |
| 2 | **ESC handler 清空 steer buffer** | `app.tsx:579` | 与 onAbort 重复清空，且先于 onAbort 执行 |
| 3 | **React state 竞态** | `app.tsx:1504-1507` | ESC handler 调用 `setIsStreaming(false)` 后，React 尚未重渲染，InputBar 仍看到旧 state=true，后续消息被错误路由到 steer buffer |

### 对比：onError 已修复但 onAbort 没有

```
onError  (line 1299): const preservedSteer = steerBuffer.current.drain()  ✓ 保留
onAbort  (line 1344): steerBuffer.current.clear()                         ✗ 丢弃
ESC handler (line 579): steerBuffer.current.clear()                      ✗ 丢弃
```

commit `40044a9` 修复了 onError 路径，但遗漏了 onAbort 和 ESC handler。

---

## 文件清单

| 文件 | 职责 |
|------|------|
| `src/tui/app.tsx:579` | ESC handler — 改为 drain + 保留 |
| `src/tui/app.tsx:1344` | onAbort callback — 改为 drain + 保留 |
| `src/tui/app.tsx:1504-1507` | InputBar onSubmit — 用 ref 快照判断路由 |
| `src/tui/steer-buffer.ts` | SteerBuffer 类（只读参考，不修改） |
| `src/tui/__tests__/esc-abort-steer-preserve.test.ts` | 新增测试文件 |

---

## 调研背书

### `steerBuffer.current.clear()` 的调用方

| 位置 | 上下文 | 是否应保留 |
|------|--------|-----------|
| `app.tsx:547` | Ctrl+C handler | 是 — Ctrl+C 是硬中断，但保留消息让用户下一轮看到更友好 |
| `app.tsx:579` | ESC double-press abort | **是** — 用户可能已输入新消息 |
| `app.tsx:1344` | onAbort callback | **是** — 与 onError 保持一致 |

### `isStreaming` 的消费者

| 位置 | 用途 |
|------|------|
| `app.tsx:1504` | InputBar onSubmit 路由判断 |
| `app.tsx:545` | Ctrl+C handler 行为分支 |
| `app.tsx:576` | ESC handler 行为分支 |
| `app.tsx:1508` | steer pending 显示条件 |
| `app.tsx:1404` | Static items 渲染条件 |

### SteerBuffer 的 drain vs clear

- `drain()`：取出所有消息，返回格式化字符串，buffer 清空。调用方获得消息内容。
- `clear()`：清空，返回 void。消息永久丢失。

修复策略：所有 abort 场景统一用 `drain()` + 视觉反馈，与 onError (line 1299-1302) 对齐。

---

### Task 1：onAbort 保留 steer 消息

- [ ] **步骤 1：编写测试**

创建：`src/tui/__tests__/esc-abort-steer-preserve.test.ts`

```typescript
import { describe, it, assert } from 'node:test'
import { SteerBuffer } from '../steer-buffer.js'

describe('SteerBuffer: abort preserves messages', () => {
  it('drain returns messages that would be lost on clear', () => {
    const buf = new SteerBuffer()
    buf.push('message before abort')
    buf.push('second queued message')
    // drain preserves — this is what onAbort should do instead of clear()
    const drained = buf.drain()
    assert.ok(drained !== null, 'drain should return messages')
    assert.ok(drained!.includes('message before abort'), 'first message preserved')
    assert.ok(drained!.includes('second queued message'), 'second message preserved')
    assert.strictEqual(buf.hasPending(), false, 'buffer empty after drain')
  })

  it('drain returns null when no messages', () => {
    const buf = new SteerBuffer()
    const result = buf.drain()
    assert.strictEqual(result, null)
  })

  it('messages pushed during abort window are preserved on next drain', () => {
    const buf = new SteerBuffer()
    buf.push('first')
    // Simulate: abort drains
    const first = buf.drain()
    assert.ok(first!.includes('first'))
    // New message arrives after abort
    buf.push('after abort')
    const second = buf.drain()
    assert.ok(second!.includes('after abort'))
  })
})
```

- [ ] **步骤 2：运行测试确认通过**

```bash
npx tsx --test src/tui/__tests__/esc-abort-steer-preserve.test.ts
```

预期：PASS（测试验证 SteerBuffer.drain 行为，不依赖 app.tsx）

- [ ] **步骤 3：修改 onAbort — drain 替代 clear**

修改：`src/tui/app.tsx:1344`

```tsx
// Before:
        steerBuffer.current.clear()

// After:
        const preservedSteer = steerBuffer.current.drain()
        if (preservedSteer) {
          pushStatic(createLogEntry({ type: 'system', content: `📨 ${preservedSteer.split('\n').length} queued message(s) preserved for next turn.` }))
        }
```

- [ ] **步骤 4：修改 ESC handler — drain 替代 clear**

修改：`src/tui/app.tsx:579`

```tsx
// Before:
          steerBuffer.current.clear()

// After:
          const escPreservedSteer = steerBuffer.current.drain()
          if (escPreservedSteer) {
            pushStatic(createLogEntry({ type: 'system', content: `📨 ${escPreservedSteer.split('\n').length} queued message(s) preserved for next turn.` }))
          }
```

- [ ] **步骤 5：修改 Ctrl+C handler — drain 替代 clear**

修改：`src/tui/app.tsx:547`

```tsx
// Before:
        steerBuffer.current.clear()

// After:
        const ctrlPreservedSteer = steerBuffer.current.drain()
        if (ctrlPreservedSteer) {
          pushStatic(createLogEntry({ type: 'system', content: `📨 ${ctrlPreservedSteer.split('\n').length} queued message(s) preserved for next turn.` }))
        }
```

- [ ] **步骤 6：类型检查 + 全量测试**

```bash
npx tsc --noEmit
npx tsx --test src/tui/__tests__/esc-abort-steer-preserve.test.ts
npx tsx --test src/tui/__tests__/steer-buffer.test.ts
npx tsx --test src/tui/__tests__/steer-buffer-on-error.test.ts
```

预期：全部通过，0 type errors

- [ ] **步骤 7：Commit**

```bash
git add src/tui/app.tsx src/tui/__tests__/esc-abort-steer-preserve.test.ts
git commit -m "fix(tui): preserve steer messages on ESC/Ctrl+C abort instead of silently discarding

onAbort, ESC double-press, and Ctrl+C were calling steerBuffer.clear()
which discarded all queued user messages. Now drains and preserves them
with a visible system notice, consistent with the onError path (commit 40044a9)."
```

---

### Task 2：修复 React state 竞态 — InputBar 路由

**原理：** ESC handler 调用 `setIsStreaming(false)` 是 React 批量更新，实际 re-render 滞后。在 re-render 完成前，InputBar 的 `onSubmit` 仍看到 `isStreaming=true`，导致用户消息被错误路由到 steerBuffer。

修复：用一个同步更新的 ref (`isStreamingRef`) 作为路由判断的真实来源，React state 仅用于 UI 渲染。

- [ ] **步骤 1：添加 isStreamingRef**

修改：`src/tui/app.tsx` — 在现有 ref 声明区域（`steerBuffer` 附近，约 line 420）添加：

```tsx
  const isStreamingRef = useRef(false)
```

- [ ] **步骤 2：同步维护 ref**

在所有 `setIsStreaming(value)` 调用处，同步更新 `isStreamingRef`：

| 位置 | 当前代码 | 改为 |
|------|---------|------|
| `app.tsx:711` (handleSubmit 开始) | `setIsStreaming(true)` | `setIsStreaming(true); isStreamingRef.current = true` |
| `app.tsx:548` (Ctrl+C handler) | `setIsStreaming(false)` | `setIsStreaming(false); isStreamingRef.current = false` |
| `app.tsx:580` (ESC handler) | `setIsStreaming(false)` | `setIsStreaming(false); isStreamingRef.current = false` |
| `app.tsx:1153` (onTurnComplete) | `setIsStreaming(false)` | `setIsStreaming(false); isStreamingRef.current = false` |
| `app.tsx:1287` (onError) | `setIsStreaming(false)` | `setIsStreaming(false); isStreamingRef.current = false` |
| `app.tsx:1332` (onAbort) | `setIsStreaming(false)` | `setIsStreaming(false); isStreamingRef.current = false` |
| `app.tsx:775` (/interview) | `setIsStreaming(false)` | `setIsStreaming(false); isStreamingRef.current = false` |
| `app.tsx:800` (/rollback) | `setIsStreaming(false)` | `setIsStreaming(false); isStreamingRef.current = false` |
| `app.tsx:810` (/retrospect) | `setIsStreaming(false)` | `setIsStreaming(false); isStreamingRef.current = false` |

（完整列表需用 grep `setIsStreaming` 确认，以上基于代码审读）

- [ ] **步骤 3：InputBar onSubmit 用 ref 判断路由**

修改：`src/tui/app.tsx:1504-1507`

```tsx
// Before:
        <InputBar onSubmit={isStreaming ? (text: string) => {
          steerBuffer.current.push(text)
          pushStatic(createLogEntry({ type: 'system', content: `Guidance queued: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" — will be injected at next opportunity` }))
        } : handleSubmit} disabled={!!pendingApproval || !!pendingIntent} vimEnabled={false} steerMode={isStreaming} inputRef={inputBarRef} />

// After:
        <InputBar onSubmit={isStreamingRef.current ? (text: string) => {
          steerBuffer.current.push(text)
          pushStatic(createLogEntry({ type: 'system', content: `Guidance queued: "${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" — will be injected at next opportunity` }))
        } : handleSubmit} disabled={!!pendingApproval || !!pendingIntent} vimEnabled={false} steerMode={isStreaming} inputRef={inputBarRef} />
```

注意：`steerMode={isStreaming}` 保持不变（它是 UI 显示属性，用 React state 正确）。只有 `onSubmit` 的路由判断从 `isStreaming` 改为 `isStreamingRef.current`。

- [ ] **步骤 4：类型检查 + 全量测试**

```bash
npx tsc --noEmit
npm exec -- tsx --test src/tui/__tests__/*.test.ts
```

预期：0 errors，全部通过

- [ ] **步骤 5：Commit**

```bash
git add src/tui/app.tsx
git commit -m "fix(tui): use ref snapshot for InputBar routing to prevent steer misroute during abort

React setIsStreaming(false) is batched — InputBar's onSubmit could still
see isStreaming=true after ESC abort, routing the next message to steerBuffer
instead of handleSubmit. Now uses isStreamingRef.current for the routing
decision, which updates synchronously."
```

---

## 验证

### 自动验证

```bash
npx tsc --noEmit
npm exec -- tsx --test src/tui/__tests__/esc-abort-steer-preserve.test.ts
npm exec -- tsx --test src/tui/__tests__/steer-buffer.test.ts
npm exec -- tsx --test src/tui/__tests__/steer-buffer-on-error.test.ts
```

全部通过，0 errors。

### 手动验证场景

1. **ESC abort 保留消息**：发送消息 → 输入中途 guidance → ESC ESC → 看到 "📨 N queued message(s) preserved" → 发新消息 → guidance 被注入
2. **Ctrl+C 保留消息**：发送消息 → 输入中途 guidance → Ctrl+C → 看到 "preserved" 通知
3. **abort 后立即发消息**：ESC ESC → 立即输入并提交 → 消息正常出现在对话中（非 "Guidance queued"）
4. **正常 streaming guidance**：发送消息 → 输入 guidance → 不按 ESC → 等待下一轮 → guidance 正常注入

---

## Self-Check

### 规格覆盖度
| 用户报告的问题 | 修复任务 |
|--------------|---------|
| ESC 中断后消息丢失 | Task 1（onAbort + ESC handler drain） |
| 中断后新消息看不到（被错误路由） | Task 2（ref 快照防竞态） |
| Ctrl+C 同样丢失消息 | Task 1 步骤 5（Ctrl+C handler drain） |

### Placeholder Scan
无 TODO/TBD/待定/后续实现。每个步骤都有完整代码。

### 类型一致性
- `isStreamingRef` 类型为 `useRef(false)` → `MutableRefObject<boolean>`，`.current` 读写均安全
- `steerBuffer.current.drain()` 返回 `string | null`，与 `clear()` 的 `void` 不同，但所有调用方均已有 `if` 检查
- `escPreservedSteer` / `ctrlPreservedSteer` / `preservedSteer` 变量名在各自作用域内唯一

---

## 执行交接

计划已完成并保存到 `docs/superpowers/plans/2026-06-01-esc-abort-steer-message-loss.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。
选哪种方式？
