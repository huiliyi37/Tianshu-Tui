# GLM-5.2 flushToolCalls 静默吞参数 → grep 循环 → doom loop

> 2026-06-19 排查归档。跨会话协作定位的典型案例：天枢(GLM) 卡在静态推理循环，外部会话(Cursor/Claude) 用复现测试 3 分钟锁定根因。

## 现象

GLM-5.2 会话中 grep 工具反复报 "pattern is required (non-empty string)"，即使 LLM 返回的 arguments 明确包含非空 pattern 字段。连续失败触发 doom loop 检测器，agent 被降级后仍在循环。多个 GLM 会话重复此模式。

## 根因

`openai-client.ts` 的 `flushToolCalls` 在 `finish_reason` 到达时立即解析 buffer 中的 arguments JSON。GLM-5.2 thinking 流式会在 `finish_reason` **之后**继续发送 arguments 尾部 delta。此时 buffer 中的 JSON 不完整，`JSON.parse` 抛异常，catch 分支静默设 `input = {}`。工具收到空 input，grep 报 pattern 缺失。

```typescript
// 修复前（静默吞错误）
try { input = JSON.parse(buf.function.arguments) }
catch { input = {} }  // ← 这里

// 修复后（延迟 flush + final 时才 emit 空）
// finish_reason 时不立即清 buffer，parse 失败的 entry 留到流末 final flush
// 只有 final flush 仍 parse 失败才 emit 空 input 并打 warn 日志
```

修复提交：`57a2c0d1`（延迟 flush + salvageFirstJsonObject）+ `82c05e4b`（回归测试）。

## 悖论：为什么持久化的 arguments 是完整的

这是整个排查中最迷惑的点。JSONL 里落盘的 arguments 字符串完整且可 parse，但 grep 报 pattern 为空。

- `context.ts:219` 落盘用 `stableStringify(block.input)`
- 如果 block.input={} 则落盘应为 `"{}"`
- 但落盘的是完整 JSON

**解开：** `flushToolCalls` 在 `finish_reason` 时跑一次（此时可能 parse 失败产出空 block），流末尾再跑一次（此时 buffer 已被前一次 flush 清空，后续 delta 创建了新 entry 但无 id/name 被跳过）。但 turn-orchestrator 的执行顺序是先 `addAssistantBlocks`（落盘）再 `executeBatch`（执行）——如果落盘发生在 flush 之后、执行之前，block.input 已被第一次 flush 设为空。

实际上这个悖论从未被完全静态解明。外部会话绕过了它——不去管持久化为什么显示完整，直接测 `flushToolCalls` 在各种 chunk 序列下产出什么。

## 两条排查路径对比

### 天枢路径（卡在静态推理）

1. 读 JSONL 发现悖论（持久化完整 vs 工具收到空）
2. 读 static.ts → context.ts → turn-stream.ts → tool-pipeline.ts → repair-pipeline.ts → repair-passes.ts → hooks/registry.ts（6 个文件）
3. 每个文件都在排除"谁删了 pattern"——没人删
4. 被悖论锚定，反复推理"如果 block.input 空则落盘应该空，但落盘不空"
5. grep 工具本身也在失败（正在调查的 bug 恰好命中了排查工具），排查能力降级
6. doom loop 检测器介入，block bash 调用，进一步限制排查能力
7. **始终没有写复现测试**

### 外部会话路径（Claude via Cursor）

1. 同样读 JSONL 发现悖论
2. 同样读代码排除 4 条路径（去重/hook/repair/跨 turn 泄漏）
3. **注意到 `processDelta` 标注 "exposed for testing"**——可以直接喂数据进去
4. 写 5 个 chunk 序列用例驱动 `processDelta` + `flushToolCalls`
5. "finish_reason 早于尾部 args" 用例 RED，根因锁定
6. 总耗时 ~3 分钟

### 差异的根因不是模型能力，是行为约束

天枢的提示词有三条合谋阻止策略切换：

1. **evidence-scope**："改代码前先读相关代码"——把"查证"等同于"读"
2. **穷尽查证**："穷尽所有可用查证手段（recall → glob/grep → read_file）"——手段列表里没有"写测试做实验"
3. **开发循环**："读 → 改 → diff → tsc + test"——测试在"改"之后，不把测试当诊断工具

修复（提交 `cd7030d2`）：evidence-scope 加「诊断策略切换」——当两个已验证事实互相矛盾时，强制停止读文件，升级为写最小复现测试。连续读 3+ 文件未排除矛盾时硬性触发。

## doom loop 检测器的角色

doom loop 检测器在这条链路上是**唯一正常工作**的组件。它准确识别了"同一工具反复失败"并介入。问题不在它身上——在它上游的 `flushToolCalls` 制造了无法自行恢复的失败循环：

```
flushToolCalls 静默吞参数 → grep 收到空 input → 报 "pattern is required"
→ GLM 认为是自己参数写法不对 → 换变体重试 → 还是空 input（flush 的 bug）
→ 连续失败触发 doom loop → 降级 → 仍在循环
```

## 蒸馏教训

1. **静态推理有边界。** 当两个已验证事实互相矛盾时，继续读代码的边际收益趋零。此时正确的做法是写一个最小复现测试直接驱动疑似函数——3 行探针比 6 个文件的推理链更有决定性。

2. **悖论是策略切换的信号。** 不要试图通过读更多代码来消除矛盾——让代码自己说话。

3. **测试不只是验证修复的工具，更是定位根因的工具。** 开发循环里测试在"改"之后（验证修复）；诊断循环里测试在"改"之前（定位根因）。

4. **"exposed for testing" 是邀请。** 当源码标注一个函数可测试时，优先用它构造复现——不要绕过它去追整条数据流。

5. **安全机制（doom loop）在 bug 链路上可能被误读为"问题的一部分"。** 实际上它拦的就是真实循环——真正的 bug 在上游制造了循环条件。

## 关键文件索引

| 文件 | 角色 |
|------|------|
| `src/api/openai-client.ts:flushToolCalls` | bug 所在（L740-L770） |
| `src/api/openai-client.ts:tryParseToolArguments` | 修复后的解析函数 |
| `src/api/__tests__/openai-client-glm-toolcall.test.ts` | 6 个回归用例 |
| `src/tools/grep.ts:parseGrepPattern` | 报错的函数（已加诊断文案） |
| `src/prompt/static.ts:evidence-scope` | 诊断策略切换规则 |
| `src/agent/context.ts:219` | 落盘路径（stableStringify block.input） |
