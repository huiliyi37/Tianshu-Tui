> **Status: COMPLETED** — 2026-06-19

# 超时治理二期 — 思考停滞上限（GLM 5.2 接入 thinkingStallTimeoutMs）

> 来源：天梁域 B 计划会话日志分析（session `43746e7a`）。Track A（超时即 abort + 子代理回收）已交付（commit `13381a0d`），本计划是同一「超时治理」主线的二期，**排进去**。
> 与 Track B（TUI/记忆，GLM 在做）零文件重叠；与「认知监控去饱和」计划（点 1，单独出）亦零重叠，可并行。

## 一、问题（来自日志事实）

- GLM 5.2（1M 上下文）思考流可达 ~158s（stream 总时长），但**整段会话 `theta.lastTimedOut` 恒为 0**——从未触发任何思考停滞保护。
- 机制其实**已存在且可配**：`OpenAIClientConfig.thinkingStallTimeoutMs`（`src/api/openai-client.ts:45`），但**默认 `undefined` = 取 `readMs`（等于禁用）**。没有任何调用方设置它（全仓仅 openai-client.ts 与其测试出现该字段）。
- 因此 GLM 偶发的「真卡死」（用户原话：偶尔会有思考超时的）只能拖到 `SLOW_READ_TIMEOUT_MS = 300s`（`openai-client.ts:67`）这个唯一兜底才被动中断，且兜底文案是泛化的 idle timeout，不是「思考停滞」。

## 二、关键语义（务必先理解，否则会选错值）

`thinkingStallTimeoutMs` 是 **chunk 间空闲窗**，不是思考总时长：

- `resetIdleTimer()` 在**每个真实 `data:` 事件**后调用（`openai-client.ts:541-544`，心跳 `:`/空行不算进展、不重置）。
- 只在 `inThinkingOnly`（收到 thinking、尚无 text、且无 toolCall/text 累积块）时生效：`thinkingStallMs = Math.min(config.thinkingStallTimeoutMs ?? readMs, readMs)`（`openai-client.ts:464-468`）。
- 触发即 `reader.cancel()` → 抛 `thinking stall timeout (${secs}s)`（`openai-client.ts:500-504`），文案已读取实际秒数。

**推论**：GLM 持续吐 `reasoning_content` delta，合法长思考的「相邻 delta 间隙」很小；158s 是总时长而非空闲间隙。所以一个 **120s 量级的空闲窗**几乎只会命中「reasoning delta 完全停流」的真卡死，而不会误杀合法长思考。

## 三、任务契约

**目标**：为 SLOW_THINKING 类 provider（至少 glm）注入一个**默认 thinkingStallTimeoutMs**，让真卡死在 ~120s 空闲被准确识别并中断（交给上层 retry），而合法长思考（持续吐 reasoning）不受影响。

**非目标**：不动 read/first-byte 兜底（300s/180s 保留）；不改 stall 触发逻辑本身；不碰其它 provider 的现有默认（保持禁用）。

**验收**：
1. glm provider 经 `createProviderClient` 构造出的 OpenAIClient，其 `config.thinkingStallTimeoutMs` = 默认值（建议 120_000），且 `< readMs`。
2. 纯 thinking 卡死（reasoning 后 120s 无任何 data 事件）→ 抛 `thinking stall timeout (120s)`。
3. 合法长思考（每 <120s 持续吐 reasoning delta，总时长 >158s）→ **不**触发 stall，正常完成。
4. 非 SLOW_THINKING provider 行为不变（默认仍禁用）。
5. typecheck 通过；`thinking-stall-config.test.ts` 既有用例全绿。

## 四、实施锚点

- **注入点**：`src/api/factory.ts:82` `new OpenAIClient({ ... })`。`provider.name` 在此可用。
  - 方案（推荐）：在 factory 顶部加 `const SLOW_THINKING_STALL_DEFAULT_MS: Record<string, number> = { glm: 120_000 }`（先只放 glm，其余 provider 谨慎，逐个用真实日志验证 chunk 间隙后再加）。
  - 注入：`thinkingStallTimeoutMs: provider.thinkingStallTimeoutMs ?? SLOW_THINKING_STALL_DEFAULT_MS[provider.name]`——保留 provider 配置覆盖能力（若 ProviderConfig 暂无该字段，先只用 map 默认，留 TODO 接配置）。
- **取值依据**：120_000ms。理由——远大于合法 reasoning delta 间隙、远小于 300s read 兜底；命中即「reasoning 完全停流」。**锁定前先用真实 glm 5.2 日志量一次「相邻 data 事件最大间隙」**，若 p100 间隙逼近 120s 则上调至 150s。
- **测试**：扩展 `src/api/__tests__/thinking-stall-config.test.ts`，新增「factory 为 glm 注入默认 120s」与「合法持续 reasoning 不误杀」两条；如 factory 无单测则新增最小 `factory.test.ts` 仅断言 glm 注入值。

## 五、风险

- **误杀长思考**：唯一真实风险。靠「空闲窗而非总时长」语义 + 120s 余量化解；上线前用真实日志量化 chunk 间隙做最终定值。
- **provider 扩散**：只先开 glm，其余 provider 不动，避免一刀切误伤 codex/deepseek 的不同流式节奏。

## 六、验证命令

```bash
npm run typecheck
node --import tsx --test src/api/__tests__/thinking-stall-config.test.ts
```

## 七、交付后状态（2026-06-15）

- 主体已交付：commit `c8b804ae`（天枢域）。typecheck 0、factory 17/17。
- 遗留项 ①「合法长思考不误杀」测试：**已补**——`thinking-stall-config.test.ts` 新增用例（glm read300/stall120，90s×3=270s 持续吐 reasoning 不触发 stall），3/3 全绿。
- 遗留项 ②「恢复路径」：**已核实成立**——`thinking stall timeout (120s)` 文案含 "timeout"，命中 error-classifier `/timeout/i` → `retryable/shouldReconnect/maxRetries:3`，真卡死 → cancel → 可重试重连 ×3。无需 loop 层特判。
- 遗留项 ③「120s 实测锁定」：仍待真卡死 stderr 校准（语义推算值，安全保守）。
- 星域质量分析见 `docs/design/star-domain-eval-log.md` #2。
