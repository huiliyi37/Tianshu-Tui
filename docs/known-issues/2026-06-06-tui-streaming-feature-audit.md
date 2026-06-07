# TUI 流式渲染 — 功能审计 (2026-06-06)

**目的:** 记录近期提交中被移除/降级的 TUI 流式渲染功能,以便未来恢复时不被遗忘。读代码取证,不靠猜。

**审计范围:** `src/tui/app.tsx`、`src/tui/committed-log.ts`、`src/tui/stream-window.ts`、`src/tui/live-tail-cap.ts`,以及 5 个近期 commit(`e08f644`、`b1374be`、`661c682`、`afa220c`、`ccd4ae9`)和工作区的未提交改动。

---

## TL;DR — 5 个被牺牲的特性

| # | 特性 | 移除 commit | 判决 |
|---|------|------------|------|
| 1 | **增量提交到 `<Static>` (per-block 滚动出区)** | `afa220c` (-99 行) | **不需要恢复** — `capLiveTail` 渲染时裁切已替代。 |
| 2 | **流式结束后保留回复尾部** | `afa220c` 连带移除 | **不需要恢复** — 修的是 #1 的次生问题,#1 没了它也没意义。 |
| 3 | **根 Box `height={termRows}` 锚定布局** | `b1374be` 撤销 `e08f644` | **不需要,且撤销正确** — 视觉埋掉 Static 历史。 |
| 4 | **动态区 Box `height={termRows}` 锚定布局** | `ccd4ae9` (HEAD 还在) | **不需要,且工作区的撤销正确** — 同 #3 的结构问题,工作区注释点名 3 次失败。 |
| 5 | **动态区内的 `flexGrow={1}` spacer 推底** | 工作区删除 | **不需要,本就是死代码** — Fragment 根无 height 约束,flexGrow 无界可填。 |

**5 个里 0 个需要恢复。** 恢复路径见末尾,但**不推荐**。

**新增的(非损失):**
- `RIVET_DEBUG_FULLSCREEN=1` 调试插桩(`src/main.tsx`)— 监听 Ink 的 `\x1B[2J` 清屏信号并写入 `layout.log`,供真终端排查"活区超终端高度 → Ink 强制重画"用。
- `committed-log` 的引用缓存(真凶① 的 Ink 6.8 `<Static>` memo 修复)— 是修复,不是损失。

---

## 1. 增量提交(incremental streaming commit)— 已删除

### 它曾经做什么

在流式过程中,**每个 block 抵达时就 `pushStatic` 到 `<Static>`**(via `blockWriterRef.current?.flush()` + `textBatcher.current.flushNow()`),而不是等 turn 结束一次性提交。

来自 `afa220c` 移除的代码(`src/tui/app.tsx` 在 `@@ -1016` hunk):

```ts
if (incrementalCommit) {
  // This step's content is already committed block-by-block. Flush the
  // unemitted tail into scrollback, then reset for the next step.
  blockWriterRef.current?.flush()
  textBatcher.current.flushNow()
  // A thinking-only step (reasoning but no content) never triggered the
  // lazy thinking commit — flush it now so it isn't lost.
  if (!thinkingCommittedRef.current && thinkBuf.current) {
    pushStatic(createLogEntry({ type: 'thinking_message', content: appendStreamWindow('', thinkBuf.current, STATIC_THINKING_CAP) }))
  }
  thinkingCommittedRef.current = false
  flushStaticBatch()
} else {
  // Archive intermediate turn text to Static and clear stream buffers
  // (only on final step)...
}
```

`afa220c` 后的等价逻辑变成单一分支(turn-end 一次性提交,推后再裁):

```ts
if (finalText || thinkingForArchive) {
  if (finalText) { /* ... interview marker parsing ... */ }
  // ...
}
```

### 用户体验影响

- **删除前(增量):** 长回复流式时,前段文字随每个 block 滚入 scrollback,屏幕上始终保持"最新的几行"在活区滚动,旧内容已经在滚动历史里。
- **删除后(turn-end):** 整段回复在 turn 结束的瞬间一次性 commit,看到一次"闪现"。

### 死状态

`incrementalCommit` 变量仍然存在但**不再被任何条件分支读取**:

```
src/tui/app.tsx:211  const incrementalCommit = currentProvider !== 'glm'
src/tui/app.tsx:214  const incrementalCommitRef = useRef(incrementalCommit)
src/tui/app.tsx:215  incrementalCommitRef.current = incrementalCommit
src/tui/app.tsx:410  }, [..., incrementalCommit]  // useCallback dep
src/tui/app.tsx:1335 }, [..., incrementalCommit]  // useCallback dep
```

— 5 处出现,0 处 `if (incrementalCommit) { ... }` 分支。依赖数组里引用它,但依赖变化的 callback 内部不再读它。

`incrementalCommitRef` 是无用的 ref wrap(包裹一个永不被读取的 ref 值)。

### 误导性注释

`src/tui/app.tsx:204-210` 的注释描述"glm 走老路,其他 provider 走增量":

```ts
/**
 * - glm: mandatory-thinking promotion dumps the whole reply as reasoning_content
 *   then promotes it to text at stream end (see openai-client.ts). Incremental
 *   commit would race that promotion, so glm keeps the original turn-end commit
 *   path (the `else` branches below are byte-identical to the previous code).
 */
const incrementalCommit = currentProvider !== 'glm'
```

**这段注释的"else branches"不再存在。** 增量分支已被 afa220c 完全删除,没有"byte-identical to the previous code"的对称结构可参照。注释现在只描述已不存在的差异。

---

## 2. 流式结束后的尾部保留(661c682)— 随 #1 一起消失

`661c682` 在增量模式下,在 `onTurnComplete` 把 `finalText` 的最后 N 行写入 `streamLiveBuf` 并 `setStreamingText`,避免清空流式缓冲后活区瞬间空白("reply vanish")。

`afa220c` 把整个增量分支删除,这条尾部保留逻辑也连带消失。`streamLiveBuf` ref 现在仅在 `onDelta`(line 441)和 onTurnComplete 的几个清理点(line 1003、1069)被写/重置,不再有"保留 tail"的特殊路径。

---

## 3. 根 Box `height={termRows}` 锚定布局(e08f644 / b1374be)— 未实现

`e08f644` 把根从 Fragment 改成 `<Box flexDirection="column" height={termRows}>`(2 行)。

`b1374be` 立即撤销(11 行,主要是注释),理由写在 `app.tsx:1371-1379`:

```
NOT wrap in <Box height={termRows}> — that makes the live frame full-screen
every render, which visually buries all <Static> history above the viewport
("丢回复": replies committed but never visible). The flexGrow spacer below
harmlessly collapses to 0 here; the input sits right under the latest output
(Claude-Code-style), which is the intended "pinned" feel without full-screen.
```

**结论:** 该方案 1 次提交即撤销,从未在 HEAD 留过"干净状态"。

---

## 4. 动态区 Box `height={termRows}` 锚定布局(ccd4ae9)— HEAD 是回归状态

`ccd4ae9` 在动态区 Box(line 1386)加 `height={termRows}`(1 行):

```
-      <Box flexDirection="column">
+      <Box flexDirection="column" height={termRows}>
```

**这与 #3 撤销的根 Box 高度约束是同类操作(把含活区的 Box 钉到终端高度),问题相同:**

- 活区变全屏 → Static 历史被推到视口上方 → "丢回复"现象(b1374be 注释里说的视觉问题)
- `flexGrow={1}` spacer 在全屏活区里才有"有界空间可填" — 但代价是 Static 内容被埋

**HEAD 状态:** `ccd4ae9` 已在 HEAD,1 行回归。

**工作区状态:** 已撤销 `ccd4ae9`(`+30/-8` 改动中包含移除该 `height={termRows}`),改用渲染时的 `displayStreamingText` 裁切来约束活区高度。

**所以严格说,HEAD 此刻是回归状态。** 工作区(未提交)是修复。

---

## 5. 动态区 `flexGrow={1}` spacer — 已删除(本就无效)

工作区从 app.tsx 删除:

```tsx
{/* Spacer: pushes ground zone (GlanceBar + InputBar) to terminal bottom */}
<Box flexGrow={1} minHeight={0} />
```

`b1374be` 注释已明确说这个 spacer "harmlessly collapses to 0 here"(Fragment 根无 `height` 约束时 `flexGrow` 没有有界空间可填)。

**这是清理死代码,不是损失。**

---

## 工作区自知的"3 次失败尝试"注释

工作区的 `src/tui/app.tsx:1371-1379` 留了一段自我审计的注释,直接点名三次失败:

```ts
return (
  // Natural-scroll layout: <Static> writes committed history to real terminal
  // scrollback, and the live frame renders BELOW it at its natural height. Do
  // NOT wrap in <Box height={termRows}> — that makes the live frame full-screen
  // every render, which visually buries all <Static> history above the viewport
  // ("丢回复": replies committed but never visible). The flexGrow spacer below
  // harmlessly collapses to 0 here; the input sits right under the latest output
  // (Claude-Code-style), which is the intended "pinned" feel without full-screen.
  // Static content off-screen — proven via 3 failed attempts (e08f644, ccd4ae9,
  // termRows-1). Ink fullscreen mode is prevented by the render-time live cap
  // (displayStreamingText) keeping the content well under terminal height.
  <>
```

**这是当前最权威的"不要再走 height 锚定老路"的警示。** `termRows-1` 是 `ccd4ae9` 的同源变体(用 `termRows-1` 替代 `termRows`),未单独成 commit。

---

## 当前实际生效的"防滚屏"机制 — 渲染时活区裁切

`src/tui/app.tsx:1363-1366`:

```ts
const liveThinkRows = streamingThinking ? Math.min(10, streamingThinking.split('\n').length) + 3 : 0
const liveToolRows = liveTools.reduce((s, t) => s + Math.min(12, (t.content ? t.content.split('\n').length : 1) + 2), 0)
const liveCapRows = Math.max(2, termRows - liveGroundRows - liveThinkRows - liveToolRows - 2)
const displayStreamingText = streamingText ? capLiveTail(streamingText, liveCols, liveCapRows) : streamingText
```

`live-tail-cap.ts` 的 `capLiveTail` 是**当前唯一**的活区高度约束机制 — 不用布局约束,改在渲染时按 chrome(thinking/tools/ground zone)剩余行数裁切 live tail。这条路径在所有 5 个 commit 中**未被动摇**,是稳态解。

---

## 判决(每项展开证据)

### 1. 增量提交 — **不需要恢复**

**替代机制已经在了** (`src/tui/app.tsx:1363-1366`):

```ts
const liveCapRows = Math.max(2, termRows - liveGroundRows - liveThinkRows - liveToolRows - 2)
const displayStreamingText = streamingText ? capLiveTail(streamingText, liveCols, liveCapRows) : streamingText
```

`capLiveTail` (`src/tui/live-tail-cap.ts`) 在**渲染时**按 chrome(thinking/tools/ground zone)剩余行数裁切 live tail,把活区钉在终端高度内。turn-end 时 `streamingText` 的完整内容一次 commit 到 scrollback。

**用户视角对比:**

| 模式 | 流式时屏幕 | turn 结束 | 信息丢失? |
|------|----------|-----------|----------|
| 增量(删除前) | 旧块持续滚出,屏幕始终是"最新几行" | 整段在 scrollback,屏幕尾仍是最新几行 | 无 |
| turn-end(当前) | 旧块被 `capLiveTail` 裁掉,屏幕始终是"最新几行" | 整段在 scrollback,屏幕尾仍是最新几行 | 无 |

两种模式下用户**看到的画面**等价;增量多出的复杂度(`blockWriterRef` 调度、dual-path `onTurnComplete`、`incrementalCommit` 死状态、glm 例外 race)在 turn-end 模型里全部消失。

**可能的反对意见(都站不住):**
- "流式时看不到开头" → `capLiveTail` 也看不到,因为活区被裁到尾部。要看开头,得等 turn 结束 — 两种模式一样。
- "流式时滚屏更慢" → 滚屏是 `capLiveTail` 解决的,跟 commit 策略无关。
- "glm 例外需要" → 删了 #1 后例外也无所谓,只剩一条路径。

### 2. 尾部保留 — **不需要恢复**

661c682 解决的是 #1 的次生问题:增量模式下,turn-end 提交后活区空白,显"vanish"。**删了 #1,vanish 现象也不存在** — turn-end 时活区本来就是满的(显示 `displayStreamingText`),提交到 scrollback 后活区再清空,过渡平滑。

### 3 & 4. 布局高度约束 — **不需要恢复,且移除都正确**

两者结构等价:在含活区的 Box 上加 `height={termRows}` → 活区变全屏 → Static 历史被推到视口上方。

工作区注释 (`src/tui/app.tsx:1373-1375`) 已自我总结:

> Static content off-screen — proven via 3 failed attempts (e08f644, ccd4ae9, termRows-1). Ink fullscreen mode is prevented by the render-time live cap (`displayStreamingText`) keeping the content well under terminal height.

**正解不在布局,在裁切。** `capLiveTail` 是 render-time 钩子,不改变布局结构,不触碰 Static — 它让活区"自然低于终端高度",Ink 的 relative-cursor-up 抹除就不会撑爆视口,也就不会触发全屏重画。

### 5. flexGrow spacer — **不需要,本就是死代码**

b1374be 注释 (`src/tui/app.tsx:1376`) 已说:

> The flexGrow spacer below harmlessly collapses to 0 here

Fragment 根无 `height` 约束,`flexGrow` 在 flexbox 里要有"有界父容器"才能撑开;没有的话,spacer 是 0 高度。删除 = 清理,不是损失。

---

## 恢复路径(若未来决定恢复 #1) — **不推荐**

读代码可见,恢复路径**最小化**应是:

1. 在 `onThinkingDelta` / `onFinalDelta` 等流式回调里恢复 `blockWriterRef.current?.flush()` + `textBatcher.current.flushNow()`(原 afa220c 删除的 `if (incrementalCommit)` 分支)。
2. 在 `onTurnComplete` 恢复 661c682 的 tail 保留逻辑。
3. 把 `incrementalCommit` 的 `else` 注释改成 `if/else` 都描述,或删 `incrementalCommit` 改用单一路径。
4. **不要恢复 e08f644 / ccd4ae9 的布局高度约束** — 已被工作区注释点名 3 次失败。

**为什么不推荐:**
- 屏幕观感与 turn-end + `capLiveTail` 等价
- 多出 dual-path 复杂度、双 `textBatcher`/`blockWriter` 调度、glm race
- `incrementalCommit` 死状态已经被实际保留下来,留着不管会越积越乱

如果要恢复,**先删掉 `incrementalCommit` 死状态**(app.tsx:211, 214, 215 和 410、1335 的依赖项),再决定走哪条路 — 不要在死状态上盖新逻辑。

---

## 附:调试插桩(非损失)

`src/main.tsx` 新增 `RIVET_DEBUG_FULLSCREEN=1` 模式:hook `process.stdout.write`,凡是写入包含 `\x1B[2J`(Ink 全屏清屏)的字符串,就在 stderr 写一行 `[fullscreen-clear] #N rows=R cols=C`。这是给真终端排查"活区超终端高度"用的诊断探针,**不参与产品行为**。

**用法:** `RIVET_DEBUG_FULLSCREEN=1 node dist/main.js 2>layout.log`

**判定:** `layout.log` 里出现 `[fullscreen-clear]` 就说明在某次渲染时活区撑爆了终端高度,Ink 触发了全屏重画 — 这是真凶② (滚屏/擦不干净) 的硬证据。

---

## 附:文件位置速查

```
src/tui/app.tsx                    — 主渲染树(1529 行)
src/tui/committed-log.ts           — append-only log + 引用缓存(真凶① 修复)
src/tui/stream-window.ts           — appendStreamWindow(文本块窗口)
src/tui/live-tail-cap.ts           — capLiveTail(防滚屏的渲染时裁切)
src/main.tsx                       — RIVET_DEBUG_FULLSCREEN 插桩
```

## 附:相关 commit

```
e08f644  fix(tui): anchor root layout to terminal height to pin ground zone
b1374be  fix(tui): revert root Box height — restore natural-scroll layout
661c682  fix(tui): keep reply tail visible after stream ends in incremental mode
afa220c  fix(tui): disable incremental streaming commit — revert to turn-end commit for all providers
ccd4ae9  fix(tui): pin live Box to terminal height so spacer pushes input bar to bottom
```

— 观象
