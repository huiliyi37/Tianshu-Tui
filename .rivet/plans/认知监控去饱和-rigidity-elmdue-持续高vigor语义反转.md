> **Status: COMPLETED** — 2026-06-19

# 认知监控去饱和 — rigidity / elmDue 在「持续高 vigor」下的语义反转与刷屏

> 来源：天梁域 B 计划会话日志分析（session `43746e7a`）。点 1，**单独出**。
> 与超时治理二期（点 2，api 层）零重叠；与 Track B（TUI/记忆，GLM 在做）零重叠——本计划只动 `src/agent/vigor.ts`、`src/agent/perception.ts` 及其测试。

## 一、问题（来自日志事实 + 代码根因）

日志现象：整段会话 `health.rigidity` 与 `health.elmDue` 初轮后**几乎恒为 true**，`vigor.tonic` 单调饱和到 ~1.0，监控信号失去诊断价值（变成刷屏噪声）。

**根因（已读代码确认，非 bug 而是退化均衡）**：

1. **tonic 饱和**：`updateVigor`（`vigor.ts:118-135`）中 `tonic` 是朝「观测成功率」收敛的 EMA（`TONIC_ALPHA=0.15`）。GLM 5.2 这类干净会话工具几乎全成功 → `tonicTarget≈1` → `tonic→1.0` 并钉死。
2. **rigidity 语义反转**：`detectRigidity(history, 10, 0.05)`（`vigor.ts:159-163`）= 「近 10 次 vigor 标准差 < 0.05 即判定刚性」。tonic 钉 1.0 → `vigor = clamp01(tonic + 0.3*phasic + 0.2*curiosity) ≈ 1.0` 恒定 → std≈0 → **rigidity 永真**。
   - 设计意图是抓「卡死/原地打转」的**平坦**，但「持续成功」的**平坦-高位**也被误判为刚性——表现越好越「刚性」，**语义反转**。
3. **elmDue 刷屏**：`shouldTriggerElmRelease(vigor, 0.8, 5)`（`vigor.ts:208-217`）= 「vigor>0.8 且近 5 次全 >0.8 即请求一次验证脉冲」。持续成功 → **每轮都满足** → 每轮都请求 ELM micro-release，无冷却，沦为噪声。

## 二、任务契约

**目标**：让 rigidity / elmDue 在「持续高位成功」时**不再恒真**，恢复其作为异常信号的诊断价值；同时不削弱它们对「真卡死 / 真平坦低位」的捕获能力。

**非目标**：不重写 vigor 主循环；不动 `modulateStrategyByVigor` 的策略调制；不改 sensorium。tonic 是否引入泄漏衰减列为**待定 P2**（影响面大，单独评估，本计划不强制）。

**验收（以合成 history 驱动单测）**：
1. **平坦-高位**（近 10 次 vigor 全 ≈1.0）→ `rigidity = false`（不再把「持续成功」当刚性）。
2. **平坦-低/中位**（近 10 次 vigor 全 ≈0.4，std<0.05）→ `rigidity = true`（真卡死仍捕获）。
3. **elmDue 冷却**：连续平滑多轮时，elmDue 不再每轮都 true——首次触发后进入冷却（N 轮内或直到出现一次非平滑回落才再触发）。
4. 既有 `vigor.test.ts` / `perception.test.ts` 全绿；typecheck 通过。

## 三、实施锚点与方案（方案在评审中定稿，先给候选）

### A. rigidity 去反转 —— `src/agent/vigor.ts:159-163` `detectRigidity`

- 候选 A1（最小、推荐）：rigidity 仅在**平坦且非高位**时成立。即 `std < threshold && mean(recent) < HIGH_BAND`（如 `HIGH_BAND = 0.75`）。平坦-高位（持续成功）不再判刚性；平坦-低/中位（真卡顿）仍判。
- 候选 A2（更强、需更多上下文）：rigidity 增加「行为重复」佐证——不仅看 vigor std，还看近 N 轮工具序列是否高度重复（需 perception 传入 recentTools）。改动面更大，列为可选增强。
- 决策建议：先做 A1（纯 vigor.ts 内、零接口扩散），A2 视评审决定是否纳入。

### B. elmDue 冷却 —— `src/agent/vigor.ts:208-217` `shouldTriggerElmRelease`

- `shouldTriggerElmRelease` 当前无状态、纯函数；冷却需要「上次触发轮次」状态。两种落法：
  - B1（推荐）：把冷却判断上移到调用方（`perception.ts:96-101` `buildHealthTelemetry` 或其调用处的 hook），传入 `lastElmReleaseTurn` / `currentTurn`，纯函数 `shouldTriggerElmRelease` 保持不变，外层加 `turn - lastElmReleaseTurn >= ELM_COOLDOWN_TURNS`（如 5）。
  - B2：给 vigor state 加 `lastElmTurn` 字段（侵入 VigorState，影响序列化/快照，谨慎）。
- 决策建议：B1，避免污染 VigorState。需顺藤摸瓜确认 `buildHealthTelemetry` 的调用链（哪个 hook 消费 elmDue、是否已有 turn 上下文）。

### C. 待定 P2（不强制）—— tonic 泄漏

- `updateVigor` 的 tonic EMA 朝成功率收敛后无回拉，长期钉 1.0、压缩 phasic 动态范围。可选：朝 0.5 基线加极慢泄漏（如每轮 `tonic = tonic*(1-leak) + 0.5*leak`，leak≈0.02）。**影响 vigor 全局动态，需独立评估 + 回归**，本计划仅记录，不实施。

## 四、风险

- 改 `detectRigidity`/elmDue 阈值会牵动所有消费这两个信号的 hook（kick / dream / theta 等）。改前用 `query_graph callers_of detectRigidity / shouldTriggerElmRelease` 列全下游，确认没有依赖「永真」语义的逻辑。
- 合成测试要覆盖三种 history 形态（平坦高 / 平坦低 / 抖动），防止只修了反转却漏掉真卡死捕获。

## 五、验证命令

```bash
npm run typecheck
node --import tsx --test src/agent/__tests__/vigor.test.ts src/agent/__tests__/perception.test.ts
```
