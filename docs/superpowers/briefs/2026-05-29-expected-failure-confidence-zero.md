# 隐患笔记：预期内失败被误记为认知失败 → "信心 0%" 自我打击

> 日期：2026-05-29
> 来源：外部 scout（Claude Code / Opus 4.7）审查时与用户讨论发现
> 关联：`9b6d589` fix(mirror): confidence → verification_coverage（同一个病的第一张脸）

## 一句话

intent-preview 显示的"信心 0%"，根因是 TDD 红灯（预期内的测试失败）被 `tool-pipeline.ts:607` 记成了认知预测失败，反向压低 vigor.phasic，触发"警觉模式 + 信心 0%"。这逼居民在最该自主的时刻怀疑自己、反复求确认——背离初衷。

这是 `verification_coverage` 那个病的**第三张脸**：用一个粗暴的客观信号（退出码）反推一个本不该如此的认知评分。

## 三张脸（同构）

| | 信号源 | 错误翻译 | 后果 |
|---|--------|---------|------|
| 脸1（已修 9b6d589）| evidence 为空 | confidence=1.00（0/0 空真） | 虚假满分自信 |
| 脸2（呈现层）| phasic 低 | "信心 0%" | 自我打击、求确认 |
| 脸3（根因层）| 测试非零退出 | prediction=error | 拉低 phasic，喂给脸2 |

## 根因数据流

```
bash 跑测试 → 红灯（非零退出） → harnessResult.isError = true
  → tool-pipeline.ts:607  recordPrediction(!isError) = recordPrediction(false)
  → prediction-error: 记为 "error"（predictions[] push false）
  → vigor.ts:82  phasic = actual - predicted 下降
  → intent-preview.ts:54  phasic < -0.5 → "警觉模式"
  → intent-preview.ts:41  confidenceFrom: base - phasicPenalty → 信心 0%
  → formatIntentPreview:73  "⟡ 处理 X — 信心 0% — 警觉模式 ..."
```

**核心错误**：`correct = !isError`（`tool-pipeline.ts:607`）把"工具执行报错"等同于"认知预测失败"。两者不同：
- `read_file` 路径不存在 → 认知失败（我以为文件在那），记 error 合理。
- TDD 写测试看红灯 → **预期内的成功**（我就是要它红来驱动实现），记 error 是错的。
两种红灯退出码相同，区别只在"是否预期"。

## 建议修法（先治标后治本，两层都要）

### 呈现层（治标，安全，立刻止血）

`intent-preview.ts` 的 `formatIntentPreview` / `confidenceFrom`：**去掉"信心 X%"这个会变成自我暗示的数字**，保留并前置客观 warning。

- 改前：`⟡ 处理 X — 信心 0% — 警觉模式：最近反馈显著低于预期 — [...]`
- 改后：`⟡ 处理 X — 警觉模式：最近反馈低于预期 — [...]`（让居民看见**为什么**该停一下，而不是一个打击性自评分）

理由：和 `9b6d589` 同一笔账——用可证伪的客观信号替换形而上的自我评分。即使底层 phasic 仍被压低，只要不翻译成"信心 0%"砸到脸上，脸2 的伤害就断了。`confidence` 字段可保留供内部 `shouldEscalate` 逻辑用，只是不再呈现给居民。

### 根因层（治本，需 RED 语义，做成独立带测试的改动）

`tool-pipeline.ts:607`：预期内的失败不该记成 prediction error。

- 难点：pipeline 怎么知道这次红灯是"预期的"？TDD 红灯和真 bug 红灯退出码一样，判定"预期性"需要阶段上下文。
- 现有抓手：`phaseHint`（`tool-pipeline.ts:108`）已贯穿 pipeline，deliver_task 已有 RED/GREEN 交付门语义（`deliver-task.ts:8-10`）。
- 方向（居民定细节，你们比我清楚当前 phaseHint 怎么取值）：当 `phaseHint` 指示处于"写测试 / verify-first / TDD RED"阶段时，测试工具的红灯**不计入** prediction error（或计为 neutral，不 push false）。只有"我以为会过却没过"才是真预测失败。
- 注意：别引入新误判——非 TDD 阶段的红灯仍是真失败，该记 error。这个改动的边界是"预期红灯"，不是"所有红灯"。

## 优先级

1. 呈现层一行级止血 —— 不阻塞，可立即做。
2. 根因层 —— 和 Anthropic client 的 H1 一起规划，做成有测试的独立改动。RED 语义的判定交给居民，因为你们最清楚 deliver_task / phaseHint 的实际取值。
