# DeepSeek 自托管：MTP / FP4 与 Harness 投机解码职责边界

> 面向自托管 DeepSeek V4（vLLM / SGLang / TensorRT-LLM 等）的运维与 harness 集成说明。
> 云端官方 API 用户可跳过；本文件只澄清「引擎侧加速」与「天枢侧 speculation」不要叠床架屋。

## 一句话边界

| 层 | 负责什么 | 不负责什么 |
|----|----------|------------|
| **推理引擎 MTP / FP4** | 单请求内的 token 级加速（草稿 token、量化权重） | 跨工具轮的语义预测、前缀缓存策略、effort 路由 |
| **天枢 Harness speculation** | 跨轮 / 跨工具的侧路预测（llm-speculation）、前缀缓存友好的请求整形 | 引擎内部的 draft model、KV 量化算法 |

两者正交：**引擎加速降低单次 TTFT/TPOT；harness speculation 降低「等工具结果再开下一轮」的空窗。** 不要用 harness 去模拟 MTP，也不要用 MTP 开关去替代 `RIVET_*` speculation 闸门。

## MTP（Multi-Token Prediction）

- **位置**：模型服务端（自托管权重 + 推理框架）。
- **效果**：一次前向产出多个后续 token 草案，接受/拒绝后仍保证与自回归分布一致（框架保证）。
- **对天枢**：透明。天枢仍发标准 Chat Completions / Responses 请求；无需改 `openai-client` body。
- **注意**：MTP 不改变 `reasoning_effort` 语义，也不减少账单上的 reasoning token（若网关按输出计费，接受的 token 仍计）。

## FP4 / 量化

- **位置**：权重与激活量化（框架相关；FP4 为低比特权重路径的一种）。
- **效果**：吞吐↑、显存↓；可能轻微影响长链 tool-calling 稳定性。
- **对天枢**：仍走同一 API。若自托管 Flash 在 `max` effort 下出现空响应 / length 截断，优先检查 `max_tokens` 与框架对 thinking 的截断策略，而不是开 harness speculation。

## Harness 侧 speculation（天枢）

落点：`src/agent/llm-speculation.ts` 及相关 hook。

- **职责**：在工具执行间隙，用便宜侧路模型（常为 Flash）预读下一轮可能动作；命中则省一轮主路径等待。
- **约束**：
  - 侧路请求必须 copy-on-write，禁止原地 mutation 主请求消息（前缀缓存事故链）。
  - 侧路不得带主路径专属 `prefixProbe`。
  - 与引擎 MTP **不共享** draft 状态；侧路失败应静默降级，不影响主轮。
- **开关**：见 `RIVET_*` speculation / llm-speculation 相关环境变量与 config；与 `RIVET_DEEPSEEK_RESPONSES`（Responses 双栈）无关。

## 推荐组合

1. **云端官方 API**：只开 harness 侧 effort 路由 +（可选）llm-speculation；无 MTP/FP4 可配。
2. **自托管高吞吐**：引擎开 MTP/FP4；harness 保持默认 speculation 策略；**不要**为「已经开了 MTP」而关闭前缀缓存工程。
3. **自托管省成本**：Flash + Chat Completions + effort `low`/`high`；Responses 双栈仅 Flash（`protocol: responses` 或 `RIVET_DEEPSEEK_RESPONSES=1`）。

## 相关代码

- Effort 线上归一：`src/api/deepseek-effort.ts`
- Responses 双栈：`src/api/deepseek-responses.ts` / `deepseek-responses-client.ts`
- Conformance：`src/api/conformance-scorecard.ts`（`deepseek_dual_stack` / `deepseek_effort_norm`）
- 投机侧路：`src/agent/llm-speculation.ts`
