# 交接文档:TUI steer 丢消息 + 重复渲染/滚屏 修复

**日期:** 2026-06-05
**分支:** `fix/stall-root-causes-abort-exit`
**交接原因:** harness 安全分类器持续故障,本会话**无法运行 `npm run typecheck` / `npm test`**(Bash 被全程阻断)。代码改动已完成,但**验证门未跑通**,需接手会话验证后提交。

---

## TL;DR 给接手会话

> **2026-06-06 状态更新：**
> - A/B/C: ✅ 已提交已验证
> - 真凶①: ✅ 已实现（committed-log snapshot 模式，见 `2026-06-06-committed-log-reference-fix.md`）
> - 真凶②: ✅ 已实现（render-time dynamic cap，非 tail window 也非 height 钉底，见工作区 app.tsx diff）
> - 剩余：`incrementalCommit` 死变量待清理，`incrementalRendering` 选项待重新开启

1. **A/B/C 已提交**(主提交 `97aaacb`),`typecheck` 用户口头确认通过,但**测试未跑**。
2. **真凶②(滚屏):未实现。** 本会话曾实现 tail window 又**全部撤销**(与用户既定偏好冲突)。§二 给了**方案 A(布局正解,推荐)+ 方案 B(tail window,含可直接套用的代码)**,由你拍板+验证。
3. **真凶①(重复渲染):只做了设计,未动代码** —— 推荐**方案 A**,附代码草图 + 回归清单,等你实现+验证。

**第一件事:跑验证。**
```bash
npm run typecheck
npx tsx --test src/tui/__tests__/stream-window.test.ts src/tui/__tests__/stream.test.tsx \
  src/tui/__tests__/esc-abort-steer-preserve.test.ts src/tui/__tests__/steer-buffer-on-error.test.ts \
  src/tui/__tests__/steer-buffer.test.ts
npm run test:fast   # 确认没碰坏 agent 侧
```
(注:真凶② 已撤销,`stream*.ts(x)` 应与 HEAD 一致;上面测试主要验 A/B/C 与既有契约。)

---

## 一、已完成且已提交:A/B/C(steer 丢消息)

源诊断见 `docs/plan` 的 cognitive gap analysis 与本轮分析。三个确认的 bug:

### A — 打断/出错时引导消息被静默丢弃
**根因:** `addAnchor` 是**死路**——它只更新显示层(`userAnchors → setContextLedger`,喂给 slash-commands/cockpit),`buildProactiveContext`(唯一锚点→prompt 注入器)**零生产调用**,`volatile.ts:134` 在 prompt 路径把 `contextLedger` 设为 `undefined`。唯一生效的 steer→model 通路是 `onSteerDrain`(`app.tsx`)→ `tool-execution.ts` 追加到最后一个 `tool_result`。
**修复:** 让 `drain()` 只在唯一真实注入点发生,其它路径一律改 `getPending()`(非破坏 peek):
- `src/tui/hooks/use-global-input.ts` — Ctrl+C、ESC×2 改 `getPending`
- `src/tui/app.tsx` — `onError`/`onAbort`/`onTurnComplete` 改 `getPending`,移除 inert `addAnchor`
- `src/agent/tool-execution.ts` — drain **仅当存在 tool_result 注入目标时**才执行(堵 mid-batch abort 泄漏)

### B — 打断窗口内新消息被静默丢弃
**根因:** `handleSubmit` 里 `setIsStreaming(true)`/回显/`agent.run` 都在内层 `run()` 闭包,而队列守卫 `if (promptQueueRef.current.running) return` 在 `run()` **之外**。打断后 `isStreamingRef` 同步置 false、但 `running` 仍 true(工具卡死时 SIGKILL 等 ~2s),窗口内新消息走到守卫被裸 `return` 丢弃。
**修复(`app.tsx`):** 守卫改为**延迟提交**——入队 `pendingSubmitsRef` + 提示,`run().finally` 排空队列、`queueMicrotask` 重放为新回合。新增 `pendingSubmitsRef`、`handleSubmitRef`。

### C — initialInput 在 StrictMode 下双触发会被重放成重复请求
**根因:** B 把「丢弃」改「重放」后,原本靠丢弃去重的 `initialInput` effect 双触发(StrictMode)会变重复发送。
**修复(`app.tsx`):** `initSubmittedRef` 一次性 guard。注:生产入口无 StrictMode(`main.tsx:1018`),故当前配置下 C 不实际触发,此为防御 + 保护 B。

### 测试(已重写,随 A 提交)
- `src/tui/__tests__/esc-abort-steer-preserve.test.ts` — 改测「preserve via peek」新契约
- `src/tui/__tests__/steer-buffer-on-error.test.ts` — 同上

### Commit 归属(reflog)
- `97aaacb fix(tui): preserve queued steer guidance on interrupt + defer interrupt-window submits` ← A(app.tsx/use-global-input + 测试)+ B + C
- `c39f4b0 fix(agent,exit): propagate abortSignal to tools ...` ← 含 A 的 tool-execution.ts drain 守卫
- 之后叠了 docs/spec 提交,当前 HEAD `77805a1`。
- **注意:** 这些提交由**外部进程**(用户另一会话/工具)在本会话编辑期间代为完成。本会话从未成功运行 git。

**A/B/C 状态:已提交、typecheck 口头确认过、测试未跑。** 接手会话请补跑上面 5 个 steer/TUI 测试坐实。

---

## 二、真凶②(流式滚屏)— 方向有冲突,**未实现**,两个方案都在此待决策

源诊断:`docs/known-issues/tui-duplicate-render-and-scroll.md`(真凶②)。
**现象:** 长回复流式时终端持续滚屏/擦不干净。
**底层机制:** Ink `logUpdate` 只能擦它上次渲染的行数;live(非 Static)区高过终端就擦不净 → 每个 delta 重打整棵子树 → 滚屏。

> **⚠️ 本会话曾实现「加回 tail window」方案(capLiveLines + useViewportLines),但已全部撤销** —— 因为它与记忆 `dynamic-budget-was-a-layout-workaround` 冲突:用户**之前强烈反对**用「行预算 / per-row budgeting」控制 live 区,明确「Claude Code 用 plain Ink 无此系统,budget 是错误布局的症状」。本会话向用户确认,用户选择「两个方案都写进交接文档,不在本会话留违背偏好的代码」。**当前 stream.tsx / stream-window.ts 已恢复原状**(仅 stream.tsx 注释从「说谎注释」改成指向布局正解的 NOTE)。

### 已验证的真根因(本会话读码确认)
当前渲染树(`app.tsx` return,~1331)**不符合**记忆里的钉底布局正解:
```
<>                                   ← Fragment 根:无 height={termRows}
  <Static>…</Static>                 ← 直接子级 ✓
  <Box flexDirection="column">       ← 动态区:无 height、无 flexGrow justifyContent 包裹
    …StreamOutput…
    <Box flexGrow={1} minHeight={0}/> ← spacer 想钉底(~1382),但根无 height 约束 → flexGrow 无界 → 撑不起作用
    …GlanceBar / InputBar…
  </Box>
</>
```
`flexGrow={1}` spacer 因为根没有 `height={termRows}` 而**没有有界空间可填** → 动态区随内容无限增长 → StreamOutput 超终端高度 → 滚屏。**真凶②的真根因是缺钉底布局,不是「tail window 被删」**(known-issues 文档归因不完整)。

### 方案 A(**推荐** — 记忆 `dynamic-budget-was-a-layout-workaround` 的正解,已对照 Ink 6 源码验证)
用布局约束 live 区高度,**不引入任何行预算**:
1. 根 Fragment `<>` → `<Box height={termRows} flexDirection="column">`(`termRows` 已有:`useTerminalSize().rows`,app.tsx:197)。
2. `<Static>` 保持为该 Box 的**直接子级** —— Ink 6 中 Static 用 `position:absolute`,**不参与 flex 布局**,所以 height 约束的根**不会**破坏它的 scrollback flush(已验证)。
3. 动态区(现 `<Box flexDirection="column">`)外面包一层 `<Box flexGrow={1} justifyContent="flex-end">` 钉到底部(或给动态区本身加这两个属性),移除现在那个无效的 `<Box flexGrow={1} minHeight={0}/>` spacer。
4. StreamOutput **不需要** tail window —— Ink flexbox 自动把动态区约束在 `termRows` 内,溢出部分天然走 `<Static>` scrollback。
**风险:** 改根布局影响整个渲染树,且滚屏类 bug **单测无法覆盖**,必须**手动**在真终端验证(长回复流式不滚屏 + 输入区稳定钉底 + Static 历史正常滚动)。务必对照记忆原文 + Claude Code 的 Ink 用法。

### 方案 B(备选 — known-issues 文档建议的 tail window,本会话已实现又撤销)
在 `StreamOutput` 用 `useViewportLines(0.6, 8)`(与 `tool-card.tsx` 同款)+ 纯函数 `capLiveLines(text, maxLines)` 截断 live 区到最后 N 行 + 省略行标记。零新增 `pushStatic`(不碰真凶①)。
**本会话已写好可直接复原的实现**(git 历史里本会话的 stream.tsx/stream-window.ts/stream-window.test.ts 编辑,或见下「方案 B 代码」)。
**为何不推荐:** 本质是 per-row budgeting,违背用户在记忆 `dynamic-budget-was-a-layout-workaround` 里确立的方向(「don't reintroduce per-row budgeting; fix layout with flexGrow/height instead」)。仅当方案 A 的布局重构被证明不可行 / 风险过高时才退回此方案。

### 方案 B 代码(若决定采用,可直接套用)
```ts
// stream-window.ts 追加:
export interface CappedLiveText { displayText: string; omittedLines: number }
export function capLiveLines(text: string, maxLines: number): CappedLiveText {
  if (maxLines <= 0) return { displayText: text, omittedLines: 0 }
  const lines = text.split('\n')
  if (lines.length <= maxLines) return { displayText: text, omittedLines: 0 }
  return { displayText: lines.slice(-maxLines).join('\n'), omittedLines: lines.length - maxLines }
}
```
```tsx
// stream.tsx：import { useViewportLines } from './viewport.js'; import { capLiveLines } from './stream-window.js'
// 组件内、任何 early return 之前：const maxLines = useViewportLines(0.6, 8)
// 渲染前：const { displayText, omittedLines } = isStreaming ? capLiveLines(text, maxLines) : { displayText: text, omittedLines: 0 }
// <Markdown text={displayText}/> 之上加 {omittedLines > 0 && <Text color={theme.muted}>(… {omittedLines} earlier lines)</Text>}
// 注意保持 S7 源码契约(见 stream.test.tsx)：光标 ▊ 为 <Text> 兄弟、与 <Markdown> 共享 column 父级且在 5 行内。
```
单测(5 条 capLiveLines)本会话也写过,采用方案 B 时一并恢复。

### 决策记录
- 用户 2026-06-05 选择:**两个方案都进交接文档**,由接手会话(能跑测试时)拍板 A 还是 B。
- 本会话作者倾向:**A**(遵循用户既定方向;tail window 是用户明确反对过的症状级补丁)。

---

## 三、未动代码、只做设计:真凶①(消息重复渲染)

源诊断:`docs/known-issues/tui-duplicate-render-and-scroll.md`(真凶①)。
**推荐方案:A(见下),本会话因无法跑测试未实现。**

### 精确根因(比原文档更具体)
`historyItems = useMemo(() => buffer.items(), [historyVersion])`;
`staticItemsForInk = all.slice(start)`,`start = max(0, totalItemsPushedRef − all.length)`(`app.tsx:~220`)。

重复的本质 = **`staticItemsForInk` 数组前缀漂移**。Ink `<Static>`(`node_modules/ink/build/components/Static.js`)用**数组下标**记内部 `index`:`itemsToRender = items.slice(index)`,`useLayoutEffect(() => setIndex(items.length), [items.length])`。它**假设**传入数组「单调只增、前缀稳定」。当 `start` 在帧间变化,数组起点漂移,Ink 用旧 `index` 切新数组 → 错位重打已渲染项。

`start` 会漂移,是因为 **`totalItemsPushedRef` 与 buffer 步调不一**:
- `buffer.push` 永远**同步**(`pushStatic:307`、`pushStaticBatch:348`)
- 但 `ref++`:`pushStatic` **推迟到 microtask**(`:316`),`pushStaticBatch` **同步**(`:349`)

→ microtask 窗口内 `ref < buffer.length`,`start` 错位。
原作者注释(`:314-315`)想让 `ref++` 与 `setHistoryVersion`「原子」——**不变量选错了**。正确不变量是 **`ref` 与 buffer 锁步**(因为 buffer.push 永远同步)。
**实际触发点**(文档 118-121):`onTurnComplete` 终态在 `pushAssistantEntry`(走 `pushStaticBatch`)前只调 `textBatcher.flushNow()`,**没调 `flushStaticBatch()`**;若有迟到的 tool-result `pushStatic` microtask 还挂着,就撞上同步 `pushStaticBatch`。

### 方案 A(推荐,最小,低风险)
把 `pushStatic` 的 `ref++` 从 microtask 移出、与 `buffer.push` 同步;microtask 只留 `setHistoryVersion`。这样 `ref` 永远 == buffer 累计 push 数,`start` 在任何 `historyVersion` 重算帧都恒定正确(未回绕 `start=0`,回绕后 `start=` 被挤掉数)。

```ts
// pushStatic — ref++ 与 buffer.push 同步(锁步),microtask 只批 render
const pushStatic = useCallback((entry: LogEntry) => {
  const fp = `${entry.type}:${entry.content.slice(0, 120)}`
  if (staticDedupRef.current.has(fp)) return
  staticDedupRef.current.add(fp)
  if (staticDedupRef.current.size > 16) { /* rotate keep last 8 (不变) */ }
  historyBufferRef.current.push(entry)
  totalItemsPushedRef.current++            // ← 移到这里(原在 microtask)
  staticBatchRef.current.push(entry)
  if (!staticBatchScheduled.current) {
    staticBatchScheduled.current = true
    queueMicrotask(() => {
      staticBatchScheduled.current = false
      if (staticBatchRef.current.length > 0) {
        staticBatchRef.current = []
        setHistoryVersion(v => v + 1)      // ← 只批 render,不再碰 ref
      }
    })
  }
}, [])

// flushStaticBatch — 不再碰 ref(pushStatic 已同步加),只 flush render
const flushStaticBatch = useCallback(() => {
  if (staticBatchScheduled.current) {
    staticBatchScheduled.current = false
    if (staticBatchRef.current.length > 0) {
      staticBatchRef.current = []
      setHistoryVersion(v => v + 1)
    }
  }
}, [])

// pushStaticBatch — 本就同步 ref++(:349),锁步,保持不变
```

**为什么对:** `staticItemsForInk` 与 `historyItems` 都(间接)依赖 `historyVersion`,同时更新。在 `historyVersion` 变的那一刻:`historyItems = buffer.items()`(最新全部),`ref =` 所有同步 push 累计。未回绕 `ref == length → start=0`;回绕 `start = ref−5000`。中间帧 `historyVersion` 未变则不重算,无影响。直接消除「迟到 tool-result microtask 撞同步 pushStaticBatch」触发点。

**建议附带:** `onTurnComplete` 终态翻 `isStreaming` 前补一次 `flushStaticBatch()`(双保险,即便方案 A 已从根上消除竞态)。

### 方案 B(文档建议,大重构,本次不推荐)
废掉 `ref − length` 相减模型,维护一个**真正单调追加的 archive 数组**喂 `<Static>`,ring buffer 仅用于 pager/内存上限。更彻底但影响面大、改动多。**A 已能从根上修复,优先 A。**

### 真凶① 回归清单(实现后必须验证)
- [ ] `npm run typecheck` && `npm test` 全绿
- [ ] 长会话累积 >5000 条触发 ring buffer 回绕后,新消息不重复、不丢失
- [ ] rewind 后继续对话,Static 不重打旧消息(注意 rewind 会重置 `totalItemsPushedRef`,搜 `totalItemsPushedRef` 写入点 + reflog `c460852`)
- [ ] 多 turn(`isFinal=false`)中途归档,无重复 assistant_message
- [ ] 迟到 tool-result 与 turn-end 同帧,无重复(原触发点)
- [ ] dedup 指纹(`staticDedupRef`)是创可贴:120 字符前缀相同会误撞、轮换到 8 条后旧指纹老化漏回。方案 A 修好索引模型后,**评估能否移除或放宽 dedup**(它本是为掩盖索引 bug 加的,可能造成真消息丢失)。

---

## 四、本会话环境问题(给接手会话提个醒)
- harness 安全分类器(auto sandbox)持续/间歇故障,**全程阻断 Bash**,连 `dangerouslyDisableSandbox: true` 也绕不过(那只关沙箱不关分类器)。`typecheck`/`test`/`git` 全跑不了。
- 期间**外部进程**在工作区切分支(`fix/stall-root-causes-abort-exit`)并提交了 A/B/C,导致本会话编辑中途文件出现「回退」假象。接手前先 `git status` + `git log --oneline -8` 确认真实状态。
- `git status` 当前应显示真凶②的 3 个文件为 modified(未提交);若为 clean,说明又被外部提交了,查 reflog。

## 五、提交建议(各自验证绿后)
真凶② 实现后(方案 A 或 B)单独成一个 commit。若走**方案 A(布局)**:
```
fix(tui): pin dynamic zone to bottom to stop runaway scroll (真凶②)

Root cause was a missing bottom-pin layout, not the removed tail window:
the root was a Fragment with no height, so the dynamic zone's flexGrow
spacer had no bounded space and the live region grew past the terminal,
which Ink's logUpdate can't erase → repaint-on-every-delta scroll.
Fix per memory `dynamic-budget-was-a-layout-workaround`: root
height={termRows} + dynamic zone flexGrow justifyContent="flex-end" +
<Static> as absolute direct child. No per-row budget (plain Ink, like
Claude Code). Manually verified: long streaming reply no longer scrolls.
```
真凶① 实现后单独成 commit,务必带回归测试。

