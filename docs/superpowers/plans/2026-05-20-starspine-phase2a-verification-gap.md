# StarSpine Phase 2A：Verification Gap Projection 实施记录

> 日期：2026-05-20  
> 类型：小步实施计划 / 可靠性交付门控  
> 状态：执行中  
> 前置：StarSpine Phase 1 TaskContract + CognitiveLedger 已落地

---

## 目标

让 StarSpine 从“任务锚点”推进到“交付门控”：

> 只要有修改但未验证，天枢的认知脊柱就必须提醒自己：还不能声称完成。

Phase 2A 只做最小 prompt projection，不做 TUI、不做 contract patch、不处理 failed repair 路径。

---

## 设计决策

### 1. 只在 `deliveryStatus === 'unverified'` 时投影

触发条件：

```ts
evidence.filesModified.size > 0 && evidence.deliveryStatus === 'unverified'
```

不触发条件：

- 没有修改文件；
- 已 verified；
- failed；
- blocked。

### 2. failed 不投影 verification-gap

`deliveryStatus === 'failed'` 时不生成 `<verification-gap>`。

原因：failed 路径已有 repairHint / failure-classifier 提示修复；再投影 verification-gap 会产生重复信号，降低提示清晰度。

### 3. Projection 必须极短

格式：

```xml
<verification-gap status="unverified" modified="N">Run relevant verification before claiming done.</verification-gap>
```

目标：小于 160 chars。

---

## 修改范围

```text
src/context/cognitive-ledger.ts
src/context/__tests__/cognitive-ledger.test.ts
```

不修改：

- system prompt；
- frozen volatile；
- PromptEngine API；
- AgentLoop wiring；
- TUI。

---

## 测试覆盖

1. no modified files → no gap
2. modified + unverified → gap exists
3. modified + verified → no gap
4. modified + failed → no gap
5. modified + blocked → no gap
6. buildCognitivePromptProjection 同时包含 TaskContract + verification-gap
7. no contract 时仍可只投影 verification-gap

---

## 后续边界

Phase 2A 不解决：

- TUI Mission Strip；
- Contract Patch；
- failed repair projection；
- successCriteria verification gate；
- subagent verification facts。

这些应进入 Phase 2B+。
