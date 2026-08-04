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

### Phase 2A — effort 路由（默认开，可用 `RIVET_EFFORT_ROUTING=0` 关闭）

- `src/agent/effort-routing.ts`：`routeRoutineEffort()` / `isEffortRoutingEnabled()`。
- 接线：`src/agent/turn-perception.ts`，用真实 sensorium 的
  `complexity / momentum / confidence`。仅"低复杂度 + (高 momentum 或高 confidence)"
  降一档；从不升档；floor 由 `ReasoningEffortController.set()` 下游钳制。
- DeepSeek 预设默认 effort：`v4-pro=high`、`v4-flash=low`（Chat 线上只认 low|high|max；UI 的 medium 映射为 low）。
- GlanceBar 展示 `◉N%` = reasoning / output 占比（有拆分数据时）。
- effort bandit 默认 `banditPromotion.effort=auto`：shadow 样本达标后真投票。

### Phase 2B — 自适应 verbosity（日常仍 opt-in；doom-loop 自动 escalate）

- `src/prompt/volatile.ts`：`renderTersenessNudge()` / `resolveTersenessFlags()`。
  - 日常：`RIVET_TERSE=1` 或 `ctx.tersenessEnabled` 开启。
  - doom-loop / storm：`turn-step-producer` 设 `tersenessEscalate`，自动注入更严 nudge
    （可用 `RIVET_TERSE=0` 彻底关闭）。
- 只进**动态 appendix**，frozen base 不动 → 默认会话字节不变（无 doom-loop 时）。

## 注意事项（坑位）

1. **`reasoning_tokens` 是 `output_tokens` 的子集，不是额外项**。算文本 token 用
   `text = output - reasoning`，不要把它加到 output 上重复计费。
2. **Anthropic 不暴露思考 token 拆分**：`reasoning_tokens` 在 Claude 路径恒为
   `undefined`（这是正确行为，不是 bug）。脚本对无拆分的会话诚实报"无数据"。
3. **Effort 路由默认开；日常 terseness 仍默认关**。关闭 effort：`RIVET_EFFORT_ROUTING=0`。
   开启日常 terse：`RIVET_TERSE=1`。彻底关闭含 doom-loop 的 terse：`RIVET_TERSE=0`。
4. **Phase 2B 故意没进 frozen base**。日常与 doom-loop escalate 都只进 appendix。
   代价：steering 力度略弱于 system prompt 级；收益：无 doom-loop 时默认零字节改动。
5. **terseness 只管输出散文，不降验证严谨度**。nudge 文案显式声明这点，避免与
   AGENTS.md"交付报告必须覆盖三项 / 不验证不声称完成"硬纪律打架——这是 terseness
   最经典的翻车方式。
6. **决策闸门是运行时步骤**。旧 cache-log 早于 Phase 0，无拆分字段；需跑新会话后再
   执行脚本看 verdict。
7. **共享工作区**：本次提交只含输出 token 优化相关文件；同期工作区另有并发会话的在途
   改动（dispatcher-hook / advisory-bus / activity-labels / ghost-render 等），不在本
   提交范围，其引入的 typecheck 报错与本改动无关。

## 后续（按优先级）

1. **跑基线 → 读 reasoning 占比**：`npx tsx scripts/analyze-output-tokens.ts`，确认
   effort 默认开后的账单结构；若仍 reasoning 主导，再考虑把 pro 默认降到 medium。
2. **effort bandit 真启用**：默认 `banditPromotion.effort=auto`；`isEffortGateOpen()` /
   `resolveBanditPromotion` 在样本与 reward margin 达标后启用真投票（仍可用
   `shadow` / `off` / `killSwitch` 回退）。
3. **GlanceBar/`/debug` 暴露 reasoning 占比**：GlanceBar 已展示 `◉N%`
   （reasoning/output）；事后分析仍可用 `analyze-output-tokens.ts`。
4. **若数据指向更强 terseness**：再评估把恒定 terseness 放 frozen base（一次性
   进缓存锚点，会话内仍稳定），届时需更新 engine-cache-stability 基线。
5. **自托管 MTP/FP4**：见 [deepseek-self-host-mtp-fp4.md](./deepseek-self-host-mtp-fp4.md)。

## 验证

- 单测：`effort-routing.test.ts`(6) + `terseness-nudge.test.ts`(6) + openai-client
  新增 reasoning_tokens 用例(5b/5c) 全过；`engine-cache-stability` / `volatile` /
  `codex-client` / `context` 回归全过（缓存稳定性不变）。
- 命令：`npx tsx --test src/agent/__tests__/effort-routing.test.ts src/prompt/__tests__/terseness-nudge.test.ts`
