# TUI: 消息重复渲染 + 流式不停滚屏

**状态:** 🔴 待修复(已定位根因,未动代码)
**记录日期:** 2026-06-05
**证据类型:** baseline(静态读码 + git 谱系 + 既有文档),用户已 live 见过现象,未跑 runtime trace 复现
**涉及文件:** `src/tui/app.tsx`、`src/tui/stream.tsx`、`src/tui/render-entry.tsx`、`src/tui/log-state.ts`

> **注意:** 本文行号基于 2026-06-05 记录时的 `app.tsx`(当时该文件在工作区有未提交改动)。
> 待在飞的改动落地后,行号可能漂移,以符号名/注释定位为准。

---

## 症状(用户原话)

> 「会话内的流式对话,agent 回复/用户回复,历史消息展示和滚动……
>   有没有可能消息重复渲染、不停的滚屏」

用户确认 **live 见过**。经诊断,这是**两个独立真凶**,分别对应两个症状,共享一条架构根因。

---

## UI 渲染结构(背景)

`app.tsx` 的 return(约 `:1295`)自上而下三段:

1. `WelcomeScreen` — 仅当无历史且非流式。
2. `<Static items={staticItemsForInk}>`(`:1300`)— 已归档历史,print-and-forget 到终端原生 scrollback,靠 Ink 内部 `index` 只渲染增量。user/assistant/thinking/tool/system 最终都落这里(见 `render-entry.tsx` 的 `RENDER_MAP`)。
3. 活动区 `<Box flexDirection="column">`(`:1306`)— overlays、`liveTools`、`ThinkingCollapser`、`StreamOutput`(实时流式正文 `:1337`)、heartbeat,底部 `<Box flexGrow={1} minHeight={0} />`(`:1346`)把 GlanceBar+InputBar 顶到终端底边。

**流式 → 归档 数据流:**
```
onTextDelta → BlockStreamWriter.push → textBatcher(microtask)
            → streamBuf(全量) / streamLiveBuf(窗口) → setStreamingText → StreamOutput 实时渲染
onTurnComplete(isFinal) → flush → 捕获 finalText → 清 live → setIsStreaming(false)
            → pushAssistantEntry → pushStaticBatch → ring buffer + totalItemsPushedRef++
            → setHistoryVersion → staticItemsForInk 重算 → <Static> 打印增量
```

---

## 真凶 ②:不停滚屏(streaming 长回复时)— 当前 HEAD 活着

### 现象
长回复流式输出时,终端持续往下滚 / 闪烁,擦除不干净。

### 根因
`stream.tsx:12-18` 的注释与实现不符(**说谎注释**):
> "The app layer progressively flushes older content to `<Static>`, so `text` here is always bounded (~80 lines max). No tail window needed."

该 progressive flush 机制**已被删除**。git 谱系显示一次反复横跳:

| commit | 动作 |
|---|---|
| `2d87543` | 加 progressive flush(`STREAM_LIVE_MAX_LINES=80`,流式中途 `pushStatic`) |
| `d0eab16` | 恢复 tail window 防卡死 |
| `07b9990` | **"restore full render, drop tail window"** — 删 `dynamic-budget.ts`(62行)+测试(102行),移除高度封顶 |

当前真实链路(`app.tsx:418-422`):
```ts
streamLiveBuf.current = appendStreamWindow(streamLiveBuf.current, combined, LIVE_STREAM_MAX_CHARS)
setStreamingText(streamLiveBuf.current)
```
- `LIVE_STREAM_MAX_CHARS = 50_000`(`app.tsx:103`)≈ **500-600 行**,不是注释说的 80 行。
- 动态区 `<Box flexDirection="column">`(`:1306`)**无任何 height / maxHeight / overflow 封顶**,仅靠底部 `flexGrow={1}` spacer。

### 后果
长回复流式时,StreamOutput+Markdown 子树长到几百行 → **超过终端高度**。
Ink `logUpdate` 只能按 `lastOutputHeight` 擦除可见行,内容高过终端就擦不干净 →
**每个 block flush(每 ~100-200 字符一次)重打整棵动态子树 → 终端持续往下滚**。
这正是 `6cc6105 fix(tui): prevent Ink flicker when dynamic zone exceeds terminal height`
当年打的仗,被 `07b9990` 拆掉护栏后回归。

### 修复方向(倾向重构,非加 guard)
- 恢复「实时区高度封顶 / 行级 progressive flush」(把超出窗口的旧行 flush 进 Static)。
- 修正 `stream.tsx:12-18` 的说谎注释,使其描述真实行为。
- 改动小、可独立验证 —— **建议先修这条**(用户主诉)。

---

## 真凶 ①:消息重复渲染(Static 区)

### 现象
同一条 assistant / tool 消息在 scrollback 里被打印两遍。

### 根因:双计数器索引模型的竞态
`staticItemsForInk = historyItems.slice(start)`,
`start = max(0, totalItemsPushedRef − historyItems.length)`(`app.tsx:211-223`)。

这是一套**双计数器**对齐 Ink `<Static>` 内部 `index` 的手搓模型。Ink Static 语义
(`node_modules/ink/build/components/Static.js`)是 `itemsToRender = items.slice(index)`,
`useLayoutEffect(() => setIndex(items.length), [items.length])` —— **只在 `items.length`
变化时推进 index**,且假设传入数组「单调只增、前缀稳定」。

两条推入路径更新 `totalItemsPushedRef` 的**时机不同**:

| 路径 | ring buffer 写入 | ref++ / setHistoryVersion |
|---|---|---|
| `pushStatic`(`:297`) | 立即 | **推迟到 microtask** |
| `pushStaticBatch`(`:342`) | 同步 | **同步** |

**竞态窗口:**
```
pushStatic(X) 跑完   → buffer 有 X,ref 未 +,microtask 挂着
pushStaticBatch([Y]) → buffer 有 Y,ref 只 +1,同步触发 render
此刻 historyItems.length 涨 2,ref 只涨 1
  → start 偏小 → slice(start) 含已打印项 → Ink 重打 → 重复 + 滚动
```

代码注释 `app.tsx:217-219` 自己承认 "transient",但**只防了 ref 超前一侧
(`if (start >= all.length) return []`),没防 ref 滞后一侧** —— 恰恰是重复的来源。

### 创可贴的局限
`b3f9532` 的 dedup 指纹(`type + content.slice(0,120)`,16→8 轮换,`:292-306`)只防
「相同内容进 buffer 两次」,防不了「索引错位重切已渲染项」。且指纹有损:
- 120 字符前缀相同的两条会**误撞丢弃**(真消息丢失)。
- 轮换到 8 条后,旧指纹老化 → 真重复**漏回来**。

### 实际触发点
`onTurnComplete` 终态路径在 `pushAssistantEntry`(走 `pushStaticBatch`)前,只调了
`textBatcher.flushNow()`,**没有调 `flushStaticBatch()`**(`app.tsx:1018-1055`)。
若有迟到的 tool-result `pushStatic` microtask 还挂着,就撞上同步的 `pushStaticBatch`。

### 修复方向(倾向重构契约,非加 guard)
- 废掉 `totalItemsPushedRef − length` 相减模型,改为给 `<Static>` 喂**单调只增、前缀稳定**
  的数组(例如维护一个真正单调追加的 archive 数组,ring buffer 仅用于 pager/内存上限)。
- 或统一 `pushStatic` / `pushStaticBatch` 为**同一异步步调**(都同步,或都 microtask 批),
  并在终态翻 `isStreaming` 前强制 `flushStaticBatch()`,从根上消除索引错位。

---

## 根因汇总(L2 链路结构)

两个真凶共享一条根:**`07b9990` 拆掉高度护栏后,实时区无界增长 + Static 索引靠两个
异步步调的计数器相减对齐**。

历史上 ≥6 个补丁都在**糊单点症状,没动模型本身**:
`b723930`(批量化 ref)、`c460852`(rewind 重置 ref)、`b3f9532`(dedup 指纹)、
tail-window / progressive-flush 反复加删(`2d87543`/`d0eab16`/`07b9990`)、
`3bce2f2`(恢复 streaming 重置)。

这是「只修最近症状、不定位责任链路」的陷阱。建议下一轮直接重构两个契约
(实时区高度封顶 + Static 单调数组),而非加第 N 个 guard。

---

## 修复优先级建议

1. **先修 ②**(不停滚屏)— 用户主诉,改动小,可独立验证。
2. **再修 ①**(重复渲染)— 索引模型重构,影响面大,需回归测试覆盖
   长会话(>5000 条触发 ring buffer 回绕)、rewind、多 turn(`isFinal=false`)、
   迟到 tool-result 撞 `pushStaticBatch` 等边界。

---

## 验证清单(修复后)

```bash
npm run typecheck
npm test
```

手动复现/验证:
- [ ] 让 agent 输出一条 >终端高度的长回复,流式过程中终端不持续滚屏(验 ②)
- [ ] 长会话累积 >5000 条目触发 ring buffer 回绕后,新消息不重复、不丢失(验 ①)
- [ ] rewind 后继续对话,Static 不重打旧消息(验 ①)
- [ ] 多 turn(isFinal=false)中途归档,无重复 assistant_message(验 ①)
- [ ] 迟到 tool-result 与 turn-end 同帧,无重复(验 ① 触发点)

---

## 相关文档 / commit

- `docs/known-issues/tui-message-flash.md` — 同源的流式结束闪烁(已修)
- `docs/superpowers/plans/2026-06-01-static-sliding-window-bug.md` — 同一索引模型的另一面(消息静默丢失,已修)
- `docs/superpowers/plans/2026-06-04-tui-static-sync-and-context-pressure.md` — Static 同步计划
- 关键 commit:`07b9990`(拆护栏)、`2d87543`(progressive flush)、`b3f9532`(dedup)、
  `b723930`(批量 ref)、`6cc6105`(动态区超高闪烁)

---

## 附:症状映射 —— "流式回复乱码/吞字/粘连" 就是真凶②(2026-06-06 诊断)

**用户报告:** 长回复"有时候像是被截断和乱码",示例里出现 `Node167起`(应 `Node 16.7 起`)、
`prearm-file`(应 `prewarm-file`)、`任务 1 →/345独立`(空格/顿号丢失)、表格 `|---|` 语法漏进散文、
末尾混入 thinking 碎片(`我现在还是？`)。

**结论:这不是新 bug,是真凶②(动态区超终端高度,Ink 擦不净)的视觉表现。** 别去查解码/拼接/markdown 解析。

**排除链(逐层证明数据无损,故乱码只能是终端重绘伪影):**
| 层 | 文件 | 判定 |
|---|---|---|
| SSE 解码 | `api/*-client.ts` | `decoder.decode(value,{stream:true})` 正确处理 UTF-8 跨 chunk ✓ 无损 |
| reasoning/content 分流 | `openai-client.ts:414-419` | reasoning_content 与 content 各自缓冲,promotion 仅 GLM 且有守卫 ✓ 不交叉 |
| RenderBatcher | `tui/render-batch.ts` | FIFO 队列 + `join('')`,microtask 整批 drain ✓ 无损、保序 |
| BlockStreamWriter | `tui/block-stream-writer.ts` | `slice(0,pos)`+`slice(pos)` 干净切分,块拼回==原文 ✓ 无损 |
| 内联 markdown 解析 | `tui/markdown-render.tsx:33` | 未闭合 delimiter 走 fall-through 当字面量,不 slice-drop;**28/28 测试通过** ✓ 无损 |

**真因复用本文档真凶②:** `StreamOutput`(`stream.tsx:15` 注释明示 live 区高度*未*封顶)+ 动态区
仅 `flexGrow={1}` spacer 无 `height/maxHeight/overflow`(`app.tsx:1383`)→ 长回复子树超 `termRows` →
Ink `logUpdate` 只擦 `lastOutputHeight` 可见行 → 旧帧擦不净、新旧帧重叠 → 屏幕呈现吞字/粘连/错位。

**为何"有时候":** 仅当 live 回复溢出终端可视高度时触发(长 plan 评估这类高 markdown 正中)。短回复正常。
**重要:** scrollback/历史里的底层消息**是完整的**,只有 live 流式画面被破坏 —— 即归档内容无损,纯显示问题。

**修复路径:** 见本文档"真凶②"节 + `HANDOFF-2026-06-05-steer-and-render-fixes.md`(方案 A 布局钉底 / 方案 B tail window)。
2026-06-06 与用户确认:**先只诊断,暂不改代码**(方案选择待定,B 与既定偏好有冲突)。
