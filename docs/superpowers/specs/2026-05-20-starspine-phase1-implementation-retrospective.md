# StarSpine Phase 1 实施复盘：TaskContract + CognitiveLedger

> 日期：2026-05-20  
> 类型：实施复盘 / 迭代学习记录  
> 范围：TaskContract 防漂移锚点、CognitiveLedger 只读聚合、Prompt minimal projection、AgentLoop wiring  
> 状态：已实施并通过 targeted verification

---

## 1. 本轮目标

本轮目标是实现 StarSpine 的第一节脊柱：

```text
userInput
  → TaskContract
  → CognitiveLedger
  → minimal prompt projection
  → PromptEngine latest-turn context
```

核心不是增加一套新状态系统，而是在现有 EvidenceTracker / TraceStore / PromptEngine / AgentLoop 之上建立最小、可验证、可扩展的认知锚点。

---

## 2. 实际实施结果

### 新增文件

```text
src/context/task-contract.ts
src/context/cognitive-ledger.ts
src/context/__tests__/task-contract.test.ts
src/context/__tests__/cognitive-ledger.test.ts
```

### 修改文件

```text
src/agent/loop.ts
src/prompt/engine.ts
src/prompt/__tests__/engine-cache-stability.test.ts
docs/superpowers/plans/2026-05-20-starspine-phase1-task-contract-cognitive-ledger.md
```

### 核心能力

1. 从 `userInput` 提取 `TaskContract`。
2. 用 `isActionable` 区分真实任务与闲聊。
3. 从用户消息提取文件 scope 与约束。
4. Contract status 随 StarPhase phaseClass 单调推进。
5. CognitiveLedger 聚合 TaskContract / EvidenceState / TraceStore。
6. PromptEngine 只接收 projection string，不理解 TaskContract 对象。
7. Projection 注入 latest-turn dynamic context，不污染 system prompt / frozenBase。
8. Projection 更新会失效 `cachedFreshForUser`，避免 same-user tool-call turns 使用 stale context。

---

## 3. 关键架构决策

### 3.1 TaskContract / CognitiveLedger 放在 `src/context/`

原计划放在 `src/agent/`，但实施时调整为：

```text
src/context/task-contract.ts
src/context/cognitive-ledger.ts
```

原因：

- TaskContract 是认知上下文结构，不是 AgentLoop 私有状态。
- CognitiveLedger 是 runtime truth 的 read model，应供 agent / prompt / TUI / future coordinator 共享。
- 避免 `src/prompt/` import `src/agent/` 形成反向依赖。

最终依赖方向：

```text
agent/loop.ts ─┐
               ├── context/task-contract.ts
prompt/engine.ts ← projection string only
```

### 3.2 PromptEngine 只接收 projection string

没有实现：

```ts
setTaskContract(contract: TaskContract)
```

而是实现：

```ts
setCognitiveProjection(projection: string | null)
```

原因：

- PromptEngine 只负责 prompt 拼接，不应理解 agent lifecycle。
- 后续 projection 可从 TaskContract 扩展到 risks / verification gaps / worker facts，而无需修改 PromptEngine 类型依赖。
- 保持 prefix-cache 路径稳定。

### 3.3 CognitiveLedger 使用 pure functions，不用 class

实现为 plain object + pure functions：

```ts
createCognitiveLedger(input)
buildCognitivePromptProjection(ledger)
getCognitivePhaseSnapshot(ledger)
```

原因：

- 符合项目“data 不用 class”的约定。
- 便于序列化、测试、未来持久化。
- Phase 1 只需要 read model，无需封装 mutable state。

---

## 4. 实施中的 dead-end 与修正

### 4.1 Dead-end：用单一大正则提取约束

最初实现尝试用一个大正则同时处理：

- `Don't modify ...`
- `Must be ...`
- `不要改接口签名`

失败点：

1. 中文约束常常没有 marker 后空格，例如 `不要改接口签名`。
2. 英文多句约束容易被贪婪匹配吞并。
3. 大正则很快变成补洞游戏，难以维护。

### 4.2 修正：clause split + marker detection

最终改为：

```text
按中英文标点 / 换行切分 clause
  → 每个 clause 检测 constraint marker
  → 截断为 compact constraint
```

这条路径更稳，也更符合 Phase 1 的“短、硬、可验证”。

测试覆盖：

- 英文 `Don't` / `Must`
- 中文 `不要`
- 中英文混合
- XML escape

---

## 5. Cache 与 prompt 稳定性复盘

### 5.1 避免改 system prompt / frozenBase

Projection 注入 latest-turn dynamic context：

```text
stable system prompt: 不变
stable volatile / frozenBase: 不变
latest-turn dynamic appendix: 加入 cognitive projection
```

这样避免破坏：

- DeepSeek exact-prefix cache
- `PromptEngine.checkDrift()`
- 历史 volatile context 稳定性

### 5.2 发现并修复 same-user cache staleness 风险

PromptEngine 原本只在 user content 改变时重建 FRESH：

```ts
if (userContent !== this.cachedFreshForUser) { ... }
```

但 tool-call turns 中 user message 不变，而 contract status 可能变化。

修正：

```ts
setCognitiveProjection(...) {
  ...
  this.cachedFreshForUser = ''
}
```

新增测试证明：

- same-user projection update 会进入 prompt；
- fingerprint 不 drift。

---

## 6. 验证记录

已运行：

```bash
npx tsc --noEmit
```

结果：通过。

已运行 targeted tests：

```bash
./node_modules/.bin/tsx --test \
  src/context/__tests__/task-contract.test.ts \
  src/context/__tests__/cognitive-ledger.test.ts \
  src/prompt/__tests__/engine-cache-stability.test.ts \
  src/prompt/__tests__/engine.test.ts \
  src/agent/__tests__/loop.test.ts
```

结果：

```text
75 tests
75 pass
0 fail
```

---

## 7. 当前边界与尚未实现

Phase 1 已完成：

- TaskContract extraction
- CognitiveLedger read model
- Prompt minimal projection
- AgentLoop per-turn wiring

尚未实现：

1. TUI Mission / TaskContract 展示。
2. TaskContract 持久化到 session recovery。
3. 用户更正对 TaskContract 的 patch 机制。
4. WorkerResult 写入 CognitiveLedger。
5. Evidence-Belief-Decision 三元闭环。
6. Contract successCriteria 的真实验证 gate。

这些应作为 StarSpine Phase 2+ 逐步推进，不应塞入 Phase 1。

---

## 8. 后续建议

### 优先级 A：TUI Mission Strip

把 TaskContract 的 objective / status / file scope 显示在 Starbridge 或 SummaryBar 中，让用户看见 agent 当前任务锚点。

### 优先级 B：Contract Patch

支持用户说：

```text
不是这个目标，改成只修 src/api/client.ts
```

系统能 patch TaskContract，而不是另起一段自然语言上下文。

### 优先级 C：Verification Gap Projection

CognitiveLedger 后续可加入：

```text
modified files exist + no verification = verification gap
```

并以极小 projection 提醒模型不要过早交付。

---

## 9. 本轮经验

1. **计划是地图，不是领地。** 原计划方向正确，但文件边界和 PromptEngine 依赖需要主动调整。
2. **不要用复杂正则承载语义。** TaskContract 提取应采用更可解释的 clause pipeline。
3. **cache-aware feature 必须测试 same-user tool-call turns。** 只测新 user message 不够。
4. **StarSpine 应作为 context 中层，而不是 agent 私有实现。** 这样才能服务 prompt、TUI、subagent、session recovery。
5. **最小脊柱已经成立。** 下一步应从“模型知道任务”走向“用户也看见任务”。
