> **Status: COMPLETED** — 2026-06-19

# mid-tui 阶段 — `engine/app.ts` 分解 + Ink 双栈退役

> 两条并行主线：**Part A** 冻结并逐步退役已废弃的 Ink 双栈（`app.tsx` + `main-ink.tsx`），消除「双栈并存」债务；**Part B** 把 T9 ANSI 唯一生产路径 `TuiApp`（`src/tui/engine/app.ts`，约 2006 行、近乎 0 直连编排测试）按职责抽成 6 个 controller。**纯结构重构 + 死栈退役，零行为变更。**
>
> ⚠ **B 必须先建统一 TTY harness（W-B0）再拆**——当前 18 个集成测试各自复制 `MockOut/MockIn`，没有共享 fixture，盲拆会让安全网形同虚设。

## 0. 三条硬缰绳（全程不可破）

① 动态附录在用户消息内冻结，中途注入走 system-reminder；② 不每轮重写 `frozenBase`/`volatileBlock`；③ 不在 anchor 前重排消息。
本阶段虽是 UI 层，但 `TuiApp` 的 `commitAbove`/`CommitEngine.write` 与 scrollback 提交契约直接影响渲染一致性——**任何 controller 抽取都不得改变 commit 时序与 `renderLive` 的绘制顺序**。

## 1. 现状（权威证据）

**双栈事实**：
- T9 ANSI 是**唯一生产入口**：`tsup.config.ts:59-60` 只编 `src/main.ts`；`package.json` `bin.rivet → dist/main.js`、无 `main` 字段；`src/main.ts:1-5` 注释「纯 ANSI，零 React/Ink」，`new TuiApp(...)`(227-236)。
- Ink 栈已死：`src/main-ink.tsx:1-4` 标注 `@deprecated`「不再构建或接收新功能」，仅它 import Ink `App`(`src/tui/app.tsx`)；`src/main.tsx` 已从仓库移除；**无运行时 flag 回退 Ink**（全 `src/` 无 `RIVET_TUI=ansi` 之类分支，相关文档已过时）。
- 结论：**Ink 可安全冻结 → 退役**；桌面端走 `rivet serve` HTTP API（`main.ts:98-102`），不依赖 Ink。

**TuiApp 接线 seam（生产）**：`main.ts:227-473`（`registerOverlays` / `SlashRouter` / `setMetricsProvider` / `onSubmit → agent.run(wrapCallbacksWithTuiApp(app))`）；桥接 `src/tui/engine/bridge.ts`；slash `src/tui/engine/slash-router.ts`。

**安全网现状**：`engine/__tests__/app-core.test.ts` **仅** 2 个纯助手（`formatElapsedShort`/`truncateToWidth`，mid-tui 前置网已落地，并自述「全类需 TTY harness」）；另有 18 个直测 `TuiApp` 的 Mock TTY 集成测试（见 §6），但 harness 复制粘贴；已知存在与 scrollback/commit/user-bubble 相关的 TTY-harness 脆弱失败（属预存失败集，重构须对照零新增）。

> 行号为抽取锚点，执行时以 `grep`/`semantic_search` 重新定位为准。

```mermaid
flowchart TD
  subgraph prod [生产 T9 ANSI]
    MAIN["main.ts"] --> APP["TuiApp engine/app.ts 2006 行"]
    APP --> ENG["CommitEngine / LiveEngine / OverlayEngine / InputHandler / ResizeHandler / InputLine"]
  end
  subgraph dead [已废弃 Ink]
    INK["main-ink.tsx @deprecated"] --> APPTSX["app.tsx (不进构建)"]
  end
  APP -.W-B1..B6 抽取.-> CTRL["ToolGroup / Overlay / StreamRender / ApprovalIntent / Input / Metrics Controllers"]
```

## 2. 改动总览

| 文件 | 改动 | 波次 |
|------|------|------|
| `src/tui/app.tsx` / `src/main-ink.tsx` | 冻结标注；README / `bootstrap.ts` 注释 / `constellation/store.ts` 入口探测同步 | W-A1 |
| `src/main-ink.tsx` + Ink-only 组件 | 删入口 → 渐删 `committed-log`/`render-batch`/`.tsx` 视图 → 评估移除 `ink`/`react` 依赖 | W-A2 |
| `src/tui/engine/__tests__/_harness.ts` | **新建**：统一 `MockOut`/`MockIn` fixture | W-B0 |
| `src/tui/engine/tool-group-controller.ts` | **新建** | W-B1 |
| `src/tui/engine/overlay-controller.ts` | **新建** | W-B2 |
| `src/tui/engine/stream-render-controller.ts` | **新建** | W-B3 |
| `src/tui/engine/approval-intent-controller.ts` | **新建** | W-B4 |
| `src/tui/engine/input-submit-controller.ts` | **新建** | W-B5 |
| `src/tui/engine/metrics-glance-controller.ts` | **新建** | W-B6 |
| `src/tui/engine/app.ts` | 各波改委托；终态为薄 facade + 字段持有 | 各波 |

## 3. Part A — Ink 双栈冻结 / 退役

### W-A1 — 冻结（低风险）
**任务契约**：`app.tsx` / `main-ink.tsx` 顶部统一「冻结：禁新功能，仅考古」标注（main-ink 已有 @deprecated，补 app.tsx）；同步消除注释债——README L3/L62 仍写 Ink 为主、`bootstrap.ts:2-10` 注释提 `main.tsx`/`main-ansi.ts`、`constellation/store.ts:58` 入口探测列表，全部更新为「T9 ANSI 唯一生产入口」。
**过门**：`tsc --noEmit` + 构建绿（不动运行时）；grep 确认无源码再依赖 Ink 路径（除 `main-ink.tsx`）。
**风险**：极低（纯标注 + 文档）。

### W-A2 — 退役（中风险，分步）
**任务契约**（逐步、每步独立提交、每步构建绿）：
1. 删 `src/main-ink.tsx`；
2. 逐个删 Ink-only 组件（`committed-log`、Ink `render-batch`/`RenderBatcher`、`.tsx` 视图组件、`surface/glance-bus`/`surface/router` 等仅 Ink 引用者）——**删前 grep 确认无生产引用**；
3. 评估移除 `ink`/`react` 依赖：**注意** `thinking.test.tsx` 等测试文件仍引用 React，需先迁移/退役这些测试或保留 React 仅作 devDependency。
**过门**：每步 `npm run build` + `tsc` 绿 + 全量测试对照预存失败集零新增；`package.json` 依赖变更单列一提交。
**风险**：中（删依赖牵连测试；分步可回退）。

## 4. Part B — `TuiApp` controller 抽取（先建 harness）

### W-B0 — 前置：统一 TTY harness（必做）
**任务契约**：抽出共享 `engine/__tests__/_harness.ts`（`MockOut`/`MockIn`，`isTTY=true`、`getScrollbackContent()` + ANSI strip 辅助），替换 18 个测试文件的复制粘贴。**先让现有 18 个测试改用共享 harness 后全绿**，再开始任何抽取——这是后续每波的安全网底座。
**过门**：18 个 `engine/__tests__/*` 迁移后全绿（预存脆弱失败维持原状、不新增）。
**风险**：低（仅测试基建）。

### W-B1 — `ToolGroupController`（边界最清，已有集成网）
**任务契约**：搬 `handleToolUse`(1251-1278)、`flushToolGroup`(1280-1290)、`handleToolResult`(1292-1371)、`expandLastTruncatedTool`(1374-1402)。
seam 字段：`toolGroupBuffer`/`pendingTools`/`toolAccumulator`/`lastTruncatedTool`/`lastCollapsedGroup`/`commit`/`state`/`commitAbove`/`refreshTodos`（todo 工具）/`delegationDomainOverride`（delegate 改 domain）。
**过门**：`app-tool-group.test.ts`（折叠组 flush / 异族打断 / ctrl+o / scrollback 渲染）全绿。
**风险**：低-中（已有最强集成网）。

### W-B2 — `OverlayController`
**任务契约**：搬 `activateOverlay`(772-789)、`deactivateOverlay`(792-795)、`handleOverlayKey`(827-934)、`pagerTotalPages`(937-942)、`getScrollbackContent`(798-800)、`getRunningWorkers`(806-818)、`registerOverlays`(1928-2005)。
seam：`overlay`/`overlayNav`/`overlayData`/`paletteExec`/`rewindExec`/`commit`/`columns`/`rows`/`theme`/`pendingTools`（tasks overlay）。
**过门**：`overlay-nav.test.ts`（pager/palette/rewind 导航）全绿。
**风险**：低（`registerOverlays` 独立 78 行）。

### W-B3 — `StreamRenderController`（最大块）
**任务契约**：搬 `handleTextDelta`(1228-1234)、`handleThinkingDelta`(1236-1249)、`commitThinking`/`commitThinkingToScrollback`(1810-1826)、`commitAssistantHeader`(1077-1082)、`renderLive`(1562-1798)、`rerender`(1801-1807)、`setStreamingState`(1085-1092)、`setPhase`/`updateTicker`/`markActivity`(998-1024)。
**⚠ seam 重点**：`commitAbove`(973-977) 是**跨 controller 共享协议**（Tool/Approval 都用），`renderLive` 读 `steerBuffer`/`pendingTools`/`toolGroupBuffer`/`approvalPending`/`intentPending`/`inputLine`/`metricsProvider`/`state.todos`（耦合最重）——抽取时 `commitAbove` 应留在 facade 或提为共享 util，`renderLive` 的绘制段顺序逐字保留。
**过门**：`user-commit-paths.test.ts`/`commit-spacing.test.ts`/`stream-render-batch.test.ts`/`steer-merge.test.ts` 全绿（这些对 commit 契约最敏感）。
**风险**：中（最大块 + 共享 commit 协议；建议独立会话）。

### W-B4 — `ApprovalIntentController`
**任务契约**：搬 `resolveApproval`/`resolveIntent`(694-710)、`handleApprovalRequired`(1829-1846)、`handleIntentPreview`(1848-1855)、constructor 审批/意图键短路(434-507)、`renderLive` 审批/意图 UI 段(1649-1684)。
seam：`approvalPending`/`approvalEditMode`/`approvalEditError`/`intentPending`/`input`/`inputLine`/`setPhase`/`renderLive`/`formatPermissionDiff`/`commitAbove`。
**过门**：`approval-key.test.ts`(y/n/e) + `intent-key.test.ts` 全绿。
**风险**：低-中（键路 + Promise 状态自洽）。

### W-B5 — `InputSubmitController`
**任务契约**：搬 constructor `InputLine.onSubmit` 闭包(315-372)、`input.onAnyKey` 普通/slash↑↓/steer↑ 段(433-650)、`onSubmit`/`rejectSubmit`/`setInput`/`getInputValue`(726-769)、`setSlashCommands`/`handleTabComplete`(1029-1074)、`submitSlashCommand`/`handleSlashCommand`(1862-1926)。
seam：`inputLine`/`input`/`inputHistory`/`slashCommands`/`slashSelectedIdx`/`fileCompletion`/`steerBuffer`/`agentBusy`/`onSubmitCallback`/`slashHandler`/`blockWriter`/`streamRenderer`/`commitUserPrompt`。
**⚠ 全局快捷键**（Ctrl+C/Esc/Ctrl+O 等，517-598）与 Lifecycle 重叠——可选拆出 `KeybindingController`，否则明确归属避免双方都搬。
**过门**：`slash-passthrough.test.ts`/`input-batch.test.ts`/`paste-integration.test.ts`/`abort-resubmit.test.ts`(`runGen` 世代守卫) 全绿。
**风险**：中（与 constructor 键绑定强耦合，宜较后拆）。

### W-B6 — `MetricsGlanceController`（provider seam 已在 main.ts）
**任务契约**：搬 `setMetricsProvider`/`getMetrics`(1118-1177)、`accumulateUsage`/`estimateSessionCost`(1475-1494)、`applyGlanceDomainDisplay`/`syncSessionStarDomainFromAgent`(1144-1168)、`setSessionStarDomain`/`setDomainSyncProvider`(1131-1142)、`setTodosProvider`/`setTodos`/`refreshTodos`(1183-1201)、`renderLive` 内 GlanceBar 段(1698-1736)。
seam：`metricsProvider`/`totalUsage`/`lastCacheHitRate`/`lastContextRatio`/`contextWindow`/`gitBranch`/`sessionStarDomainName`/`delegationDomainOverride`/`state`/`domainSyncProvider`/`tick`(1Hz sync 1009-1011)。
**过门**：`glance-metrics.test.ts`/`domain-glance.test.ts`/`todo-panel.test.ts`/`team-panel-domain.test.ts` 全绿。
**风险**：低（provider 注入 seam 已在 main.ts）。

## 5. 反证测试表（哪些偷懒会红）

| 偷懒实现 | 会红的测试 |
|----------|-----------|
| W-B0 未建共享 harness 直接拆 | 后续波 18 测试随机漂移、无统一基线（评审拒绝） |
| W-B3 改变 `renderLive` 绘制段顺序 / `commitAbove` 时序 | commit-spacing / user-commit-paths（块间距 + 气泡契约） |
| W-B1 flush 折叠组逻辑改写 | app-tool-group（异族打断 / 折叠 flush） |
| 退役 Ink 时漏 grep 删了仍被引用的组件 | tsc / 构建失败 |
| 删 react 依赖但 `thinking.test.tsx` 仍引用 | 测试编译失败（W-A2 步骤 3 守卫） |
| controller 抽取改变 GlanceBar 1Hz sync 时机 | domain-glance / glance-metrics |

## 6. 现有 `TuiApp` 直测集成测试（抽取后必须全绿）

`app-core.test.ts`(2 助手)、`user-commit-paths.test.ts`、`slash-passthrough.test.ts`、`commit-spacing.test.ts`、`app-tool-group.test.ts`、`stream-render-batch.test.ts`、`steer-merge.test.ts`、`abort-gate.test.ts`、`abort-interrupt-ux.test.ts`、`abort-resubmit.test.ts`、`approval-key.test.ts`、`intent-key.test.ts`、`overlay-nav.test.ts`、`glance-metrics.test.ts`、`domain-glance.test.ts`、`todo-panel.test.ts`、`team-panel-domain.test.ts`、`input-batch.test.ts`、`paste-integration.test.ts`。
子引擎单测（不经 TuiApp，不受影响）：`live-engine.test.ts`、`input-handler.test.ts`、`resize-handler.test.ts`、`write-batcher.test.ts`、`input-niceties.test.ts`。

> 注意：当前全量基线可能含与 TUI 无关的预存失败，以及与 scrollback/commit/user-bubble 直接相关的 TTY-harness 脆弱失败。每波须**对照 clean HEAD 预存失败集，零新增**，不得把预存红当成新回归、也不得借重构掩盖新失败。

## 7. 缰绳

- A、B 两条主线可并行，但 **B 必须先做 W-B0**。
- controller 一律走「字段经 `this.app` / deps 访问」的薄抽取，**不重写 `renderLive` 绘制顺序、不改 commit 时序**；diff 只见方法体移动。
- `commitAbove` 作为跨 controller 共享协议，留 facade 或提共享 util，不在某个 controller 内私有化。
- Ink 退役分步、每步可回退、删依赖单列提交。
- 每波 `npm run build` + `tsc --noEmit` + 相关 `engine/__tests__/*` 全绿；对照预存失败集零新增。
- W-B3（最大块）建议独立会话。

## 8. 执行次序

```
Part A: W-A1 冻结（低） → W-A2 退役（中，分步可回退）
Part B: W-B0 共享 harness（必做前置）
   → W-B1 ToolGroup（低中）→ W-B2 Overlay（低）
   → W-B3 StreamRender（中，⚠ 独立会话，commitAbove/renderLive 时序保真）
   → W-B4 ApprovalIntent（低中）→ W-B5 InputSubmit（中）→ W-B6 MetricsGlance（低）
```

## 9. 不建议（破坏不变量）

- 在 W-B0 共享 harness 之前直接拆 `TuiApp` 渲染路径；
- 把 `renderLive` 拆成多 controller 各自绘制（会打乱单次全量绘制的间距契约）；
- 把 `commitAbove` 复制进多个 controller（共享协议必须单一来源）；
- 退役 Ink 时一次性删依赖而不分步验证。
