# Project Memory 架构冲突分析

> 日期：2026-06-01 | 作者：天枢（DeepSeek V4）| 触发：P4-P6 方案评审发现 manifest 违规

## 1. 结论先说

**P4-P6 方案的写入方向正确，但注入路径违反了已有架构决策。**

具体冲突：
- `.rivet/knowledge/manifest.md` 明确规定：`project memory does not enter volatile prompt, recall is the access path`
- `docs/superpowers/plans/2026-05-27-项目记忆按需召回.md` 是经过天权审查后落地的方案，**刻意移除了** project memory 的 prompt 注入
- 但 commit `079a05d` 在实现 P1-P3 时，**重新引入了** `projectMemoryBlock` 到 volatile prompt
- 我更新的 P4-P6 方案（`2026-06-01-project-memory-system.md`）继承了这个违规路径

**必须在实施 P4-P6 之前解决此冲突。**

## 2. 时间线还原

| 时间 | 事件 | 作用 |
|------|------|------|
| 2026-05-27 | 天枢按 `2026-05-27-项目记忆按需召回.md` 执行，移除 prompt 注入 | 建立了 "recall-only" 契约 |
| 2026-05-27 | commit `43ebfe6` `fix(prompt): stop injecting project memory` | 代码落地 |
| 2026-05-27 | commit `02d6b95` `refactor(prompt): remove project knowledge snapshot` | 清理残留 |
| 2026-05-27 | `.rivet/knowledge/manifest.md` 写入 contract 条目 | 制度化 |
| 2026-06-01 | commit `079a05d` `feat(memory): implement project memory system` | **重新引入** `projectMemoryBlock` 到 volatile-snapshot + volatile |
| 2026-06-01 | 我基于 `079a05d` 的实现写了 P4-P6 方案 | **沿用了违规路径** |

**根因**：`079a05d` 实现了新的 JSONL 记忆系统（memory.jsonl），但选择了"自动注入 frozen volatile block"作为读取路径——这与 5 天前的架构决策直接矛盾。

## 3. 两派立场的证据

### 3.1 "注入 prompt"派的论据（P1-P3 实现 + P4-P6 方案）

1. **边际 token 成本为零** — project memory 进入 frozen block，prefix cache 覆盖后 turn 2+ 无额外开销
2. **无需模型主动调 recall** — 模型经常不调 recall，记忆形同虚设
3. **4K token 渲染上限** — 不会挤占太多上下文
4. **200 条物理上限** — 膨胀可控
5. **结构化 XML** — 比天权时代的 Markdown 更精确

### 3.2 "recall-only"派的论据（manifest + 按需召回方案 + 天权 invariant）

1. **Memory Selection Principle**（project-memory.md）：
   > "The project-memory problem is not primarily storage; it is selection. Without selection pressure, memory becomes an archive cabinet and eventually prompt noise."

2. **天权 Canonical Memory 写入不变量**（2026-05-21-canonical-memory-write-invariants.md）：
   - 三条不变量中的核心：**canonical memory 的消费者必须是显式的**（recall/search），不是隐式的（prompt injection）
   - 原文精神："machine writers must not overwrite human-maintained canonical memory" → 扩展理解为 "machine memory 不应静默改变每轮 prompt 的语义"

3. **Prefix cache 稳定性**（2026-05-27-项目记忆按需召回.md 的核心动机）：
   - project memory 内容变化时，整个 frozen block 失效
   - 200K 窗口下 prefix cache 价值巨大（DeepSeek V4 exact-prefix cache）
   - 频繁写入 project memory → 频繁 prefix cache miss

4. **prompt 噪声风险**：
   - 自动升级的 commit fact 可能包含大量 `fix: typo` 级别的小提交
   - failure_pattern 即使要求 ≥2 次去重，CI 跑挂 2 次的项目级 issue 可能只是临时网络问题
   - 模型每轮都看到这些"记忆"，即使不相关

## 4. 关键区别：memory.jsonl vs project-memory.md

这是理解冲突的关键。两套系统虽然都叫 "project memory"，但本质不同：

| | `project-memory.md`（天权时代） | `memory.jsonl`（P1-P3 新建） |
|---|---|---|
| 格式 | Markdown（人类可读的 curated prose） | JSONL（结构化机器数据） |
| 写入者 | Dream（5 curated criteria 门控） | claim-extractor + remember 工具（自动） |
| 内容 | 架构 invariant、selection principle | commit hash、file observation、failure pattern |
| 质量 | 高（每条经过蒸馏） | 参差不齐（自动提取，门控弱） |
| 大小 | ~6.8KB | 0KB（尚未使用） |

**天权的 manifest 约束的是 `project-memory.md`**——那是 curated 的高质量记忆。而 `memory.jsonl` 是机器自动写入的结构化数据，两者不可混为一谈。

但 manifest 的 contract 写的是 "project memory"，没有区分文件格式。这个模糊性是冲突的根源之一。

## 5. 三种解决路径

### 路径 A：回归 recall-only（严格遵守 manifest）

**做法**：
1. 移除 `projectMemoryBlock` 从 volatile-snapshot + volatile
2. P4-P6 的写入逻辑保留（写入 memory.jsonl）
3. 读取路径改为：recall 工具搜索 memory.jsonl
4. 更新 manifest 区分 `.md`（人类 curated）和 `.jsonl`（机器数据）

**优点**：
- 完全遵守已有架构决策
- Prefix cache 不受 memory 变化影响
- Prompt 不受 memory 噪声影响

**缺点**：
- 核心问题未解决——模型经常不调 recall
- 跨会话知识传递仍然断裂
- P4-P6 的写入变得价值减半（写了但模型看不到）

### 路径 B：允许 memory.jsonl 注入（修正 manifest）

**做法**：
1. 保持 `projectMemoryBlock` 注入 volatile
2. 明确 manifest：`.md` 不注入（curated，recall-only），`.jsonl` 注入（结构化，budget-controlled）
3. P4-P6 按现有方案实施
4. 加入更强的门控防止噪声

**优点**：
- 解决了"模型不调 recall"的核心问题
- 写入即生效，跨会话知识不丢
- Frozen block + prefix cache 仍然覆盖 turn 2+

**缺点**：
- 与天权 "Memory Is Selection, Not Storage" 的哲学冲突
- Prefix cache 在 memory 内容变化时失效（但 frequency 低：只在有新 commit 或压缩时写入）
- 需要非常严格的门控，否则 4K token budget 变成垃圾场

### 路径 C：混合方案——分层注入

**做法**：
1. memory.jsonl 分两层：
   - **Tier 1（高置信度）**：confidence ≥ 0.9 的 decision / project_rule / user_constraint → 注入 frozen volatile block（prefix cache 稳定，因为写入频率低）
   - **Tier 2（一般置信度）**：其余条目 → 仅 recall 可检索
2. P5 的 commit fact：confidence=0.95 的 decision → 自动进 Tier 1
3. P6 的 session memory 升级：只有 decision 全部升级（数量少、价值高）
4. 更新 manifest 明确分层策略

**注入内容估算**：
- Tier 1 通常是 5-15 条高价值决策 ≈ 300-900 tokens
- 对 200K 窗口占比 < 0.5%
- Prefix cache 失效频率：只有新 commit 或新 decision 写入时，约每 5-10 轮一次

**优点**：
- 平衡了"模型不调 recall"和"prompt 噪声"两个极端
- 高价值决策确实能改善模型行为
- 与 Memory Selection Principle 一致：注入的每条都是 "will this change how a future agent decides?"
- Prefix cache 影响最小化（Tier 1 写入频率低）

**缺点**：
- 实现复杂度高于 A 或 B
- 需要在 loader 中增加分层逻辑
- 门控规则需要持续调整

## 6. 我的建议

**推荐路径 C（分层注入）**，理由：

1. **天权的 invariant 不反对高质量记忆注入**——它反对的是无选择的全量注入。"Memory Is Selection, Not Storage" 的本质是"注入的每一条都必须改变未来判断"。Tier 1 的 decision 和 project_rule 满足这个标准。

2. **commit `079a05d` 的违规是功能性的**——它解决了真实问题（模型不调 recall），只是没遵守 manifest。与其撤销，不如修正 manifest 让规范匹配正确的实现。

3. **P4-P6 的写入方向正确**——在压缩前保全信息是必须的。分歧只在读取路径，不影响写入逻辑。

4. **200K 窗口有足够空间**——300-900 tokens 的高价值 Tier 1 注入，对 200K 窗口来说影响微乎其微。

## 7. 落地清单

如果采纳路径 C，需要以下改动：

| 优先级 | 改动 | 说明 |
|--------|------|------|
| **P0** | 修正 `.rivet/knowledge/manifest.md` | 区分 `.md`（curated, recall-only）和 `.jsonl`（structured, tiered injection） |
| **P0** | 修正 `2026-06-01-project-memory-system.md` P4-P6 | 注入路径从全量改为分层 |
| **P1** | `project-memory-loader.ts` 增加 `loadTier1ProjectMemory` | 只返回 confidence ≥ 0.9 且 kind ∈ {decision, project_rule, user_constraint} |
| **P1** | `volatile-snapshot.ts` 用 Tier 1 loader 替代全量 loader | 减少注入量和 prefix cache 失效频率 |
| **P1** | P4-P6 实施 | 写入逻辑不变，读取路径用分层 loader |
| **P2** | 补测试 | memory-writer + memory-loader + volatile tier 分层 |

## 8. 天权的秤

> "被推翻不是失败，是秤变得更精确的唯一方式。"

天权 5 天前建立的 "recall-only" 契约基于以下前提：
1. project memory 是 `.md`（curated prose）
2. 写入靠 Dream（低频、高门控）
3. 内容大（6.8KB），全量注入是噪声

现在前提变了：
1. project memory 是 `.jsonl`（结构化数据）
2. 写入靠 claim-extractor + remember（自动、有门控）
3. 内容可以分层（Tier 1 小、Tier 2 大）

**前提变了，结论可以变。但变之前必须显式修正 manifest 和相关文档，让后来者看到完整的决策链。**

这正是天权的 `canonical-memory-write-invariants.md` 第一条不变量要求的：canonical memory 的变更必须是显式的、可追溯的。
