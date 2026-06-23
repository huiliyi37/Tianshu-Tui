# 输出 Token 优化 — 度量优先 + 数据闸门

> 状态：Phase 0 + 2A + 2B 已落地（默认关，opt-in）。Phase 1 决策闸门为运行时步骤。
> 起点文档：`.rivet/plans/headroom-能力对标与原生增强方案.md`（P1/P2）。

## 背景与判断

最终文本输出本就很短，所以纯 verbosity steering 的边际价值低。但 `Usage`
此前只有一个 `output_tokens`，**没把 reasoning(思考)token 单独拆出来**——对
DeepSeek V4 这类思考模型，`output_tokens = 思考 + 文本`，钱很可能烧在思考上而
系统看不见。因此把顺序改成：**先打通拆分度量，再按数据决定是否干预、干预哪侧。**

```
reasoning >> text  → 杠杆是 effort 路由（Phase 2A）
text 主导          → 杠杆是 verbosity（Phase 2B）
两者都已很低        → 停止，不为优化而优化
```

## 已落地

### Phase 0 — 输出 token 拆分度量（默认生效，纯增量）

- `src/api/types.ts`：`Usage.reasoning_tokens?`（可选，**是 output 的子集，非叠加**）。
- `src/api/openai-client.ts`：两处 usage 构造 + `calibrateUsage` 透传
  `completion_tokens_details.reasoning_tokens`（DeepSeek / OpenAI 兼容）。
- `src/api/codex-client.ts`：`extractReasoningTokens()` 从 Responses API 的
  `output_tokens_details.reasoning_tokens` 取值，四处接通。
- `src/agent/loop-factory.ts`：cache-log entry 新增 `output` / `reasoning` / `text`
  字段（此前连 output 都未记录）。
- `src/agent/context.ts`：会话级累计同步 `reasoning_tokens`。
- `scripts/analyze-output-tokens.ts`：读 cache-log，按会话 + 总体输出拆分占比与
  verdict（2A / 2B / 停止）。

### Phase 2A — effort 路由（opt-in，默认关）

- `src/agent/effort-routing.ts`：`routeRoutineEffort()`，`RIVET_EFFORT_ROUTING=1` 开启。
- 接线：`src/agent/turn-perception.ts`，用真实 sensorium 的
  `complexity / momentum / confidence`。仅"低复杂度 + (高 momentum 或高 confidence)"
  降一档；从不升档；floor 由 `ReasoningEffortController.set()` 下游钳制。

### Phase 2B — 自适应 verbosity（opt-in，默认关）

- `src/prompt/volatile.ts`：`renderTersenessNudge()`，`RIVET_TERSE=1` 或
  `ctx.tersenessEnabled` 开启，支持 `tersenessEscalate`（doom-loop/storm 时更紧）。
- 只进**动态 appendix**，frozen base 不动 → 默认会话字节不变，缓存稳定性测试无需改。

## 注意事项（坑位）

1. **`reasoning_tokens` 是 `output_tokens` 的子集，不是额外项**。算文本 token 用
   `text = output - reasoning`，不要把它加到 output 上重复计费。
2. **Anthropic 不暴露思考 token 拆分**：`reasoning_tokens` 在 Claude 路径恒为
   `undefined`（这是正确行为，不是 bug）。脚本对无拆分的会话诚实报"无数据"。
3. **两个干预都默认关**。这是有意的——在 Phase 1 拿到数据前不改默认行为。开启方式：
   `RIVET_EFFORT_ROUTING=1` / `RIVET_TERSE=1`。
4. **Phase 2B 故意没进 frozen base**。原计划写"frozen base 恒定 + appendix 自适应"，
   为硬保"缓存测试不变"，恒定 + 自适应都放进 appendix 并改成 opt-in。代价：steering
   力度略弱于 system prompt 级；收益：默认零字节改动、缓存测试无需动。
5. **terseness 只管输出散文，不降验证严谨度**。nudge 文案显式声明这点，避免与
   AGENTS.md"交付报告必须覆盖三项 / 不验证不声称完成"硬纪律打架——这是 terseness
   最经典的翻车方式。
6. **决策闸门是运行时步骤**。旧 cache-log 早于 Phase 0，无拆分字段；需跑新会话后再
   执行脚本看 verdict。
7. **共享工作区**：本次提交只含输出 token 优化相关文件；同期工作区另有并发会话的在途
   改动（dispatcher-hook / advisory-bus / activity-labels / ghost-render 等），不在本
   提交范围，其引入的 typecheck 报错与本改动无关。

## 后续（按优先级）

1. **跑基线 → 读 verdict → 决定**：正常用几个真实会话后
   `npx tsx scripts/analyze-output-tokens.ts`，按 verdict 决定开 2A / 2B / 都不开。
   按"文本已很短"的直觉，大概率落在 2A 或"停止"。
2. **接 `tersenessEscalate` 到 doom-loop 信号**：当前 escalate 入参已就绪但调用方未
   接线。可挂 `getDoomLoopLevel()`（trace-store）在循环/storm 时置真。
3. **effort bandit 真启用评估**：`reasoning-effort-controller.ts` 已有 P3 shadow
   telemetry；待 `isEffortGateOpen()` 闸门(totalPulls≥30 且吻合率≥0.8)满足后，可考虑
   让 bandit 真投票，与 2A 的确定性 gate 二选一或叠加。
4. **GlanceBar/`/debug` 暴露 reasoning 占比**：把脚本的拆分做成实时面板一行，省得事后
   翻 cache-log。
5. **若数据指向 2B 且值得更强 steering**：再评估把恒定 terseness 放 frozen base（一次性
   进缓存锚点，会话内仍稳定），届时需更新 engine-cache-stability 基线。

## 验证

- 单测：`effort-routing.test.ts`(6) + `terseness-nudge.test.ts`(6) + openai-client
  新增 reasoning_tokens 用例(5b/5c) 全过；`engine-cache-stability` / `volatile` /
  `codex-client` / `context` 回归全过（缓存稳定性不变）。
- 命令：`npx tsx --test src/agent/__tests__/effort-routing.test.ts src/prompt/__tests__/terseness-nudge.test.ts`
