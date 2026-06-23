# 调查报告：LLM Compact 摘要质量与信息保护机制

> 调查时间：2026-06-23 | 状态：已验证，原审查核心成立但遗漏了多层保护
> 核实时间：2026-06-23 | 核实结论：文档核心断言成立；补充了 partial compact 无 TaskAnchor 交叉缺口（缺口表 C 新增行）、P0 persist 执行顺序陷阱（第 8 节 P3）、token 估算口径偏差（第 8 节 P4，详见 issue 1 第 3 节）、测试 P2.1 虚假绿灯前置条件（第 8 节 P0）、优先级修订

## 结论

原审查的核心判断成立：`llmCompact` 将完整会话历史交给模型，输出预算相对 1M 窗口确实极端（最高 8K 字符），且**没有摘要质量校验**。但审查低估了已有的多层确定性保护机制（15+ 项），也高估了 `buildTaskAnchorAppendix` 的局限性——实际包含 constraints、success criteria、scope 与进度。

**严重程度修正**：1M 路径中等（有 partial + task-anchor 缓冲）；<1M tier-2 micro compact 较高；摘要质量不可控是系统性设计债。

---

## 1. 摘要预算的真实数据

`src/compact/constants.ts:128-131`:

| 窗口大小 | full 预算 | partial 预算 |
|---------|-----------|-------------|
| < 500K | 3,000 字符 | 2,000 字符 |
| 500K - 1M | 6,000 字符 | 4,000 字符 |
| ≥ 1M | 8,000 字符 | 5,000 字符 |

**修正**：不是固定 3K-8K，而是三级分档。1M 窗口实际压缩比取决于 partial vs full：
- **partial compact**：仅压缩 old zone（保留 anchor 2 条 + recent 60 条），压缩比远低于 100:1
- **full compact**（75%+ 或 86% split）：整个历史 → 8K 字符 + fallback，压缩比确实极高

---

## 2. LLM Compact Prompt 分析

### 2.1 llmCompact（行 922-995）

Prompt 要求保留：
1. 用户核心需求与意图演变（**用户纠正优先**）
2. 关键技术决策及原因
3. 文件路径与变更摘要
4. 错误与修复
5. 当前工作状态与进度
6. 待办与下一步

要求丢弃：工具输出细节、探索中间过程、重复状态汇报。

**用户意图链**（`extractUserIntentChain`，行 27-40）：从消息中提取最近 20 条用户消息、每条 300 字符，在 prompt 中逐条列出并要求"不得合并或遗漏"。

**局限**：最多 20×300 字符；multimodal user 未处理；无 hallucination 检测。

### 2.2 tryPartialCompact vs llmCompact

| 维度 | partial | full |
|------|---------|------|
| 压缩范围 | 仅 old zone（anchor 后 ~splitPoint） | 全历史 |
| 近期消息 | **保留 recent 60 条完整** | 全部替换为摘要 |
| 预算 | partial（1M→5000 字） | full（1M→8000 字） |
| prompt 强度 | 保留列表，无"必须逐条" | "必须完整保留的用户意图链" + 纠正优先 |
| task-anchor | **不注入** | 经 `replaceWithCheckpoint` 注入 |

---

## 3. 信息保护机制完整清单

### A. 非 LLM（确定性）保护

| 机制 | 保护内容 | 触发路径 | 位置 |
|------|---------|---------|------|
| Cache anchor（前 2 消息） | 初始 user/assistant | checkpoint / partial / split | `constants.ts:110` |
| `buildCompactSummary` | Goals / Progress / Files / Errors（零 LLM 成本） | maybeCompact tier≥2 | `compaction-controller.ts:212-250` |
| `buildStructuredHandoff` | 9 段结构化交接 + 工具轨迹 + reasoning 片段 | session split fallback | `124-203` |
| `renderTaskAnchor` | objective / constraints / successCriteria / scope / completed / remaining（各≤6 项） | replaceWithCheckpoint、tier≥2 | `task-contract.ts:269-296` |
| TodoStore 进程单例 | 权威 todo 列表（completed / in_progress / pending） | turn>3 每轮 `setTaskProgress` | `turn-end.ts:38-41` |
| `extractTaskState` / `taskStateFromTodos` | current / completed / remaining / decisions | 每 turn volatile；handoff/summary | `task-state.ts` |
| Trajectory 结构化记录 | tool / target / status / errorClass | handoff / errors 段 | `trajectory.ts` |
| `microCompactOai` | 截断旧 tool_result，保留 recent 4 条 | <1M tier compact；heap compact | `compact/micro.ts` |
| `compactStaleRoundsOai` | 截断 N-2+ 轮 tool 结果 | <1M, turn=0 | `compact-boundary-coordinator.ts:111-138` |
| `findSafeSplitPoint` | 不切断 tool_calls ↔ tool 组 | partial compact | `compaction-controller.ts:54-84` |
| `runResumePreflightOai` | 修复 orphan tool_call | 所有 safeReplace | `720-725` |
| `persistExtractedMemories` | 启发式 memory 条目（≤20 条） | **仅 ceiling 95% / split 86%** | `728-744` |
| Plan trace appendix | 计划步骤 XML（跨 compact 存活） | 下 user 边界注入 | volatile appendix |
| Playbook / claims / pheromones | 跨会话教训与声明 | hook 通道 | 多处 |
| Session memory 文件 | 磁盘记忆（启动加载） | `.rivet/sessions/<id>.memory.json` | `session-persist.ts:412-414` |

### B. LLM 依赖

| 机制 | 风险 |
|------|------|
| `llmCompact` 摘要 | 幻觉、遗漏、超预算 |
| `tryPartialCompact` old zone 摘要 | 同上；但 recent 60 条完整 |
| LLM compact prompt 中的意图链 | 仅 prompt 约束，无执行校验 |

### C. 已知缺口

| 缺口 | 影响 | 来源 |
|------|------|------|
| **摘要质量无校验** | 幻觉或遗漏无法检测 | 系统性 |
| **maybeCompact / partial 不 persist memory** | 常规 compact 路径丢失启发式记忆 | `docs/superpowers/plans/2026-06-01-project-memory-system.md` P4 已提 |
| **compact 后不热更新 session memory** | 同会话 prompt 看不到新提取的记忆 | `loop.ts:401-411` 仅 appendMemory |
| **followUp 不更新 TaskContract** | 短纠正/约束变更不进 task-anchor | `turn-step-producer.ts:197-200` |
| **multimodal 用户消息意图链** | 非 string content 被跳过 | `extractUserIntentChain:34` |
| **partial compact 不注入 TaskAnchor** | LLM 摘要丢 constraints/scope 后无确定性后备（issue 1 × issue 2 交叉点） | `tryPartialCompact:902-905` vs `replaceWithCheckpoint:787-793` |

---

## 4. session-memory-extract 评估

`src/agent/session-memory-extract.ts`:

**提取类型**：

| kind | 来源 | 启发式规则 |
|------|------|---------|
| `user_preference` | user | `always/never/prefer/must/不要...` |
| `decision` | assistant | `decided/chose/strategy/because...` |
| `file_observation` | tool + recentToolTargets | 文件路径 regex |
| `failure_pattern` | tool | Error/TypeError/failed... |
| `task_state` | assistant | todo/next/remaining... |

**限制**：
- 去重后最多 20 条，每条 300 字符
- 非 LLM，纯启发式 regex
- **仅在 86% split 和 95% ceiling 时触发**——常规 compact 不调用
- 同会话写入磁盘但**不热更新 prompt**

**评估**：弱补救，不能替代完整历史。跨会话有用（下次启动加载），同会话价值有限。

---

## 5. TaskContract 补救范围（修正原审查）

原审查说"buildTaskAnchorAppendix 仅覆盖任务目标"——**不准确**。

`src/context/task-contract.ts:269-296` 的 `renderTaskAnchor` 包含：

- **objective**（任务目标）
- **scope.mentionedFiles**（涉及文件，≤6）
- **constraints**（禁止项/约束，≤6）
- **successCriteria**（成功标准，≤2）
- **progress.completed**（已完成，最近 6 项）
- **progress.remaining**（待做，前 6 项）
- 声明为 `authoritative="true"`——summary 冲突时以此为准

**但有限制**：`followUp` 模式继承旧 contract，短纠正/约束变更不进入。

---

## 6. 用户纠正的存活路径

用户在会话中纠正 agent 理解时，纠正能否在压缩后存活？

| 路径 | 能否存活 | 条件 |
|------|---------|------|
| LLM 摘要 | **部分** | prompt 明确要求"用户纠正优先"，但依赖模型遵守 |
| TaskContract | **视模式** | 新 `task` turn 会重建 contract；`followUp` 继承旧的不更新 |
| 意图链（extractUserIntentChain） | **部分** | 最近 20 条×300 字符，作为 LLM prompt 辅助 |
| session-memory-extract | **偶尔** | 仅 `user_preference` 类提取；仅紧急路径持久化 |
| partial compact recent 60 | **是** | 如果纠正在最近 60 条消息内 |

**结论**：用户纠正的存活没有确定性保证，主要依赖 LLM 摘要的自觉和 partial compact 的 recent 保留。

---

## 7. 严重程度评估

| 场景 | 严重度 | 理由 |
|------|--------|------|
| 1M partial compact（60-75%） | **中** | recent 60 保留 + 延迟 compact；摘要丢失主要影响 old zone |
| 1M full compact / 95% ceiling | **中高** | 历史 collapse 为 8K + anchor；fallback 可极瘦 |
| <1M tier-2 micro compact | **高** | 确定性 summary 启发式弱 + 可能无 LLM；task-anchor 依赖 contract |
| 无摘要质量校验 | **高（设计债）** | 系统性风险，与窗口大小无关 |
| followUp 用户纠正 | **中** | contract 不更新；依赖 LLM 摘要自觉 |
| session-memory 作为安全网 | **低~中** | 仅 86%/95% 写入；不热更新 |

---

## 8. 改进方向（含核实后优先级修订）

综合调查发现和逐条核实，按依赖关系排序：

1. **P0：修测试 P2.1 的虚假绿灯**（前置条件，详见 issue 1 文档）
   `makeController` 默认不含 `primaryClient`，60%/75% 分支从未被测到。必须先修好测试，后续改动才有回归保护。

2. **P1：partial compact 路径注入 TaskAnchor**
   在 `tryPartialCompact` 的 `safeReplaceMessages` 之后加 `buildTaskAnchorAppendix()` 调用。一行代码，补上 issue 1 × issue 2 交叉缺口。

3. **P2：1M 路径加 `isCachePreservingProvider` gate**（详见 issue 1 文档）

4. **P3：maybeCompact / partial persist memory + 热更新**
   `persistExtractedMemories` 必须在 `safeReplaceMessages` **之前**调用（`enforceContextCeiling` 已遵循此顺序：行 517 persist → 行 527 replace）。persist 后还需 `updateSessionMemory(buildMemoryBlock())` 热更新到当前 prompt。

5. **P4：统一 token 估算口径**（详见 issue 1 文档第 3 节）
   T7 的 `estChars/4` 对 CJK 低估 3.3 倍，是"统一决策路径"方向的技术前提。

6. **P5**：`followUp` 含 CONSTRAINT_MARKER 或显式纠正时 merge 进 TaskContract
7. **P6**：摘要 post-check（对照 todo/trajectory 必填字段校验）；失败回退 `buildStructuredHandoff`
8. **P7**：E2E 测试：模拟 30+ turn → partial → 断言 objective/constraints/todo 仍在 prompt

---

## 涉及文件

- `src/agent/compaction-controller.ts` — llmCompact（922-995）、tryPartialCompact（815-912）、buildCompactSummary（212-250）、replaceWithCheckpoint（772-807）、persistExtractedMemories（728-744）
- `src/agent/session-memory-extract.ts` — extractSessionMemories、启发式规则
- `src/agent/task-state.ts` — extractTaskState（17-44）、taskStateFromTodos（56-74）
- `src/context/task-contract.ts` — renderTaskAnchor（269-296）、extractTaskContract（184-206）
- `src/compact/constants.ts` — summaryOutputBudgetChars（128-132）
- `src/agent/turn-step-producer.ts` — followUp contract 继承（197-200）
- `src/agent/turn-end.ts` — TodoStore → setTaskProgress（32-42）
- `src/prompt/engine.ts` — T7 token 估算口径（548-558）、COLLAPSE_FLOOR_FILL_RATIO（52）
- `src/agent/context.ts` — session 层 getEstimatedTokens（331-333）、estimateOaiMessageTokens CJK 感知
- `src/compact/micro.ts` — estimateOaiMessageTokens CJK 分叉（77-94）
- `src/agent/__tests__/compaction-controller.test.ts` — P2.1 虚假绿灯（191-245）、makeController 无 primaryClient（21-32）
