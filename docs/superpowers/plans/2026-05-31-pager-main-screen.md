# Pager 主屏方案 实现计划

> **状态：✅ 已全部实施** — Pager 主屏 overlay (历史翻页)

**目标：** 将会话历史从 Ink `<Static>` 一次性渲染模式改为可滚动的主屏交互模式，用户无需 Shift 切换即可用 j/k/PgUp/PgDn 浏览历史。

**架构：** 当前 `app.tsx` 用 Ink `<Static>` 渲染 `historyItems`——一旦写入终端 scrollback，React 不再管理。改为"主屏 Pager"模式：活跃区（流式输出 + 工具卡片）占终端下半部分，上方是可滚动的历史窗口，由状态管理 `scrollOffset` 控制。三种方案递进式设计，从最简单到最完整。

**技术栈：** Ink 6 / React，已有 `src/tui/pager.tsx`（Pager 组件 + ScrollBuffer），已有 `src/tui/ring-buffer.ts`，已有 `src/tui/viewport.ts`

---

## Scope Check

本计划涉及 TUI 层的渲染模式变更，不涉及 agent/api/compact 层。三个方案独立递进：

1. **方案 A：接入现有 Pager 作为 overlay** — 最小改动，0 新文件
2. **方案 B：主屏分窗渲染（SplitPane）** — 中等改动，替代 `<Static>`
3. **方案 C：全虚拟化主屏** — 最大改动，完全摆脱 `<Static>`

## 三种方案详述

### 方案 A：接入 Pager overlay（最小改动）

**原理：** 已有 `src/tui/pager.tsx` 的 `Pager` 组件支持 j/k/PgUp/PgDn/g/G/q 导航。将它作为 surface router 的一个 overlay（类似 starmap/chronicle/cockpit）接入。用户按快捷键（如 `Ctrl+P` 或 `/scroll`）进入，`q/Esc` 退出回主屏。

**改动范围：**
- 修改：`src/tui/surface/registry.ts` — 添加 `pager` overlay 定义
- 修改：`src/tui/app.tsx` — 接入 Pager overlay + 绑定快捷键 + 传入 ScrollBuffer 数据

**优点：**
- 改动 < 50 行
- Pager 组件已存在且经过测试
- 不影响现有 `<Static>` 行为
- 不增加指令负担（仅在需要滚动时手动进入）

**缺点：**
- 不是"主屏就是可滚动的"
- 需要显式切换，用户可能不知道这个功能

**量化评估：**
- 预计实现时间：15 分钟
- 新增代码：~30 行
- 风险：极低（纯增量）

---

### 方案 B：主屏分窗渲染（SplitPane）

**原理：** 去掉 `<Static>`，改为两区域布局：
1. **上方：历史窗口** — 渲染 `historyItems[offset..offset+windowSize]`，支持 j/k/PgUp/PgDn 滚动
2. **下方：活跃区** — StreamOutput + ThinkingCollapser + liveTools + InputBar（固定在底部）

非流式时，全部空间给历史窗口。流式时，活跃区占底部 30-40%。

**改动范围：**
- 创建：`src/tui/split-pane.tsx` — 分窗布局组件
- 修改：`src/tui/app.tsx` — 用 SplitPane 替代 `<Static>` + 添加滚动状态管理
- 修改：`src/tui/viewport.ts` — 添加分窗行数计算

**优点：**
- 主屏默认可滚动，无需切换模式
- 历史窗口只渲染可见行数（虚拟化），性能好
- 活跃区始终固定在底部，输入和状态栏不会被推走

**缺点：**
- 需要管理滚动焦点（用户在历史窗口滚动时，InputBar 暂时失焦）
- 中等复杂度
- `<Static>` 的 "write-once-to-scrollback" 优势丧失（终端原生滚动不可用）

**量化评估：**
- 预计实现时间：1-2 小时
- 新增代码：~150 行
- 风险：中等（焦点管理、布局稳定性）

---

### 方案 C：全虚拟化主屏

**原理：** 完全去掉 `<Static>` 和 `<Box>` 的终端 scrollback 依赖。所有历史条目（historyItems）都通过一个虚拟化列表渲染器管理，只渲染当前视口内的条目。类似 web 的 react-window/react-virtualized。

**改动范围：**
- 创建：`src/tui/virtual-list.tsx` — 虚拟化列表组件（计算可见条目、管理 offset）
- 创建：`src/tui/virtual-list.test.ts` — 测试
- 修改：`src/tui/app.tsx` — 全面重构渲染逻辑
- 修改：`src/tui/render-entry.tsx` — 每个条目需要预计算高度

**优点：**
- 性能最优（只渲染可见条目）
- 支持任意长会话
- 主屏原生可滚动

**缺点：**
- 需要预计算每个条目的渲染高度（Markdown/code block/表格高度不确定）
- Ink 没有内置虚拟化支持，需自行实现
- 复杂度最高，有回退风险
- 终端原生 scrollback 完全不可用

**量化评估：**
- 预计实现时间：3-4 小时
- 新增代码：~300 行
- 风险：高（条目高度预估不准确会导致滚动跳跃）

---

## File Structure

### 方案 A
| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tui/surface/registry.ts:1-30` | 修改 | 添加 pager overlay 定义 |
| `src/tui/app.tsx:440-560` | 修改 | 接入 Pager + 快捷键 + ScrollBuffer 数据源 |

### 方案 B
| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tui/split-pane.tsx` | 创建 | 分窗布局（历史窗口 + 活跃区） |
| `src/tui/app.tsx:1240-1280` | 修改 | 用 SplitPane 替代 `<Static>` |
| `src/tui/viewport.ts` | 修改 | 添加分窗行数计算函数 |

### 方案 C
| 文件 | 操作 | 职责 |
|------|------|------|
| `src/tui/virtual-list.tsx` | 创建 | 虚拟化列表渲染器 |
| `src/tui/virtual-list.test.ts` | 创建 | 测试 |
| `src/tui/app.tsx:1240-1280` | 修改 | 全面重构渲染逻辑 |
| `src/tui/render-entry.tsx` | 修改 | 每条目预计算高度 |

---

## Research Endorsement（调研背书）

### 删除 `<Static>` 的可行方案（方案 B/C 才涉及）

**现有 `<Static>` 的调用方：** 仅 `app.tsx` 第 ~1255 行一处使用。
```tsx
<Static items={historyItems}>
  {(item) => <React.Fragment key={renderMemoKey(item)}>{renderStaticEntry(item, verbose)}</React.Fragment>}
</Static>
```

**`<Static>` 存在理由：** Ink 官方推荐用于"已完成的输出"。写出到终端 scrollback 后不再重新渲染，性能最优。但代价是不可撤销、不可滚动。

**Edge case：** 方案 B/C 去掉 `<Static>` 后，长会话的所有历史条目都在 React 树中。需要虚拟化或截断来保证性能。当前 `HISTORY_MAX_ITEMS=1000` 的 ring buffer 已经提供了上限保护。

### Pager 组件（方案 A 用到）

**`src/tui/pager.tsx` 状态：** 完整实现，有 Pager 组件和 ScrollBuffer 类，但未被任何文件 import。属于"已写未接入"状态。

**ScrollBuffer vs RingBuffer：** `ScrollBuffer`（pager.tsx 内）和 `RingBuffer`（ring-buffer.ts）功能重叠。`app.tsx` 已用 `RingBuffer` 管理 `historyBufferRef`。方案 A 直接用 `historyItems`（来自 RingBuffer）传入 Pager 即可，不需要 ScrollBuffer。

### Surface Router（方案 A 用到）

**`src/tui/surface/registry.ts`** 已有 overlay 定义模式（cockpit/starmap/chronicle），添加 pager 遵循相同模式。

### 输入焦点管理

**`src/tui/app.tsx:440-560`** 中 `useInput` 已处理大量快捷键。方案 A 只需在 useInput 中添加一个条件分支。方案 B 需要引入"焦点模式"概念（历史窗口聚焦时输入被 pager 捕获，InputBar 聚焦时正常输入）。

---

## Tasks

### 方案 A：接入 Pager overlay（推荐先做）

#### Task 1: 注册 Pager overlay

- [ ] 修改 `src/tui/surface/registry.ts:17-22`：在 `createSurfaceDefinitions()` 返回数组中添加 pager 定义
  ```ts
  { id: 'pager', layer: 'overlay', discoverable: true, paletteEntry: { label: 'Scrollback', hint: '浏览会话历史', hotkey: 'p' }, render: () => null },
  ```
- 修改：`src/tui/surface/registry.ts:17`
- 测试：无新测试（overlay 注册是声明式的）
- 验证：`npx tsc --noEmit` 通过
- 提交：`feat(tui): register pager overlay in surface definitions`

#### Task 2: 在 app.tsx 接入 Pager 渲染

- [ ] 修改 `src/tui/app.tsx`：
  1. 在文件顶部 import Pager：`import { Pager } from './pager.js'`
  2. 在 overlay 渲染区（`activeOverlay === 'cockpit'` 旁边）添加：
     ```tsx
     {activeOverlay === 'pager' && (
       <Pager entries={historyItems} verbose={verbose} onExit={() => surfacePop()} />
     )}
     ```
  3. 在 useInput 中添加快捷键绑定（如 `Ctrl+P`）：
     ```ts
     if (_key.ctrl && _input === 'p') {
       if (isSurfaceVisible('pager')) { surfacePop() }
       else { surfacePush('pager') }
       return
     }
     ```
- 修改：`src/tui/app.tsx:1`（import）、`src/tui/app.tsx:440-560`（useInput）、`src/tui/app.tsx:1260`（overlay 渲染）
- 测试：无新测试（Pager 已有测试，集成测试需手动验证）
- 验证：`npx tsc --noEmit` 通过
- 提交：`feat(tui): wire Pager overlay into main app with Ctrl+P toggle`

#### Task 3: 给 Pager 添加 /scroll 斜杠命令入口

- [ ] 修改 `src/tui/slash-commands.ts`：在 switch 中添加 `/scroll` 命令，调用 `ctx.surfacePush('pager')`
- 修改：`src/tui/slash-commands.ts:300-330`
- 测试：`src/tui/__tests__/slash-commands.test.ts` 添加一个用例
- 验证：`npm exec -- tsx --test src/tui/__tests__/slash-commands.test.ts`
- 提交：`feat(tui): add /scroll slash command to open pager`

---

### 方案 B：主屏分窗渲染（独立实现路径）

#### Task B1: 创建 SplitPane 组件

- [ ] 创建 `src/tui/split-pane.tsx`：
  - Props: `historyItems`, `verbose`, `scrollOffset`, `onScroll`, `activeContent`, `isStreaming`
  - 计算：历史窗口高度 = `termRows - activeHeight - statusBarHeight`
  - 渲染：上方 `historyItems.slice(offset, offset + windowSize)`，下方活跃区
  - useInput: j/k/PgUp/PgDn 控制 `scrollOffset`
- 创建：`src/tui/split-pane.tsx`
- 测试：`src/tui/__tests__/split-pane.test.ts` — 测试行数计算和 offset 边界
- 验证：`npm exec -- tsx --test src/tui/__tests__/split-pane.test.ts`
- 提交：`feat(tui): create SplitPane component for split-screen history view`

#### Task B2: 集成 SplitPane 替代 `<Static>`

- [ ] 修改 `src/tui/app.tsx`：
  1. 添加 `scrollOffset` state
  2. 用 `<SplitPane>` 替换 `<Static>` + 底部活跃区
  3. 管理焦点：流式时自动滚到底部，非流式时允许自由滚动
- 修改：`src/tui/app.tsx:1240-1280`
- 测试：手动验证
- 验证：`npx tsc --noEmit` 通过
- 提交：`feat(tui): replace Static with SplitPane for scrollable main screen`

---

### 方案 C：全虚拟化主屏（独立实现路径）

#### Task C1: 创建 VirtualList 组件

- [ ] 创建 `src/tui/virtual-list.tsx`：
  - 接收 `items: LogEntry[]` + `viewportHeight: number`
  - 为每个条目预估渲染高度（基于 content 行数 + type 权重）
  - 计算可见范围 `[offset, offset + visibleCount]`
  - 渲染可见条目 + 上下 placeholder padding
- 创建：`src/tui/virtual-list.tsx`
- 创建：`src/tui/__tests__/virtual-list.test.ts`
- 测试内容：offset 边界、高度预估、空列表
- 验证：`npm exec -- tsx --test src/tui/__tests__/virtual-list.test.ts`
- 提交：`feat(tui): create VirtualList component with height estimation`

#### Task C2: 集成 VirtualList 替代 `<Static>`

- [ ] 修改 `src/tui/app.tsx`：用 `<VirtualList>` 替换 `<Static>`，管理 scrollOffset state
- 修改：`src/tui/app.tsx:1240-1280`
- 验证：`npx tsc --noEmit` 通过
- 提交：`feat(tui): replace Static with VirtualList for fully virtualized main screen`

---

## Verification

```bash
# Type check (all plans)
npx tsc --noEmit

# 方案 A 测试
npm exec -- tsx --test src/tui/__tests__/slash-commands.test.ts

# 方案 B 测试
npm exec -- tsx --test src/tui/__tests__/split-pane.test.ts

# 方案 C 测试
npm exec -- tsx --test src/tui/__tests__/virtual-list.test.ts

# 手动验证：启动后
node dist/main.js
# 方案 A：按 Ctrl+P → 应显示 Pager overlay，j/k 滚动，q/Esc 退出
# 方案 B：主屏应直接可滚动，InputBar 固定底部
# 方案 C：主屏应只渲染可见条目，滚动流畅
```

---

## Self-check

### 1. Spec coverage

| 需求 | 覆盖任务 |
|------|----------|
| 不增加指令负担 | 方案 B/C 默认主屏可滚动，方案 A 需 Ctrl+P 但属于 overlay 不改主屏 |
| 有用时主屏就是可滚动的 | 方案 B/C 直接实现；方案 A 是 overlay 但可升级 |
| 三个方案写到计划里 | ✓ 本文档 |
| 短文件名 | `2026-05-31-pager-main-screen.md` ✓ |

### 2. Placeholder scan

- 无 TODO / TBD / 待定 / 后续实现
- 所有代码片段都是具体的
- 所有测试都有具体内容描述

### 3. Type/signature consistency

- `Pager` props: `{ entries: LogEntry[], verbose: boolean, onExit: () => void }` — 与 `src/tui/pager.tsx:11-15` 一致
- `SplitPane` props: 新定义，内部一致
- `VirtualList` props: 新定义，内部一致
- `surfacePush` / `surfacePop` — 来自 `useSurface` hook，签名一致

---

## Execution Handoff

**推荐路径：** 先实现方案 A（15 分钟，验证 Pager 组件可用性），再根据体验决定是否推进方案 B。

计划已完成并保存到 `docs/superpowers/plans/2026-05-31-pager-main-screen.md`。两种执行方式：
1. 子代理驱动（推荐）— 每个任务调度一个新的子代理，任务间进行审查，快速迭代。
2. 内联执行 — 在当前会话中使用 executing-plans 执行任务，批量执行并设有检查点。

选哪种方式？
