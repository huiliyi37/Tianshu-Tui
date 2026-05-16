# Rivet Attention Anchor Dispersal 设计

## 背景

用户观察：模型在收到具体指令后，注意力坍缩到指令锚点，反复产出最小修复补丁而非整体方案。能力从 100 降到 80。需要一种机制让模型在复杂任务中被强制拉回全局视角。

参考论文：Temporal Straightening（时间拉直）— 用户要求逆向思考：不是让轨迹更直（更可预测），而是在关键点引入受控曲率（强制模型看向侧面）。

当前 Rivet 状态：
- System prompt 有 `verify-first` 和 `before-implementing` 规则，但纯文本无强制力
- Volatile context 注入 git status（仅 branch + short status），无 git log
- Trajectory 存在但不直接对模型可见（仅通过 task-state 间接暴露 5 条）
- ContextAnchor 类型已定义（支持 decision/error/preference），但 anchors 始终为空
- Session memory 存在但无自动决策点捕获

---

## 设计哲学："模型不需要被命令做什么，它需要被展示它正在做什么"

跨学科调研的核心收敛：

| 领域 | 机制 | 对 Rivet 的启示 |
|------|------|----------------|
| 认知神经科学 | 散焦注意力双向因果提升创造性 | 被动注入全局信息拓宽模型"注意力范围" |
| 认知神经科学 | 孵化效应对困难问题效果最大 | 复杂任务时注入"暂停+回顾"信号 |
| 生物学 | Bet hedging 以 1-5% 恒定成本运行 | Always-on 的 git log 注入是"探索预算" |
| 生物学 | 边际值定理：边际收益 < 平均时离开 | 检测"进展停滞"触发策略切换 |
| 编译器 | Analysis pass 廉价且强制 | 信息注入是"廉价分析"，不是额外 turn |
| 编译器 | LICM 将重复局部修复提升为架构修改 | 检测重复模式 → 提示模型升级修复层级 |
| 棋类 AI | UCB 探索项确保被忽略选项获得注意力 | Mirror 提示确保模型注意到自己的盲点 |

**反直觉但有证据的关键洞察**：
1. 问题越难，分散注意力越有效（孵化效应）
2. 不需要失败信号才触发探索（bet hedging）
3. 当前方案置信度越高越该分散（UCB 设计核心）
4. 分析是廉价的，执行才昂贵（编译器 pass manager）

---

## 推荐方案：三层防御

```text
Layer 1: Always-On (每轮)
  └── <recent-commits> — 最近 5 条 git log，~60 tokens
      → 模型被动知道"项目最近发生了什么"

Layer 2: Triggered (条件触发)
  └── <behavior-mirror> — 仅在检测到重复模式时注入，~50 tokens
      → 模型被主动告知"你在重复/停滞"

Layer 3: Persistent (跨 compaction)
  └── <decisions> — 自动提取的决策点锚点，~40 tokens
      → compaction 后模型仍知道"之前决定了什么"
```

### Layer 1：Recent Commits 注入

修改 `src/prompt/volatile-git.ts`，在 `loadGitStatus()` 中加入 `git log --oneline -5`。

注入格式：
```xml
<recent-commits>
f2e69ff feat(tui): add Ctrl+C soft interrupt
6ee4ef8 fix(agent): address execution resilience review findings
119f102 docs: mark execution resilience plan complete
f709e85 fix(security): shell injection, SSRF protection
ae429bc feat(tui): wire trajectory stats into SummaryBar
</recent-commits>
```

设计决策：
- 固定 5 条（不多不少：3 条太少看不到趋势，10 条太多浪费 token）
- 只在 git repo 中且有 commit 时注入
- 在 volatile block 中（不影响 frozen prefix）

### Layer 2：Behavior Mirror

修改 `src/agent/task-state.ts`，新增 `detectPatterns()` 函数。

检测 3 种模式：

| 模式 | 检测条件 | Mirror 文本 |
|------|---------|------------|
| 重复编辑 | 同一文件在 trajectory 中出现 3+ 次 | "你已经编辑 {file} {N} 次了。根因是什么？是否需要更高层级的修复？" |
| 错误循环 | 同类 errorClass 出现 2+ 次 | "同类错误 ({class}) 已出现 {N} 次。当前方法可能不是正确路径。" |
| 未验证 | 连续 3+ 次 edit/write 后无 run_tests/bash | "你已经连续修改 {N} 个文件但未验证。建议先运行测试确认方向正确。" |

注入格式：
```xml
<behavior-mirror>
你已经编辑 src/auth/middleware.ts 3 次了。根因是什么？是否需要更高层级的修复？
</behavior-mirror>
```

设计决策：
- 只在 turn > 3 时激活（简单任务不需要）
- 用问句而非命令（"根因是什么？"比"请先分析根因"对 DeepSeek 更有效）
- 最多 1 条 mirror（避免信息过载）
- 优先级：错误循环 > 重复编辑 > 未验证

### Layer 3：Decision Anchors

激活已有的 `ContextAnchor` 类型。

从模型输出中自动检测决策语句：
```typescript
const DECISION_RE = /(?:I'll|I will|方案是|我决定|approach:|plan:)\s*(.{10,80})/gi
```

注入格式：
```xml
<decisions recent="2">
  <decision turn="3">Use middleware pattern for auth instead of decorator</decision>
  <decision turn="5">Split monolith into context/ module structure</decision>
</decisions>
```

设计决策：
- 最多保留 3 个最近决策（token 预算）
- 跨 compaction 持久化（写入 session-memory 的 `decision` 类型）
- 只在 turn > 5 时开始注入（需要积累足够决策）

---

## 与已有设计的关系

| 已有设计 | 本方案关系 |
|---------|-----------|
| Task State (`<task-progress>`) | Layer 2 的 mirror 是 task-state 的"警告扩展" |
| Trajectory Recorder | Layer 2 的数据源 |
| Session Memory | Layer 3 的持久化后端 |
| Volatile Context | 所有 3 层的注入载体 |
| TurnHarness | Layer 2 的检测可以在 harness 的 onAfterTool hook 中触发 |
| Glanceable Cockpit | SummaryBar 可以展示 mirror 状态（是否触发） |

---

## 风险与应对

### 风险 1：DeepSeek 忽略注入信息

应对：
- Mirror 用问句设计（触发模型的 QA 训练）
- Git log 是纯事实信息（模型倾向于引用事实）
- 如果完全无效，Layer 1 仍有零害处（信息在那里，不增加成本）

### 风险 2：Volatile block 过大

应对：
- 3 层总计 ~150 tokens（git 60 + mirror 50 + decisions 40）
- 当前 volatile block 约 500-800 tokens，增加 ~20%
- 如果超过 2000 tokens 阈值，按优先级裁剪：先去 decisions，再去 mirror，git log 保留

### 风险 3：Mirror 误报

应对：
- 阈值保守（3 次重复才触发，不是 2 次）
- 误报只是多了一个问句，不会阻止执行
- Phase 3 的 A/B 测试会调优阈值

### 风险 4：Decision 检测正则不准

应对：
- 宁可漏检不可误检（保守正则）
- 误检的 decision 只是多了一行无害文本
- 可以在 /memory 命令中手动修正

---

## 规格自检

- **占位符**：无 TODO、待定
- **内部一致性**：3 层互不冲突，各有独立触发条件
- **范围**：聚焦 volatile context 注入 + task-state 扩展，不涉及 agent loop 核心逻辑
- **模糊性**：检测条件有精确阈值，注入格式有精确 XML schema

---

## 下一步

创建实施计划，3 个 Phase 各 3 天。
