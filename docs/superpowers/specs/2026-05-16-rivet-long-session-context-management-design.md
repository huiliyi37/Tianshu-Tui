# Rivet 长会话上下文管理设计

> 深度头脑风暴产出 — 经过变异（4 方案）→ 选择（2 灭绝）→ 适应（1 方案）三轮过程

## 背景

### 问题

Rivet 当前上下文管理是被动式：在 token 占用达到 800K 阈值时触发 `smartCompact`（LLM 摘要），中间穿插 `microCompact`（tool_result 截断到 1200 字）。这种"到阈值才急救"的策略在长会话（3-4 小时、50+ 轮对话）中存在三个致命问题：

1. **不可恢复的灾难**：会话炸掉（上下文溢出 1M 窗口）后，所有上下文丢失，无法恢复
2. **压缩即丢失**：smartCompact 用 LLM 做摘要，用户约束和决策可能在压缩时被误判为不重要而丢弃
3. **Lost-in-middle 效应**：在 26K+ token 后模型对中间信息的注意力显著衰减，即使未到阈值

### 约束

- DeepSeek V4 1M token 窗口，prefix cache 要求保留前 2 条消息
- 会话炸掉 = 零容忍（灾难性不可恢复）
- 必须适用于所有用户类型（开发者 + 非开发者）
- 必须保持 prefix cache 命中率

### 调研发现

| 来源 | 核心发现 |
|------|---------|
| Anthropic 上下文工程 | 三层策略：压缩（第一杠杆）、结构化笔记、子代理架构。"find the smallest set of high-signal tokens" |
| Mem0 | 两层 RAM/Storage 模型。LoCoMo 基准：91.6% 准确率 @ <7K token vs 72.9% @ 26K+ token |
| Budget-Aware Context Management (arXiv) | 显式 token 预算分配框架，LLM 代理在预算约束下做长链推理 |
| Lost-in-middle 研究 | 26K+ token 后注意力衰减显著，需要在衰减前主动管理 |
| Rivet 代码审计 | tool_result 是主要增长源（bash 100K、git 50K、web-fetch 50K），当前 microCompact 截断到 1200 字丢失细节 |

## 三轮思考过程

### 第一轮：变异（4 个方案）

| 方案 | 生态位 | 一句话核心选择 |
|------|--------|---------------|
| V1（主流） | 增强现有压缩 | 在现有基础上增加多级压缩阈值（400K/600K/800K/900K），每级不同策略 |
| V2（邻近） | 预算管理 | 给每个上下文消费者分配 token 预算，全程监控，超预算按优先级回收 |
| V3（空位） | 分层记忆 | Working Memory（窗口内，严格预算）+ Persistent Memory（文件级，跨会话），用"遗忘"替代"压缩" |
| V4（突变） | 最小窗口 | 模型窗口只保留最近 1 轮 + 系统提示，全部历史通过 recall 工具按需检索 |

### 第二轮：选择

| 方案 | 因果链 | 成本/收益 | 共演化 | 落地性 | 判定 |
|------|--------|----------|--------|--------|------|
| V1 | 通过但脆弱 | 中等 | 静态 | 可执行 | **灭绝** — 局部最优陷阱，不解决根本问题 |
| V2 | 通过 | 良好 | 动态 | 可执行 | 存活（中） |
| V3 | 通过 | 最佳 | 动态 | 可执行 | 存活（强） |
| V4 | 断裂 | 差 | 静态 | 风险极高 | **灭绝** — 1 轮窗口在编码场景下不可行 |

**灭绝原因：**
- V1：多级压缩是"在泰坦尼克号上多加几个舱壁"——延缓但不消除溢出。长期技术债高。
- V4：编码任务需要模型记住之前的修改、约束、目标。1 轮窗口导致能力严重退化。

**收敛洞察：** V2 和 V3 收敛到同一核心真相——"上下文管理的核心是主动预算控制，不是被动压缩"。

### 第三轮：适应

**最终方案：V3（工作/持久记忆分层）+ V2 预算概念 + V4 recall 工具**

核心架构转变：从"上下文 = 全部历史"到"上下文 = 工作记忆 + 轻量引用"，配合持久记忆层和 recall 检索工具。

## 最终方案

### 架构概览

```
┌─────────────────────────────────────────────┐
│            Model Context Window              │
│  ┌───────────┐  ┌──────────┐  ┌───────────┐ │
│  │ System     │  │ Volatile │  │ Working   │ │
│  │ Prompt     │  │ Context  │  │ Memory    │ │
│  │ (fixed)    │  │ (refresh)│  │ (budgeted)│ │
│  └───────────┘  └──────────┘  └───────────┘ │
│         ↕            ↕             ↕         │
│  ┌─────────────────────────────────────────┐ │
│  │        Context Budget Manager           │ │
│  │  WARN: 500K  HARD: 700K  CEILING: 800K │ │
│  └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
                      ↕ forget / recall
┌─────────────────────────────────────────────┐
│         Persistent Memory (~/.rivet/memory/)│
│  ┌──────────┐  ┌──────────┐  ┌────────────┐ │
│  │ Tool     │  │ Constraint│ │ Session    │ │
│  │ Archives │  │ & Decision│ │ Summaries  │ │
│  │ (SHA-256)│  │ Log       │ │ Chain      │ │
│  └──────────┘  └──────────┘  └────────────┘ │
└─────────────────────────────────────────────┘
```

### 核心组件

#### 1. Context Budget Manager

**位置：** `src/agent/budget-manager.ts`

**职责：** 全程追踪 token 占用，在预算线处触发主动遗忘。

**预算线：**

| 级别 | 阈值 | 动作 |
|------|------|------|
| NORMAL | < 500K | 无动作 |
| WARN | 500K | >10 轮之前的 tool_result 替换为单行引用，写入持久记忆 |
| HARD | 700K | >5 轮之前的 tool_result 替换 + 中间 assistant messages 摘要 |
| CEILING | 800K | 触发现有 smartCompact 作为最后安全网 |

**接口：**

```typescript
interface BudgetManager {
  check(): BudgetStatus
  forget(olderThanRounds: number): Promise<ForgetResult>
  getFootprint(): TokenFootprint
}

interface TokenFootprint {
  system: number
  volatile: number
  working: number
  total: number
  budgetLevel: 'normal' | 'warn' | 'hard' | 'ceiling'
}

interface ForgetResult {
  forgottenCount: number
  reclaimedTokens: number
  archivedTo: string[] // persistent memory file paths
}
```

**关键设计决策：**
- 每轮结束后调用 `check()`，而非每条消息——减少开销
- 遗忘操作是"转移"而非"删除"——完整内容写入持久记忆，工作窗口只留引用
- 引用格式：`[archived:read_file:src/loop.ts:v3@2026-05-16T14:30:00]`，包含工具名、路径、版本号、时间戳
- 引用占 ~50 token，原始 tool_result 平均 2-5K token，回收比 40-100:1

#### 2. Persistent Memory Store

**位置：** `src/memory/persistent-store.ts`

**职责：** 管理跨会话持久记忆的读写。

**存储结构：** `~/.rivet/memory/`

```
~/.rivet/memory/
├── tool-archives/
│   └── <sha256-hash>.json    # 完整 tool_result + 元数据
├── constraints.jsonl          # 用户约束和决策（追加写入）
├── session-summaries.jsonl    # 每次遗忘时的会话进展摘要
└── index.json                 # 全局索引（工具名→文件路径→存档ID）
```

**tool-archive 条目格式：**

```typescript
interface ToolArchive {
  id: string              // SHA-256 hash
  toolName: string        // read_file, bash, git, etc.
  filePath?: string       // 目标文件路径（如有）
  timestamp: string       // ISO 8601
  sessionId: string
  roundNumber: number
  originalSize: number    // token 数
  content: string         // 完整 tool_result
  summary?: string        // 轻量摘要（Phase 3）
}
```

**复用已有基础设施：**
- `output-store.ts` 的 SHA-256 索引模式 → 直接复用索引逻辑
- `session-persist.ts` 的 JSONL 追加写入 → 复用存储格式
- `file-history.ts` 的快照清理 → 参考过期策略

#### 3. Recall 工具

**位置：** `src/tools/recall.ts`

**职责：** 让模型从持久记忆中检索历史信息。

**工具定义：**

```typescript
{
  name: 'recall',
  description: '从持久记忆中检索历史工具结果、约束或会话摘要',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词或文件路径' },
      type: { type: 'string', enum: ['tool_result', 'constraint', 'summary', 'all'], default: 'all' },
      since: { type: 'string', description: 'ISO 8601 时间，只返回此时间之后的结果' },
      limit: { type: 'number', default: 5, description: '最大返回条数' }
    }
  }
}
```

**检索策略：**
- 精确匹配：文件路径或工具名完全匹配
- 关键词匹配：query 在 content/summary 中的出现次数
- 时间排序：最近的优先
- 返回格式：摘要 + 引用 ID，模型可以请求完整内容

#### 4. 约束提取器（Phase 3）

**位置：** `src/memory/constraint-extractor.ts`

**职责：** 从对话中提取用户约束和决策，持久化后在新会话中自动注入。

**提取触发：** 每轮结束后，如果本轮包含用户消息且用户消息中包含指令性内容。

**提取方式：** 轻量 LLM 调用（非主模型），prompt 要求识别：
- 用户明确说的规则（"不要动缓存代码"、"用 TDD"）
- 用户做的决策（"选方案 A"、"用 Zod 做验证"）
- 用户表达的偏好（"我喜欢函数式风格"）

**注入方式：** 新会话启动时，从 `constraints.jsonl` 加载最近 N 条约束，注入到 volatile context 的 `<constraints>` 块中。

### 与现有系统的集成

#### 不改变的部分

| 组件 | 理由 |
|------|------|
| `src/compact/micro.ts` | 作为 Tier 1 紧急截断仍然保留 |
| `src/compact/auto.ts` | 作为 CEILING 安全网保留（800K） |
| `src/agent/context.ts` | 增量 token 估算复用 |
| `src/tools/output-store.ts` | SHA-256 索引模式复用 |
| prefix cache 锚定 | 前 2 条消息（系统提示 + volatile）不变 |

#### 改变的部分

| 组件 | 变更 |
|------|------|
| `src/agent/loop.ts` | 每轮结束后调用 BudgetManager.check() |
| `src/compact/auto.ts` | shouldAutoCompact 增加 budget level 判断 |
| `src/agent/session-persist.ts` | 增加 persistent memory 引用的持久化 |
| `src/prompt/volatile.ts` | Phase 3 注入约束块 |

### Token 预算模型

```
1M token 窗口分配：

系统提示:        ~15K (固定)
Volatile Context: ~3K  (每轮刷新，不累积)
工作记忆预算:     ~550K (严格管理)
  - 最近 3 轮完整保留: ~150K
  - 3-10 轮 tool_result 摘要: ~100K
  - 3-10 轮 assistant messages: ~100K
  - 预算缓冲: ~200K
推理余量:        ~430K (模型推理使用)
```

## 实施路径

### Phase 1：上下文预算监控 + 主动遗忘（3-4 天）

**目标：** 从被动压缩变为主动管理，确保长会话 token 占用平稳。

**具体动作：**
1. 创建 `BudgetManager`，在每轮结束后检查 token 占用
2. 实现 forget 操作：将旧 tool_result 写入 `~/.rivet/memory/tool-archives/`，模型窗口中替换为单行引用
3. WARN（500K）和 HARD（700K）两级预算线
4. 现有 smartCompact 保留为 CEILING（800K）安全网

**成功标准：** 模拟 50 轮会话，token 占用曲线平稳在 400-550K，不触及 800K。

**退出条件：** 如果主动遗忘导致模型丢失关键任务上下文（通过 A/B 测试），退回纯预算监控（V2）。

### Phase 2：持久记忆层 + recall 工具（3-4 天）

**目标：** 被遗忘的信息不丢失，模型可以按需检索。

**具体动作：**
1. 实现 `PersistentStore`，复用 output-store 的 SHA-256 索引
2. 创建 `recall` 内置工具
3. 持久记忆过期策略（默认 7 天，可配置）
4. session-persist 增加 persistent memory 引用的持久化

**成功标准：** 模型在 tool_result 被遗忘后，通过 recall 找回信息并正确使用。

**退出条件：** 如果 recall 调用频率 >2 次/轮，说明遗忘策略太激进，调回阈值。

### Phase 3：约束提取 + 跨会话恢复（2-3 天）

**目标：** 用户约束跨会话存活，新会话自动恢复项目上下文。

**具体动作：**
1. 实现 `ConstraintExtractor`，轻量 LLM 提取约束和决策
2. 新会话启动时自动注入约束到 volatile context
3. 会话摘要链：遗忘时生成进展摘要并持久化

**成功标准：** 新会话开始时，模型自动知道上一会话的 3 个关键约束。

**退出条件：** 如果约束提取准确率 <80%（抽检），暂停自动提取，改为手动标注。

## 风险与应对

| 风险 | 概率 | 影响 | 应对 |
|------|------|------|------|
| 遗忘时机不对，丢失关键上下文 | 中 | 高 | Phase 1 用保守阈值（500K），Phase 2 用 recall 兜底 |
| recall 工具调用频率过高，拖慢交互 | 中 | 中 | 遗忘策略可配置，recall 结果缓存 |
| 约束提取误判 | 中 | 中 | Phase 3 先做提取但不自动注入，人工验证后再开启 |
| 持久记忆无限增长 | 低 | 低 | 7 天过期 + 100MB 磁盘上限 |
| prefix cache 命中率下降 | 低 | 高 | 前 2 条消息不变，遗忘只影响中间消息 |

## 下一步

Phase 1 的第一个具体动作：创建 `src/agent/budget-manager.ts`，实现 `TokenFootprint` 计算和 `BudgetStatus` 检查，写测试验证 token 估算准确性。
