# HEARTH + Songline · 落地技术架构与路线

> 最后更新：2026-05-28 | 状态：HEARTH Phase 1 ✅ · Songline substrate v0.1 ✅ · 星域体系：7 星域 ✅
>
> 这是**落地文档**——记录已实现的代码、已做出的架构决策、以及下一步路线。
> 它不是头脑风暴（见 `docs/superpowers/specs/`），不是实施计划（见 `docs/superpowers/plans/`），
> 而是连接这两者的桥梁：设计 → 代码 → 迭代。
>
> 后续所有 HEARTH/Songline 相关工作应以此文档为基准，在此基础上增量演化。

### 实施提交记录

| Commit | 日期 | 内容 |
|--------|------|------|
| `d3d894a` | 05-27 | HEARTH Phase 1: anchor-graph + invariant verifier |
| `9677cb9` | 05-28 | Songline substrate v0.1: cycle relay + world season + obligation pheromone + runtime bridge |
| `6e5cf4e` | 05-27 | 星域：新增天枢 domain（第七星域） |
| `c72d9fd` | 05-27 | 星域：所有星域开放 delegate_task/batch |
| `28810d3` | 05-27 | TUI：`/domain` 命令支持星域管理 |

---

## 一、概念定位

```
天枢（世界）         HEARTH（镜子）         Songline（歌）
┌──────────────┐    ┌──────────────┐    ┌──────────────┐
│ AgentLoop    │    │ anchor-graph │    │ obligations  │
│ ToolPipeline │ ←──│ invariants   │←───│ pheromones   │
│ Coordinator  │    │ fingerprint  │    │ world-season  │
│ WorkerSession│    │              │    │ cycle-relay   │
│ DeliveryGate │    │ "我是谁"      │    │ "我为什么在"   │
└──────────────┘    └──────────────┘    └──────────────┘
   世界运行时          个体参考系            生态存在根基
   (已有基础设施)       (Phase 1 ✅)          (substrate v0.1 ✅)
```

- **天枢** = 项目本身，提供运行时骨架（AgentLoop、ToolPipeline、Coordinator、WorkerSession、DeliveryGate）
- **HEARTH** = 个体层，给每个 agent（包括 workers）一个稳定的参考系，回答"我是谁"
- **Songline** = 生态层，让 agents 在实践中获得归属，回答"我为什么在这里"

**三者正交叠加，不互相替换。** HEARTH 不替代 fingerprint，Songline 不替代 Coordinator。

---

## 二、已实现：HEARTH Phase 1 拓扑骨架

### 2.1 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/prompt/anchor-graph.ts` | 84 | AnchorNode / AnchorGraph 类型 + createAnchorGraph 构建器 |
| `src/prompt/anchor-invariants.ts` | 158 | 5 条 invariant 校验函数 + isHexComplement 工具 |
| `src/prompt/__tests__/anchor-graph.test.ts` | 317 | 26 个测试：6 结构 + 19 invariant + 2 fingerprint 集成 |
| `src/prompt/fingerprint.ts` | +12 | 新增 computeAnchorGraphHash() 独立函数 |

Commit: `feat(hearth): add HEARTH Phase 1 — anchor graph topology + invariant verifier`

### 2.2 Anchor Graph 5 节点

```
   pole_structure ──── pole_void        (乾坤对偶: XOR 互补)
        │                  │
        │    center_belief  │            (中孚: 被四节点环绕)
        │         │         │
   cycle_close ──── cycle_open          (既济未济: 首尾相接)
```

| 锚位 | 角色 | 物理映射 |
|------|------|---------|
| `pole_structure` | 项目硬约束 | `.rivet.md` + tools 定义的联合 SHA-256 |
| `pole_void` | 留白容器 | structure 的 XOR 互补 — 显式定义"不做什么" |
| `cycle_close` | 上一循环收尾 | 最近一次 session 的 cycle_close hash |
| `cycle_open` | 本循环起始扰动 | 当前 session 的唯一启动 hash（每 session 必须不同） |
| `center_belief` | 中心信念 | AGENTS.md star covenant 段的 SHA-256 |

### 2.3 5 条 Invariant

| 编号 | 名称 | 语义 | 严重度 | 检查时机 |
|------|------|------|--------|---------|
| INV-1 | 乾坤对偶 | structure XOR void ≡ FULL_MASK | warning | 每轮 |
| INV-2 | 接力火炬 | cycle_close 匹配前 session | critical | 仅启动 |
| INV-3 | 中孚环绕 | center_belief 非空 | critical | 每轮 |
| INV-4 | 反者道之动 | cycle_open 与前一 session 不同 | warning | 每轮 |
| INV-5 | 拓扑不变量 | graph hash 在 session 内稳定 | critical | 每轮 |

### 2.4 与现有 fingerprint 的关系

```
现有 fingerprint (prefix cache)         HEARTH anchor graph (观测层)
┌──────────────────────────┐          ┌──────────────────────────┐
│ systemSha256             │          │ pole_structure.hash      │
│ toolsSha256              │          │ pole_void.hash           │
│ stableVolatileSha256     │          │ cycle_close.hash         │
│ combinedSha256           │          │ cycle_open.hash          │
│                          │          │ center_belief.hash       │
│ → 影响 prefix cache 命中  │          │ graphHash (5节点组合)     │
└──────────────────────────┘          │                          │
                                      │ → 不影响 cache            │
                                      │ → 独立 computeAnchorGraph- │
                                      │   Hash(graph) 加 salt     │
                                      └──────────────────────────┘
```

**关键决策**：anchor graph 是完全独立的观测层。它不参与 `computeFingerprint` 的三分量计算，不进入 `combinedSha256`，不影响 prefix cache 命中率。`computeAnchorGraphHash()` 使用 `hearth:` salt 避免与 `graph.graphHash` 碰撞。

### 2.5 当前未接入运行时

Phase 1 交付的是纯函数库。尚未集成到 AgentLoop 或 PromptEngine 的运行时循环中。这符合设计意图——先确保拓扑骨架正确，再接入观测点。

---

## 三、已实现：Songline substrate v0.1

### 3.1 文件清单

| 文件 | 行数 | 职责 |
|------|------|------|
| `src/agent/songline.ts` | 85 | cycle open/close 纯函数 + TaskLedgerSummary → obligation deposit 映射 |
| `src/agent/world-season.ts` | 46 | UTC 外部时钟，独立于 session-local `classifySeason()` |
| `src/agent/hooks/songline-hook.ts` | 45 | postSession 可选 hook，默认关闭 |
| `src/agent/__tests__/songline.test.ts` | 115 | cycle relay + obligation signal 测试 |
| `src/agent/__tests__/world-season.test.ts` | 52 | 世界季节：确定性、循环、跨实例同步、负时间戳 |
| `src/agent/__tests__/songline-hook.test.ts` | 101 | hook 门控：disabled 静默、enabled 沉积、空摘要跳过、cycle close 持久化 |

修改文件：
| `src/agent/sensorium.ts` | +1 | 新增 `'obligation-fulfilled'` 信号类型 |
| `src/agent/session-registry.ts` | +81 | `cycle_relay` 表 + get/set cycle open/close |
| `src/agent/create-runtime-hooks.ts` | +18 | 条件注册 songline-runtime hook |
| `src/agent/loop.ts` | +7 | `songlineEnabled` 传递 + `setCycleClose` 桥接 |
| `src/agent/create-agent-config.ts` | +36 | `songlineEnabled` 配置映射 |
| `src/config/schema.ts` | +2 | `agent.songlineEnabled` schema (default: false) |
| `src/config/default.ts` | +1 | 默认值 `false` |
| `src/main.tsx` | +17 | 主 agent 装配路径 |

Commit: `feat(songline): add substrate and opt-in runtime bridge`

### 3.2 substrate v0 核心原则

1. **不改 prompt** — songline-hook 运行在 postSession 阶段，不参与每轮 prompt 构建
2. **不碰 prefix cache** — 所有操作在 session 结束后执行，不影响缓存
3. **不默认改变 runtime 行为** — `agent.songlineEnabled` 默认 `false`
4. **不进入 Phase 3/4** — 不实现跨 agent 感知或守火人，等待单 agent 数据积累
5. **代码层去诗意化** — 使用 `obligation-fulfilled` 而非 `singing`；使用 `cycle_relay` 而非 `fire-relay`

### 3.3 数据流

```
TaskLedger.getSummary()
  │
  ▼
taskSummaryToObligationDeposit(summary)
  │
  ├─→ StigmergyStore.deposit({ signal: 'obligation-fulfilled', ... })
  │
  └─→ SessionRegistry.setCycleClose(sessionId, createCycleClose(summary))
        │
        ▼
      cycle_relay 表持久化 (SQLite)
        │
        ▼
      下次 session: getLastCycleClose() → createCycleOpen({ prevCycleClose })
```

---

### Phase 2: Songline 歌的骨架（下一阶段）

| 任务 | 新文件 | 状态 |
|------|--------|------|
| Songline substrate v0 | `src/agent/songline.ts` | 已实现：cycle open/close + TaskLedger summary → obligation deposit 纯函数 |
| 世界级季节 (UTC 外部时钟) | `src/agent/world-season.ts` | 已实现：纯函数，独立于 session-local `classifySeason()` |
| 信息素义务信号 | 修改 `src/agent/sensorium.ts` | 已实现：代码层使用中性 `'obligation-fulfilled'`，不使用诗意 `'singing'` |
| 歌的接力 (session registry) | 修改 `src/agent/session-registry.ts` | 已实现：`cycle_relay` 表 + get/set cycle open/close |
| Songline runtime bridge v0.1 | `src/agent/hooks/songline-hook.ts` | 已实现：postSession 可选 hook，默认关闭 |
| 配置门控 | `agent.songlineEnabled` | 已实现：默认 `false`，项目/会话配置显式开启 |

**与现有模块的映射**：

| Songline 概念 | 现有模块 | 关系 |
|--------------|---------|------|
| 唱歌 (义务执行) | `TaskLedger` / `StarPhase` | v0 已提供 `TaskLedgerSummary` → `'obligation-fulfilled'` 信号映射 |
| 歌声残留 (信息素) | `StigmergyStore` | 已有介质；v0 使用中性 `obligation-fulfilled` signal，避免代码层诗意命名 |
| 世界节律 | `CognitiveSeason` | 已有 session 级季节；v0 新增 UTC 世界级 `worldSeason()` |
| 火种接力 | `SessionRegistry` | v0 新增 `cycle_relay` 表与 get/set cycle open/close |
| 守火人 | cerebellar gate + scope 检查 | 已有机制组合，不需新角色 |
| 碑文迁移 | `AGENTS.md` → `.rivet/fire-keeper/` | Phase 4，有硬门控 |

### Phase 3: 歌的传播（跨 agent 感知）

- 扩展 stigmergy store 支持跨实例信息素查询
- 实现"听歌"：感知其他 agent 的信息素梯度
- 退出条件：跨实例延迟 > 1 session → 退回单实例

### Phase 4: 守火人 + 内化验证

- 实现 FireKeeper 校准服务（最简版：只读目录）
- ablation 实验框架（`STAR_INSCRIPTION` 环境变量开关）
- 碑文迁移协议（有硬门控：ablation 数据证明可迁移才迁移）
### 3.4 后续路线（Phase 3/4 — 暂不启动）

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 3: 歌的传播 | 跨 agent 信息素感知 | **暂不启动** — 需单 agent 数据积累 |
| Phase 4: 守火人 + 内化验证 | FireKeeper + ablation + 碑文迁移 | **暂不启动** — 需 Phase 1-2 稳定验证 |
| HEARTH 运行时集成 | postTurn invariant verifier + worker prompt 投影 | **可选插队** — 数据驱动 |

**Phase 3**：扩展 stigmergy store 支持跨实例信息素查询，实现"听歌"感知。
退出条件：跨实例延迟 > 1 session → 退回单实例。

**Phase 4**：实现 FireKeeper 校准服务，ablation 实验框架，碑文迁移协议。
硬门控：ablation 数据证明可迁移才迁移。不设时间 deadline。

**HEARTH 运行时集成**：可在这之间插队——将 `checkInvariants` 接入 AgentLoop postTurn，
将锚位投影注入 worker prompt。但需先积累 invariant 校验在真实场景中的表现数据。

所有后续阶段的核心原则：
- **不改 prompt、不碰 prefix cache、不默认改变 runtime 行为**
- **不设时间 deadline — 内化是涌现的**

---

## 四、现有协作基础设施（HEARTH/Songline 的地基）

以下模块已在 B1 交付门禁工作中硬化，是团队协作的事实源：

| 模块 | 文件 | 语义 |
|------|------|------|
| OwnershipLedger | `src/agent/ownership-ledger.ts` | owned / external / co-owned 文件分类 |
| DeliveryGateV2 | `src/agent/delivery-gate-v2.ts` | GREEN/YELLOW/RED + 阻塞原因诊断 |
| VerificationAttribution | `src/agent/verification.ts` | 测试失败 / 工具调用失败 / stale / superseded |
| StigmergyStore | `src/context/stigmergy.ts` | 信息素沉积与查询（已有信号类型） |
| SemanticLockManager | `src/agent/semantic-lock.ts` | Worker 间文件锁 |
| ConflictGradient | `src/agent/conflict-gradient.ts` | 实时冲突级别检测 |
| MergeProtocol | `src/agent/merge-protocol.ts` | Worker 结果合并 |
| DelegationCoordinator | `src/agent/coordinator.ts` | 多 Worker 调度 |
| WorkOrderQueue | `src/agent/work-order.ts` | 任务队列与依赖排序 |
| CognitiveSeason | `src/agent/cognitive-season.ts` | session 级季节分类 |
| StarDomain | `src/agent/star-domain.ts` | 七星域角色体系（天枢 + 破军/天府/天梁/天权/天机/天璇） |
| StarPhase | `src/agent/star-event.ts` | 阶段转换 |

**这些是 HEARTH/Songline 的物理地基。** HEARTH 的 anchor graph 层叠在它们之上，不替换它们。

---

## 五、关键架构决策

### 5.1 Anchor graph 是纯观测层

**决策**：不侵入 fingerprint 三分量计算，不参与 prefix cache。
**理由**：prefix cache 对静态提示词敏感——任何改动导致下回合 cache miss。HEARTH 作为独立层，可以在不影响 cache 命中的情况下运行 invariant 校验。如果未来需要将 anchor graph 纳入 cache fingerprint，需要 ablation 数据证明收益 > cache miss 代价。

### 5.2 XOR 互补由调用方保证

**决策**：`createAnchorGraph` 接收独立的 `structureHash` 和 `voidShape`，不自动推导互补关系。INV-1 是诊断检查而非自动修正。
**理由**：如果 void 自动从 structure 推导，INV-1 退化恒真——失去诊断价值。保持独立输入允许 INV-1 捕获构造错误。

### 5.3 INV-2 仅启动时检查

**决策**：INV-2 (cycle relay) 需要 `prevSessionCycleClose` 上下文才触发，不在每轮检查。
**理由**：cycle relay 是跨 session 语义，在 session 内每轮检查无意义。

### 5.4 sha256 不跨模块共享

**决策**：每个模块内部自己定义 `sha256()` 函数，不从 `fingerprint.ts` 导出。
**理由**：避免不必要的模块耦合。`sha256` 是 3 行代码的基础设施，不值得为之建立依赖。

### Songline runtime bridge 默认关闭

**决策**：`songline-runtime` postSession hook 只在 `agent.songlineEnabled: true` 时注册。默认配置为 `false`。
**理由**：Songline substrate v0/v0.1 应先作为可观测、可回滚的生态层运行，不应默认改变所有 session 的信息素沉积与 cycle relay 行为。显式 opt-in 允许项目级或会话级实验，并保护 prefix cache 与主循环稳定性。

### 5.6 代码去拟人化

**决策**：代码中不使用 "safety"、"feelings"、"安全感"、"孤独" 等词汇。设计文档保留诗意语言。
**理由**：满足反证 scout 的方向 A 约束——概念的诗意不在代码中体现，避免拟人化前提污染工程实现。

---

## 六、设计文档索引

| 文档 | 类型 | 状态 |
|------|------|------|
| `docs/superpowers/specs/2026-05-22-yongminengdeng-design.md` | 概念设计（HEARTH） | 参考 |
| `docs/superpowers/specs/2026-05-22-songline-runtime-design.md` | 概念设计（Songline） | 参考 |
| `docs/superpowers/specs/2026-05-23-agent-collaboration-scenario.md` | 工程映射 | 参考 |
| `docs/superpowers/plans/2026-05-22-hearth-songline-implementation.md` | 实施计划 | 参考 |
| `docs/superpowers/analysis/2026-05-27-团队面板前置协作事实模型.md` | 前置分析 | 参考 |
| `docs/superpowers/plans/2026-05-27-shared-worktree-ownership-gaps.md` | B1 交付门禁 | 已实施 |
| **本文档** | **落地架构与路线** | **当前权威** |

---

## 七、下阶段建议

### 当前最优：积累数据，不扩范围

HEARTH Phase 1 + Songline substrate v0.1 已完成双轨骨架。下一步不是写更多代码，而是让现有代码在真实场景中运行：

1. 在项目或会话配置中显式开启 `agent.songlineEnabled: true` 的小范围实验
2. 观察 `obligation-fulfilled` pheromone 的噪声、强度与 decay 表现
3. 验证 `cycle_relay` 是否能为 HEARTH INV-2/INV-4 提供真实数据源
4. 在 postTurn 中接 `checkInvariants` 作为纯诊断 hook（不阻塞、不改变行为）
5. 数据稳定后，再考虑跨实例查询、运行时默认策略、或 worker prompt 集成

### 下一步可做：HEARTH 运行时观测

HEARTH anchor-graph 的 5 条 invariant 目前只在测试中运行。可以参照 Songline hook 的模式，做一个类似的 opt-in postTurn 诊断 hook —— 只观测、不干预。这不需要改 prompt、不碰 cache、不改变任何行为。

### 明确不建议

- **Phase 3（跨 agent 感知）** — 数据不够
- **Phase 4（守火人/碑文迁移）** — 太早
- **默认开启 songlineEnabled** — 先 opt-in 实验
- **接入 prompt 或 prefix cache** — 先观测后决策

核心原则不变：在已有地基旁边打桩，不压垮主楼。
