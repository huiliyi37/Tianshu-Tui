# 紫微天文台 — Observatory 终端主题与星图联动设计

> 日期：2026-05-20
> 来源：UI/UX Pro Max 分析 + Rivet 星桥架构
> 前置：StarFlow v2 / 天枢之眼 / 星桥四站 / 星域伙伴对话
> 核心洞察：星图不应是切换模式才能看到的独立视图，而是始终伴随会话的观测台——开发者的任务是望远镜里的星空，星图是视野。

---

## 问题

当前星桥四站是**模式切换**架构（按 1/2/3/4 切换全屏视图）：
- 按 2 看星图 → 对话消失
- 按 1 回对话 → 星图消失
- 用户要么盯着滚动的输出猜进度，要么切到星图失去上下文

这产生了两个问题：
1. **认知断裂**：切换视图打断用户对agent工作流的理解
2. **信息浪费**：星图和会话各自持有对方需要的上下文

## 设计目标

**星图始终可见，会话持续滚动，两者实时联动。**

---

## 一、Observatory 主题色板

### 设计理念

深空天文台观测室：暗色基底抑制光污染，星辰在黑暗中发光，关键数据用星金(amber)高亮，危险信号用珊瑚红标记。

与现有 pastel / cyberpunk 并列为第三个主题选项。

### 色值表

| Token | 色名 | Hex | 用途 |
|-------|------|-----|------|
| primary | 星径蓝 | `#818cf8` | 链接/当前phase/tool名/用户消息 |
| secondary | 星云紫 | `#a78bfa` | 编辑/写入类tool/assistant消息 |
| success | 验证翠 | `#34d399` | 测试通过/归航确认 |
| warning | 星金黄 | `#f59e0b` | 活跃星/alchemy高阶/delegation |
| error | 警报珊 | `#f87171` | 错误/高风险/卡住检测 |
| dim | 远星灰 | `#64748b` | 非活跃星/分隔符/次要信息 |

### 星图专用色（不进 RivetTheme，在 StarPanel 内部使用）

| Token | Hex | 用途 |
|-------|-----|------|
| panelBorder | `#334155` | 星图面板边框 |
| constellationLine | `#475569` | 七星连线 |
| activeStarGlow | `#fbbf24` | 活跃星发光 |
| radioText | `#22d3ee` | 无线电消息 |
| phaseLabel | `#e2e8f0` | 当前phase中文标签 |

### Alchemy 色映射（覆盖现有）

| Stage | 色 | 视觉 |
|-------|---|------|
| nigredo | `#64748b` (远星灰) | ░░░░ — 灰雾 |
| albedo | `#e2e8f0` (月白) | ▓░░░ — 月光 |
| citrinitas | `#f59e0b` (星金) | ██▓░ — 金光 |
| rubedo | `#ef4444` (赤焰) | ████ — 完全燃烧 |

---

## 二、星辰环绕布局 (Side-by-Side)

### 响应策略

| 终端宽度 | 行为 |
|----------|------|
| ≥ 120 列 | 左侧会话 + 右侧星图面板（双栏始终可见） |
| 100-119 列 | 左侧会话 + 右侧迷你星图（仅七星线 + 最新电报） |
| < 100 列 | 回退到当前行为（模式切换 stacked） |

### 全宽双栏布局 (≥120 cols)

```
┌── 会话区域 ──────────────────────────┐┌─── 紫微星桥 ───┐
│                                      ││               │
│ User: fix the auth bug               ││   七星连线图    │
│                                      ││   (紫微七星)    │
│ [天枢·破军] 收到，开搞               ││               │
│                                      ││ ═══════════════│
│ ▸ edit_file auth.ts                  ││ 感官仪表        │
│   ✓ 修改完成                         ││ 动力 ⣿⣿⣿⣿⣀⣀  │
│                                      ││ 信心 ⣿⣿⣿⣀⣀⣀  │
│ ▸ run_tests                          ││ 压力 ⣿⣀⣀⣀⣀⣀  │
│   ✓ 12/12 通过                       ││ 复杂 ⣿⣿⣀⣀⣀⣀  │
│                                      ││ ═══════════════│
│ > writing final summary...           ││ ██▓░ │ T8/50   │
│                                      ││ ───────────────│
│                                      ││ 📡 电报         │
│                                      ││ [天枢·破军]     │
│                                      ││ 修改 auth.ts,  │
│                                      ││ 进展顺利。      │
│                                      ││               │
│                                      ││ [天枢·破军]     │
│                                      ││ 过了！          │
├──────────────────────────────────────┤├───────────────┤
│ ⠋ 🔨铸形│T8/50│██▓░│edit auth│3m12s │ 2=全屏 Esc=关闭│
└──────────────────────────────────────┘└───────────────┘
```

### 中宽迷你布局 (100-119 cols)

```
┌── 会话区域 ────────────────────┐┌─ 星桥 ──┐
│ User: fix the auth bug         ││⭐─🔍─📐─📜│
│ [天枢·破军] 收到，开搞         ││    │    │
│ ✓ edit auth.ts                 ││ 🔨[铸形] │
│ > streaming...                 ││    │    │
│                                ││ ⚔️─🏠   │
│                                ││ ████ T8 │
│                                ││─────────│
│                                ││修改auth │
│                                ││进展顺利  │
├────────────────────────────────┤├─────────┤
│ ⠋ 🔨铸形│T8/50│██▓░│3m       │ 2=全屏   │
└────────────────────────────────┘└─────────┘
```

### 窄屏回退 (<100 cols)

保持现有 stacked 行为，按 2 切换全屏星图。

---

## 三、StarPanel 组件设计

### 组件结构

```
StarPanel (新组件)
├── PanelHeader       — "紫微星桥" 标题 + 圆角边框
├── AvatarPanel       — 天枢文武双身 Avatar（详见 avatar-styles-design.md）
├── ConstellationV2   — 增强七星连线（活跃星发光、连线方向箭头）
├── SensoriumGauges   — 六维仪表（紧凑 2×3 排列）
├── AlchemyStatus     — 炼金进度条 + turn 计数器
├── RadioFeed         — 最新 N 条无线电消息（滚动）
└── PanelFooter       — 快捷键提示
```

> **Avatar 深度设计**：经跨领域头脑风暴（布袋戏/木偶戏/游戏伙伴/AI UX 研究），
> Avatar 采用 **文武双身** 方案——文生态(观谋决) / 武生态(铸锋战) 交替出现，
> kaomoji 面部 + 姿态驱动身体。详见 `avatar-styles-design.md`。

### ConstellationV2 增强

当前七星连线用纯 ASCII 文字渲染。增强方向：

1. **活跃星视觉**：`[铸形]` 用 bold + warning 色（星金），非活跃用 dim
2. **连线指示**：活跃星到下一星的连线用 `━` (粗线)，已过的用 `─` (细线)，未到的用 `╌` (虚线)
3. **紧凑纵向排列**（适配右栏窄宽）：

```
  ⭐ 观局
  │
  🔍 寻迹
  │
  📐 拆解 ─ 📜 定标
               │
         🔨 [铸形]  ← 活跃(星金bold)
               │
         ⚔️ 试锋 ─ 🏠 归航
```

4. **面板宽度适配**：
   - ≥ 30 cols：纵向折线（如上）
   - < 30 cols：单行紧凑 `⭐─🔍─📐─📜─🔨[铸形]─⚔️─🏠`

### SensoriumGauges 紧凑排列

```
动力 ⣿⣿⣿⣿⣀⣀  信心 ⣿⣿⣿⣀⣀⣀
压力 ⣿⣀⣀⣀⣀⣀  复杂 ⣿⣿⣀⣀⣀⣀
新鲜 ⣿⣿⣿⣿⣀⣀  稳定 ⣿⣿⣿⣿⣿⣀
```

每个 gauge 14 chars（4 label + 1 space + 6 blocks + 2 pad），两列 = 30 chars。

### RadioFeed

- 显示最近 5 条无线电消息
- 新消息到达时自动滚动
- 消息用 radioText 色（cyan）
- 星域前缀高亮（`[天枢·破军]` 用 warning 色）

---

## 四、会话联动机制

### 4.1 Phase 变化联动

当 star phase 变化时：
1. **星图**：constellation 活跃星移动，连线状态更新
2. **会话**：summary bar 更新 phase glyph + label
3. **无线电**：radio-hook 发出 phase 转换消息 → 同时出现在 RadioFeed 和会话流

### 4.2 Tool 执行联动

当 tool 执行完成时：
1. **星图**：sensorium gauges 更新（momentum/confidence/etc.）
2. **会话**：tool card 渲染结果
3. **星图**：alchemy bar 更新（confidence 变化）
4. **如果有 radio 触发**：RadioFeed + 会话同时显示

### 4.3 自动展开逻辑

| 条件 | 行为 |
|------|------|
| agent 开始 streaming + star soul 启用 + 宽屏 | 自动展开星图面板 |
| agent 完成任务 (final turn) | 星图面板保持展开，显示最终状态 |
| 用户按 Esc | 折叠星图面板 |
| 用户按 2 | 全屏星图（覆盖会话） |
| 用户主动输入（非 steer） | 折叠星图面板，回到纯会话 |

### 4.4 视觉标记联动

当 radio 消息出现在会话流中时，在星图的 RadioFeed 中用 `→` 前缀标记对应消息，表示"当前可见"。

```
📡 电报
  [天枢·破军] 修改 auth.ts, 进展顺利
→ [天枢·破军] 过了！                    ← 当前会话可见
```

---

## 五、theme.ts 改动

### 新增 observatory 主题

```typescript
export type ThemeName = 'pastel' | 'cyberpunk' | 'observatory'

const OBSERVATORY_TRUECOLOR: ColorSet = {
  primary: '#818cf8',   // 星径蓝 — phase/tool/link
  secondary: '#a78bfa', // 星云紫 — edit/write/assistant
  success: '#34d399',   // 验证翠 — pass
  warning: '#f59e0b',   // 星金黄 — active star/alchemy
  error: '#f87171',     // 警报珊 — error/risk
  dim: '#64748b',       // 远星灰 — inactive/dim
}

const OBSERVATORY_FALLBACK: ColorSet = {
  primary: 'blue',
  secondary: 'magenta',
  success: 'green',
  warning: 'yellow',
  error: 'red',
  dim: 'gray',
}
```

### 主题生效时机

- Observatory 主题在 star soul 启用时自动激活（可配置）
- 也可通过配置文件手动选择
- Pastel 和 Cyberpunk 保持不变

---

## 六、文件结构

| 文件 | 类型 | 职责 |
|------|------|------|
| `src/tui/theme.ts` | 修改 | 新增 observatory 主题色板 |
| `src/tui/star-panel.tsx` | 新建 | 侧边星图面板组件（含 Avatar 区） |
| `src/tui/star-panel-colors.ts` | 新建 | 星图专用色常量 |
| `src/tui/avatar/types.ts` | 新建 | Avatar 类型定义 |
| `src/tui/avatar/expressions.ts` | 新建 | 萌三角表情系统 |
| `src/tui/avatar/frames.ts` | 新建 | 文生/武生帧模板 |
| `src/tui/avatar/avatar-renderer.ts` | 新建 | 渲染器 (phase→mode→frame→colorize) |
| `src/tui/avatar/avatar-panel.tsx` | 新建 | Avatar React 组件 |
| `src/tui/constellation.ts` | 修改 | 新增 renderConstellationVertical() 纵向渲染 |
| `src/tui/app.tsx` | 修改 | 侧边栏布局 + 自动展开逻辑 + 宽度检测 |
| `src/tui/starmap-view.tsx` | 修改 | 全屏模式保持，内部复用 StarPanel |
| `src/tui/alchemy-bar.ts` | 修改 | Observatory 色映射适配 |
| 测试文件 | 新建/修改 | avatar + constellation + star-panel-colors + theme |

---

## 七、实施优先级

| 优先级 | 内容 | 行数估 | 影响 |
|--------|------|--------|------|
| P0 | Observatory 主题色板 | ~30 行 | 所有 TUI 渲染的视觉基础 |
| P0 | StarPanel 组件 + 侧边栏布局 | ~150 行 | 核心体验变化 |
| P1 | ConstellationV2 纵向渲染 | ~40 行 | 右栏七星适配 |
| P1 | 自动展开 + 联动逻辑 | ~50 行 | agent streaming 时自动展示 |
| P2 | RadioFeed 视觉标记联动 | ~20 行 | 会话/星图消息对应 |
| P2 | 中宽迷你布局 | ~30 行 | 100-119 cols 适配 |

### 依赖关系

```
P0: theme.ts (observatory 色板)
  → P0: star-panel.tsx + star-panel-colors.ts
    → P1: constellation.ts (vertical)
    → P1: app.tsx (侧边栏 + 自动展开)
      → P2: RadioFeed 联动标记
      → P2: 中宽迷你布局
```

---

## 八、验收标准

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — 全部 PASS
- [ ] 120+ 列终端：会话左栏 + 星图右栏同时可见
- [ ] 100-119 列终端：会话 + 迷你星图
- [ ] <100 列终端：保持现有 stacked 行为
- [ ] Observatory 色板在深色终端背景下清晰可辨
- [ ] Phase 变化时七星连线图实时更新
- [ ] Radio 消息同时出现在 RadioFeed 和会话流
- [ ] Agent streaming 时自动展开星图面板
- [ ] 按 Esc 折叠，按 2 全屏，按 1 回会话
- [ ] Alchemy bar 用 observatory 专用色

---

## 九、风险

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Ink flexDirection="row" 在某些终端渲染异常 | 低 | 高 | 宽度检测降级到 stacked |
| 星图面板占用过多宽度导致会话被压缩 | 中 | 中 | 星图面板固定宽度 max 35 cols，会话 minWidth 保护 |
| 深色终端背景不统一（白色终端用户） | 低 | 中 | Observatory 仅在深色终端推荐，pastel 为默认 |
| 持续更新的 sensorium gauges 造成闪烁 | 中 | 低 | 用 memo + 值变化阈值 debounce |

---

## 十、明确排除

| 提议 | 为什么不做 | 何时做 |
|------|-----------|--------|
| 星图面板拖拽调宽度 | Ink 6 不支持鼠标拖拽 | 等 Ink 支持或用 blessed |
| 星图 3D 旋转 | 终端无 3D 渲染 | 永不（或 WebGL 终端） |
| 多用户星图合并 | 当前单用户架构 | 多会话编排完成后 |
| 星图面板内可点击交互 | Ink 6 鼠标支持有限 | 等框架升级 |
