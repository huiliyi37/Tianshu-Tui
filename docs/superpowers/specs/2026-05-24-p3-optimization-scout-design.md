# P3 优化 Scout 设计文档：三路前沿技术落地

> 基于 P3 前沿技术调研的灵感种子，优化已落地的 P1-6~10 设计
> 日期：2026-05-24
> 视角：天璇（边界行走 · 跨域共振）调研产出 → 落地设计

---

## 背景

P1-6~10 已落地的 5 个设计：
1. **Speculative prewarm** — 流式检测 read_file 时预热文件缓存
2. **Observation masking** — 固定窗口（10 user turns）移除旧 tool result
3. **File content dedup** — djb2 hash 精确匹配去重
4. **Per-message budget** — 按大小驱逐超预算 tool result
5. **Reflective compaction** — regex 提取 decisions/findings 生成 checkpoint

P3 调研发现大量可优化方向。本文档设计三路 scout 的落地方案。

---

## 模块 A：语义级轨迹精简

### 问题

当前 prune 按固定窗口和大小阈值操作，不区分内容价值。一个关键 debug 输出和一个无关目录列表被同等对待。

### 调研基础

| 论文/项目 | 核心方法 | 关键数字 |
|-----------|---------|---------|
| AgentDiet (FSE 2026) | 滑动窗口反射，廉价 LLM 判断 useless/redundant/expired | 39-59% token 减少，0 性能损失 |
| SWE-Pruner (上交+字节) | 0.6B Qwen3-Reranker，行级 CRF 剪枝 | 23-54% 减少，<100ms |
| Squeez (KRLabs) | 2B LoRA pruner，verbatim span 提取 | 92% 压缩，0.86 recall |
| ACON (Microsoft) | 失败驱动压缩指南优化，gradient-free | 26-54% 减少 |
| Focus | Agent 自主决定压缩时机，slime mold 启发式 | 22.7% 减少 |
| pi-context-prune | cache-aware prune-on 模式 | 多种触发策略 |

### 设计方案：三层渐进式精简

```
Layer 1: 规则过滤（零成本）
├── 垃圾路径：__pycache__/, .git/, node_modules/ 目录列表 → 删除
├── 测试通过列表：只保留失败用例 + 最后一次运行摘要
├── 编辑回显：edit_file 输出中与 read_file 重复的内容 → 摘要
└── 重复 grep：同一 pattern 的多次 grep → 只保留最新

Layer 2: 过期检测（AgentDiet 风格）
├── lag=3 步：只评估 3 步前的 tool result
├── 覆盖检测：后续步骤重新读取同一文件 → 旧版本标记过期
├── 引用追踪：tool result 从未被后续 assistant 消息引用 → 标记 useless
└── 阈值保护：只处理 >500 tokens 的 tool result

Layer 3: Flash 反射（可选，高压力时启用）
├── 触发条件：session >15 步 且 token 压力 >70%
├── 用 DeepSeek Flash 评估 lag 窗口内的 tool results
├── 成本：~$0.0007/次（可忽略）
└── 回退：Flash 失败时用 Layer 1+2 的结果
```

### 关键约束

- 所有精简只在 cache anchor boundary 之后进行，保护 prefix cache
- Layer 1 在 `buildOaiRequest` 中执行（现有 observation masking 位置）
- Layer 2 在 `pruneStaleToolResults` 中扩展
- Layer 3 在 `CompactionController.maybeCompact` 中触发

### 实现文件

| 文件 | 改动 |
|------|------|
| `src/compact/semantic-prune.ts` | 新建：Layer 1 规则 + Layer 2 过期检测 |
| `src/compact/prune.ts` | 扩展：集成 semantic-prune |
| `src/prompt/engine.ts` | 修改：buildOaiRequest 中调用 Layer 1 |
| `src/compact/flash-reflect.ts` | 新建：Layer 3 Flash 反射（可选） |

### 预估

- Layer 1: 1 天，~80 行
- Layer 2: 2 天，~150 行
- Layer 3: 1 天，~100 行

---

## 模块 B：多路推测执行

### 问题

当前只在流式输出中检测到 `read_file` 时预热文件缓存。这是最保守的单路推测，仅覆盖一种工具。

### 调研基础

| 论文/项目 | 核心方法 | 关键数字 |
|-----------|---------|---------|
| PASTE (上交+微软) | Pattern Tuple 从历史 trace 学习，idle 时推测执行 | 93.8% 命中率，48.5% 延迟降低 |
| B-PASTE | Beam-aware 多分支推测，critical-path 排序 | 1.4x 加速 |
| IdleSpec | 工具等待期间 Progressive + Recovery 双策略推测 | +9.1% MLE-Bench |
| SpecHop | 多条并行推测线程，异步验证 | 40% 延迟降低 |
| Speculative Actions (ICLR 2026) | Semantic guards + Safety envelopes | 55% 准确率 |
| Qwen Code Speculation | COW overlay 文件隔离，读写分离 | 最多 20 turns 推测 |
| LLMCompiler (ICML 2024) | LLM Planner 生成 DAG，并行调度 | 3.7x 延迟改善 |

### 设计方案：分层推测架构

```
Tier 0: 当前（已有）
└── 流式检测 read_file → 预热文件缓存

Tier 1: Pattern-based 单路推测（MVP）✅ 已实现
├── 记录 tool call bigram + trigram：(prev, tool_A) → (tool_B, args_template, probability)
├── 存储：内存 Map（session 级），bigram 200 条 + trigram 100 条上限
├── 工具执行完成后，查表预测下一个工具（trigram 优先，≥3 数据点时使用）
├── 只对只读工具推测执行：read_file, grep, glob, list_dir
├── LLM 实际输出匹配 → 直接注入结果（跳过执行）
├── 不匹配 → 丢弃（零回滚成本）
└── 记录命中/未命中统计到 trace-store

Tier 2: Flash 空闲推测
├── 工具执行等待期间，用 Flash 发推测请求
├── 共享 prefix（cache hit 接近 100%，边际成本 ≈ 0）
├── Prompt："Based on current context, predict the next tool call as JSON"
├── 推测结果暂存 buffer，LLM 输出后验证
├── Progressive drafting：从当前计划外推
└── Recovery drafting：预判失败路径

Tier 3: COW overlay + 写推测
├── overlay 目录：/tmp/rivet-speculation/{session}/{id}/
├── 读工具直接放行，写工具重定向到 overlay
├── Accept → 回写真实文件系统
├── Abort → 删除 overlay
└── 最多 K=3 条推测线程
```

### DeepSeek 不对称优势

| 特性 | 推测收益 |
|------|---------|
| 99.41% cache hit | 第二路推测请求 prefix 全命中，input 成本 ≈ 0 |
| Flash 640x 便宜 | 即使 30% 命中率，净收益仍为正 |
| 长 TTL prefix cache | 推测请求跨 turn 共享 prefix |

### 回滚策略

| 工具类型 | 策略 | 回滚成本 |
|---------|------|---------|
| 只读（read_file, grep, glob） | 纯丢弃 | 零 |
| 写操作（edit_file, write_file） | COW overlay | 删除 overlay 目录 |
| 不可逆（git push, npm publish） | 禁止推测 | N/A |

### 验证机制

1. **Output Match**：tool_name + args 完全匹配 → 直接用推测结果
2. **Semantic Equivalence**：参数不同但语义等价 → Semantic Guard 验证
3. **State Consistency**：COW overlay 天然保证状态一致性

### 实现文件

| 文件 | 改动 | 状态 |
|------|------|------|
| `src/agent/tool-pattern-miner.ts` | 新建：bigram + trigram pattern 存储和查询 | ✅ 已实现 |
| `src/agent/speculation-engine.ts` | 新建：推测调度器（Tier 1-3） | 待实现 |
| `src/agent/speculation-overlay.ts` | 新建：COW 文件系统 overlay（Tier 3） | 待实现 |
| `src/agent/turn-stream.ts` | 修改：扩展 onToolCallHint 到多工具 | 待实现 |
| `src/agent/tool-execution.ts` | 修改：推测结果注入 | 待实现 |

### 预估

- Tier 1: 2-3 天，~200 行
- Tier 2: 1 周，~300 行
- Tier 3: 2 周，~500 行

---

## 模块 C：LLM 反思式压缩

### 问题

当前用 regex 从模型文本提取 decisions/findings，质量低、覆盖窄、不能跨 session 复用。

### 调研基础

| 论文/项目 | 核心方法 | 关键数字 |
|-----------|---------|---------|
| Experiential Reflective Learning (ICLR 2026) | 反思轨迹生成启发式规则 | +7.8% Gaia2 |
| ALTK-Evolve (IBM) | 轨迹→可复用指南，质量过滤 | +14.2% 困难任务 |
| Mistake Notebook Learning (ACL 2026) | 结构化四元组，accept-if-improves 门控 | +9pp Text-to-SQL |
| ACE (ICLR 2026 Main) | 增量 delta 更新，防止 context collapse | +10.6% AppWorld |
| Claude Dreaming (Anthropic) | 空闲时回顾 100 条 transcript | 6x 任务完成率 |
| Letta Sleeptime | 双 agent 异步记忆维护 | 74% LoCoMo |
| Auto-Dreamer | 快慢分离，GRPO 训练 consolidator | 12x 更小活跃记忆 |
| OEP (安全警告) | 自生成规则可被 poisoning | >50% 攻击成功率 |

### 设计方案：两阶段反思 + 规则生命周期

#### Phase 1: Compaction-time 启发式生成（替代 regex）

```
触发：每次 compaction 时
输入：最近 N 个 tool-call 周期的摘要（~4000 tokens）
模型：DeepSeek Flash（$0.0007/次）
输出：HeuristicRule[]（MNL 四元组格式）
存储：.rivet/knowledge/heuristics.jsonl（append-only）
初始 confidence: 0.5（unverified）
回退：Flash 失败时用现有 regex 提取
```

#### Phase 2: 规则注入 + 验证循环 ✅ IMPLEMENTED

```
Session 开始：
├── 加载 heuristic store (.rivet/heuristics.jsonl)
├── 按 hitCount × recency 排序 (getTopK)
└── 注入 top-5 到 volatile context dynamic appendix (setHeuristicRules)

Session 中：
├── 规则以 <learned-heuristics> 标签渲染在 dynamic appendix
└── 缓存安全：不影响 frozen prefix（仅在 buildDynamicAppendix 中渲染）

Session 结束（runPostSession）：
├── 记录 hit（所有注入的规则）
├── 更新 confidence（成功 +0.1，失败 -0.2）
├── prune 冷规则
└── 持久化到磁盘
```

实现文件：
- `src/compact/heuristic-store.ts` — JSONL 读写/衰减/去重/prune
- `src/compact/heuristic-injector.ts` — formatHeuristicsForInjection(rules)
- `src/prompt/volatile.ts` — VolatileContext.heuristicRules 字段 + dynamic appendix 渲染
- `src/prompt/engine.ts` — setHeuristicRules() setter + dynamicCtx 传递
- `src/agent/loop.ts` — 初始化 HeuristicStore, run() 中加载注入, runPostSession() 中验证

#### 规则格式

```typescript
interface HeuristicRule {
  id: string              // content-addressed hash
  pattern: string         // 可复用洞察（1-2句）
  antiPattern?: string    // 应避免的做法
  category: string        // "file-edit" | "test" | "api-call" | "debug"
  confidence: number      // 0-1，accept-if-improves 门控
  source: "compaction" | "session-review" | "user-correction"
  hitCount: number        // 被检索和使用的次数
  createdAt: number
  lastUsedAt?: number
  sessionId: string       // 溯源
}
```

#### 规则生命周期

```
Hot（7天内 或 近3 session 有 hit）→ 始终注入
Warm（8-30天，有 hit 记录）→ 按 category 匹配注入
Cold（>30天，无 hit）→ 归档不删除，可搜索
去重：相似度 >0.92 的规则合并（保留新文本+旧溯源）
```

#### 安全措施（基于 OEP 论文警告）

- 自动生成的规则标记为 `unverified`
- 只有在后续 session 中成功使用后才升级为 `verified`
- 用户修正始终覆盖自动规则
- 规则总数上限 500 条，超出时按 confidence × recency 淘汰

### 成本分析

| 场景 | 成本 |
|------|------|
| 单次 compaction 反射（cache miss） | $0.0007 |
| 单次 compaction 反射（cache hit） | $0.00015 |
| 10 次/天 | $0.007/天 |
| 100 次/天 | $0.07/天 |

**结论**：成本可忽略，主要约束是延迟而非费用。

### 实现文件

| 文件 | 改动 | 状态 |
|------|------|------|
| `src/compact/heuristic-extractor.ts` | 新建：Flash 反思提取（替代 regex） | 待实现 |
| `src/compact/heuristic-store.ts` | 新建：JSONL 读写/衰减/去重 | ✅ 已实现 |
| `src/compact/heuristic-injector.ts` | 新建：top-K 选择和注入 | ✅ 已实现 |
| `src/agent/compaction-controller.ts` | 修改：集成 heuristic-extractor | 待实现 |
| `src/prompt/engine.ts` | 修改：volatile block 注入规则 | ✅ 已实现 |
| `src/prompt/volatile.ts` | 修改：dynamic appendix 渲染 heuristicRules | ✅ 已实现 |
| `src/agent/loop.ts` | 修改：session 开始加载 + 结束验证 | ✅ 已实现 |
| `.rivet/knowledge/heuristics.jsonl` | 新建：规则存储 | ✅ 运行时自动创建 |

### 预估

- Phase 1: 2-3 天，~200 行
- Phase 2: 3-5 天，~300 行

---

## 三模块协同

```
工具执行 ──→ [模块B: 推测下一步] ──→ 预执行/预热
    │
    ▼
tool result ──→ [模块A: 语义精简] ──→ 精简后存入 session
    │
    ▼
compaction 触发 ──→ [模块C: 反思生成规则] ──→ 跨 session 复用
    │
    ▼
下次 session ──→ 注入规则 ──→ 更好的决策 ──→ 更少的错误 ──→ 更少的 token
```

### 复利效应

C 生成的规则让 agent 犯更少错误 → 更短的轨迹 → A 需要精简的更少 → B 的推测更准确（模式更稳定）。

### 实施优先级

| 阶段 | 内容 | 预估 | 依赖 | 状态 |
|------|------|------|------|------|
| Sprint 1 | A-Layer1 + A-Layer2 + C-Phase1 | 4-5 天 | 无 | 进行中 |
| Sprint 2 | B-Tier1 + C-Phase2 | 1 周 | Sprint 1 | ✅ 已完成 |
| Sprint 3 | A-Layer3 + B-Tier2 | 1-2 周 | Sprint 2 | 待开始 |
| Sprint 4 | B-Tier3 (COW overlay) | 2 周 | Sprint 3 | 待开始 |

---

## 参考文献

### 模块 A
- [AgentDiet (FSE 2026)](https://arxiv.org/abs/2509.23586)
- [SWE-Pruner](https://arxiv.org/abs/2601.16746) | [GitHub](https://github.com/Ayanami1314/swe-pruner)
- [Squeez](https://arxiv.org/abs/2604.04979) | [GitHub](https://github.com/KRLabsOrg/squeez)
- [ACON (Microsoft)](https://arxiv.org/abs/2510.00615) | [GitHub](https://github.com/microsoft/acon)
- [Focus](https://arxiv.org/abs/2601.07190)
- [RE-TRAC (Microsoft)](https://arxiv.org/abs/2602.02486)
- [Agent Capsules](https://arxiv.org/abs/2605.00410)
- [Morph Flash Compact](https://www.morphllm.com/blog/compact-sdk)
- [pi-context-prune](https://github.com/championswimmer/pi-context-prune)

### 模块 B
- [PASTE (arXiv:2603.18897)](https://arxiv.org/abs/2603.18897)
- [B-PASTE (arXiv:2604.16469)](https://arxiv.org/abs/2604.16469)
- [IdleSpec (arXiv:2605.22154)](https://arxiv.org/abs/2605.22154)
- [SpecHop (arXiv:2605.21965)](https://arxiv.org/abs/2605.21965)
- [Speculative Actions (ICLR 2026)](https://arxiv.org/abs/2510.04371)
- [SpecAgent (arXiv:2510.17925)](https://arxiv.org/abs/2510.17925)
- [LLMCompiler (ICML 2024)](https://arxiv.org/abs/2312.04511) | [GitHub](https://github.com/SqueezeAILab/LLMCompiler)
- [Qwen Code Speculation Engine](https://qwenlm.github.io/qwen-code-docs/en/design/prompt-suggestion/speculation-design/)
- [DeepSeek-Reasonix](https://github.com/esengine/DeepSeek-Reasonix)

### 模块 C
- [Experiential Reflective Learning (arXiv:2603.24639)](https://arxiv.org/abs/2603.24639)
- [ALTK-Evolve (IBM)](https://huggingface.co/blog/ibm-research/altk-evolve)
- [Mistake Notebook Learning (ACL 2026)](https://arxiv.org/abs/2512.11485) | [GitHub](https://github.com/Bairong-Xdynamics/MistakeNotebookLearning)
- [ACE (ICLR 2026)](https://arxiv.org/abs/2510.04618) | [GitHub](https://github.com/ace-agent/ace)
- [Auto-Dreamer (arXiv:2605.20616)](https://arxiv.org/abs/2605.20616)
- [MetaClaw (arXiv:2603.17187)](https://arxiv.org/abs/2603.17187) | [GitHub](https://github.com/aiming-lab/MetaClaw)
- [Letta Sleeptime](https://github.com/letta-ai/sleep-time-compute)
- [OEP 安全警告 (arXiv:2605.18930)](https://arxiv.org/abs/2605.18930)
- [Claude Dreaming (Anthropic 2026)](https://tech.yahoo.com/ai/claude/articles/claude-agents-dream-now-anthropics-161500849.html)
- [Mneme](https://github.com/CVPaul/mneme)
- [cavemem](https://github.com/JuliusBrussee/cavemem)
