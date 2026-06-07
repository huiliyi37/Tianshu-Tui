# TUI 渲染修复:committed-log 引用稳定性 + live 区高度约束

**日期:** 2026-06-06
**分支:** `fix/stall-root-causes-abort-exit`
**状态:** 已修复,已验证(真终端 minimax 会话截图确认)

---

## 核心发现

### 真凶:Ink 6.8 `<Static>` 的 useMemo 引用语义

**症状:** agent 回复在流式时正常显示,turn 结束后**消失**;整个会话历史不可见;用户消息和 agent 回复不在同一屏。

**根因:** `committed-log.ts` 的 `items()` 返回同一个数组引用(内部 `arr` 直接暴露)。Ink 6.8 的 `<Static>` 组件(源码 `node_modules/ink/build/components/Static.js:12`):

```js
const itemsToRender = useMemo(() => items.slice(index), [items, index]);
```

`useMemo` 的依赖是 `[items, index]`。当 `items` 是同一个引用(即使内容已变),memo **永不失效** → `items.slice(index)` 返回缓存的空数组 → 新 append 的条目从不渲染进 scrollback。

**验证:** 隔离 Ink 6.8 repro 直接证明:
- `mode=stable`(返回同一引用): rendered items `[]` — **FAIL**
- `mode=snapshot`(append 后返回新 slice): rendered items `[0,1,2]` — **PASS**

**修复(`src/tui/committed-log.ts`):**

```typescript
// 旧(bug):直接返回内部数组 → 引用不变 → Ink memo 不失效
items(): readonly LogEntry[] { return arr }

// 新:append 后清 snapshot → 下次 items() 返回新 slice → Ink memo 刷新
let snapshot: readonly LogEntry[] | null = null
append(entry) { arr.push(entry); snapshot = null; return true }
items() { if (snapshot === null) snapshot = arr.slice(); return snapshot }
```

**设计约束(真凶① 不变量必须保持):**
- 数组必须**前缀稳定**(只 append,不 remove/reorder)— Ink 的 `index` 是数组索引,如果前缀移动就 desync(真凶① 的根因)
- 同一个 historyVersion 内多次调用 `items()` 必须返回**同一引用**(否则每次 render 都 re-slice,性能浪费)
- `snapshot` 机制同时满足两者:mutation 时 invalidate,多次读时 cache

---

## 协同修复:live 区高度约束(防 Ink 满屏模式)

**机制:** Ink 6.8 的 `onRender`(`ink.js:328-330`)在 `lastOutputHeight >= stdout.rows` 时进入满屏模式:每帧写 `\x1B[2J\x1B[H`(清屏+光标归位)。在普通终端上这会把每次重绘推进 scrollback → 回复和输入被分隔到不同屏。

**验证:** 隔离 repro 确认: 30 行 reply + 24 行终端 → `ESC[2J` 触发 1 次。

**实现(`src/tui/app.tsx`):**

1. **移除 `height={termRows}`**(revert `ccd4ae9`):live Box 不可设满屏高,否则 `<Static>` scrollback 被满屏帧埋在视口上方。

2. **Render-time cap**(在 JSX return 之前):
```typescript
const liveGroundRows = 5
const liveThinkRows = streamingThinking ? Math.min(10, ...) + 3 : 0
const liveToolRows = liveTools.reduce(...)
const liveCapRows = Math.max(2, termRows - liveGroundRows - liveThinkRows - liveToolRows - 2)
const displayStreamingText = capLiveTail(streamingText, liveCols, liveCapRows)
```
保证 `stream tail + thinking + tools + ground < termRows`,数学上不可能触发满屏模式。

3. **Gated diagnostic**(`src/main.tsx`,默认无效):
```bash
RIVET_DEBUG_FULLSCREEN=1 node dist/main.js 2>layout.log
```
仅当 `RIVET_DEBUG_FULLSCREEN=1` 且 stderr 非 TTY 时,拦截 `\x1B[2J` 写计数日志。生产完全无开销。

---

## 为什么之前反复失败(5 个 commit 横跳)

| 尝试 | 方向 | 为什么失败 |
|---|---|---|
| `e08f644` | root `<Box height={termRows}>` | 满屏帧占满视口,Static history 被埋("丢回复") |
| `b1374be` | revert 回 Fragment | ✅ 正确(自然滚动) |
| `ccd4ae9` | live Box `height={termRows}` | 同 `e08f644`——任何满屏帧都把 Static 埋掉 |
| `3c5310d` → `afa220c` | 增量 commit → turn 末 commit | 增量 commit 让回复进 scrollback 后不在屏上;turn 末 commit 是正确模型 |
| 各次 cap 尝试 | 限 live 区高度 | 方向对但**不是主 bug** — 是安全网不是根因 |

**真正的 bug 从来不是布局——是 `<Static>` 根本没渲染任何东西。** 所有布局修复都看起来"无效",因为即使布局正确,回复也从没进入 scrollback。流式时在 live 区可见(直接 render),turn 末从 live 清除后就消失了。

---

## Ink 6.8 `<Static>` 关键行为备忘

| 行为 | 源码位置 | 影响 |
|---|---|---|
| `items` 引用变化才重算 slice | `Static.js:12` `useMemo([items, index])` | **必须每次 append 返回新引用** |
| `items.length` 变化才推进 index | `Static.js:16` `useLayoutEffect([items.length])` | 前缀稳定+长度递增 = index 同步 |
| `position: absolute` | `Static.js:22` | 不参与 Yoga flex layout |
| static output flush | `ink.js:254-281` | 在 live output 之前写入终端(真 scrollback) |
| 满屏模式 | `ink.js:328-330` | `outputHeight >= rows` → `\x1B[2J\x1B[H` clear+redraw |

---

## 文件变更清单

| 文件 | 改动 |
|---|---|
| `src/tui/committed-log.ts` | `items()` 返回 cached snapshot(append/reset 时清除);`releaseRendered` 改变内容时也清 snapshot |
| `src/tui/app.tsx` | (1) 移除 live Box `height={termRows}`;(2) render-time live cap(`displayStreamingText`);(3) `StreamOutput` 用 `displayStreamingText` |
| `src/main.tsx` | gated fullscreen diagnostic(默认无效) |

---

## 验证门

- [x] `npm run typecheck` — 绿
- [x] `npx tsx --test src/tui/__tests__/committed-log.test.ts` — 10/10 pass
- [x] 隔离 Ink 6.8 repro — stable=FAIL, snapshot=PASS
- [x] 真终端手验 — agent 回复 turn 结束后可见,输入框紧贴回复下方
- [ ] `npm run test:fast` — 待跑(推荐接下来验证)

---

## 教训

1. **Ink 的 `<Static>` 对引用语义极其敏感。** 它用 `useMemo` 而非 deep compare。任何"优化"为稳定引用的改动都可能让新内容永远不渲染。
2. **"回复消失"的外观像布局问题,但真因是渲染管线没有数据。** 布局修复再多也看不到效果,因为渲染目标是空的。
3. **隔离 repro 是破局关键。** 从第一次发现"fullscreen-clear=0"的瞬间,排除了整条布局猜想线,转向了 commit 管线。
4. **同一个 bug 修 ≥2 次还复发 = 不是这层的问题。** `height={termRows}` 试了两次都失败不是因为放错位置,是因为根因在别处。
