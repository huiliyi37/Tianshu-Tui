# 天枢星图流 v2：态势感知 + 信息素记忆 — 深度头脑风暴设计文档

> 版本：v2.0
> 状态：设计完成，待实施
> 前置资产：天枢星图流 v1 设计文档、ASL 设计、Dream Phase 1

---

## 背景

### 用户需求
"架构不能拖后腿，走在最前面，能力开到最强。借鉴已经没有很多效果。"

### 项目上下文
- 终端 TUI coding agent，基于 Ink/React
- 已有：免疫系统（antibody）、小脑回路（prediction-error）、梦境蒸馏（dream）、行为镜像、证据追踪、策略转移、子代理协调
- 已设计未实现：天枢星图流 8 阶段、ASL 事件通道、双模型路由
- 核心优势：极大程度提高开源模型性能

### 调研发现摘要

**4 个 Scout 的交叉发现：**

| Scout | 领域 | 最强发现 |
|-------|------|----------|
| 物理/复杂性 | stigmergy 信息素、全息边界编码、耗散结构、奇异吸引子 | 跨会话空间记忆 + 停滞检测触发去稳定 |
| 神经科学 | 认知地图、神经调质三标量、theta-gamma 节律、内感受、默认模式网络 | harness 层连续调节 + 节律性多关注 + 预测性资源管理 |
| 神秘学结构 | 易经 6-bit 编码、塔罗叙事状态机、炼金术 4 阶段、九型人格压力向量 | 极低 bit 预测性状态 + 阶段感知 + 行为模式预防性转向 |
| 定向反证 | 7 个隐含前提攻击 | LLM 不能自省(harness 层决策) + 短会话约束 + 维度耦合 + 解耦优于统一 |

---

## 三轮演化过程

### 第一轮：变异

4 个方案占据不同生态位：

| 方案 | 核心选择 | 生态位 |
|------|----------|--------|
| V1 进化星图流 | 6-bit 态势 + stigmergy + 星图流 | 与已有设计资产对接 |
| V2 神经调质仲裁 | DA/5-HT/NE 三标量 + 现有监控器 | 最小改动增强 |
| V3 全息认知地图 | 代码库拓扑 + 边界编码 | 空间感知投资 |
| V4 集体智能总线 | worker 共享黑板 + 涌现 | 协议层突破 |

### 第二轮：选择

- **灭绝 V4**：前提不满足（sub-agent 使用频率低）
- **回收 V4 trait**：共享黑板 → 简化为 stigmergy 文件
- **V1/V2/V3 收敛**：harness 层自主决策原则
- **V2 吸收入 V1**：三标量成为 6 维中的 3 个维度

### 第三轮：适应

最终方案 = V1 + V2 部分 + V3 部分 + 反证约束

---

## 最终方案：天枢星图流 v2

### 核心架构

```
┌─────────────────────────────────────────────────────┐
│  TUI 表现层：StarFlow Chart                          │
│  星图点亮 + 态势仪表 + 阶段转换动画                    │
└──────────────────────┬──────────────────────────────┘
                       │ StarEvent (phase + sensorium snapshot)
┌──────────────────────▼──────────────────────────────┐
│  态势感知层：AgentSensorium                          │
│  6 维连续向量 → 策略选择 → 行为调节                    │
│  纯 TypeScript，零 LLM 开销                          │
└──────────────────────┬──────────────────────────────┘
                       │ reads/writes
┌──────────────────────▼──────────────────────────────┐
│  记忆层：Stigmergy (Pheromones)                     │
│  .rivet/pheromones.json — 跨会话空间记忆              │
│  自动衰减，自动沉积，worker 共享                       │
└──────────────────────┬──────────────────────────────┘
                       │ feeds
┌──────────────────────▼──────────────────────────────┐
│  现有监控器（不变）                                   │
│  prediction-error / pressure-monitor / strategy-shift│
│  antibody / evidence / dream                         │
└─────────────────────────────────────────────────────┘
```

### 组件 1：AgentSensorium（态势感知）

**不是统一状态模型，是仲裁层。** 反证 scout 指出统一模型的风险。所以：
- 现有监控器保持独立运作
- Sensorium 是只读聚合器 + 策略选择器
- 不引入新的耦合

**6 个维度（0.0 - 1.0 连续值）：**

| 维度 | 信号源 | 计算方式 |
|------|--------|----------|
| `momentum` | PredictionAccumulator | consecutiveCorrect / windowSize |
| `pressure` | PressureMonitor | ratio (tokens / contextWindow) |
| `confidence` | EvidenceTracker | verified_count / modified_count |
| `complexity` | 工具调用多样性 | unique_tools_used / total_calls (sliding 5) |
| `freshness` | Pheromones | avg_pheromone_strength for active files |
| `stability` | strategy-shift | 1.0 - (doom_events / 5) |

**策略输出（不是 64 种查表，是连续映射）：**

```typescript
interface StrategyProfile {
  reasoningEffort: 'off' | 'low' | 'medium' | 'high' | 'max'
  explorationBreadth: number    // 0-1, 影响工具选择多样性
  commitThreshold: number       // 0-1, 多高置信度才执行破坏性操作
  shouldEscalate: boolean       // 是否请星（路由到强模型）
  thetaCycleInterval: number    // 每 N 步做一次跨文件一致性检查
}

function computeStrategy(s: Sensorium): StrategyProfile {
  return {
    reasoningEffort: s.complexity > 0.7 ? 'high' : s.momentum > 0.8 ? 'low' : 'medium',
    explorationBreadth: s.stability < 0.3 ? 0.9 : 0.3,  // 不稳定时广搜
    commitThreshold: s.pressure > 0.7 ? 0.9 : 0.6,       // 压力大时更谨慎
    shouldEscalate: s.confidence < 0.3 && s.momentum < 0.2,
    thetaCycleInterval: s.complexity > 0.5 ? 3 : 7,       // 复杂任务更频繁检查
  }
}
```

**关键设计决策（来自反证 scout）：**
- ❌ 不暴露给 LLM — 只在 harness 层驱动
- ❌ 不需要校准期 — 第 1 turn 就有值（从信息素预热 + 默认值）
- ❌ 不假设正交 — 策略函数显式处理维度间的交互
- ✅ 事件源 — 状态变化记录为事件，可回溯调试

### 组件 2：Stigmergy（信息素跨会话记忆）

**文件：** `.rivet/pheromones.json`

```typescript
interface Pheromone {
  path: string                    // 文件路径
  signal: PheromoneSignal         // 信号类型
  strength: number                // 0.0 - 1.0
  depositedAt: number             // timestamp
  halfLife: number                // ms (默认 7 天)
  context?: string                // 简短上下文 (< 80 chars)
}

type PheromoneSignal =
  | 'fragile'                     // 多次失败
  | 'well-tested'                 // 测试覆盖好
  | 'performance-critical'        // 性能敏感
  | 'refactor-candidate'          // 需要重构
  | 'dead-end'                    // 此路不通
  | 'entry-point'                 // 常用入口
  | 'coupling-hub'                // 高耦合节点
```

**沉积规则（自动，每次 tool 调用后）：**

| 事件 | 沉积信号 | 强度 |
|------|----------|------|
| write_file 后 test pass | `well-tested` | 0.6 |
| write_file 后 test fail | `fragile` | 0.8 |
| 同一文件 3 次 read 无 write | `entry-point` | 0.4 |
| bash 命令失败 2+ 次 | `dead-end` | 0.9 |
| import-graph 入度 > 5 | `coupling-hub` | 0.5 |

**衰减规则：**
```typescript
function currentStrength(p: Pheromone): number {
  const elapsed = Date.now() - p.depositedAt
  return p.strength * Math.exp(-0.693 * elapsed / p.halfLife)
}
```

**消费方式：**
1. 会话启动 → 读取信息素 → 注入 Sensorium.freshness
2. 文件选择 → 优先读取 `entry-point` 信号强的文件
3. 风险评估 → `fragile` 文件自动提高 commitThreshold
4. 策略选择 → `dead-end` 文件自动跳过

**容量控制：** 最多 200 条目，LRU + 强度阈值（< 0.05 自动清除）

### 组件 3：Theta-Gamma 节律（跨文件一致性检查）

**触发条件：** 当 `sensorium.complexity > 0.5`（多文件任务）时启用

**机制：**
- 每 `thetaCycleInterval` 个 tool call，暂停当前工作
- 遍历所有"活跃文件"（本 session 已修改的文件）
- 对每个文件执行快速一致性检查：
  - import 是否仍然解析？
  - 导出的类型签名是否与调用方匹配？
  - 如果有对应测试文件，是否仍然引用正确的函数名？
- 发现不一致 → 立即修复（在继续主任务之前）

**实现：** 不需要 LLM — 用 TypeScript compiler API 做类型检查即可

```typescript
function thetaCycleCheck(activeFiles: string[]): Inconsistency[] {
  // 用 tsc --noEmit 检查类型一致性
  // 用 import-graph 检查引用完整性
  // 返回发现的不一致列表
}
```

### 组件 4：StarFlow TUI 集成

**Sensorium → StarEvent 映射：**

| Sensorium 状态 | 星图阶段 | TUI 表现 |
|----------------|----------|----------|
| 首 turn + shouldEscalate | 请星（天枢规划） | ⭐ 天枢亮起 |
| freshness > 0.7 | 寻迹（定位） | 🔍 紫微寻迹 |
| complexity > 0.5 | 排阵（拆解） | 📐 天玑排阵 |
| confidence > 0.6 + writing | 铸形（实现） | 🔨 玉衡铸形 |
| running tests | 试锋（验证） | ⚔️ 开阳试锋 |
| momentum > 0.8 + final turn | 归航（交付） | 🏠 摇光归航 |
| confidence < 0.3 mid-task | 二次请星 | ⭐⭐ 天枢再临 |

**状态栏一行摘要：**
```
⭐ 天枢授策 │ DA:0.7 5HT:0.3 NE:phasic │ 📁 3 files │ ⏱ 12s
```

### 组件 5：耗散结构踢（停滞突破）

**触发条件：** `momentum < 0.2 && stability < 0.3`（连续失败 + 策略无效）

**动作序列：**
1. 记录当前方法为 `dead-end` 信息素
2. NE 切换到 tonic 模式（广搜）
3. 执行"关联扫描"：从 import-graph 中找与当前文件语义距离最远但结构相连的文件
4. 重新阅读用户原始请求
5. 生成 2-3 个替代框架

**与现有 strategy-shift 的关系：** strategy-shift 是"换个方法试"，耗散踢是"换个问题框架"。前者是 V2 级别的调整，后者是 V4 级别的重构。

---

## 与天枢星图流 v1 的关系

| 维度 | v1 | v2 |
|------|----|----|
| 阶段驱动 | 硬编码 8 阶段顺序 | Sensorium 动态驱动阶段转换 |
| 模型路由 | 天枢/紫微二元 | shouldEscalate 连续判断 |
| 跨会话 | 无 | Stigmergy 信息素 |
| 自适应 | 无 | 6 维态势 → 策略选择 |
| 二次请星 | 规则触发 | confidence + momentum 阈值 |
| TUI | 星图点亮 | 星图 + 态势仪表 + 节律指示 |

v2 不替代 v1，而是给 v1 加了"神经系统"。v1 是骨架（阶段结构），v2 是肌肉和神经（态势感知 + 自适应）。

---

## 风险与应对

| 风险 | 应对 |
|------|------|
| 6 维度选择不对 | Phase 1 用 benchmark 验证，不对就降到 3 维（momentum/pressure/stability） |
| 信息素被污染 | 指数衰减 + 强度阈值 + dead-end 信号需要 2+ 次确认 |
| theta-gamma 拖慢速度 | 只在 complexity > 0.5 时启用，且用 tsc 而非 LLM |
| Sensorium 计算开销 | 纯算术，< 1ms/turn |
| 与现有代码冲突 | 100% 扩展适应，不修改现有模块，只读取它们的输出 |

---

## 实施路径

| Phase | 内容 | 时间 | 成功标准 | 退出条件 |
|-------|------|------|----------|----------|
| 1 | AgentSensorium + computeStrategy | 1 周 | benchmark 提升 >15% | 维度振荡 → 降到 3 维 |
| 2 | Stigmergy pheromones.json | 1 周 | 第 3 次使用命中率 >80% | 文件 >100KB → LRU 淘汰 |
| 3 | StarFlow TUI + theta-gamma | 1 周 | 用户不再问"怎么样了" | 渲染 >50ms → 纯文本降级 |
| 4 | 耗散踢 + 二次请星 | 3 天 | 停滞突破成功率 >60% | 误触发 >20% → 提高阈值 |

---

## 下一步

Phase 1 的第一个具体动作：在 `src/agent/` 下创建 `sensorium.ts`，定义 `AgentSensorium` 接口和 `computeStrategy()` 函数，从现有的 `PredictionAccumulator`、`PressureMonitor`、`EvidenceTracker` 读取数据。
