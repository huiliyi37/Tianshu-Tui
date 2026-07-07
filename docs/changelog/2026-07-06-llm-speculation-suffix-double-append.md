# LLM speculation 侧路请求：system suffix 双写与 wire 探针基线毒化

日期：2026-07-06
影响版本：所有开启 `llmSpeculation.enabled: true` 的会话（默认关闭）
相关文件：`src/api/openai-client.ts`、`src/agent/llm-speculation.ts`

## 现象

本地会话 `1924fe2b`（deepseek-v4-pro）cache-log 在 22:57:42（turn 36）与 22:57:53（turn 38）出现两条 `wireDiverged idx 0, role system, approxCharPos 0`，而 engine 层探针（prefixDiverged）沉默——即 engine 构建的消息数组字节稳定，分歧发生在 client 发送层变换之后。

## 铁证：prevCount/newCount 只差 1

两条记录分别是 `prevCount 146 → newCount 147` 和 `150 → 151`。正常相邻主轮之间消息数至少 +2（assistant + tool result）。唯一自洽的解释：

- turn 35 主请求 145 条 → spec 侧路在其慢工具窗口发 146 条（主请求 + 1 条预测指令）→ turn 36 主请求 147 条（145+2）
- turn 37 主请求 149 条 → spec 150 条 → turn 38 主请求 151 条

探针链：spec（双 suffix system）对 turn 35 基线记一次 idx 0 divergence；turn 36（单 suffix）对 spec 基线再记一次并覆盖 consume-once 槽位；cache-log 消费到的就是 `{146→147, idx 0}`。turn 37 干净是因为 turn 36 的工具批没有慢工具、spec 未发。

## 根因（两个 bug 叠加）

1. **system 消息对象共享 + client 原地 mutation → suffix 双写。**
   `speculate()` 用 `[...params.request.messages, specUser]` 构造消息——数组是新的，元素是同一批对象引用。而 client `stream()` 里 suffix 应用是 `sysMsg.content += this.systemSuffix`（原地 mutation）。主轮 stream() 已给该 system 对象追加过一次中文思考指令；spec 复用同一对象再进 stream() 又追加一次 → spec 请求上线的 system = prompt+suffix+suffix。

2. **`{...params.request}` 泄漏 `prefixProbe: true`。**
   engine 只给主轮请求打 `prefixProbe` 标（`engine.ts:751` 注释明确警告侧路会毒化基线），spec 的展开语法把它带了进来 → 双 suffix 的 system 写入 wire 探针基线 → 下一主轮报幻影 divergence。

## 真实代价（日志不可见）

spec 请求的 system 在 ~10K 字符处字节分叉 → 该请求的**整个历史前缀缓存全 miss**（94K token 会话约 0.09 元/次，DeepSeek 侧还落盘一条新前缀分支）。spec 的 `onStopReason` 丢弃 usage、不写 cache-log——这笔钱完全隐形，与「共享主请求前缀、零成本搭缓存便车」的设计承诺正好相反。

同型隐患：`FallbackStreamClient`（`fallback-client.ts`）failover 时把同一个 request 对象先后传给两个 client 的 `stream()`，同样会双写 suffix。

## 修复

1. **client 层 suffix 改 copy-on-write**（`openai-client.ts`）：不再 `content +=`，改为 `wireMessages[sysIdx] = { ...sysMsg, content: sysMsg.content + suffix }`。调用方的 request.messages 不再被污染——spec 复用、fallback 重放、任何未来的 request 重入都安全。
2. **spec 请求显式剥离 `prefixProbe`**（`llm-speculation.ts`）：即使 suffix 修好，spec 请求仍会把「主请求 +1 条 user」写入探针基线，下一主轮在原 spec user 位置必然幻影 divergence，必须剥离。

## 回归测试

- `src/api/__tests__/openai-client.test.ts`：同一 request 对象连续 `stream()` 两次，断言 wire 字节一致（无双 suffix）且调用方对象未被 mutation；连续 probed 请求纯追加时 `consumeWireDivergence()` 为 null。
- `src/agent/__tests__/llm-speculation.test.ts`：主请求带 `prefixProbe: true` 时，spec 请求断言 `prefixProbe === undefined`，主请求自身标志保留。

## 教训

- **request 对象可能被多个 `stream()` 调用重入**（spec 复用、fallback 重放、未来的重试路径）。client 发送层变换绝不能 mutation 调用方的消息对象——一切改写走 copy-on-write。
- **侧路请求用展开语法复制主请求时，必须显式清除主路径专属标志**（`prefixProbe` 等），否则观测通道被毒化，产出误导性诊断信号。
- **不记录 usage 的侧路请求是成本盲区**：它出了问题（如整段前缀 miss）不会在任何日志里留痕，只能靠账单异常倒查。

## 后续：侧路 usage 记账（同日修复）

上面第三条教训已闭环。全仓 6 个侧路 `stream()` 调用原本都用 `onStopReason: () => {}` 丢弃 usage——会话总量（meta `tokenUsage`）、cache-log、telemetry 三条记账链路全部旁路。改动：

1. **通用记账 sink** `createSidePathUsageRecorder`（`loop-factory.ts`）：usage 经 `SessionContext.addSidePathUsage` 计入会话总量（**不走** `addUsage`——那会把侧路请求的 input 当成主对话的实测占用，改写 `lastRealPromptTokens`/`tailEstimate`/校准比，毒化占用估计锚点），并向 cache-log 落一条 `{event:'side_path', kind, model, input, cacheRead, cacheCreate, output, hitRate}` 事件行——与主轮行区分，不消费探针。
2. **llm-speculation** 接线 `recordUsage`（kind=`llm-speculation`），telemetry 记录补 `inputTokens`/`cacheReadTokens`/`outputTokens`。onStopReason 可能触发两次（finish 帧 + usage 帧），以 `input_tokens > 0` 门控只记一次。
3. **压缩总结**两处（partial-compact / llm-compact）接线 `recordSummaryUsage`（kind=`compact-summary`，model 取 request.model——专用 compact client 可能跑不同模型）。
4. **引擎调用计数落盘**：postSession 把 llm-speculation 引擎的 `stats()`（fired/parseFailures/errors）写进 meta `llmSpeculationEngine` 字段——此前"spec 到底发了几次 API 调用"在磁盘上无从考证。

短 prompt 侧路（intent-router / goal-criteria / anti-anchoring / worker JSON 修复）单次几百 token，本次不接；sink 就位后随时可加。
