# 天枢文武双身 — Avatar 拟人化设计（深度头脑风暴版）

> 日期：2026-05-20（深度头脑风暴更新）
> 来源：4 scout 跨领域调研 + 三轮演化选择
> 前置：StarFlow v2 七星相位 / 炼金四阶 / 星域三格 / Observatory 主题
> 核心洞察：状态辨识度的关键不在精细度，而在**对比度**。两个风格截然不同的角色（文/武）之间的切换，比一个角色的微表情变化显眼 100 倍。

---

## 跨领域调研发现

### 布袋戏 · 皮影戏 · 木偶戏

| 发现 | 出处 | 对 Avatar 的启示 |
|------|------|-----------------|
| 木偶没有可动面部，身体姿态投射情绪到面孔上 | Blind Summit Theatre | 不需要精细面部。身体对了，用户脑补面孔 |
| 文生/武生双模：文生举止缓慢受控，武生动作快速刚猛 | 布袋戏（素还真/一页书） | **模式切换本身就是最强情绪信号** |
| 关节优先级：头倾斜 > 躯干弧度 > 手臂位置 | 提线木偶 | 3 关节组足够，不需要更多 |
| "死掉的木偶就是静止的木偶" | 木偶操控师共识 | 永不静止——微小呼吸节奏是灵魂底线 |
| 皮影剪影情感映射：负空间(手臂与身体间隙)增强姿势可读性 | 皮影戏 | 姿态 > 细节 |

### 游戏伙伴 · 虚拟宠物 · AI 助手

| 发现 | 出处 | 对 Avatar 的启示 |
|------|------|-----------------|
| Clippy 三级渐进 idle：眨眼 → 环境扫视 → 打盹 | Microsoft Agent | 永不静止，但不打断工作流 |
| 开发者更倾向 AI "表现得像机器" | MIT Bryan Reimer | **不要过度拟人化，用状态指示而非情感表演** |
| 萌三角：眼+嘴构成倒三角，3 个点传达情绪 | Chibi 设计研究 | 最低 3 个字符就能表达面部 |
| 虚拟宠物 4-10 个离散状态，阈值驱动平滑过渡 | Tamagotchi/VPet | Rivet 的 sensorium 已经是这个！ |
| Microsoft Mico (2025)：非写实 blob，可选且可关闭 | Fast Company | 避恐怖谷，**必须 opt-in** |

### 终端渲染技术

| 发现 | 出处 | 对 Avatar 的启示 |
|------|------|-----------------|
| Claude Code buddy：3 帧 + 3 状态 (idle/active/fade) | Claude Code `/buddy` | 极简状态机已经过生产级验证 |
| 半块字符 `▀▄` + ANSI 双色 = 2x 垂直分辨率 | ratatui-image | 升级路径，非必须 |
| Kaomoji 是终端原生语言，零学习成本 | 终端文化 | `(◠‿◠)` 不触发恐怖谷 |

### 反证发现（隐含前提质疑）

| 隐含前提 | 如果不成立… | 分类 | 应对 |
|----------|-----------|------|------|
| 终端能可靠渲染半块字符 | Avatar 变成菱形/空白 | 现状 | 三级降级策略，kaomoji 为底线 |
| 开发者会觉得 mascot 讨喜 | Clippy 综合症，用户想关掉 | 假设 | **默认关闭，opt-in** |
| 16×16 以下像素画可辨识 | 不同状态看起来一样 | 事实 | 用模式切换(文/武)而非微表情 |
| 持续动画增加生动感 | 变成视觉噪音 | 假设 | 微动画极克制，仅星辰闪烁 |
| 视觉拟人化有正向 ROI | MIT 研究：无面部时信任更高 | 假设 | Rivet 上下文不同（用户主动要求），但仍需 opt-in |

---

## 设计方案：天枢文武双身

### 核心概念

不是一个角色有 9 种表情，而是**两个角色交替出现**——来自布袋戏的文生/武生美学。

- **文生态（观·谋·决）**：观局、寻迹、拆解、定标、归航 → 缓慢、儒雅、拱手
- **武生态（铸·锋·战）**：铸形、试锋 → 快速、刚猛、持器

切换本身就是最强的状态信号。用户瞟一眼就知道 agent 从"想"变成了"干"。

### 角色帧表

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│  【文生态 · 观谋决】                                      │
│                                                          │
│  观局         寻迹          定标           归航            │
│                                                          │
│    ·★·          ·★·          ·★·          ·✦★✦·         │
│  (◠‿◠)       (◉_◉)        (◡▽◡)        (◡▿◡)         │
│  /|☆|\       /|☆|↗        /|☆📜         \|☆|/  ✦      │
│   / \         / \           / \          ╱╲╱╲          │
│  思考中…      搜索中…       签约中…        完成!           │
│                                                          │
│  【武生态 · 铸锋战】                                      │
│                                                          │
│  铸形              试锋                                   │
│                                                          │
│    ·✦✦·              ·✦·                                │
│  (●△●)            (◎─◎)                                │
│  /|⚔|\🔨          /|⚔|╱                                │
│   / \ ✦            / \                                  │
│  编码中!           验证中~                                │
│                                                          │
│  【特殊状态】                                             │
│                                                          │
│  卡住           再临            开场          测试失败     │
│                                                          │
│    ·★· ;          ·★·          ·✦★✦·         ·★·！       │
│  (×~×)         (●─●)        (◠▽◠)         (○△○)       │
│  /|☆|\         /|☆|\        /|☆|\✦        /|☆|\        │
│  ?? ??        ←/ \？        / \           /!!  \       │
│  嗯？？        重新审视       天枢，就位      测试挂了…     │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 表情系统

3 字符面部 = 萌三角：`左眼 + 嘴 + 右眼`

| 情绪 | 表情 | 文/武 | 触发 |
|------|------|-------|------|
| 平静 | `◠‿◠` | 文 | 观局/idle |
| 搜索 | `◉_◉` | 文 | 寻迹 |
| 专注 | `●△●` | 武 | 拆解/铸形 |
| 满意 | `◡▽◡` | 文 | 定标 |
| 欣慰 | `◡▿◡` | 文 | 归航 |
| 紧张 | `◎─◎` | 武 | 试锋 |
| 严肃 | `●─●` | — | 再临 |
| 困惑 | `×~×` | — | stuck |
| 惊讶 | `○△○` | — | test_fail |
| 致意 | `◠▽◠` | 文 | session_start |

### 身体语言系统

| 部位 | 文生态 | 武生态 | 变化含义 |
|------|--------|--------|---------|
| 头顶星辰 | `·★·` 缓闪 | `·✦✦·` 快闪 | 文=沉思，武=火热 |
| 胸口徽章 | `☆` | `⚔` | 文=星官，武=战士 |
| 手臂 | 拱手 `/|..|\` | 持器 `/|..|🔨` | 文=礼，武=工具 |
| 脚下 | 站立 `/ \` | 迈步 `/ \ ✦` | 文=静，武=动 |
| 状态文案 | `思考中…` | `编码中!` | 文=省略号，武=感叹号 |

### 文武切换映射

```typescript
type AvatarMode = 'wenxing' | 'wuxing'

function phaseToMode(phase: StarPhase): AvatarMode {
  switch (phase) {
    case 'yuheng-implementing':
    case 'kaiyang-testing':
      return 'wuxing'
    default:
      return 'wenxing'
  }
}
```

### 星域配饰

配饰叠加在基础角色上，不改变文/武模式：

| 域 | 文生徽章 | 武生徽章 | 文案风格 |
|----|---------|---------|---------|
| 破军 | `☆→⚔` | `⚔→⚔⚔` | 直接："开搞!" |
| 天府 | `☆→🛡` | `⚔→🛡⚔` | 谨慎："先评估…" |
| 天梁 | `☆→📏` | `⚔→📏⚔` | 精确："按 spec 来" |
| 无域 | `☆` | `⚔` | 通用 |

### 炼金色调

ANSI 前景色覆盖整个角色：

| Stage | 色 | 星辰 | 整体氛围 |
|-------|---|------|---------|
| nigredo | `#64748b` 远星灰 | `·★·` 黯淡 | 灰雾笼罩 |
| albedo | `#e2e8f0` 月白 | `·★·` 银白 | 月光照耀 |
| citrinitas | `#f59e0b` 星金 | `·✦·` 温暖 | 金光初现 |
| rubedo | `#ef4444` 赤焰 | `·✦✦·` 燃烧 | 全身赤焰 |

### 微动画

**呼吸** (5s 周期)：
```
帧1: ·★·  →  帧2: ·✦·  →  帧3: ·★·     (星辰闪烁)
```

**眨眼** (每 20 tick)：
```
帧1: (◠‿◠) → 帧2: (─‿─) → 帧3: (◠‿◠)  (0.4s)
```

**文→武切换** (瞬时)：
```
帧1: 文生帧 → 帧2: ·  · (空白闪) → 帧3: 武生帧
```

**渐进 idle** (无事件时)：
```
10s → 眨眼加速
30s → 打哈欠 (◠o◠)
60s → 打盹 (─‿─)z
```

### opt-in 设计

- **默认关闭**。首次启动提示："是否在侧边栏显示天枢 Avatar？[y/N]"
- 配置项 `avatar: 'off' | 'minimal' | 'full'`
  - `off`：无 avatar
  - `minimal`：单行 `(◠‿◠) 观局中…`
  - `full`：完整 5 行面板
- 任何时候可通过配置或快捷键切换

---

## 三级渲染降级

| 检测 | 渲染模式 | 字符集 | 效果 |
|------|---------|--------|------|
| truecolor (chalk.level≥3) | 全彩 kaomoji + ANSI 着色 | Unicode 符号 | 最佳 |
| 256色 (chalk.level≥2) | 近似色 kaomoji | Unicode 符号 | 良好 |
| 基础色 (chalk.level<2) | 纯文字状态指示 | 纯 ASCII | 兜底 |

未来升级路径（非本期）：
- 半块字符 `▀▄` 精细版 — 验证终端兼容性后作为 v0.3
- Braille 点阵版 — 高端终端展示用

---

## 技术架构

### 文件结构

```
src/tui/avatar/
├── types.ts              — AvatarFrame, AvatarContext, AvatarMode
├── expressions.ts        — 表情系统 (萌三角 3-char face)
├── frames.ts             — 文生/武生帧模板
├── avatar-renderer.ts    — 核心渲染器 (phase→mode→frame→colorize)
├── avatar-panel.tsx      — React 组件 (侧边栏面板)
└── __tests__/
    ├── expressions.test.ts
    ├── frames.test.ts
    └── avatar-renderer.test.ts
```

### 核心类型

```typescript
export type AvatarMode = 'wenxing' | 'wuxing'

export type AvatarMood =
  | 'calm' | 'searching' | 'focused' | 'satisfied' | 'content'
  | 'tense' | 'serious' | 'confused' | 'surprised' | 'greeting'

export interface AvatarFrame {
  lines: string[]
  width: number
  height: number
}

export interface AvatarContext {
  phase: StarPhase
  alchemy: AlchemyStage
  domain: DomainVoiceId
  mood: AvatarMood
  mode: AvatarMode
  tick: number
  isStuck: boolean
  isTestFailing: boolean
  idleSeconds: number
}
```

### 渲染流水线

```
StarPhase → phaseToMode() → AvatarMode (文/武)
StarPhase → phaseToMood() → AvatarMood (表情)
AvatarMood + tick → getFace() → FaceExpression (3 chars)
AvatarMode + FaceExpression + domain → buildFrame() → string[]
AlchemyStage → colorize(frame) → ANSI colored string[]
```

---

## 与 Observatory 主题的关系

Avatar 系统是 Observatory 主题侧边栏的**视觉核心**：

```
┌── 会话区域 ────────────────┐┌─── 紫微星桥 ───┐
│                            ││               │
│ User: fix auth bug         ││    ·✦✦·       │ ← Avatar
│                            ││  (●△●)       │
│ [天枢·破军] 开搞           ││  /|⚔|\🔨    │
│                            ││   / \ ✦      │
│ ✓ edit auth.ts             ││  编码中!      │
│                            ││               │
│ > streaming...             ││ ⭐─🔍─📐─📜   │ ← 七星
│                            ││       │       │
│                            ││  🔨[铸形]     │
│                            ││       │       │
│                            ││  ⚔️─🏠       │
│                            ││               │
│                            ││ ██▓░ │ T8/50  │ ← 炼金
│                            ││ ─────────────│
│                            ││ 📡 修改auth   │ ← 电报
│                            ││ 进展顺利      │
├────────────────────────────┤├───────────────┤
│ ⠋ 🔨铸形│T8/50│██▓░│3m    │ Esc=折叠      │
└────────────────────────────┘└───────────────┘
```

---

## 灵感碎片池

完整碎片池持久化在：
`.superpowers/brainstorm/2026-05-20-terminal-avatar-anthropomorphism-fragments.json`

包含 20 条跨领域碎片，来源：布袋戏、皮影戏、木偶戏、游戏伙伴、虚拟宠物、AI 助手 UX、终端渲染技术、反证研究。

---

## 迭代路线

| 版本 | 内容 | 行数估 |
|------|------|--------|
| v0.1 | kaomoji 文武双身 + 表情系统 + phaseToMode | ~100 行 |
| v0.2 | 侧边栏面板 + Observatory 主题接入 + opt-in | ~120 行 |
| v0.3 | 微动画(呼吸/眨眼/渐进idle) + 星域配饰 | ~60 行 |
| v0.4 | 半块字符精细版(验证兼容性后) | ~100 行 |

---

## 验收标准

- [ ] 文/武模式切换：从观局进入铸形时角色明显变化
- [ ] 10 种表情通过 kaomoji 可辨识
- [ ] 炼金色调覆盖角色整体颜色
- [ ] 微动画：星辰闪烁 + 眨眼循环
- [ ] 默认关闭，配置 `avatar: 'off' | 'minimal' | 'full'`
- [ ] 三级渲染降级（truecolor → 256色 → 纯 ASCII）
- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — 全部 PASS
