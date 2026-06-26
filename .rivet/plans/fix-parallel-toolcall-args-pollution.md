# 修复：并行 tool_call 流式参数污染 → grep pattern 丢失 → worker 无 JSON

> 2026-06-26。诊断证据来自主会话 `oh-my-pi/384919c7` 及其 reviewer worker `wo_09e8f6fd`。

## 现象 → 根因映射

用户报告的三类问题，按真实根因重新归因（原先"Flash 不会输出 JSON"的推断**错误**）：

| # | 报告的现象 | 真实根因 |
|---|-----------|---------|
| 1 | deliver_task auto review 100% 失败，"Parse failed after 3 attempts" / "Escalated: 4 consecutive failures" | reviewer worker 在审查中卡在**工具循环**耗尽 budget，从未输出 JSON。工具循环由下面的 grep 污染引起。 |
| 2 | "review worker 实际产出了审查内容（CompactionManager wire breaks）但嵌在非 JSON 文本里" | **这是真 findings**。worker 完成了高质量审查（5 条 CRITICAL/HIGH），承诺"Let me produce the final JSON"后去 grep 验证，grep 持续报错 → 耗尽 turns → 没机会收尾成 JSON。 |
| 3 | `read_section` 报 "Artifact not found" | **独立的第二个 bug**，不在本次修复范围（见"范围外"）。 |

## 真根因：并行 tool_call 流式参数污染

### 证据（worker `wo_09e8f6fd`，模型 `deepseek-v4-flash`）

1. worker 每个失败 grep 的 `arguments` **都是完整正确的**：
   `{"path":"packages/coding-agent/src","pattern":"\\.compactionManager\\.checkCompaction"}`
2. 但 grep 工具返回 `Error: pattern is required (non-empty string). Received input keys: **file_path, path**. pattern type: undefined.`
3. `file_path` 是 **read_section** 的字段，grep schema 里根本没有。两条失败的 grep（line 42/47）**恰好与 read_section 在同一并行批次**。
4. 所有失败 grep 都出现在**并行 tool_calls 批次**里（2-4 个同行）；单 grep 调用成功。
5. worker 反复换 grep 写法重试 8 次，全部同种失败——因为 bug 在 streaming 层，不在参数写法。

### 断裂点（`src/api/openai-client.ts`）

`processDelta` 处理 `delta.tool_calls` 时（L772-795）：

```typescript
const idx = tc.index ?? 0   // ← L774：trailing args chunk 缺 index 时归零
const buf = this.toolCallBuffer.get(idx) ?? { function: { arguments: '' } }
...
buf.function.arguments += tc.function.arguments   // ← 追加到 idx 的 buffer
```

DeepSeek/GLM 在 `finish_reason` **之后**追加 trailing arguments delta 时，这些 chunk **经常不带 `index`**（见既有回归测试 `tc.index omitted on continuation chunks`）。`?? 0` 把它们路由到 index 0 的 buffer：

- 若 index 0 是另一个工具（如 read_section），trailing args 追加进 read_section 的 buffer → read_section 的 input 被污染（`{file_path} + {path,pattern}`），且 grep 自己的 buffer 不完整。
- final flush 时 grep buffer parse 失败 → emit `input: {}`（L856）→ grep 报 "pattern is required"。
- 或 `salvageFirstJsonObject`（L45）从拼接串 `{...}{...}` 里取第一个对象 → grep 收到 read_section 的 `{file_path, section}`。

### 已复现

复现测试（驱动真实 `processDelta`/`flushToolCalls`，已验证两条污染路径）：

- 路径 A：trailing grep args 无 index → 污染 read_section buffer → grep emit `{}`。
  实测输出：`grep: {}` + `[tool-arg-parse-failure] id=... name=grep`。
- 路径 B：buffer 拼接成 `{file_path}{path,pattern}` → salvage 取第一个 → grep 收到 `{file_path, section}`。

### 与历史归档的关系

`.rivet/knowledge/debug-glm-flush-tool-args-loss.md`（2026-06-19）已定位过**同一 bug 的一条路径**（finish_reason 后 trailing args → 静默 `catch{input={}}`）。当时的修复（`57a2c0d1` + `82c05e4b`）：
- `flushToolCalls` defer 到 final flush；
- `tryParseToolArguments` 加 `salvageFirstJsonObject`；
- 6 个回归测试。

**但回归测试只覆盖 GLM 单工具 / 同类工具(grep+grep)碰撞，没覆盖：**
- (a) 不同工具（read_section + grep）在同一批次的跨 buffer 污染；
- (b) trailing args chunk 无 index 时 `?? 0` 把污染导向 index 0 的另一个工具。

这两条正是本次 100% 复现的盲区。

## 修复计划

### 改动 1（核心）：缺 index 的 continuation chunk 按内容归属，不归零

`src/api/openai-client.ts` `processDelta` 的 tool_calls 处理块。

现状：`const idx = tc.index ?? 0`。

改为：当 chunk 缺 `index` 时，先尝试按 `tc.id` 或 `tc.function.name` 在已存在的 buffer 里找到归属 entry；找不到才回退 0。这样 trailing args 不会误并入无关工具的 buffer。

判定优先级：
1. `tc.index` 存在 → 用它（不变）。
2. 缺 index 但有 `tc.id` → 查 buffer 里 `buf.id === tc.id` 的 entry。
3. 缺 index 且无 id，但本 stream 内**只有一个**未完成 buffer → 归属到它（最常见：单工具 finish_reason 后补 args）。
4. 缺 index 且无 id，但有多个未完成 buffer → 保守地**不追加**（丢弃该 delta 并 warn），避免污染。这比静默并入 index 0 安全——丢一个 trailing chunk 顶多让某个 call 的 JSON 少一段尾部（`salvageFirstJsonObject` 仍能尝试救），而并入错误 buffer 必然污染。

注：DeepSeek/GLM 的 trailing args delta 通常只带 `function.arguments` 片段（无 id/index/name），所以情况 3/4 是主要命中路径。情况 3 正确覆盖"单工具延迟补全"；情况 4 用 fail-safe 丢弃替代 fail-loud 污染。

### 改动 2（防御）：grep 收到空 input 时，错误信息提示上游污染

`src/tools/grep.ts` `execute`（L69-80）。

现状：`Received input keys: ${keySummary}`。当 `keys.length === 0` 时已提示"arguments may have failed to parse during streaming"。

补充：当 input 含跨工具字段（如 grep 收到 `file_path`）时，附加一句指向 streaming 污染的诊断。这是观测性改进，不改主流程——帮助下次问题被更快识别（本次就是因为错误信息里的 `file_path` 才锁定根因）。

### 改动 3（回归测试）：补两条跨工具污染用例

`src/api/__tests__/openai-client-glm-toolcall.test.ts` 新增：

- **read_section[0] + grep[1] 并行 + grep trailing args 无 index**：grep 的 pattern 必须存活，read_section 的 input 不含 grep 字段。
- **两个不同工具，trailing args 无 index 且多 buffer 未完成**：不产生污染块（情况 4），且任一已完整 parse 的 call 正常 emit。

## 验证

1. `npx tsx --test src/api/__tests__/openai-client-glm-toolcall.test.ts` 全绿（含新增用例）。
2. 既有 6 个用例不回归。
3. `npm run typecheck` 通过。

## 范围外（本次不修，记录待办）

- **artifact namespace mismatch**（现象 3）：worker 写 `<cwd>/.rivet/artifacts/worker-<orderId>/`，主会话 `ArtifactStore` 只索引自己的 sessionId。`buildPrimaryWorkerPacket`（`worker-prompts.ts:358-413`）的桥接 re-save 是死代码——`coordinator.ts` ~18 个调用点（828/836/859/877/992/1019/1176/1225/1431/1492/1510/1550/1593/1625/1628/1746）都没传 `artifactStore`。需单独修复，改动面大。
- **tierLock + 连续失败计数器措辞**："Escalated: 4 consecutive failures" 的 4 是 `getSummary().failed`（累计），不是 `consecutiveFailures`（3 触发）。显示误导但非 bug。

## 影响评估

- 改动 1 是 streaming 解析核心路径，影响**所有 provider 的所有 tool_call**。但新逻辑严格更保守（缺 index 时不再盲归零），对正确流（每个 chunk 都带 index）零影响。
- 情况 4 的"丢弃无 index delta"在最坏情况下让某个 tool_call 的 JSON 不完整 → 走既有的 final-flush warn + `input:{}` 路径，行为与修复前**一致**（修复前也是 input:{}`，只是污染了别的 call）。净效果：减少污染、不引入新失败模式。
