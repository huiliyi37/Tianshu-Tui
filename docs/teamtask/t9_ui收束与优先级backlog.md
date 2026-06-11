# T9 UI 层收束与优先级 Backlog

> 2026-06-11 · t9-ui-refactor 分支 · 一轮收束（convergence）
>
> 目的：把散落在多份 plan 文档里的「后续增补 / 不在本轮 / DEFERRED」收拢成**一份**带优先级的待办，作为继续推进 UI 层前的统一基线。本文件只做收束与排期，不改代码。

---

## 0. 收束基线：已落地（不再重复排期）

T9 ANSI TUI（`main-ansi.ts` 路径）当前已具备日常对话能力，以下均已提交并测试覆盖：

- **渲染**：LiveEngine 增量重绘 + CSI 2026 同步输出 + reservedTail 底部 chrome 保护
- **输入**：bracketed paste、CJK/emoji grapheme 光标、多行导航、`\⏎` 续行、批渲染
- **打断**：`isAgentActive()` 门禁 + loop.ts eager abortController + `_pendingAbort` 闩（warmup 窗口可打断）
- **指标**：GlanceBar 走 `metricsProvider` 读真实 session 数据（cache% / ctx% / `◧ Xk/Yk` / `$cost` 不膨胀）
- **面板**：常驻 todo 任务面板（三态 checklist）、子代理 TeamPanel 解码渲染、delegate/team → 天机 domain 切换
- **命令**：`/model` 切换落地、slash 透传、welcome 屏、`/clear`/`/exit`/`/starmap`/`/chronicle`
- **审批**：`y`/`n` 真实闭环（pending Promise）

> 来源 plan：`t9_ansi渲染重写` · `t9_渲染流畅化` · `t9_agentloop_wiring` · `t9_claude_code_parity`(M1–M4) · `t9_补齐与数据真实化`(A–D)

---

## 1. 优先级总览

| 级别 | 主题 | 为什么 | 工作量 |
|------|------|--------|--------|
| **P0** ✅ | 审批 `[e] edit` 假选项 | 信任/正确性缺陷：UI 明示可编辑，实际直接放行 | S |
| **P0** ✅ | Intent preview 静默放行 | 安全闸被旁路：开启 intent 时永远 `continue`，无 y/n/veto | S–M |
| **P1** ✅ | Overlay 交互导航 | pager 不能翻页、palette 不能选 → overlay 形同只读弹窗 | M |
| **P1** ◑ | Cockpit / `/context` 面板接线 | `/context` 已可用；cockpit 6 面板 overlay deferred→P2 | M |
| **P1** ✅ | slash handler `cost` 写死 0 | `/cost` 等命令读到假值（GlanceBar 已真实，命令侧未对齐） | S |
| **P2** | M5 切换与清理 | feature flag 灰度 → 性能基准 → 删 Ink/.tsx → 文档 | L |
| **P3** | 内层 worker 流式上行 | 子代理实时活动两路 UI 均不显示，需新增 `onSubAgent*` 回调 | L（跨共享层） |
| **P3** | TodoStore 子进程单例覆盖 | 已知 issue，独立排期 | M |

S≈半天 · M≈1–2 天 · L≈3 天+

---

## 2. P0 — 体验正确性（应在本轮收束内解决）

### P0-1 审批 `[e] edit` 是假动作 — ✅ 完成（路径 A）

- **已改（路径 A）**：删 `else if (c === 'e')` 分支（`e` 被吞、审批仍 pending）；底部 affordance 移除 `[e] edit`，只留 `[y] approve [n] deny`。测试 `approval-key.test.ts::审批模式 e → 不是 approve`。路径 B（单行编辑态）仍 backlog。
- **风险**：用户以为按 `e` 能改工具入参，实际等同 `y`。信任面缺陷。
- **两条收束路径（择一）**：
  - **A（最小，推荐先做）**：从底部 affordance 移除 `[e] edit`，只留 `[y]/[n]`，消除误导。半天。
  - **B（完整）**：`e` 切到一个单行编辑态（复用 InputLine），编辑工具 input 的 JSON/关键字段，确认后以 `{ approved: true, editedInput }` resolve。1–2 天。
- **验收**：A → UI 不再出现 edit 字样；B → 编辑后 agent 收到改后的 input（RED→GREEN：mock approval 返回 editedInput，断言工具收到改后值）。

### P0-2 Intent preview 静默放行 — ✅ 完成

- **复核结论**：意图闸**非默认关** —— `TurnIntentController.evaluate` 只要 `onIntentPreview` 接线就在真实运行态触发（commitThreshold>0.8 / dead-end 信息素 / 抖动建议），每 session ≤3 次。旧 stub `'continue'` 是真旁路 → 必须补 UI（非降级）。
- **已改**：新增 `intent` InputMode + `intentPending`，复用审批 pending-Promise + live-region。渲染框（summary + ⚠warnings + ↳alternatives）；`y/Enter`=continue、`n/Esc`=veto、`a`=alternative(仅当有 alts)，余键吞掉。测试 `intent-key.test.ts`（7 例）。

---

## 3. P1 — 功能完整（收束后第二批）

### P1-1 Overlay 交互导航 — ✅ 完成

- **现状**：[app.ts:381-393](src/tui/engine/app.ts) overlay 仅 `Esc` 关闭；pager 无 `j/k`/方向键翻页，palette 无方向键选择 + Enter 执行（`renderPager`/`renderCommandPalette` 已是纯渲染，缺输入态）。
- **已改**：`handleOverlayKey` 路由 overlay 内按键 —— pager 维护 `overlayNav.pagerPage`（j/↓/PgDn 下翻、k/↑/PgUp 上翻、Home/End 首末页、越界 clamp、q 关闭）；palette 维护 `overlayNav.paletteIndex`（↑/↓ 循环选中、Enter 经 `paletteExec(idx)` 执行并关闭、q 关闭）。纯渲染器经 spread 注入 page/selectedIndex，激活时复位 nav。
- **验收**：pager 翻页 ✅、palette 选择执行 ✅。测试 `overlay-nav.test.ts`（4 例，真实 ANSI 序列驱动）。
- **验收**：注入按键 → 断言 pager page 偏移变化 / palette 选中项变化与 Enter 触发命令。

### P1-2 Cockpit / `/context` 面板接线 — ✅ `/context` 半完成 · cockpit 半 deferred→P2

- **现状**：[slash-router.ts:86](src/tui/engine/slash-router.ts) `setCockpitPanel` noop、[:96](src/tui/engine/slash-router.ts) `setSummaryState` noop、[:87-88](src/tui/engine/slash-router.ts) `surfacePush/surfacePop` undefined。
- **结论（复核后）**：`/context claims|antibodies|conflicts` **已在 T9 可用** —— 只依赖 `ctx.claimStoreRef.current` + `pushStatic`，二者 SlashRouter 已真实接线，无需改动。cockpit 6 面板 `.tsx` 是 React 绑定（Ink 路径），数据层 `buildCockpitSnapshot` 是纯函数可复用，但 T9 ANSI 路径缺 renderer。
- **决策**：本批只交付 `/context` 半（已验证可用）。cockpit overlay 呈现 **deferred 到 P2** —— 需新建 ANSI `renderCockpit(snapshot)→string[]` + 注册 cockpit overlay + 接 `surfacePush('cockpit')→activateOverlay`，复用 P1-1 导航。`setCockpitPanel`/`setSummaryState`/`surfacePush`/`surfacePop` 维持 noop 直至该项启动（明确标注，非假动作隐藏）。
- **验收**：`/context` 列出 claims/antibodies ✅；cockpit overlay → P2。

### P1-3 slash handler `cost` 真实化 — ✅ 完成

- **现状**：[slash-router.ts:79](src/tui/engine/slash-router.ts) `cost: 0` 写死、`maxTokens` 取 `models[0]`（非当前模型）。
- **已改**：TuiApp 新增 `getMetrics()` 暴露与 GlanceBar 同源快照；SlashRouter 读 `cost`/`maxTokens`（无 provider 回退 models[0]/0）。
- **验收**：`/cost` 与 GlanceBar 同源 ✅；/model 切换后 maxTokens 跟随（闭包读当前 ctx）✅。测试 `glance-metrics.test.ts::getMetrics`。

---

## 4. P2 — 上线收尾（M5 切换与清理）

> 来源：`t9_claude_code_parity` M5（唯一仍 `pending` 的里程碑）。建议 P0/P1 清完、T9 可日常替代后再启动。

- **P2-1 Feature flag 灰度**：`RIVET_TUI=ansi`（或 `RIVET_T9=1`）在 `main.tsx` 路由到 T9 路径，默认仍 Ink，可选切换。
- **P2-2 性能基准**：Ink vs T9 帧率（100 行流式）、内存（1000 条 scrollback）、CPU（持续流式 10 min）。
- **P2-3 全量回归 + E2E 清单**：对话 / 工具 / 审批 / session restore / rewind / overlay 手验。
- **P2-4 删除旧代码**：36 个 `.tsx`、`ink`/`react`/`yoga-wasm-web` 依赖、`patches/ink+6.8.0.patch`、tsup JSX 配置。
- **P2-5 文档**：README 架构图 + CLAUDE.md TUI 层描述更新。

---

## 5. P3 — 大改 / 独立排期（不在近期收束）

- **内层 worker 流式上行**：子代理实时活动（worker 的 token/工具）两路 UI 均不显示，需新增 `onSubAgent*` 回调，跨共享层大改。当前 TeamPanel 只在 `team_orchestrate` 终态解码渲染。
- **TodoStore 子进程单例覆盖**：已知 issue，与 todo 面板 canonical 源相关，独立排期。
- **compaction / appendix cache 并行化**：既有 DEFERRED，属 agent/compact 层。

---

## 6. 邻接项（非 UI 层，但 UI 已在「报警」）

- **Token 爆炸 P1**（[docs/known-issues/token-explosion-2c25c34e.md](docs/known-issues/token-explosion-2c25c34e.md)）：根因在 agent loop 每 turn 多次重发完整上下文 + tool result 不截断 + 1M 窗口压缩阈值过高。**属 agent/compact 层，不在 UI 收束范围**，但 GlanceBar 的真实 ctx%（≥78% `⚠compact`）现在会把症状暴露给用户——UI 侧已尽责，修复落在 agent 层。

---

## 7. 本轮收束建议（下一步）

1. **先清 P0**（信任/安全面，工作量小）：
   - P0-1 先走路径 A（移除 `[e] edit` 假 affordance），把完整编辑流程（路径 B）排到 P1 批次。
   - P0-2 先确认 intent 预览默认开关；若默认开启则立即补 UI，否则降 P1。
2. **再批 P1**：P1-1 overlay 交互 → P1-2 cockpit/context（复用导航）→ P1-3 cost 对齐。
3. **P2（M5 上线）**：待 T9 在本机日常跑顺、P0/P1 收口后启动，从 feature flag 灰度切入。

每项保持 RED→GREEN（`node:test` + `node:assert/strict`），`npm run typecheck` 零错，改动文件 `ReadLints` 无 lint，TUI 全量无新增回归。
