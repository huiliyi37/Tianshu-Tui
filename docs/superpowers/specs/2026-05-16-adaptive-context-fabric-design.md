# Adaptive Context Fabric (ACF) — 深度头脑风暴设计文档

> 深度头脑风暴产出 — 经过变异（5 方案）→ 选择（2 灭绝）→ 适应（1 方案）三轮过程
> 5 个并行子代理调研（技术/学术/竞品/跨领域/反证）

## 背景

### 问题

Rivet 当前上下文管理针对 DeepSeek V4 (1M) 优化，已实现 99% prefix cache 命中率。但要支持更多模型（Claude 200K、GPT-4o 128K、Qwen 128K-1M、开源模型 8K-128K），现有设计存在致命缺陷：

1. **绝对值阈值失效**：`AUTO_COMPACT_THRESHOLD = 800K` 在 128K 窗口上永远不触发
2. **双重 AND 关系阻塞**：`compact-policy.ts`（比例制）和 `auto.ts`（绝对值）必须同时同意才触发压缩
3. **无结构性安全保证**：模型不知道自己不知道（A14 问题），摘要丢失细节后无法自行发现

### 约束

- DeepSeek V4 99% prefix cache 命中率不能退化
- 上下文溢出 = 零容忍（灾难性不可恢复）
- 必须支持 8K-1M 全范围窗口
- 设计目标：超越所有现有终端编码代理
- 不考虑成本

### 现有代码审计

| 文件 | 职责 | 问题 |
|------|------|------|
| `src/compact/constants.ts` | 绝对值阈值 800K/500K | 小窗口失效 |
| `src/compact/auto.ts` | shouldAutoCompact + smartCompact | 与 compact-policy AND 关系 |
| `src/compact/micro.ts` | tool_result 截断到 1200 字 | 无分级，一刀切 |
| `src/context/compact-policy.ts` | 比例制 tier 0-4 | 被 auto.ts 否决 |
| `src/context/rounds.ts` | API round 分组 | 可复用为段边界 |
| `src/context/ledger.ts` | ContextLedger 追踪 | 可扩展 |
| `src/agent/loop.ts:229-257` | 压缩触发逻辑 | 双重判断需重构 |

---

## 调研发现

### Scout 1：各 Provider 缓存机制

| Provider | 窗口 | 缓存机制 | 稳定性要求 | TTL | 折扣 |
|----------|------|---------|-----------|-----|------|
| DeepSeek V4 | 1M | 自动精确前缀匹配 | 从第一个 token 精确匹配 | 磁盘持久化 | 90% |
| Claude | 200K | 显式 cache_control 断点 | 断点前字节相同 | 5min/1hr | 90% |
| OpenAI GPT-4o | 128K | 自动部分前缀匹配 | 128-token 粒度 | 5-10min | 50% |
| Gemini 2.5 | 1M | 显式命名缓存 + 隐式 | 精确匹配 | 1hr | 90% |
| Qwen | 128K | 显式 cache_control | 反向匹配最后 20 块 | 5min | 可变 |
| vLLM (本地) | 可配 | 块级 KV cache | 哈希块匹配 | LRU 淘汰 | 延迟节省 |

**关键发现**：
- 不可能用一套消息结构适配所有 provider
- DeepSeek 精确前缀 vs OpenAI 部分匹配 vs Claude 显式断点 = 根本不同的优化策略
- OpenAI 的 128-token 粒度意味着尾部小变动不影响缓存（比 DeepSeek 宽容）

### Scout 2：学术前沿

| 论文/系统 | 核心发现 | 可用数据 |
|-----------|---------|---------|
| BudgetMem (2025) | 72.4% 内存节省，仅 1.0% F1 损失 | ~70% 上下文冗余 |
| Gist Token 压缩 (ACL 2025) | 4x <3% 损失，8x ~8%，>10x 灾难 | 结构化数据退化更快 |
| Lost-in-middle (TACL 2023) | 中间位置 30-70% 注意力死区 | 20-30% 准确率下降 |
| MEMENTO (Microsoft 2026) | 自压缩比外部摘要好 10-15% | 2.5x KV cache 缩减 |
| HiAgent (ACL 2025) | 子目标边界触发压缩 | 50+ 步长程任务改善显著 |
| UT-ACA (2026) | 不确定性触发上下文扩展 | 按需分配 > 预分配 |
| KVFlow (NeurIPS 2025) | 工作流感知缓存淘汰 | 1.83-2.19x 加速 |
| 递归摘要 (2025) | 单次提及事实被不成比例丢失 | 需要 mention-count 保护 |

**关键洞察**：
- 动态预算分配 > 静态分区
- 自压缩（模型写自己的摘要）> 外部摘要
- 子目标边界（任务完成、文件切换、错误解决）是自然压缩触发点
- 单次提及的事实（错误信息、行号、用户约束）需要特殊保护

### Scout 3：竞品实现

| 代理 | 策略 | 创新点 | 弱点 |
|------|------|--------|------|
| Claude Code | 95% 阈值 LLM 摘要 | CLAUDE.md 控制摘要 | 33-45K buffer 问题，单次大响应溢出 |
| Aider | 递归 head-tail split + PageRank repo map | 动态 token 预算 repo map | 无 recall，Ollama 静默截断 |
| OpenCode | 两阶段 prune-then-summarize | 先删 tool output 再 LLM | 无结构性安全保证 |
| Cline | 手动/自动 condense + /newtask | 可视化进度条 | 大文件直接撑爆 |
| Continue.dev | 预防性上下文选择 | Context Provider 插件架构 | 无压缩，依赖短会话 |
| OpenHands | 非破坏性 event condensation | 可逆压缩（View.from_events） | 仅限 OpenHands 架构 |

**关键发现**：
- 所有竞品都是被动策略（到阈值才压缩）
- 无人解决"单次大响应溢出"问题
- 无人有结构性安全保证（关键信息零丢失）
- OpenHands 的非破坏性压缩是唯一可逆方案

### Scout 4：OS 内存管理类比

| OS 概念 | LLM 上下文类比 | 可迁移算法 |
|---------|--------------|-----------|
| PSI 压力阶梯 | 分级压力响应 60/75/85/95% | 测量压力频率，不只看利用率 |
| 工作集模型 (Denning) | 追踪活跃引用段 | 工作集 > 窗口 → 任务分解 |
| LRU-2 防扫描污染 | 区分读一次 vs 反复引用 | 一次性文件读取优先驱逐 |
| 反抖动守卫 | 驱逐后 K 轮内 recall → 增加粘性 | 防止压缩→回忆→再压缩循环 |
| COW 惰性加载 | 子代理传 manifest 不传全文 | 按需 fault-in |
| 三层缓存 L1/L2/L3 | 全文/摘要/冷存储 | 非包含策略（摘要不含原文） |

**关键洞察**：
- 测量"压力频率"比测量"利用率"更智能（如果每轮都在压缩 = 抖动）
- 工作集追踪可以防止驱逐正在使用的上下文
- 反抖动守卫是防止病态循环的关键机制

### Scout 5：定向反证（隐含前提）

| 假设 | 风险 | 影响 |
|------|------|------|
| A14: 模型能检测何时需要 recall | **HIGH** | LLM 静默失败，不会触发 page fault |
| A4: 摘要保留足够信息用于 recall | **HIGH** | 摘要丢失细节 + 模型不自知 = 静默错误 |
| A5: 重注入的上下文被等同对待 | MEDIUM-HIGH | 位置编码/注意力可能不同 |
| A8: Provider 机制可共享统一抽象 | MEDIUM-HIGH | 机制差异太大，统一抽象可能是 leaky abstraction |
| A11: 对话具有时间局部性 | MEDIUM | 调试场景跳跃任意历史 |
| A9: CVMM 开销在小窗口上可忽略 | HIGH (8K-32K) | 管理开销占比过大 |

**最危险的组合**：A14 + A4 = 摘要丢失细节 + 模型不知道需要 recall → 静默错误输出，比简单截断更危险。

---

## 三轮思考过程

### 第一轮：变异（5 个方案）

| 方案 | 生态位 | 核心选择 |
|------|--------|---------|
| V1（主流） | 增强现有压缩 | 阈值从绝对值改百分比，增加 4 级渐进压缩 |
| V2（邻近） | Provider-Aware 预算管理 | 每个 provider 独立缓存适配器 + BudgetManager 分级遗忘 |
| V3（空位） | 三层存储 + 结构性锚点 | 不可驱逐锚点保证关键信息零丢失 + 主动预注入绕过 A14 |
| V4（突变） | Checkpoint-Resume 极小窗口 | 不压缩，每 N 轮清空重启，只注入 task state |
| V5（组合） | 窗口分级自动选策略 | 8K-32K 用 V4，32K-256K 用 V3，256K-1M 用 V2 宽松模式 |

### 第二轮：选择

**灭绝**：
- **V1** — 无差异化优势，所有竞品都能做到。局部最优陷阱。
- **V4（独立方案）** — 对大窗口是反模式，用户选 1M 就是要长上下文。但 checkpoint-resume 作为 last-resort 子组件存活。

**存活**：
- **V3（强）** — 结构性锚点解决 A14，三层存储覆盖全场景，因果链完整
- **V2（弱）** — Provider adapter 是必需组件，但 recall 依赖模型自知不可靠
- **V5（中）** — 本质是 V3 + 窗口分级

**最强竞争者**：V3

**收敛洞察**：V2 和 V3 收敛到"上下文管理的核心是信息分级，不是压缩算法"。V4 和 V3 收敛到"压力超阈值时干净重启比激进压缩更安全"。

### 第三轮：适应

**套路清除**：
- "统一抽象层" → 改为策略模式，每个 provider 独立实现
- "LLM 做摘要" → 70% 冗余可用零成本规则驱逐

**扩展适应**：
- `output-store.ts` SHA-256 索引 → 复用为 persistent store 索引
- `trace-store.ts` 事件追踪 → 扩展为段引用追踪
- `task-state.ts` → 主动预注入的信号源
- `checkpoint.ts` dirty snapshot → last-resort fallback
- `rounds.ts` API round 分组 → 段的自然边界

**Discarded trait 吸收**：
- V1 的百分比化阈值 → 作为 ACF 基础层
- V4 的 task-state 提取 + 干净重启 → 作为 95% ceiling 的 last-resort

---

## 最终方案：Adaptive Context Fabric (ACF)

### 架构概览

```
┌─────────────────────────────────────────────────────────────┐
│                    Model Context Window                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ System    │  │ Volatile │  │ Anchors  │  │ Working    │  │
│  │ Prompt    │  │ Context  │  │ (pinned) │  │ Memory     │  │
│  │ (frozen)  │  │ (refresh)│  │ (≤5%)    │  │ (budgeted) │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
│         ↕            ↕             ↕              ↕          │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │           Pressure Monitor (PSI-inspired)                │ │
│  │  Tier 0: <60%  Tier 1: 60-78%  Tier 2: 78-88%          │ │
│  │  Tier 3: 88-95%  Tier 4: >95% (last-resort)            │ │
│  └─────────────────────────────────────────────────────────┘ │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │           Provider Adapter (strategy pattern)            │ │
│  │  DeepSeek: exact-prefix │ Claude: explicit-breakpoint   │ │
│  │  OpenAI: partial-prefix │ Local: block-kv / none        │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                          ↕ forget / recall
┌─────────────────────────────────────────────────────────────┐
│              Persistent Store (~/.rivet/memory/)              │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────┐    │
│  │ Tool     │  │ Session      │  │ Anchor             │    │
│  │ Archives │  │ Summaries    │  │ Registry           │    │
│  │ (SHA-256)│  │ (per-round)  │  │ (never-expire)     │    │
│  └──────────┘  └──────────────┘  └────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 核心创新点（超越竞品）

1. **结构性锚点 (Pinned Anchors)**：用户约束、关键决策、错误修复方案被提取为不可驱逐的一行引用。即使整个 round 被压缩，锚点保留。解决 A14（模型不知道自己不知道）。

2. **主动预注入 (Proactive Injection)**：每轮开始前，系统基于 task-state 从冷存储匹配相关上下文注入 volatile context。不等模型 recall，系统主动提供。

3. **反抖动守卫 (Anti-thrashing Guard)**：如果被驱逐的段在 2 轮内被引用/recall，自动提升为锚点。防止压缩→回忆→再压缩的病态循环。

4. **Provider-Aware 消息组装**：不是统一抽象，而是策略模式。每个 provider 有独立的消息排列和缓存标记逻辑。

5. **分级压力响应 (PSI-inspired)**：不只看利用率，还追踪压缩频率。如果每轮都在压缩 = 抖动 → 触发任务分解建议而非更激进压缩。

### Token 预算模型（动态，非静态）

```
对于 contextWindow = W 的模型：

系统提示 (frozen):     ~5-8% of W (固定，缓存锚定)
Volatile Context:      ~2-3% of W (每轮刷新)
Pinned Anchors:        ≤5% of W (不可驱逐)
Working Memory:        50-70% of W (弹性，受压力管理)
  - 最近 3 轮全文:     ~30% of W
  - 3-10 轮摘要:       ~20% of W
  - 预注入上下文:      ~10% of W
Generation Reserve:    15-20% of W (永远保留)
```

### 与现有系统的集成

| 组件 | 变更 |
|------|------|
| `src/compact/constants.ts` | 绝对值 → `contextWindow` 百分比 |
| `src/compact/auto.ts` | 去掉与 compact-policy 的 AND 关系 |
| `src/context/compact-policy.ts` | 成为唯一压缩决策者 |
| `src/agent/loop.ts` | 每轮后调用 PressureMonitor.check() |
| `src/api/` | 新增 provider-profile + cache-adapter |
| `src/context/` | 新增 anchor-registry + proactive-inject |
| `src/tools/` | 新增 recall 工具 |

### 不改变的部分

| 组件 | 理由 |
|------|------|
| `src/compact/micro.ts` | 作为 Tier 1 零成本压缩保留 |
| `src/context/rounds.ts` | 段边界逻辑复用 |
| `src/agent/context.ts` | 增量 token 估算复用 |
| `src/tools/output-store.ts` | SHA-256 索引模式复用 |
| prefix cache 锚定（前 2 条消息） | DeepSeek 99% 命中率的基础 |

---

## 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| 锚点提取误报（无关内容被标记） | 中 | 低 | 预算上限 5%，超出时按 salience 排序淘汰最低的 |
| Provider API 变更破坏缓存策略 | 低 | 中 | 策略模式隔离，单个 provider 变更不影响其他 |
| 主动预注入注入无关内容 | 中 | 低 | 基于 task-state 精确匹配，不做模糊搜索 |
| 小窗口 (8K) 上 ACF 开销过大 | 中 | 中 | 8K-32K 自动降级为 checkpoint-resume 模式 |
| 反抖动守卫过度保护导致窗口膨胀 | 低 | 中 | 锚点总预算硬上限 5%，超出时强制淘汰最旧锚点 |
| DeepSeek 缓存命中率退化 | 低 | 高 | Phase 1 完成后立即验证，退化 >1% 则回退 |

---

## 下一步

Phase 1 的第一个具体动作：将 `src/compact/constants.ts` 的绝对值阈值改为 `contextWindow` 的百分比，并让 `compact-policy.ts` 独立驱动压缩决策（去掉 AND 关系）。
