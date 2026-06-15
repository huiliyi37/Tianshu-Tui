# mid-tui 计划交接 — W-B3~B6 待执行

> 原始计划：`.rivet/plans/mid-tui-engine-app分解-ink退役.md`
> 分支：`desktop/antigravity-base`，HEAD = `7381a729`

## 1. 已交付进度

| 提交 | 内容 | 状态 |
|------|------|------|
| `25bcc523` | W-A1+W-A2 Ink 双栈退役（-9358 行） | ✅ |
| `0b3f0329` | W-B0 统一 TTY harness（_harness.ts + 12 测试迁移） | ✅ |
| `e4ac58f6` | ELM 去饱和 caller-held 修复（旁路 bugfix） | ✅ |
| `ea96b791` | thinking-stall 测试 + Ink 退役测试适配 | ✅ |
| `4e141f85` | W-B1 ToolGroupController（5 字段迁出） | ✅ |
| `7381a729` | W-B2 OverlayController（6 字段迁出） | ✅ |

## 2. 已建立的抽取模式（必须沿用）

W-B1/W-B2 确立了 TuiApp controller 抽取的实际模式：

```
1. 新建 src/tui/engine/<name>-controller.ts，持有原 private 字段
2. app.ts 中替换 N 个字段声明为 1 个 controller 实例
3. app.ts 方法体不变，字段访问改 this.xxxController.method()
4. 方法体留在 app.ts（不搬到 controller）——因为深度耦合 commitAbove/renderLive/writeBatcher
```

**关键设计偏离**：原计划要求搬方法体到 controller。实际执行发现 app.ts 的方法深度耦合 `commitAbove()`/`renderLive()`/`writeBatcher.schedule()` 等 TuiApp 生命周期，搬到独立类需暴露 ~15 个 private 成员。改为只搬**状态字段**，方法体保留。效果：app.ts 声明区缩短，状态管理可独立测试。

## 3. 剩余波次

### W-B3 — StreamRenderController（中风险，计划建议独立会话）

**目标字段**：`assistantHeaderDone`、`streamedText`（如果有）、thinking 相关状态

**目标方法**（留在 app.ts，改读 controller）：
- `handleTextDelta`、`handleThinkingDelta`
- `commitThinking`/`commitThinkingToScrollback`
- `commitAssistantHeader`
- `setStreamingState`、`setPhase`/`updateTicker`/`markActivity`

**⚠ 缰绳**：
- `commitAbove`（L1111）是**跨 controller 共享协议**，必须留 facade 或提为共享 util
- `renderLive` 绘制段顺序逐字保留——改变顺序会导致 commit-spacing / user-commit-paths 测试红
- `blockWriter`（BlockStreamWriter）和 `streamRenderer`（StreamRenderer）是构造函数中初始化的复杂对象，与 InputLine.onSubmit 闭包深度绑定

**安全网**：`user-commit-paths.test.ts`、`commit-spacing.test.ts`、`stream-render-batch.test.ts`、`steer-merge.test.ts`（这些对 commit 契约最敏感）

### W-B4 — ApprovalIntentController（低-中风险）

**目标字段**：`approvalPending`、`approvalEditMode`、`approvalEditError`、`intentPending`

**目标方法**：`resolveApproval`、`resolveIntent`、`handleApprovalRequired`、`handleIntentPreview`

**安全网**：`approval-key.test.ts`(y/n/e)、`intent-key.test.ts`

### W-B5 — InputSubmitController（中风险）

**目标**：constructor `InputLine.onSubmit` 闭包(~60 行)、`input.onAnyKey` 段(~200 行)、slash 命令处理

**⚠ 注意**：全局快捷键（Ctrl+C/Esc/Ctrl+O 等）与 Lifecycle 重叠，需明确归属

**安全网**：`slash-passthrough.test.ts`、`input-batch.test.ts`、`paste-integration.test.ts`、`abort-resubmit.test.ts`

### W-B6 — MetricsGlanceController（低风险）

**目标字段**：`metricsProvider`、`totalUsage`、`lastCacheHitRate`、`lastContextRatio`、`contextWindow`、`gitBranch`、`sessionStarDomainName`、`delegationDomainOverride`、`domainSyncProvider`

**目标方法**：`setMetricsProvider`/`getMetrics`、`accumulateUsage`/`estimateSessionCost`、GlanceBar 相关

**安全网**：需新建（计划 §6 列出 `glance-metrics.test.ts` 等但目前不存在）

## 4. 关键注意事项

### `.git/info/exclude` 陷阱
新建的 controller 文件会被 `.git/info/exclude` 自动排除（原因不明，可能是某 hook 的行为）。每次 `git add` 新文件前需先检查：
```bash
grep "<filename>" .git/info/exclude && sed -i '' '/<filename>/d' .git/info/exclude
```

### `app-tool-group.test.ts` 不存在
计划 §6 列出此测试作为 W-B1 安全网，但实际不存在。安全网仅有间接覆盖（`error-abort-cleanup` 3/3、`stream-render-batch` 2/2）。

### `run_tests` 工具不稳定
部分测试返回 `0 passed, 0 failed, 0 skipped`——这是 tsx EPERM（IPC pipe 权限问题），不是代码问题。用 `npm exec -- tsx --test <file>` 可绕过。

### ink/react 依赖仍在 package.json
W-A2 步骤 3（移除依赖）未执行。`npm run build` 成功但有 unused import 警告。移除前需确认无测试文件引用 React（如已删除的 `thinking.test.tsx`）。

### `commitAbove` 共享协议
```typescript
private commitAbove(write: () => void): void {
  this.live.clearForCommit()
  write()
  this.renderLive()
}
```
被 ~20 处调用（tool/approval/thinking/stream/checkpoint）。**不在任何 controller 内私有化**，留 facade 或提为独立 util。

## 5. 验证命令

```bash
npx tsc --noEmit                              # typecheck（~5s）
npm run build                                 # tsup 构建（~2s）
npm exec -- tsx --test src/tui/engine/__tests__/error-abort-cleanup.test.ts  # 间接安全网
npm exec -- tsx --test src/tui/engine/__tests__/stream-render-batch.test.ts  # 间接安全网
```

## 6. 当前 app.ts 结构

```
app.ts ~2160 行
├── imports + 常量 + 类型 (~170 行)
├── TuiApp class
│   ├── 字段声明 (~60 行，含 3 个 controller 实例)
│   ├── constructor (~350 行，含 InputLine.onSubmit + onAnyKey 闭包)
│   ├── 公开 API (~100 行)
│   ├── commitAbove / commitUserPrompt (~30 行)
│   ├── phase + ticker (~50 行)
│   ├── approval/intent resolution (~40 行)
│   ├── handleToolUse/handleToolResult/flushToolGroup/expandLastTruncatedTool (~200 行)
│   ├── handleTextDelta/handleThinkingDelta (~30 行)
│   ├── renderLive (~250 行，最大单体)
│   ├── handleOverlayKey (~110 行)
│   ├── handleTurnComplete/handleAbort (~80 行)
│   ├── registerOverlays (~80 行)
│   └── metrics/glance 方法 (~100 行)
└── 工具函数 (hexComplement 等)
```

3 个已抽取 controller：
- `tool-group-controller.ts`（129 行）
- `tool-accumulator.ts`（17 行）
- `overlay-controller.ts`（84 行）
