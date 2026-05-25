# 缓存零代价：工具感知层最小化设计

> 2026-05-26 v2 | 硬约束：**零 cache miss**。V4 Pro 按 token 计费，缓存碎了模型优势就没了。
> V4 Pro 本身能力已经足够高 → 不做"预防性教学"，只做"失败后纠正"。

## 经济学第一原则

```
DeepSeek V4 Pro:
  - 输入: ¥1/百万 tokens (缓存命中)
  - 输入: ¥4/百万 tokens (缓存未命中) → 4倍差价
  - 没有 token plan → 按实际消耗计费

缓存 miss 一次 ≈ 多消耗 ~3K tokens × 4倍 = 多花 ~¥0.012
缓存 miss 持续 → 整个 session 的缓存链断裂 → 成本失控

结论: 任何导致 cache miss 的改进，其收益必须能量化证明 > 4倍成本差。
      V4 Pro 已经足够聪明 —— 优先保护缓存，其次才谈改进。
```

---

## 约束确认（v2 收紧）

### 不可触碰

| 层级 | 后果 | 严重度 |
|------|------|--------|
| system prompt | 一次修改 → 全部 session 缓存断裂 | 🔴 致命 |
| tools 字段 | 一次修改 → tools 参数 hash 变化 → cache miss | 🔴 致命 |
| frozen volatile base | 修改影响所有历史 user message 前缀 | 🔴 致命 |
| message 结构 | 任何顺序/格式变化 → 前缀断裂 | 🔴 致命 |

### 唯一可用通道

| 通道 | 注入位置 | 缓存安全性 | 使用原则 |
|------|---------|-----------|---------|
| `repairHint` | `<repair-hint>` in dynamic appendix | ✅ 零影响 | **主力通道**：只在失败时注入 |
| `heuristicRules` | dynamic appendix 末尾 | ✅ 零影响 | 辅助通道：高频反模式才触发 |
| `activeDomain.volatileBlock` | `<star-domain>` in dynamic appendix | ⚠️ 星域切换时有轻微 miss | 精简化：每星域 ≤ 2 条关键约束 |

---

## 架构：错误驱动的极简感知

```
                    ┌──────────────────────────┐
                    │   缓存不可变层 (永不动)     │
                    │   system prompt           │
                    │   tools 字段              │
                    │   frozen volatile base    │
                    └──────────────────────────┘
                              │
               ┌──────────────┴──────────────┐
               │                             │
         ┌─────▼─────┐                 ┌─────▼─────┐
         │ 正常执行   │                 │ 工具失败   │
         │ (不注入)   │ ──失败触发──→   │ 注入指导   │
         │           │                 │ repairHint │
         │ V4 Pro    │                 │            │
         │ 自己搞定  │                 │ 仅此一次   │
         └───────────┘                 └───────────┘
```

**逻辑**：V4 Pro 能力足够高。不需要事前教它怎么用工具。只有在它**实际犯错**时，才注入一次纠正指导。错了再教，不错不教。

---

## 实施：只做两件事

### 1. ToolGuidanceStore（只用于失败匹配）

```typescript
// src/prompt/tool-guidance.ts

interface ToolGuidance {
  tool: string
  /** 失败时的一次性纠正指导（30-80 tokens） */
  onFailure: string
  /** 匹配失败模式 */
  failureTriggers: Array<{ pattern: string; guidance?: string }>
}

// 极简版——只为最常见的 3-5 个失败模式准备指导
const BUILTIN_GUIDANCE: ToolGuidance[] = [
  {
    tool: 'bash',
    onFailure: 'bash 链式命令用 &&。输出截断等 3s 后用 rawPath 读完整内容。不要用 bash 读文件/搜代码。',
    failureTriggers: [
      { pattern: 'output truncated' },
      { pattern: 'timed out' },
    ],
  },
  {
    tool: 'delegate_task',
    onFailure: 'delegate_task 的 worker 在隔离 session 运行，不能访问项目外文件。用 bash cat 替代。',
    failureTriggers: [
      { pattern: 'files outside the project directory' },
    ],
  },
  {
    tool: 'read_file',
    onFailure: 'read_file 必须用绝对路径。大文件用 offset/limit 读片段。已读过的文件不要重读。',
    failureTriggers: [
      { pattern: 'File not found' },
    ],
  },
  {
    tool: 'edit_file',
    onFailure: 'edit_file 的 old_string 必须在文件中唯一。先 read_file 确认内容再编辑。',
    failureTriggers: [
      { pattern: 'old_string not found' },
    ],
  },
]
```

### 2. RepairEngine 接入

```typescript
// 在 repair-engine 的诊断流程中增加一步：

function injectToolGuidance(toolName: string, errorMessage: string): string | null {
  const g = BUILTIN_GUIDANCE.find(g => g.tool === toolName)
  if (!g) return null
  
  for (const t of g.failureTriggers) {
    if (errorMessage.includes(t.pattern)) {
      return t.guidance ?? g.onFailure
    }
  }
  return g.onFailure
}

// 接入 PromptEngine.setRepairHint(hint)
```

### 不做的事情

- ❌ 上下文行为提示（Phase 2）—— 预防性教学，V4 Pro 不需要
- ❌ 星域工具约束（Phase 4 原版）—— 太重在 dynamic appendix，增加波动
- ❌ Habituation 集成（Phase 5）—— 过度工程化
- ❌ 方向 E 的 Worker 池 —— 需要动 tools 字段，缓存断裂

---

## 不做方向 E 的理由（缓存经济学论证）

方向 E 需要缩减主 agent 的 tools 字段。这会导致：

1. **一次性 cache miss**：tools 字段 hash 变化 → DeepSeek prefix cache 失效
2. **整个 session 缓存链断裂**：不只是当次 miss，而是后续所有请求的 prefix 锚点都变了
3. **成本**：一个典型 session（50 user messages × 10 tool turns = 500 API calls）
   - 500 次全部 cache miss（最坏情况）→ 500 × 3K tokens × ¥4/百万 = ¥6
   - 500 次全部 cache hit（最优情况）→ 500 × 3K tokens × ¥1/百万 = ¥1.5
   - 差 4 倍
4. **收益不明确**：Worker 减少了主 agent 的上下文占用，但增加了 delegate 延迟和 worker API 调用成本

**结论**：当前阶段不做方向 E。等 cache 稳定性得到充分验证后，作为一个独立的一次性迁移项目评估。

---

## 星域约束的轻量化处理

原 Phase 4 建议每个星域追加 150-300 tokens 的工具约束。这会导致：
- 星域切换时 dynamic appendix 波动增大
- miss 时的 token 增量增加（虽然频率不变）

**轻量化方案**：不追加工具约束到 volatileBlock，而是在 `star-domain.ts` 的 `volatileBlock` 中直接内嵌 1 行关键约束（≤ 15 tokens）。

```typescript
// 当前（已经够用）
volatileBlock: '你当前在破军域。破军之道：破旧立新的勇气。容忍失败，追求突破，不计代价探索边界。'

// 轻量化追加（仅 1 行）
volatileBlock: '你当前在破军域。破军之道：破旧立新的勇气。容忍失败，追求突破，不计代价探索边界。bash 可用，勿用于读文件。'
```

差异：从 ~30 tokens → ~40 tokens，几乎不可感知。

---

## 最终方案：一个文件 + 一个接入点

```
新增:
  src/prompt/tool-guidance.ts          (~80 行)

修改:
  src/prompt/repair-engine.ts          (+15 行，调用 injectToolGuidance)
```

### 总 token 增量

- 平时（无失败）：**零增量**
- 失败时：+30-80 tokens 注入到 repairHint（已在 dynamic appendix 中）
- 缓存：**零影响**

### 预期效果

- bash 输出截断 → agent 之前可能不知道 rawPath → 现在一次指导后就知道
- delegate_task 报 "files outside project" → agent 之前可能重复尝试 → 现在一次指导后改用 bash
- read_file 报 "File not found" → agent 之前可能用相对路径 → 现在提示用绝对路径

---

## 缓存安全性验证

| 验证项 | 预期 |
|--------|------|
| `getFingerprint()` | 不变 |
| `getSystemPrompt()` | 不变 |
| `buildStableVolatileBlock()` | 不变 |
| `getDefinitions()` | 不变（不新增/删除/修改工具） |
| 无失败时的请求 | 与当前完全相同（zero overhead） |
| 失败时的请求 | repairHint 内容增加 30-80 tokens（在已有通道中） |
