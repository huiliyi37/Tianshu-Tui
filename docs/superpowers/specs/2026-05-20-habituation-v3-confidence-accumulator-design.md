# 习惯化引擎 v3：信心累加器 + 阶段调制

## 背景

### 问题

冰鉴缓存引擎 v2 的习惯化阈值是固定 turn 计数器（`stableCount >= threshold`，默认 5）。这导致：
- **感知期**（agent 读大量文件、volatile 剧烈变化）：字段碰巧不变 5 turn 就会被错误晋升
- **执行期**（agent 锁定方向连续写文件）：需要等满 5 turn 才能晋升，浪费缓存机会
- 计数器不感知 agent 行为阶段，无法区分"偶然静默"和"真正稳定"

### 约束

- 不引入 `src/prompt/` → `src/agent/` 的 import 依赖（架构边界）
- sensorium 已从 6D 简化为 3D（momentum, pressure, confidence），stability 维度不存在
- sensorium.stability 语义为 doom-loop 严重度，与字段稳定性无关
- 字段值用 SHA-256 hash 判断，是二值数据（match / no-match）
- 改动量目标：50-80 行产品码 + 30-50 行测试

### 调研发现（4 scout + 1 反证）

跨领域调研发现 **没有任何生物/物理系统用固定计数器判断稳定性**。所有系统检测的是统计相变：

| 领域 | 机制 | 可移植性 |
|------|------|----------|
| B 细胞亲和力成熟 | IRF4 信心累加器 + 正反馈 + 双稳态开关 | **高 — 核心采纳** |
| 粘菌网络优化 | `dD/dt = f(|Q|) - D`，衰减项持续挑战 | **高 — 缺席衰减采纳** |
| Cao-Rhinehart R 统计量 | V_local / V_global ≥ R_critical | 低 — 二值数据上退化为计数器 |
| Omori 余震衰减 | `n(t) = K/(c+t)^p` | 低 — 需要连续时间序列 |
| 经典核化理论 | 簇大于临界半径 → 不可逆生长 | 中 — 概念上对应"亚临界不晋升" |
| 爵士主题结晶 | 临界慢化（rising AR(1) + variance） | 低 — 需要信号处理 |

### 反证 scout 关键发现

1. `sensorium.stability` 语义错误 — 测量 doom loop，非字段稳定性
2. PromptEngine 无 sensorium 数据路径 — 但已有 `setBehaviorMirror()` 等 setter 模式
3. R 统计量在二值数据上退化 — 放弃 R 统计量方案
4. StarPhase 在 postTool 计算 — 但 phaseClass 可在 perception 完成后提前获取

## 方案

### 信心累加器 + phaseHint α 调制

替换固定 turn 计数器为连续信心分，由 agent 行为阶段调制累加速率。

#### 核心公式

```
match:   confidence += (1 - confidence) * alpha(phaseHint)
change:  confidence = 0
absent:  confidence *= (1 - decay)

habituated = confidence >= PROMOTION_THRESHOLD
```

生物学对应：
- `confidence` = IRF4 累加器（0 → 1 连续）
- `alpha(phaseHint)` = 神经调质门控（行为阶段调制累加速率）
- `(1 - confidence) * alpha` = 正反馈（IRF4 正调控 — 越接近晋升，每次确认的边际信心越小，但绝对增长速率在低信心区更快）
- `confidence = 0` on change = 硬重置（B 细胞去习惯化）
- `confidence *= (1 - decay)` on absent = 粘菌衰减项（缺席字段自然遗忘）

#### α 调制表

| phaseHint | α | 含义 | ~晋升 turn 数 |
|-----------|---|------|--------------|
| `explore` | 0.10 | 感知期，保守 | ~15 turn |
| `plan` | 0.20 | 规划期，中等 | ~7 turn |
| `execute` | 0.35 | 执行期，积极 | ~4 turn |
| `verify` | 0.30 | 验证期，稍积极 | ~5 turn |
| `deliver` | 0.40 | 交付期，最积极 | ~3 turn |
| 未知/缺省 | 0.20 | 回退到 plan | ~7 turn |

晋升 turn 数推导：`n = ceil(log(1 - 0.8) / log(1 - α))`

#### 缺席衰减

```
decay = 0.3   →   confidence *= 0.7 per absent turn
```

- 连续缺席 1 turn：信心保留 70%
- 连续缺席 3 turn：信心保留 34%（0.7^3）
- 连续缺席 5 turn：信心保留 17% → 实际去习惯化

#### 数据流

```
AgentLoop
  │
  ├── perception.perceive()  →  computes sensorium + StarPhase
  │                                │
  │                                └──→ promptEngine.setPhaseHint(phaseClass)
  │                                       │
  └── promptEngine.buildRequest()          │
        │                                  │
        └── tracker.recordTurn(fieldValues, this.phaseHint)
              │
              └── confidence += (1-confidence) * ALPHA_TABLE[phaseHint]
```

phaseHint 是 `string`（不是 StarPhase 类型），不引入跨模块类型依赖。

#### FieldState 变更

```typescript
// Before (v2)
interface FieldState {
  hash: string
  content: string
  stableCount: number
  habituated: boolean
}

// After (v3)
interface FieldState {
  hash: string
  content: string
  confidence: number      // 0.0 - 1.0, replaces stableCount
  habituated: boolean
}
```

#### 接口变更

```typescript
// FieldHabituationTracker
constructor(config: HabituationConfig)
// HabituationConfig.threshold removed, replaced by:
// HabituationConfig.promotionThreshold?: number  (default 0.8)
// HabituationConfig.decayRate?: number            (default 0.3)

recordTurn(fieldValues: Record<string, string>, phaseHint?: string): void
// phaseHint is optional — falls back to alpha=0.2

// PromptEngine
setPhaseHint(hint: string): void
```

## 验收标准

- [ ] explore 阶段：字段稳定 10 turn 不晋升（α=0.1, 10 turn → confidence ≈ 0.65 < 0.8）
- [ ] execute 阶段：字段稳定 4 turn 即晋升（α=0.35, 4 turn → confidence ≈ 0.82 > 0.8）
- [ ] 字段内容变化：信心立即归零
- [ ] 字段缺席 3 turn：信心降至 34%
- [ ] 无 phaseHint 时：回退到 α=0.2，行为类似 v2 threshold=7
- [ ] 所有现有测试通过或合理更新
- [ ] npm run typecheck — 0 errors
- [ ] 缓存命中率不低于 v2 的 74.6%

## 风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| phaseClass 获取时机不对 | 中 | 中 | 降级为固定 α=0.2 |
| α 参数需要调优 | 高 | 低 | 参数外置到 config，支持运行时调整 |
| 缺席衰减过于激进 | 低 | 中 | decay=0.3 是保守值，3 turn 缺席仍保留 34% |
