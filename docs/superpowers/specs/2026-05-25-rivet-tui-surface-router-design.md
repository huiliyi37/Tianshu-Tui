# Rivet TUI 整体重构方向 — 深度头脑风暴结果

> 2026-05-25 / 6 scout 并行调研 + 三轮变异-选择-适应

## 背景

### 用户需求
对 Rivet（Ink 6 + TypeScript 的 terminal coding agent）的 UI 布局和体验给出优化设计。用户在澄清问题中明确选择「整体重构方向」（非局部修补）。

### 项目上下文
- **当前分支**：`feat/tianshu-sycophancy-trap-2.5`
- **TUI 规模**：app.tsx 1241 行；`src/tui/` 下约 50 个 .tsx/.ts 文件
- **运行时硬约束**：DeepSeek 1M context prefix cache 是核心优化（系统 prompt 与早期消息必须稳定）
- **架构特异性**：6 个 star domain worker（破军/天府/天梁/天权/天机/天璇）+ 8 阶段星程，是运行时核心而非 UI 装饰

### 调研发现摘要（6 scout）

| Scout | 关键发现 |
|-------|---------|
| 内部历史 | app.tsx 166 次修改；5/16 一天产出 4 份独立 TUI 设计文档；TUI 2.1→2.4 在 4 天内迭代；从未做整体减法 |
| 内部表面 | 6 个死表面（StarPanel/StarStatus/MissionStrip/ApprovalRiskCard/Pager/OnboardingPanel）零外部 import；无统一导航总线（数字键 + slash 命令两套割裂状态机）；数字键 4 已穿帮；elapsed×3、turn×2、phase 语义重叠 |
| 外部竞品 | Claude Code/Aider/Crush/Goose 全部单列 chat；OpenCode 是唯一带 sidebar；行业根本分裂是 chat-centric vs protocol-centric |
| 外部 TUI 范式 | 6 条原则（可见即可达 / 视觉边界焦点 / viewport 裁剪 / 模态正交 / 时间用图 / 操作可逆）；coding agent 普遍缺失 viewport 裁剪、可见即可达、色阶编码风险、独立命令日志区 |
| 反向域（高压系统） | dark cockpit philosophy（正常状态全暗，异常自点亮）；用户偏好 ≠ 系统最优；物理空间约束是功能 |
| 反证 scout | 事实：多 agent 升级必须有出口、星位是运行时架构；假设可破：行业共识=最优、死表面=冗余、键位空间不足 |

### 假设合成与反证修正

> **原假设**：激进减法到单列 chat + 统一可见即可达导航总线 + dark cockpit 静默
>
> **反证修正后**：激进减法到单列 chat + **一个最低 glance 出口**（不是零 starmap）+ **统一现有三套导航为一套**（不是新增）

## 三轮思考过程

### 第一轮：变异

生态位测绘：terminal coding agent / 多 worker 并行 / Ink 6 / 6 星域 / DeepSeek 1M。

四个方案（每个占据不同生态位）：

| 方案 | 一句话核心选择 |
|------|---------------|
| V1（主流） | chat + 右抽屉 — 克隆 OpenCode 哲学 |
| V2（邻近） | chat + Ctrl+K palette 统一所有导航 — Helix space-mode |
| V3（空位） | GlanceBar(顶 1 行 dark cockpit) + chat + 弹层深度面板 — Rivet 独占 |
| V4（突变） | 取消主表面，buffer 平权切换 — weechat 反共识 |

适应度函数：
- **硬约束**：(1) worker 升级/失败必须有非零可见出口；(2) 不破坏 prefix cache；(3) 1-2 周可完成；(4) 不删 star-domain.ts 等运行时核心
- **加分**：单一信源 / 可见即可达 / 色阶代替文字 / viewport 裁剪 / 保留星位身份
- **减分**：新增键位 / 新增渲染节点 / 新增依赖 / 破坏 prefix cache / 完全脱离行业共识

### 第二轮：选择

- **V2 灭绝**：因果链断裂（默认看不到 worker），违反"多 agent 必须可见"事实约束
- **V4 灭绝**：目标偏移（超出"布局体验优化"边界）+ 落地性失败（高概念，第一步无法定义）+ prefix cache 风险 + 3 人团队消化容量不足
- **V1 存活但弱**：Bloomberg 教训陷阱（删除独有差异化的代价过大）
- **V3 存活且最强**：唯一同时满足 4 项硬约束 + 5 项加分维度 + 占据空生态位

discarded_trait 回收：V2 的 palette 哲学（→ V3 的 Ctrl+K 统一深度入口）；V4 的 viewport 独立性（→ V3 的弹层面板独立滚动状态）。

新发现：
1. 三套割裂状态机的根本病因是**强行让两类性质不同的导航共享同一个键位空间**（被动 glance vs 主动深度访问）
2. 死表面分三类：融入 GlanceBar / palette 内激活 / 直接删除
3. app.tsx 1241 行的根本病因是**无 SurfaceRouter 模块**

### 第三轮：适应

#### SurfaceRouter 详细设计 ★（核心交付物）

**三层栈模型**（参考 lazygit ContextMgr）：

```
┌────────────────────────────────────────────┐
│  GlanceBar  (永远 1 行, 不参与路由)          │
├────────────────────────────────────────────┤
│  POPUP layer  (palette / approval / intent) │
├────────────────────────────────────────────┤
│  OVERLAY layer  (cockpit / starmap / ...)   │
├────────────────────────────────────────────┤
│  BASE layer  (chat 永远存在)                 │
├────────────────────────────────────────────┤
│  Input + AgentStatus  (永远 1-2 行, 不参与)  │
└────────────────────────────────────────────┘
```

**三层契约**：
- BASE：永远只有一个（chat），不可 pop，不可 replace
- OVERLAY：同时只有一个（互斥）；进入退出走历史栈
- POPUP：可叠加，按推入顺序最上者获焦；Esc 弹最上一个

**核心 API**（`src/tui/surface/types.ts`）：

```ts
export type SurfaceLayer = 'base' | 'overlay' | 'popup'

export interface GlancePulse {
  readonly domain?: StarDomainId
  readonly level: 'quiet' | 'active' | 'alert'
  readonly hint?: string
}

export interface SurfaceDefinition {
  readonly id: string
  readonly layer: SurfaceLayer
  readonly exclusiveWith?: readonly string[]
  readonly discoverable: boolean
  readonly paletteEntry?: { label: string; hint?: string; hotkey?: string }
  readonly render: (ctx: SurfaceRenderContext) => ReactNode
  readonly glance?: (state: SurfaceGlanceContext) => GlancePulse | null
  readonly onEnter?: () => void
  readonly onExit?: () => void
}

export interface SurfaceRouterApi {
  register(def: SurfaceDefinition): Unregister
  push(id: string): void
  pop(): void
  replace(id: string, layer: SurfaceLayer): void
  closeLayer(layer: SurfaceLayer): void
  activeOf(layer: SurfaceLayer): string | null
  isVisible(id: string): boolean
  glanceSnapshot(): readonly GlancePulse[]
  subscribe(cb: (event: SurfaceEvent) => void): Unsubscribe
}
```

**文件结构**：

```
src/tui/surface/
├── types.ts            # ~80 行
├── router.ts           # ~200 行, 纯状态机, 不依赖 React
├── registry.tsx        # registerSurfaces()
├── glance-bus.ts       # 订阅 RuntimeHookPipeline, 维护 glance 数据
├── use-surface.ts      # React hook 包装订阅
├── __tests__/
│   ├── router.test.ts
│   ├── exclusivity.test.ts
│   ├── glance-snapshot.test.ts
│   ├── history-stack.test.ts
│   └── prefix-cache-isolation.test.ts  # 强制隔离门
└── README.md
```

**用户操作模型**：

| 用户动作 | Router 行为 | 视觉结果 |
|---------|-------------|---------|
| 启动 | `register('chat'→base)` | chat 主区 + GlanceBar |
| `Ctrl+K` | `push('palette'→popup)` | palette 浮于最上 |
| palette 内按 `c` | `pop(palette)` → `push('cockpit'→overlay)` | cockpit 覆盖 chat |
| 按 `Esc` | `pop()` | 回退一层 |
| worker 失败 | router 不动，glanceBus 推 alert | GlanceBar 色阶点亮，不抢焦点 |
| `2`/`3` | **不再绑定** | 输入框消费 |

**与 prefix cache 的隔离契约**（硬要求）：
- 不读写 `src/prompt/**`
- 不读写 `AgentSession.messages`
- 不触发改变 prefix 顺序的 hook
- 仅订阅 `RuntimeHookPipeline.postTool` / `postTurn` 副本数据用于 glance
- 强制门：`prefix-cache-isolation.test.ts` 断言 `messages` 数组身份相等

**Glance Contract**（GlanceBar 数据来源）：
- 三档色阶（dark cockpit）：`quiet`（几乎不可见）/ `active`（cyan）/ `alert`（red/amber，仅此档展第二行 hint）
- 6 域 pulse 数据源直接复用 `coordinatorState` / `starEvent` / `theta`，零新增运行时

#### 扩展适应清单

| 已有资源 | 新用途 |
|---------|-------|
| `star-event.ts` 的 `mapSensoriumToPhase` | 直接驱动 GlanceBar phase |
| `star-domain.ts` 的 6 域定义 | 直接驱动 GlanceBar 6 域 pulse |
| `command-palette.tsx` | 扩展为统一 surface 入口 |
| `RuntimeHookPipeline.postTool/postTurn` | 注入 GlanceBar 副本数据 |
| `CoordinatorState.shouldEscalate()` | 直接驱动 alert |
| `theme.ts` | 扩三档色阶 token |
| 现有 `cockpit/` 7 子面板 | 不动，只改入口 |

#### 死表面三类处理

- **融入 GlanceBar**：StarPanel（6 域可视化压到 1 行 6 色块）
- **palette 内激活**：MissionStrip（必要时通过 palette 进入）
- **直接删除**：constellation 半死代码（无设计意图文档支持）

## 最终方案

**单列 chat（BASE）+ 顶 1 行 GlanceBar（dark cockpit）+ Ctrl+K palette（深度面板发现入口）+ cockpit/starmap/chronicle（overlay 弹层）+ SurfaceRouter（统一治理）**

### 实施路径（12 工作日）

#### Phase 1（Day 1-5）：SurfaceRouter 骨架，UI 视觉保持现状
- 建 `src/tui/surface/` 模块
- chat 注册为 base
- 删 starbridgeMode 数字键 2/3
- cockpit/starmap/chronicle 注册为 overlay
- palette 改造为 surface 发现入口
- **成功标准**：三套现有导航行为可复现 / 单元测试覆盖三层栈语义 / `prefix-cache-isolation.test.ts` 通过 / app.tsx ≤ 900 行
- **退出条件**：5 天内无法承载所有现有表面 → 回退评估

#### Phase 2（Day 6-9）：GlanceBar 引入
- GlanceBar v0（静态布局）
- GlanceBar v1（接 glanceBus，三档色阶）
- 删 StatusBar/SummaryBar/AgentStatus 旧实现
- 删 constellation 半死代码
- **成功标准**：异常事件可视延迟 ≤ 200ms / elapsed/turn/phase 单一来源 / worker 失败时用户无需操作即见 alert
- **退出条件**：色阶可读性不足 → 回退两档

#### Phase 3（Day 10-12）：死表面整理 + 全量回归
- StarPanel 内容融入 GlanceBar
- MissionStrip 入 palette
- 全量回归测试（2340 tests）
- **成功标准**：测试全绿 / app.tsx ≤ 600 行 / 30 分钟自测会话无回归
- **退出条件**：prefix cache 命中率下降 > 5% → 立即回滚 GlanceBar 数据接入

## 风险与应对

| 风险 | 应对 |
|------|------|
| GlanceBar 色阶在不同终端配色下不一致 | Phase 2 退出条件覆盖；必要时回退两档 |
| SurfaceRouter 注册顺序与运行时 hook 顺序耦合 | `router.ts` 加 register-order-independent 测试 |
| 死表面整理误删用户预期保留的元素 | Phase 3 前 git tag 快照；必要时回滚 |
| prefix cache 隔离契约违反 | `prefix-cache-isolation.test.ts` 强制门 |
| 12 天估算保守度不够 | 每个 Phase 设独立退出条件，不强行赶进度 |

## 下一步

**Phase 1 第一个具体动作**：

```bash
# 1. 创建 surface 模块骨架
mkdir -p src/tui/surface/__tests__

# 2. 写 src/tui/surface/types.ts (~80 行) — 上述完整 API 定义

# 3. 写 src/tui/surface/router.ts (~200 行) — 纯状态机, 不依赖 React
#    - 三层栈数据结构: { base: string, overlay: string | null, popupStack: string[] }
#    - register/push/pop/replace 实现 (immutable, 每次返回新状态)
#    - subscribe 用 listener 数组

# 4. 写 src/tui/surface/__tests__/router.test.ts
#    - test('base 不可 pop')
#    - test('overlay 互斥, push 新 overlay 替换旧的')
#    - test('popup 可叠加, pop 弹最上层')
#    - test('register 顺序无关')
```

完成 Phase 1 第一个动作后，写一个最小验证：用 SurfaceRouter 重写 `app.tsx` 中 `starbridgeMode` 与 `cockpitPanel` 的状态管理，行为不变，但状态机迁出。这是 Phase 1 的核心交付物。
