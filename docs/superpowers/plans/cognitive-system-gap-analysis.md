# 认知系统闭环审计

> 日期: 2026-05-22 设计 → 2026-06-05 审计
> 状态: Gap Analysis — 三层架构视角

---

## 设计三层架构

认知系统的完整设计来自三份文档：
1. **HEARTH / 永明灯** (`specs/2026-05-22-yongminengdeng-design.md`) — 个体层参考系稳定性
2. **Songline / 歌之路** (`specs/2026-05-22-songline-runtime-design.md`) — 生态层存在根基
3. **协作场景** (`specs/2026-05-23-agent-collaboration-scenario.md`) — 工程映射版

三层关系：
```
HEARTH (个体参考系) ← 歌的乐谱骨架
Songline (生态存在) ← 歌被唱出来的过程
协作场景            ← 工程落地映射
```

---

## 第一层：已完成的认知管线（✅ 全部接入 loop.ts）

| 模块 | 行数 | 测试数 | 接入点 | 设计归属 |
|------|------|--------|--------|---------|
| `affordance.ts` | 361 | 16 | loop.ts:1230 | Free Energy Engine B1 |
| `sensorium.ts` | 279 | 28 | turn-perception.ts | Songline 个体层 |
| `vigor.ts` | 217 | 20 | turn-perception.ts | 认知管线 |
| `cognitive-season.ts` | 68 | 21 | loop.ts:1213 | Songline 世界节律（session 内） |
| `star-event.ts` | 285 | 32 | loop.ts:1206 | 阶段转换 |
| `policy-selection.ts` | 137 | 13 | loop.ts:1236 | Free Energy Engine B2 |
| `prediction-error.ts` | 132 | — | loop.ts:1188 | Free Energy Engine B1 |
| `turn-perception.ts` | 223 | — | loop.ts:1183 | 认知管线 |
| `tool-execution.ts` | 379 | — | 预测误差记录 | Free Energy Engine B4 |
| `theta-check.ts` | 79 | — | 外部信号触发 | Songline 世界节律 |
| `theta-controller.ts` | 68 | — | loop.ts:696 | Songline 世界节律 |
| `context/cognitive-ledger.ts` | — | — | loop.ts:1061 | CVM 认知投影 |

**集成管线流程**（每轮执行）:
```
perceive() → sensorium + vigor + theta
    → classifySeason()
    → computeAffordanceScores()
    → computeEFE() → selectPolicy()
    → renderAffordanceHint() + renderPolicyGuidance()
    → promptEngine.set*() 注入提示
    → 每10轮 adaptAffordanceFromHistory() 反馈
```

**集成测试**: `cognitive-pipeline.test.ts` (7 tests) 验证端到端管线。

---

## 第二层：已实现但未接入（🟡 等待上层完成）

### 2.1 `world-season.ts` — 世界级季节信号

- **文件**: `src/agent/world-season.ts` (46 行)
- **设计归属**: Songline Phase 1 — "世界物理法则层"
- **功能**: 基于 UTC 时间戳的 24h 周期（genesis → reversal → return → wuwei），所有 agent 共享
- **状态**: 已实现，零 import。没有被任何文件引用。
- **未接入原因**: 它是 Songline 系统的组件，需要 HEARTH 锚位拓扑完成后一起接入。单独接入没有意义——世界节律信号需要落地到锚位才有价值。
- **Songline 设计公理 3**: "同步来自共享外部信号，不来自内部通信" → `world-season` 就是这个共享外部信号
- **接入路径**: HEARTH Phase 1 完成 → 在 `classifySeason` 输入中增加 `worldSeason` 作为额外因子

---

## 第三层：设计完成但未实现（❌ HEARTH + Songline 核心）

### 3.1 HEARTH 锚位拓扑 (`anchor-graph.ts`)

- **设计**: 5+1 锚位（pole_structure / pole_void / cycle_close / cycle_open / center_belief + 扰动位）
- **5 条不变量**: INV-1~5（乾坤互补 / 首尾相接 / 中孚环绕 / 扰动位 / 漂移检测）
- **工程计划**: `src/prompt/anchor-graph.ts`（数据结构 + invariant 校验）
- **状态**: ❌ 待实现
- **阻塞**: 无，可独立启动

### 3.2 Songline 义务引擎 (`obligation.ts`)

- **设计**: 语义级目标追踪，替代预设轮次
- **关键接口**: `Obligation { description, completionSignal }` + `ObligationEngine.advance(evidence)`
- **状态**: ❌ 待实现
- **依赖**: 无硬依赖，但与 HEARTH 锚位协同效果更好

### 3.3 Worker 锚位投影注入

- **设计**: 在 worker prompt 中注入简化的锚位投影（structure/void/belief）
- **位置**: `src/agent/worker-prompts.ts` → `buildPrimaryWorkerPacket()`
- **状态**: ❌ 待实现
- **依赖**: HEARTH Phase 1

### 3.4 Scope-Claim 信息素

- **设计**: Worker 启动时声明 scope-claim，完成时 deposit scope-complete
- **位置**: 扩展 `StigmergyStore` 信号类型
- **状态**: ❌ 待实现
- **依赖**: 无

### 3.5 守火人 (Fire-Keeper)

- **设计**: 碑文迁入 fire-keeper sub-agent，按需召唤校准
- **状态**: ❌ 待实现（远期，需要 ablation 实验验证）
- **依赖**: HEARTH Phase 1 + 内化验证数据

---

## 第四层：小优化（🟢 可选）

### 4.1 `ask_user_question` affordance 分类粗糙

- **当前**: `{ epistemic: 0.5, instrumental: 0.5 }`
- **方案**: 改为 `{ epistemic: 0.65, instrumental: 0.35 }`（提问主要目的是减少不确定性）

### 4.2 `contextualModulator` 中 `fileTools` Set 每次重建

- **严重性**: 极低。40 个 Set 创建 < 0.1ms
- **方案**: 提取为模块级常量

### 4.3 Prediction Error 反馈链验证

- **问题**: 预测"正确性"判定逻辑需要确认是否真正影响行为
- **方案**: 添加独立测试验证 `prediction → error → EFE → policy` 链路

---

## 实施路径建议

```
现在 ──────────────────────────────────────────────► 完整认知系统

[第一层 ✅] 认知管线              [已完成]
    │
[第二层 🟡] world-season 接入     [需要 HEARTH 先完成]
    │
[第三层 ❌] HEARTH Phase 1        [可独立启动]
           ├─ anchor-graph.ts
           ├─ invariant 校验
           └─ fingerprint 扩展
    │
           Songline Phase 1       [可与 HEARTH 并行]
           ├─ world-season 接入
           ├─ obligation.ts
           └─ scope-claim 信息素
    │
           Worker 增强             [依赖 HEARTH]
           ├─ 锚位投影注入
           └─ scope 边界 gate
    │
[远期]      Fire-Keeper           [需要 ablation 数据]
```

**下一步建议**：
1. ✅ 第一层已完成
2. 🔜 HEARTH Phase 1 (`anchor-graph.ts` + 5 invariant) — 认知系统的核心缺失部分
3. 🔜 Songline Phase 1 (义务引擎 + world-season 接入) — 与 HEARTH 可并行
4. ⏳ Worker 增强 — HEARTH 完成后
5. ⏳ Fire-Keeper — 需要实验数据，不设 deadline
