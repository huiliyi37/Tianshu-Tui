# GLM-5.2 流式：finish_reason 早于 tool_call arguments 导致工具收到空参数

状态：已修复（2026-06-19）。代码 `57a2c0d1`（flush 延迟修复）、`2ba6522a`（raw-sse 落盘诊断）；回归测试 `src/api/__tests__/openai-client-glm-toolcall.test.ts`。前置诊断埋点 `e1d9330f`（grep 报错文案）、`1add7e9c`（tool-input-trace）。

## 症状

GLM-5.2 会话中，`grep` 工具偶发、成簇地返回 `Error: pattern is required (non-empty string)`，但模型明明传了合法 pattern。表现高度迷惑：

- 失败与 pattern 内容无关：裸词 `switchAgentRuntime` 失败，而带空格/管道的 `class DelegationCoordinator`、`destroy|cleanup|...` 成功。
- 时序相关、成簇：一长串成功调用后突然连续几次失败，模型换 bash 兜底才恢复。
- 跨会话复发，"怎么修补都修补不过来"。
- 典型事故会话：`.rivet/sessions/c4c11702-...jsonl`（glm-5.2，6 turn / 132 tool call / `cleanExit:false` / prompt token 21.3M——循环重读的代价）。

## 误导性线索（曾让排查走入悖论）

事故会话里，持久化到 JSONL 的 `tool_calls[].function.arguments` **是完整的**（pattern 非空），但工具却报 "pattern is required"。这制造了一个看似自相矛盾的局面：

- 落盘内容 = `stableStringify(block.input)`（`src/agent/context.ts:219`），且 `addAssistantBlocks` 早于工具执行（`src/agent/turn-orchestrator.ts:600` 先于 `executeBatch`）。
- 因此「`flushToolCalls` 里 `JSON.parse` 失败→`{}`」一度被证伪：若真为空，落盘也该是 `"{}"`。
- repair pipeline（`tool-pipeline.ts`，三 pass 对合法 grep 全 no-op）、PreToolUse hook（未配置）、`executeBatch`（原样透传 `tu`）都不改写输入。

静态阅读到此走入悖论。突破口是放弃静态推断、转复现测试 + 真实抓包（见 `cd7030d2` 的诊断策略切换规则）。

## 根因（真实 GLM SSE 抓包实证）

GLM-5.2（thinking）**违反 OpenAI 流式约定**：它在 `finish_reason:"tool_calls"` 块（甚至带 `usage`）**之后**才继续流式补发 tool_call 的 `arguments`，且可能跨两个不同 `completion id` 的流段。

真实 SSE（强制 grep，5 次连续调用）抓到：

```
[31] delta.tool_calls[0] = { id, function:{ name:"grep", arguments:"{\"pattern\":\"export function switch..." } }
[32] finish_reason:"tool_calls" + usage   ← 旧代码在此 flush
[33+] delta.reasoning_content ...           ← 新 completion id
[55] delta.tool_calls[0].function.arguments = 完整 args   ← 在 finish 之后才到齐
```

旧 `flushToolCalls` 在 `finish_reason`（`processDelta`）时立即解析当时 buffer 里的残缺 JSON，`catch { input = {} }` **静默吞成空对象**，喂给 `grep.execute` → `parseGrepPattern` 见 `pattern===undefined` → "pattern is required"。

网络分块的非确定性解释了所有诡异特征：args 有时在 finish 前到齐（成功），有时在之后（失败）——所以偶发、成簇、与内容无关。

关于「落盘完整却执行为空」的矛盾：两者读的是不同时刻 / 不同来源。真正落盘完整的是 buffer 最终累积的完整 args；而执行用的是 finish 处那次过早 flush 产出的空 block。修复后两者恒一致。

## 数据流

```
GLM SSE: [tool_call header] → [finish_reason + usage] → [reasoning] → [完整 arguments] → [DONE]
                                      │                                      │
                              旧:在此 flush                          新:在此(流末)才 flush
                              buffer 残缺 → JSON.parse 失败           buffer 完整 → 正确解析
                              → catch{} → 空 input → grep 报错        → 完整 input → grep 正常
```

## 修复（`src/api/openai-client.ts`）

`flushToolCalls` 改为双相，配合解析容错：

1. **延迟而非吞空**：`finish_reason` 触发的是非 final flush；对「非空但暂不可解析」的 arguments **保留在 buffer**（不发空 block、不整体清空），让 finish 之后到达的 arguments deltas 补齐；流末 flush 标 `final:true` 才发出完整 block。
2. **salvage**：`tryParseToolArguments` + `salvageFirstJsonObject` 处理两个工具调用共用 `index 0`（GLM 省略/重复 index）导致 args 被拼接成 `{...}{...}` 的情况，抢救首个合法对象。
3. **保留无参调用**：空 arguments → `{}`，不影响无参工具。
4. **不再静默**：最终仍无法解析时走 `warnToolArgParseFailure` 显式告警，并保留 `e1d9330f` 的 grep 报错文案（暴露实际 input keys + 流式解析嫌疑）。

诊断开关：`RIVET_DEBUG_TOOL_STREAM=1`（flush 阶段/buffer/args 采样）、`RIVET_DEBUG_RAW_SSE=1`（原始 SSE 落盘到 `<cwd>/.rivet/raw-sse[-<sessionId>].jsonl`，或设为路径）。

## 验证

- 回归测试 `openai-client-glm-toolcall.test.ts`：6 用例覆盖 baseline / 同 chunk finish / **finish 早到** / 缺 index / index 碰撞 / 无参调用。修复前 3 个 finish-早到类用例失败，修复后全绿。
- `tsc --noEmit` 干净；`src/api` 全目录 229 测试、相关回归 161 测试绿。
- **真实 GLM 实跑 5/5 通过**（含原会话失败的 `export function switchAgentRuntime|...` 与裸词 `switchAgentRuntime`）。

## 排查启示

- 「持久化完整 vs 执行为空」是不同时刻 / 不同数据源的产物——遇到这类悖论别死磕静态阅读，尽早转复现测试 + 真实抓包。
- 流式 provider 不能假设遵守 OpenAI 约定（finish_reason 之后不再有 content/args）。tool_call 的发出时机应锚定**流末**，而非 finish_reason。
- 静默 `catch { = {} }` 把传输/解析故障伪装成模型错误，是这类长链路最毒的反模式——失败要么 fail-loud，要么可观测。
