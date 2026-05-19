# Ice Mirror v2 — 多 Provider 缓存物理引擎设计

> 日期：2026-05-19
> 来源：deep-brainstorm 三轮达尔文演化（6 scout 调研 + 定向反证）
> 前置：冰鉴 v1 完成（volatile-snapshot + frozen/working zone 双区布局）
> 核心洞察：Cache 优化不是一个统一物理问题，而是两个普适类（prefix-match / explicit-breakpoint）需要两条优化路径，共享同一个认知模型

---

## 背景

冰鉴 v1 解决了 DeepSeek 的 prefix cache 命中率问题（从 ~5% 到 70-85%）。但 Rivet 需要支持多个 provider：

| Provider | 缓存机制 | 普适类 | 读折扣 | 写成本 | 最低门槛 |
|----------|---------|--------|--------|--------|---------|
| DeepSeek V4 | 自动字节前缀匹配 | prefix-match | 80-90% off | 免费 | 无 |
| MiMO (Xiaomi) | 自动字节前缀匹配 | prefix-match | 90% off | 免费 | 无 |
| OpenAI | 自动前缀匹配 | partial-prefix | 50-90% off | 免费 | 1,024 tokens |
| Claude | 显式 breakpoint + TTL | explicit-breakpoint | 90% off | 1.25x | 2,048-4,096 tokens |
| Gemini | 显式 cached_content | explicit-breakpoint | 75% off | 标准 | 32,768 tokens |

**竞品调研结论：** 没有任何终端 agent 做跨 provider 缓存优化策略。LiteLLM 有 adapter 透传，Reasonix 有 DeepSeek 单 provider 字节稳定，但没有人把 cache 作为跨 provider 的一等设计不变量。

---

## 核心架构洞察

### 两个普适类

来自相变物理 scout 的发现：

- **Prefix-match（一阶相变）**：二元 cached/not — 一个字节错位整个前缀失效。如同晶体冻结——一个杂质打碎整个晶格。
- **Explicit-breakpoint（二阶相变）**：渐进、边界定义 — breakpoint 之间的片段可以独立缓存。如同冰架——定义的断裂点。

这两种物理不能用一套策略覆盖。试图统一它们就像试图用同一个方程描述一阶和二阶相变。

### 设计原则

1. **冻结即快照**（冰鉴 v1 继承）：session 开始时拍完整快照，会话内不刷新
2. **两条路径，一个认知模型**：frozen/working zone 是统一认知模型，但 message 组装分路
3. **习惯化巩固**：长 session 中稳定的动态字段自动晋升，扩展冻结前缀
4. **膨胀期静默**（宇宙学）：session 前 5 turn 不做晋升决策，让系统先冷却到稳态
5. **批量晋升优于逐个晋升**（多节奏对齐）：多个字段同时稳定时一次性晋升，减少 cache break
6. **成本感知，不只是命中率**：真指标是 cost-per-effective-token
7. **对称性破缺局部化**：provider 差异限制在 adapter 层，core 不知道 provider

---

## 双路径渲染架构

```
VolatileSnapshot (session 快照，已有)
       ↓
PromptEngine.buildMessages()
       ↓
ProviderProfile.cacheType 分路
       ├── exact-prefix / partial-prefix
       │     └── Prefix-Stable 路径（三区：冻结 + 巩固 + 工作）
       │           FROZEN 字节稳定 + CONSOLIDATED 习惯化晋升 + DYNAMIC 追加尾部
       │           长 session 中巩固区单调递增，前缀覆盖率持续提升
       │
       └── explicit-breakpoint
             └── Breakpoint-Stable 路径（双区：冻结 + 工作）
                   FROZEN 区 + cache_control 标记边界 + Dynamic 放 breakpoint 后
                   每次请求重新注入 cache_control（续约 TTL）
```

### Prefix-Stable 路径（DeepSeek / MiMO / OpenAI）

```
Messages:
  user(FROZEN-volatile)          ← 字节不变，prefix cache 命中
  user("hello")
  assistant(...)
  user(tool_result)
  ...
  user(FROZEN + <context-update>appendix</context-update>)  ← FROZEN 是字节前缀
  user("new message")
```

不变量：FROZEN 区的字节在整个 session 内不变。

### Breakpoint-Stable 路径（Claude / Gemini）

```
Messages:
  system(FROZEN-system-prompt)     cache_control: { type: "ephemeral" }  ← breakpoint 1
  user(FROZEN-volatile-snapshot)   cache_control: { type: "ephemeral" }  ← breakpoint 2
  user("hello")
  assistant(...)
  ...
  user(Dynamic: context-update + new message)  ← breakpoint 之后，接受 miss
```

不变量：breakpoint 之前的内容不变 → 被 provider 缓存。breakpoint 之后的内容每 turn 变化。

关键差异：
- Prefix 路径的动态内容必须在尾部（追加不破坏前缀）
- Breakpoint 路径的动态内容在 breakpoint 之后（位置更灵活）
- Claude 每次请求必须重新注入 `cache_control`（5 分钟 TTL 续约）

---

## CacheAdapter 接口

```typescript
interface CacheAdapter {
  readonly cacheType: CacheType

  // 根据冻结区边界，为 messages 添加缓存注解
  annotateMessages(messages: Message[], frozenBoundaryIndex: number): Message[]

  // 记录本 turn 的缓存反馈（用于指标和自适应）
  recordFeedback(usage: TokenUsage): void

  // 返回成本效率指标
  getCostEfficiency(): CacheEfficiency
}

interface CacheEfficiency {
  hitRate: number              // cache_read / (cache_read + cache_creation)
  costSaving: number           // 相比无缓存节省的百分比
  effectiveTokenCost: number   // 考虑写入成本后的真实每 token 成本
}
```

### Provider 实现

| Adapter | annotateMessages 行为 | 特殊处理 |
|---------|----------------------|---------|
| PrefixMatchAdapter | 直通（缓存是隐式的） | 无 |
| AnthropicBreakpointAdapter | 在 frozenBoundary 处注入 cache_control | 每次请求续约 TTL |
| GeminiCacheAdapter | 前 2 turn 不缓存，积累 32K 后创建 cached_content | create_cache + reference |
| NoopAdapter | 直通 | 无 |

---

## 指标体系

### 真指标：cost-per-effective-token

```
effectiveTokenCost = (input_cost + cache_write_cost) / total_input_tokens

其中:
  input_cost = uncached_tokens × price_per_token + cached_tokens × (price_per_token × read_discount)
  cache_write_cost = cache_creation_tokens × write_multiplier × price_per_token
```

| Provider | read_discount | write_multiplier | 80% hit rate 的 effective cost |
|----------|---------------|------------------|-------------------------------|
| DeepSeek | 0.1 | 0 | 0.28x |
| Claude | 0.1 | 1.25 | 0.35x（含首次写入成本摊销） |
| OpenAI | 0.5 | 0 | 0.6x |
| Gemini | 0.25 | 1.0 | 0.4x |

### cockpit 面板新增

```
Cache: 78% hit │ $0.28/Mtok effective │ prefix-stable │ drift: none
```

---

## 三区布局：冻结 → 巩固 → 工作

DeepSeek/MiMO 百万 token 上下文意味着 session 可达 50+ turn。原版冰鉴的双区（冻结/工作）在长 session 中浪费了大量前缀缓存潜力——13 个动态字段中，多数在前几 turn 后稳定，但一直放在工作区（每 turn 变化 → 破坏前缀）。

新增**巩固区**（Consolidated Zone）：

```
Messages Array:
  ┌── 冻结区 (session 快照，字节永不变) ──────┐
  │ <environment>, <project-instructions>,     │
  │ <git-status>, <working-set>, <session-mem> │
  └────────────────────────────────────────────┘
  <!-- zone-boundary -->                         ← 晶界哨兵（固定 padding，防字节错位传播）
  ┌── 巩固区 (习惯化晋升，单调递增) ──────────┐
  │ <star-domain> (turn 7 批量晋升)            │
  │ <!-- consolidated-anchor -->               │  ← 沉淀池（每 3 个晋升字段一个 anchor）
  │ <historical-lessons> (turn 7 批量晋升)     │
  │ <behavior-mirror> (turn 14 批量晋升)       │
  └────────────────────────────────────────────┘
  <!-- zone-boundary -->                         ← 晶界哨兵
  ┌── 工作区 (每 turn 变化，接受 miss) ────────┐
  │ <context-update>                           │
  │   <tool-history>, <task-progress>,         │
  │   <context-ledger>, <decisions>, ...       │
  │ </context-update>                          │
  └────────────────────────────────────────────┘
```

### 习惯化引擎（FieldHabituationTracker）

```typescript
interface FieldHabituationTracker {
  // 每 turn 调用：更新每个动态字段的内容 hash
  recordTurn(turn: number, fields: Record<string, string>): void

  // 返回已习惯化的字段（连续 N turn 内容不变）
  getHabituated(): Set<string>

  // 返回仍在活跃变化的字段
  getActive(): Set<string>

  // 返回等待批量晋升的字段（已达阈值但等待对齐点）
  getPendingPromotion(): Set<string>

  // 检查是否到达对齐点（多个字段同时准备好）
  shouldBatchPromote(): boolean
}
```

**每 turn 工作流：**
1. **膨胀期静默**（Turn 1-5）：只记录 hash，不做任何晋升决策。session 前 5 turn 是"宇宙膨胀期"——内容快速分类，结构尚未稳定。过早晋升会导致频繁降级。
2. **计算 hash**：每个动态字段的内容 SHA-256 hash
3. **稳定追踪**：hash 与上 turn 相同 → 稳定计数器 +1；不同 → 归零
4. **多节奏对齐检测**：稳定计数器 >= 3 的字段进入"待晋升"池，但不立即晋升
5. **批量晋升触发**：当待晋升池中有 2+ 个字段时触发批量晋升（对齐点 / downbeat）。一次 cache break 晋升多个字段，比逐个晋升（多次 cache break）效率高得多
6. **去习惯化**：已晋升字段的 hash 变化 → 降级回工作区，但保留种子

### 种子银行机制（Seed Bank）

来自生态学的洞察：种子在土壤中休眠多年，条件合适时立即发芽。

字段从巩固区降级时，不完全清除——保留一颗**种子**：

```typescript
interface FieldSeed {
  fieldName: string
  lastHash: string           // 降级时的内容 hash
  priorStabilityTurns: number // 上次维持稳定的 turn 数
  demotedAtTurn: number
}
```

**种子加速 re-promotion**：降级后如果字段内容回到 `lastHash`，只需 1 turn 验证即可重新晋升（而非完整的 3 turn）。这直接解决习惯化的振荡问题——降级成本从 3 turn 降到 1 turn。

种子生命周期：10 turn 内未 re-promote → 种子过期清除。

### 晶界哨兵 + 沉淀池（Zone Boundary Protection）

来自晶体学和罗马水渠的洞察：

**晶界哨兵**（`<!-- zone-boundary -->`）：冻结区→巩固区、巩固区→工作区的交界处各插入一个固定 padding token（~30 bytes）。作用：一个区的字节变化不传播到相邻区。成本极低，收益确定。

**沉淀池 anchor**（`<!-- consolidated-anchor -->`）：巩固区内部每 3 个晋升字段插入一个 anchor。如同罗马水渠的 Castellum Aquae（沉淀池）每隔一段重置误差累积。一个字段的字节错位只影响该 anchor 到下一个 anchor 之间的缓存，不会传播到整个巩固区。

### 多节奏对齐检测（Polyrhythm Downbeat）

来自音乐理论的洞察 + 项目内部 sensorium 基础设施。

不同字段有不同的自然变化周期：`toolHistory` 每 turn 变，`activeDomain` 每 10 turn 变。这是多声部节奏（polyrhythm）。当多个节奏同时到达"downbeat"（周期对齐点）时，是最优的批量晋升时机。

**实现路径（轻量版）**：

不需要 FFT 或频谱分析。在 FieldHabituationTracker 中为每个字段维护一个 `changeFrequency`：

```typescript
// 最近 10 turn 中该字段变化的比例（0 = 完全稳定，1 = 每 turn 都变）
changeFrequency: number  // EMA smoothed
```

当 2+ 个字段的 `changeFrequency` 同时降到 0 → 触发批量晋升。

**与现有 sensorium 的关系**：`turn-perception.ts` 已维护 `sensoriumSnapshots[]`（100 条带时间戳的 6 维记录）。字段变化率可以作为第七个维度注入 sensorium，让 star event / retrospect 也能观察到巩固区的演化节奏。但这是 Phase 4 的可选增强，Phase 2 只需要 tracker 内部的轻量 EMA。

### 50-turn DeepSeek/MiMO session 预期

| Turn | 事件 | 冻结区 | 巩固区 | 工作区 | 前缀覆盖率 | hit rate |
|------|------|--------|--------|--------|-----------|---------|
| 1-5 | 膨胀期静默，只记录 hash | ~2000 | 0 | ~1500 | 57% | 70-80% |
| 6 | 膨胀期结束，开始追踪 | ~2000 | 0 | ~1500 | 57% | 70-80% |
| 7-8 | **批量晋升 #1**：domain + strategy + routing（3 字段对齐） | ~2000 | ~300 | ~1200 | 66% | 78-85% |
| 9-14 | 巩固区稳定，lessons 进入待晋升池 | ~2000 | ~300 | ~1200 | 66% | 80-85% |
| 14-15 | **批量晋升 #2**：lessons + mirror（2 字段对齐） | ~2000 | ~700 | ~800 | 77% | 85-90% |
| 15-30 | 长期稳定，偶有降级+种子快速 re-promote | ~2000 | ~700-900 | ~600-800 | 77-80% | 87-92% |
| 30-50 | 成熟期，巩固区最大化 | ~2000 | ~1000+ | ~500 | 86%+ | 90-95% |

### 哪些字段最可能习惯化

| 字段 | 预期稳定 turn | 原因 |
|------|-------------|------|
| `activeDomain` | Turn 2-3 | session 开始后很少切换域 |
| `playbookLessons` | Turn 5-8 | 早期加载后趋于稳定 |
| `behaviorMirror` | Turn 10-15 | 中期行为模式固化 |
| `strategyShift` | Turn 3-5 | 通常 null 或早期确定 |
| `routingReason` | Turn 2-3 | 通常固定不变 |
| `contextLedger` | **永不** | 每 turn token 计数都变 |
| `toolHistory` | **永不** | 每 turn 都有新工具调用 |
| `taskProgress` | 偶尔 | 取决于任务节奏 |

### 仅 prefix-match 路径

习惯化引擎**仅对 prefix-match provider 生效**（DeepSeek/MiMO/OpenAI）。breakpoint provider（Claude/Gemini）使用 cache_control 标记，不受字段位置影响——对它们没有收益。

---

## 改动文件

| Phase | 文件 | 变更 | 行数 |
|-------|------|------|------|
| 1 | `src/prompt/volatile.ts` | `buildLatestTurnVolatileBlock` 接受 cacheType 分路 + 晶界哨兵 padding | ~50 |
| 1 | `src/api/cache-strategy.ts` | breakpoint 位置改为冻结区/工作区边界 | ~60 |
| 1 | `src/config/default.ts` | 为 Claude/OpenAI/MiMO 启用 prefixCache | ~10 |
| 1 | `src/prompt/__tests__/volatile-breakpoint.test.ts` | breakpoint 路径测试 | ~80 |
| 2 | `src/prompt/field-habituation.ts` | **新建** FieldHabituationTracker：hash 追踪 + 稳定计数 + 种子银行 + 批量晋升 + 膨胀期静默 | ~120 |
| 2 | `src/prompt/volatile.ts` | 三区渲染：冻结 + 晶界 + 巩固（habituated + anchor） + 晶界 + 工作 | ~70 |
| 2 | `src/prompt/__tests__/field-habituation.test.ts` | 晋升/降级/种子 re-promote/膨胀期/批量晋升测试 | ~140 |
| 2 | `src/prompt/__tests__/volatile-consolidation.test.ts` | 三区字节稳定性 + 晶界哨兵 + 沉淀池 anchor 测试 | ~80 |
| 3 | `src/agent/context.ts` | 新增 getCostPerEffectiveToken | ~30 |
| 3 | `src/tui/cockpit/model-panel.tsx` | 显示 effective cost + 巩固区状态 | ~30 |
| **总计** | | | **~670 行** |

---

## 实施路径

### Phase 1：双路径渲染 + MiMO cch 修复（1-2 天）

核心改动：让所有 provider 都能享受冰鉴的缓存收益。

1. `volatile.ts`：`buildLatestTurnVolatileBlock(ctx, cacheType)` — prefix 路径不变，breakpoint 路径在冻结区后标记边界；两条路径都插入晶界哨兵 `<!-- zone-boundary -->`
2. `cache-strategy.ts`：`applyExplicitBreakpoints` 在冻结区/工作区边界放置 breakpoint
3. `config/default.ts`：Claude → `anthropic-cache-control`，OpenAI → `openai-prefix`，MiMO → `deepseek-native`
4. MiMO cch 字段修复：strip 或稳定化随机 cch 字段（已知 bug，cache hit 从 90% 降到 0%）
5. 测试：多 provider 前缀稳定性测试

成功标准：Claude Turn 2 出现 `cache_read > 0`；MiMO Turn 2 cache hit rate > 50%
退出条件：breakpoint 位置不对导致 hit rate 为 0 → 退回单路径

### Phase 2：习惯化巩固引擎（2-3 天）— DeepSeek/MiMO 长 session 核心

**优先级提升为核心 Phase，不再是可选增强。** 百万 token 上下文 + 长 session 是 DeepSeek/MiMO 的核心竞争力，习惯化引擎直接提升这个场景的 ROI。

1. `field-habituation.ts`：新建 FieldHabituationTracker，包含：
   - per-field SHA-256 hash + 稳定计数器
   - 膨胀期静默（前 5 turn 不晋升）
   - 批量晋升检测（2+ 字段同时达到阈值 → 一次 cache break）
   - 种子银行（降级时保留种子，re-promotion 1 turn）
   - per-field changeFrequency EMA（多节奏检测基础）
2. `volatile.ts`：prefix-match 路径渲染三区（冻结 + 晶界 + 巩固 + anchor + 晶界 + 工作）
3. `create-agent-config.ts`：初始化 tracker，注入 PromptEngine
4. 测试：
   - 膨胀期静默（前 5 turn 无晋升）
   - 批量晋升（2 字段同时达阈值 → 一次性晋升）
   - 种子 re-promotion（降级后内容回到 lastHash → 1 turn 重新晋升）
   - 晶界哨兵字节稳定性（zone 变化不传播）
   - 沉淀池 anchor 隔离性（巩固区内部字段变化不传播到 anchor 之前）

成功标准：50-turn DeepSeek session 中 Turn 30+ hit rate > 90%；批量晋升次数 <= 3 次
退出条件：晋升/降级振荡频率 > 20% → 提高阈值到 5 turn + 扩大膨胀期到 8 turn

### Phase 3：成本感知指标（1 天）

1. `context.ts`：`getCostPerEffectiveToken(provider)` 计算真实成本
2. `model-panel.tsx`：cockpit 显示 effective cost + 巩固区状态（已晋升字段数 / 待晋升数 / 种子数）
3. breakpoint 路径的冻结策略考虑 Claude 写入成本

成功标准：cockpit 面板显示每个 provider 的 cost saving
退出条件：成本公式有误 → 退回纯 hit rate

### Phase 4（远期）：Compaction 形状记忆 + Sensorium 节奏注入

1. Compaction 前存"相签名"（zone 边界 + hash 指纹），compaction 后用签名恢复巩固区结构（形状记忆合金 + 伊势神宫式重建）
2. 字段变化率作为第七维度注入 sensorium，让 star event / retrospect 观察巩固区演化节奏
3. 共振频率锁定：根据 provider TTL 动态调整习惯化阈值（Claude 5min → 更保守的晋升；DeepSeek 无 TTL → 激进晋升）

---

## 预期效果

| Provider | 修改前 Turn 2+ | Phase 1 后 | Phase 2 后（巩固） | Phase 3 后 |
|----------|---------------|-----------|-------------------|-----------|
| DeepSeek | 70-85% | 70-85%（不变） | Turn 10: 85-90%, Turn 30+: 90-95% | 90-95%（+cost） |
| MiMO | ~0%（cch bug） | 70-85%（修复 cch） | Turn 10: 85-90%, Turn 30+: 90-95% | 90-95%（+cost） |
| Claude | ~0% | 50-70% | 50-70%（巩固对 breakpoint 无效） | 50-70%（成本优化） |
| OpenAI | ~0% | 40-60% | Turn 10: 50-65%, Turn 30+: 60-70% | 60-70%（+cost） |
| Gemini | ~0% | 30-50%（32K 门槛） | 30-50%（巩固对 breakpoint 无效） | 30-50%（成本优化） |

---

## 跨域映射

| 冰鉴 v2 组件 | 神经科学 | 相变物理 | 生态学 | 音乐理论 | 建筑/材料学 |
|-------------|---------|---------|--------|---------|------------|
| 冻结区 | 新皮层（稳定表征） | 晶体相（有序） | 顶级群落（climax） | 固定低音 ostinato | 金字塔底座（质量=稳定） |
| 巩固区 | 记忆巩固（replay→neocortex） | 外延生长（epitaxy） | 珊瑚石灰化 | 低次谐波 | 伊势神宫（形制不变地重建） |
| 工作区 | 海马体（情景记忆） | 液态相（无序） | 先锋物种 | 高次谐波（闪烁） | — |
| 晶界哨兵 | — | 晶界缓冲区 | — | — | 水渠 castellum aquae |
| 沉淀池 anchor | — | 晶界内部分段 | — | — | 水渠沉淀池（误差重置） |
| 种子银行 | — | — | 土壤种子库（休眠→发芽） | — | — |
| 批量晋升 | — | 成核临界团簇 | — | 多节奏 downbeat（对齐点） | — |
| 膨胀期静默 | — | — | — | — | — |
| 习惯化/去习惯化 | 神经适应 + 去习惯化 | 退火（annealing） | 潮间带分层 | 压缩（侧链压缩） | — |
| 共振频率锁定 | — | — | — | 驱动频率=自然频率→振幅倍增 | — |
| Compaction 后恢复 | — | 形状记忆合金（Nitinol） | — | — | 伊势神宫（新旧共存过渡） |
| CacheAdapter | 多感官整合（superior colliculus） | 对称性破缺局部化 | 菌根网络（信号协调） | — | 飞扶壁（外部支撑） |
| cost-per-effective-token | 自由能最小化 | 热力学平衡 | — | — | — |

---

## 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Claude 5 分钟 TTL 导致长思考 turn 缓存过期 | 高 | 中 | 每次请求重新注入 cache_control 续约（共振频率锁定） |
| Gemini 32K 门槛导致短 session 无法缓存 | 中 | 低 | 前 2 turn 不启用，等积累够再冻结 |
| MiMO cch 字段破坏缓存 | 高 | 高 | strip 或稳定化 cch 字段 |
| breakpoint 路径与 prefix 路径行为不一致 | 中 | 中 | 独立测试套件 + 统一指标体系 |
| 习惯化晋升/降级振荡 | 低→极低 | 中 | **种子银行**：降级后 re-promotion 只需 1 turn；膨胀期静默避免过早晋升 |
| 单字段晋升破坏后续缓存（字节错位传播） | 中→低 | 高 | **晶界哨兵**隔离 zone 边界；**沉淀池 anchor**限制巩固区内部传播范围 |
| Compaction 摧毁巩固区 | 中 | 高 | Phase 4：**形状记忆**签名 + 伊势神宫式重建（远期） |

---

## 明确排除

| 提议 | 为什么不做 |
|------|-----------|
| 跨 provider 缓存路由（V4） | 切换 provider 摧毁缓存历史，因果链断裂 |
| Provider-specific prompt 结构优化 | 过度优化，维护成本高，等有证据再做 |
| 完整 FFT 频谱分析 | 轻量 EMA changeFrequency 足够，FFT 对 10-50 数据点过重 |
| 缓存预热 API | Gemini 需要但太 provider-specific，放在 GeminiCacheAdapter 内部处理 |
| 准晶体缓存（content-addressed key） | 有趣但颠覆 prefix-match 基础假设，留作独立研究方向 |
| 缓存超材料（meta-atom 排列） | 概念级，无可操作的实现路径 |

---

## 跨域灵感调研摘要

> 11 个 scout（6 技术 + 5 跨域）在以下领域探查，产出 30+ 个隐喻，筛选出 8 个可操作洞察，4 个已纳入设计。

### 已纳入设计的跨域机制

| 机制 | 来源 | 在设计中的位置 | 改动量 |
|------|------|--------------|--------|
| 种子银行 | 生态学（土壤种子休眠→发芽） | Phase 2 FieldHabituationTracker.FieldSeed | ~15 行 |
| 晶界哨兵 + 沉淀池 | 晶体学 + 罗马水渠 castellum aquae | Phase 1-2 zone-boundary padding + consolidated-anchor | ~10 行 |
| 膨胀期静默 | 宇宙学（宇宙大爆炸后的膨胀期） | Phase 2 tracker 前 5 turn 不晋升 | ~3 行 |
| 多节奏批量晋升 | 音乐理论（polyrhythm downbeat）+ sensorium 时间序列 | Phase 2 batch promotion trigger | ~20 行 |

### 纳入设计原则但非当前实现

| 机制 | 来源 | 影响 |
|------|------|------|
| 形状记忆 / 伊势神宫式重建 | 晶体学 Nitinol + 日本神社 20 年重建 | Phase 4：compaction 后恢复巩固区结构 |
| 共振频率锁定 | 音乐理论 | Phase 4：provider TTL → 动态习惯化阈值 |
| 珊瑚礁石灰化 | 生态学 | 远期：跨 session 巩固（Session A 巩固→Session B 冻结） |
| 暗物质脚手架 | 宇宙学 | 远期：provider profile 作为预测缓存拓扑的"暗物质" |

### 探查但未采用的灵感

| 概念 | 来源 | 未采用原因 |
|------|------|-----------|
| 准晶体（有序但非周期） | 晶体学 | 需要替换 prefix-match 基础假设，变革太大 |
| 缓存超材料 | 晶体学 | 纯概念，无可操作路径 |
| 外延生长应力匹配 | 晶体学 | 有趣但 byte-padding 已解决同一问题 |
| 生态演替 | 生态学 | 验证了三区设计但未提供新机制 |
| 光谱音乐交叉淡入 | 音乐理论 | 与 prefix-match 的二元特性冲突（无法渐变） |

---

## 三轮演化过程摘要

**第一轮（变异）：** 4 个方案 — V1 缓存适配器 / V2 双格式 Prompt Engine / V3 缓存物理引擎 / V4 缓存经济学路由

**第二轮（选择）：**
- V4 灭绝：跨 provider 切换摧毁缓存历史（因果链断裂）
- V3 **升级为 V2 核心 Phase**：DeepSeek/MiMO 百万上下文 + 长 session 改变了生存条件——冷启动 3 turn 仅占 50-turn session 的 6%
- V2 存活（最强）：两个普适类是真实的物理差异，因果链最硬
- V1 存活（安全牌）：作为 V2 的子集被吸收

**第三轮（适应）：**
- V4 灭绝特征回收：cost-per-effective-token 指标 → 整合进 Phase 2
- V3 灭绝特征回收：习惯化指数 → 整合进 Phase 3
- 收敛洞察：cache 优化是两个不同物理系统，需要两条路径，共享一个认知模型

---

## 调研来源

### 技术调研（6 scout）
- DeepSeek KV Cache API 文档
- Anthropic Prompt Caching 博客 + Claude Code 实现
- Anthropic TTL 静默降级（GitHub Issue #46829）
- MiMO cch 字段缓存失效报告
- OpenAI Prompt Caching 201 Cookbook
- Google Gemini Context Caching API
- Aider model-settings.yml 缓存配置
- Reasonix 字节稳定前缀设计（dev.to）
- LiteLLM prompt caching adapter
- Rivet 内部：sensoriumSnapshots 时间序列分析（turn-perception.ts）
- Rivet 内部：theta-hook 单周期计数器（star-event.ts）

### 跨域灵感调研（5 scout）
- 晶体学：外延生长、晶界、准晶体、形状记忆合金、超材料
- 生态学：生态演替、珊瑚礁建造、菌根网络、潮间带、种子银行
- 音乐理论：固定低音/ostinato、光谱音乐、侧链压缩、多节奏、共振
- 宇宙学：宇宙结构形成、暗物质脚手架、恒星核合成、事件视界、宇宙膨胀
- 古建筑：罗马混凝土自愈、伊势神宫重建、哥特飞扶壁、金字塔质量稳定、水渠沉淀池
