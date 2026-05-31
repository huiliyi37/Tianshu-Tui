# Phase 1：确定性成功输出裁剪 — 实施计划

> **日期**：2026-05-31
> **来源设计**：`docs/superpowers/specs/2026-05-31-harness-engineering-comparison-design.md`
> **决策**：保守折叠（成功且 ≤ 10 行留全文，超过才折叠为摘要；失败永远 dump 全文）

## 目标

借鉴 HumanLayer 的 success-swallows-failure：工具成功输出在超过阈值时折叠为摘要行，回收 prefix-cache 有效载荷。零 LLM 成本，纯确定性，不碰 cache 前缀。

## 现状（已审计 + 核查修正）

- `src/tools/output-store.ts:buildModelOutput` 是 **bash / diff** 的「回给 LLM」出口。**run-tests 不走此路**——它有独立管道 `parseOutput → formatOutput → truncateOutput`（run-tests.ts:299-302），只 import `buildUiOutput`。两个改动点互相独立。
- `buildModelOutput` 当前折叠仅按行数：`lines.length <= 200` 时**原样全文**；命令过滤器 `applyCommandFilter` 仅在 `exitCode !== 0` 应用。
- 缺口：成功且 < 200 行的 bash 输出全文进 context（长 build 日志、大 diff）。
- run-tests 的 `formatOutput` 已把成功压成 ~3 行（`Exit code / N passed / Duration`），收益边际但零成本。
- 原始输出已通过 `persistRawOutput` 落盘，agent 可用 `read_section` 按需拉取。

## 改动点（绝对最小）

### 1. `src/tools/output-store.ts` — buildModelOutput 加成功折叠分支（覆盖 bash/diff）

在现有 `lines.length <= MODEL_MAX_LINES` 分支**之前**插入：

```
const SUCCESS_INLINE_LINES = 20
if (meta.exitCode === 0 && lineCount > SUCCESS_INLINE_LINES) {
  return `${header} (output suppressed — read full via artifact if needed)`
}
```

- 阈值 20（非 10）：避免 `bash cat file.ts` 等 11–20 行常见场景被误折叠。
- 成功 + ≤ 20 行 → 原有全文分支（不变）。
- 成功 + > 20 行 → 只回 header 摘要行（已含 `exit=0 time=Xs lines=N`）。
- 失败 → 不进此分支，走原有 filter + 截断（全文/头尾）。

### 2. `src/tools/run-tests.ts` — 成功时用解析计数生成摘要

成功路径（`exitCode === 0`）的 `content` 从 `truncated` 改为结构化摘要行：

```
content: exitCode === 0
  ? `✓ ${parsed.passed} passed${parsed.skipped ? `, ${parsed.skipped} skipped` : ''}${parsed.duration ? ` (${parsed.duration})` : ''}`
  : truncated,
```

- `uiContent` 不变（TUI 仍展示完整）。
- 失败仍走 `truncated`（含失败用例 + 错误）。

## 验证

1. `npm run typecheck` — 无类型错误。
2. 新增 `src/tools/__tests__/output-store.test.ts` 用例：
   - 成功 + 5 行 → 全文返回（含 raw 内容）。
   - 成功 + 50 行 → 只返回 header 摘要行，不含 raw body。
   - 失败 + 50 行 → 全文/头尾（现有行为不变）。
3. run-tests 成功摘要：mock parsed 计数，断言 content 为 `✓ N passed` 形态。
4. `npm test`（相关文件）+ 全量回归。

## 退出条件

若折叠后 agent 丢失定位信息：失败永远全文 + 原始输出已落盘可 read_section 拉取，风险极低。如阈值 20 行仍过激进，调高 `SUCCESS_INLINE_LINES`。

## 不做（反证已砍）

- ❌ hook 输出折叠：本 Phase 只动工具输出。hook 输出统一格式留待确认 hook 是否真进消息流后再评估（避免猜测）。
- ❌ 持续漂移检测、recovery hysteresis。
