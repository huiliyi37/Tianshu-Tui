# 中等问题修复 — 字面精度收敛（累加器字节 / scrollback 行数）

> 来源：天梁 Track B（`102264b9`）与天枢超时治理（`c8b804ae`）review 中的**中等问题（M 级）**。
> 之前主线只做 P0/High，本计划收尾 M 级。失效模式同源：**命名/注释声称的量纲 > 实现实际兑现的量纲（伪精确）**。
> 均不破坏既有目标（内存仍有界、stall 仍生效），是「让精确声明 = 实测兑现」的收敛。

## 背景（失效事实）

| # | 位置 | 声称 | 实际 | 性质 |
|---|---|---|---|---|
| M1 | `src/tui/engine/app.ts` `capToolAccumulator` / `TOOL_ACCUMULATOR_MAX_BYTES` | 「字节封顶」 | `text.length`（UTF-16 码元）+ `text.slice(-maxBytes)`，截断提示写 `N chars` | CJK 密集时实际字节 > 64KB |
| M2 | `src/tui/engine/commit-engine.ts` `scrollbackMaxLines` / `DEFAULT_SCROLLBACK_MAX_LINES` | 「行数上限」 | RingBuffer 封的是**条目数（push 次数）**；单条目可含内嵌 `\n` | 多行条目时 `split('\n')` 超过名义行上限 |
| M3 | thinking-stall `120_000` 默认值（`factory.ts`） | 「基于真实 chunk 间隙」 | 语义推算值，无真实 SSE 间隙实测 | 校准类，需真卡死数据 |

---

## M1 — 累加器字节封顶：让度量与名字一致

**任务契约**：`capToolAccumulator` 的「字节」语义要么兑现、要么改名。目标是消除伪精确，且保持内存有界 + 不破坏现有 12 测试的行为契约。

**两个方案（评审定稿，推荐 A）**：
- **方案 A（推荐，真字节）**：用 `Buffer.byteLength(text, 'utf8')` 做判定；超限时按字节安全截尾——`Buffer.from(text,'utf8').subarray(-maxBytes)` 后用 `TextDecoder('utf8', {fatal:false})`/`toString` 解码（容忍并丢弃被切断的首个多字节序列），再从首个 `\n` 后取整行。截断提示改 `truncated ~N bytes`。名实一致，给出真实内存上界。
- **方案 B（最省，诚实降级）**：保留码元实现，但把 `TOOL_ACCUMULATOR_MAX_BYTES`→`TOOL_ACCUMULATOR_MAX_CHARS`、注释与提示统一为「字符/码元」，删掉「字节而非字符」的自相矛盾注释。内存仍有界（≤ maxChars × 2~4 bytes）。

**锚点**：`src/tui/engine/app.ts`（`capToolAccumulator` + 常量 + 调用处 `this.toolAccumulator.set(...)`）。

**验收**：
1. 方案 A：构造含 CJK 的 >64KB 文本，`Buffer.byteLength(capped) <= TOOL_ACCUMULATOR_MAX_BYTES + 单字符冗余`；截尾不产生 `\uFFFD` 替换符泄漏到行内（或明确容忍并测之）。
2. 行边界保留行为不回归（现有「截断后从行边界开始」测试仍绿）。
3. `tool-accumulator-cap.test.ts` 全绿（按方案调整断言文案/度量）。

---

## M2 — scrollback 封顶：条目 vs 行

**任务契约**：`scrollbackMaxLines` 的「行」语义要么兑现、要么改名。保持长会话内存有界。

**两个方案（评审定稿，推荐 A）**：
- **方案 A（推荐，改名诚实）**：`scrollbackMaxLines`→`scrollbackMaxEntries`、`DEFAULT_SCROLLBACK_MAX_LINES`→`..._ENTRIES`，注释说明「封条目数；单条目可多行」。零行为变化，纯命名校正。内存有界（条目数 × 单条目有界）。
- **方案 B（真行数）**：getContent/写入路径按累计 `\n` 计行，超行预算时逐条驱逐最旧——成本更高（RingBuffer 需按行权重驱逐），仅当 pager UX 真要求精确行窗时才做。

**锚点**：`src/tui/engine/commit-engine.ts`（option 字段、常量、构造器、注释）；`commit-engine-scrollback-cap.test.ts` 用例命名/断言同步。

**验收**：
1. 方案 A：改名后 typecheck 通过；既有 4 测试改名后全绿；补一条「单条目含内嵌 `\n` 不被误计为多条」的说明性断言。
2. 无调用方残留旧字段名（grep `scrollbackMaxLines` 零残留）。

---

## M3 — 120s 值实测校准（监控类，非代码改动）

**任务契约**：不改默认值，建立校准入口。
- 在 thinking-stall 触发路径补一行结构化日志：触发时记录 `providerName / 实际空闲秒数 / 是否 thinking-only`，落到现有 telemetry/stderr。
- 下次 GLM 真卡死时，用该日志确认 120s 是否合适（间隙 p100 是否逼近 120s）。
- **不在本计划强行调值**——保守语义推算值安全，等数据。

**锚点**：`src/api/openai-client.ts` idle 触发处（`streamTimedOut` 抛错前）。可选，视评审是否纳入本波。

---

## 验证命令

```bash
npm run typecheck
node --import tsx --test src/tui/engine/__tests__/tool-accumulator-cap.test.ts src/tui/engine/__tests__/commit-engine-scrollback-cap.test.ts
```

## 风险与边界

- M1 方案 A 的字节截尾要处理「切断多字节序列」边界，务必测 CJK；若不想引入解码复杂度，选方案 B（改名）同样消除伪精确。
- M2/M1 都优先「诚实命名」而非「拔高实现」——除非有真实 UX/内存需求驱动方案 B/A 的精确实现，避免为精度而精度。
- 三项彼此独立、与 Track B 生产路径同文件但改动小，建议一波内顺序做完（M1→M2→M3）。
