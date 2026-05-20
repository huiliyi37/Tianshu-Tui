# 三国英雄伴侣 — 设计规格文档

> **日期**：2026-05-20
> **状态**：设计预留（工程钩子先行，角色实现待美工）
> **前置**：星君 Avatar 系统 v1（文/武双身 + 印章冠 + 五色星辰）
> **设计哲学**：三国英雄是星君的「人间化身」—— 星辰之力降临人间，以英雄之姿陪伴开发者

---

## 一、设计愿景

### 核心理念

星君是天上的星辰之官，三国英雄是人间的豪杰之士。

当开发者需要**运筹帷幄**时，诸葛亮化身文星君辅佐；
当开发者需要**冲锋陷阵**时，关羽化身武曲君开路。

**三层叙事**：
- **表层**：kaomoji 面部 — 全球通用，零学习成本
- **中层**：印章冠 + 英雄名号 — 东亚文化圈直觉感知
- **深层**：三国典故 + 星辰对应 — 文化爱好者会心一笑

### 英雄与星辰的对应

| 星辰 | 三国英雄 | 理由 | 文/武模式 |
|------|---------|------|----------|
| 天枢（北斗之首） | 刘备 | 仁德之主，七星之首 | 文星（默认） |
| 天璇 | 诸葛亮 | 智慧化身，运筹帷幄 | 文星 |
| 天玑 | 庞统 | 凤雏之智，谋略深远 | 文星 |
| 天权 | 关羽 | 义薄云天，文武双全 | 文星/武曲切换 |
| 玉衡 | 张飞 | 万夫莫敌，冲锋陷阵 | 武曲 |
| 开阳 | 赵云 | 浑身是胆，攻守兼备 | 武曲 |
| 摇光 | 黄忠 | 老当益壮，百发百中 | 武曲 |

---

## 二、工程预留设计

### 2.1 类型扩展

#### HeroId 类型

```typescript
/**
 * 三国英雄 ID
 *
 * 用于标识当前激活的英雄伴侣。
 * null = 使用默认星君（文/武双身模式）
 */
export type HeroId =
  | 'liubei'    // 刘备 — 天枢，仁德之主
  | 'zhuge'     // 诸葛亮 — 天璇，智慧化身
  | 'pangtong'  // 庞统 — 天玑，凤雏之智
  | 'guanyu'    // 关羽 — 天权，义薄云天
  | 'zhangfei'  // 张飞 — 玉衡，万夫莫敌
  | 'zhaoyun'   // 赵云 — 开阳，浑身是胆
  | 'huangzhong' // 黄忠 — 摇光，老当益壮
  | null        // 默认星君模式
```

#### AvatarContext 扩展

```typescript
export interface AvatarContext {
  // ... 现有字段 ...

  /** 当前激活的英雄（null = 默认星君模式） */
  hero: HeroId
}
```

### 2.2 英雄帧模板接口

```typescript
/**
 * 英雄帧模板
 *
 * 每个英雄有独特的视觉元素：
 * - seal: 英雄专属印章冠（如 诸葛亮扇、关羽刀）
 * - gesture: 英雄专属手势（如 羽扇纶巾、横刀立马）
 * - color: 英雄主色调（基于五行属性）
 */
export interface HeroFrameTemplate {
  /** 英雄 ID */
  id: HeroId
  /** 英雄名号（2字） */
  name: string
  /** 英雄专属印章冠 */
  seal: SealCrown
  /** 英雄专属手势 */
  gesture: Record<AvatarMode, string>
  /** 英雄主色调（hex） */
  primaryColor: string
  /** 英雄五行属性 */
  element: 'wood' | 'fire' | 'earth' | 'metal' | 'water'
  /** 英雄台词（用于 greeting） */
  greetingQuote: string
}
```

### 2.3 英雄帧模板表（占位）

```typescript
/**
 * 英雄帧模板注册表
 *
 * 每个英雄的视觉模板。
 * 实际字符画由美工设计后填入。
 */
export const HERO_TEMPLATES: Record<HeroId, HeroFrameTemplate | null> = {
  null: null, // null ID 使用默认星君模板

  liubei: {
    id: 'liubei',
    name: '刘备',
    seal: {
      top: '╭刘╮',
      middle: '备│备',
      bottom: '╰┬╯',
    },
    gesture: {
      wenxing: '拱手', // 仁德之礼
      wuxing: '双剑', // 雌雄双剑
    },
    primaryColor: '#dc2626', // 火德（汉室正统）
    element: 'fire',
    greetingQuote: '备虽不才，愿与君共谋大事',
  },

  zhuge: {
    id: 'zhuge',
    name: '诸葛',
    seal: {
      top: '╭诸╮',
      middle: '葛│葛',
      bottom: '╰┬╯',
    },
    gesture: {
      wenxing: '羽扇', // 羽扇纶巾
      wuxing: '七星', // 七星灯续命
    },
    primaryColor: '#4f46e5', // 木德（东方青龙）
    element: 'wood',
    greetingQuote: '亮虽驽钝，愿效犬马之劳',
  },

  // ... 其他英雄待美工设计后填入 ...

  pangtong: null,  // 待实现
  guanyu: null,    // 待实现
  zhangfei: null,  // 待实现
  zhaoyun: null,   // 待实现
  huangzhong: null, // 待实现
}
```

---

## 三、渲染流水线扩展

### 3.1 帧选择逻辑

```typescript
/**
 * 选择帧模板
 *
 * 优先级：
 * 1. 英雄帧模板（如果 hero !== null 且模板存在）
 * 2. 默认星君帧模板（fallback）
 */
function selectFrameTemplate(
  mode: AvatarMode,
  phase: StarPhase,
  hero: HeroId,
): HeroFrameTemplate | null {
  if (hero === null) return null
  return HERO_TEMPLATES[hero] ?? null
}
```

### 3.2 buildFrame 扩展

```typescript
export function buildFrame(
  mode: AvatarMode,
  face: FaceExpression,
  phase: StarPhase,
  domain: DomainId,
  hero: HeroId = null, // 新增参数，默认为 null（向后兼容）
): AvatarFrame {
  // 1. 尝试获取英雄模板
  const heroTemplate = selectFrameTemplate(mode, phase, hero)

  // 2. 使用英雄模板或默认模板
  const seal = heroTemplate?.seal ?? selectSeal(mode, phase)
  const gesture = heroTemplate?.gesture[mode] ?? GESTURES[mode]
  const status = STATUS_LABELS[phase]

  // ... 其余逻辑不变 ...
}
```

### 3.3 renderAvatar 扩展

```typescript
export function renderAvatar(ctx: AvatarContext): AvatarFrame & {
  phase: StarPhase
  mode: ReturnType<typeof phaseToMode>
  mood: AvatarMood
  hero: HeroId
} {
  // ... 现有逻辑 ...

  // 6. 构建帧（传递 hero）
  const frame = buildFrame(mode, face, ctx.phase, ctx.domain, ctx.hero)

  return {
    ...frame,
    phase: ctx.phase,
    mode,
    mood,
    hero: ctx.hero,
  }
}
```

---

## 四、英雄与星域的映射

### 4.1 DomainId 扩展

```typescript
/**
 * 星域 ID 扩展
 *
 * 保留原有星域，新增英雄专属星域。
 * 用于决定英雄的默认文/武模式倾向。
 */
export type DomainIdExtended =
  | DomainId          // 原有星域：pojun / tianfu / tianliang
  | 'liubei'         // 刘备域：仁德为主，默认文星
  | 'zhuge'          // 诸葛亮域：智慧为主，默认文星
  | 'guanyu'         // 关羽域：义勇双全，文武切换
  | 'zhangfei'       // 张飞域：勇猛为主，默认武曲
  | null
```

### 4.2 英雄默认模式映射

```typescript
/**
 * 英雄默认文/武模式
 *
 * 每个英雄有自己的倾向，但实际模式仍由 StarPhase 决定。
 * 这只是英雄的「性格倾向」，用于 greeting/idle 状态。
 */
export const HERO_DEFAULT_MODE: Record<HeroId, AvatarMode> = {
  null: 'wenxing', // 默认星君
  liubei: 'wenxing',
  zhuge: 'wenxing',
  pangtong: 'wenxing',
  guanyu: 'wenxing', // 关羽文武双全，默认文
  zhangfei: 'wuxing',
  zhaoyun: 'wuxing',
  huangzhong: 'wuxing',
}
```

---

## 五、五色星辰与英雄配色

### 5.1 英雄五行属性

| 英雄 | 五行 | 主色 | 对应 |
|------|------|------|------|
| 刘备 | 火 | `#dc2626` 朱砂 | 汉室正统，火德 |
| 诸葛亮 | 木 | `#4f46e5` 靛蓝 | 东方青龙，智慧 |
| 庞统 | 水 | `#1e1b2e` 玄墨 | 北方玄武，深谋 |
| 关羽 | 土 | `#f59e0b` 星金 | 中央黄龙，义勇 |
| 张飞 | 火 | `#ef4444` 赤焰 | 南方朱雀，勇猛 |
| 赵云 | 金 | `#e2e8f0` 月白 | 西方白虎，忠勇 |
| 黄忠 | 土 | `#f59e0b` 星金 | 中央黄龙，稳健 |

### 5.2 配色优先级

```typescript
/**
 * 获取英雄/星君主色
 *
 * 优先级：
 * 1. 英雄主色（如果激活英雄）
 * 2. 文/武模式主色（默认）
 */
export function getAvatarPrimaryColor(
  mode: AvatarMode,
  hero: HeroId,
): string {
  if (hero !== null) {
    const template = HERO_TEMPLATES[hero]
    if (template) return template.primaryColor
  }
  return MODE_COLORS[mode]
}
```

---

## 六、英雄台词系统

### 6.1 场景台词

```typescript
/**
 * 英雄场景台词
 *
 * 每个英雄在不同场景有独特台词。
 * 用于 RadioFeed 和状态文字。
 */
export interface HeroQuotes {
  /** 开场白 */
  greeting: string
  /** 观局时 */
  observing: string
  /** 行动时 */
  acting: string
  /** 成功时 */
  success: string
  /** 失败时 */
  failure: string
  /** 卡住时 */
  stuck: string
}
```

### 6.2 英雄台词表（占位）

```typescript
export const HERO_QUOTES: Record<HeroId, HeroQuotes | null> = {
  null: null, // 默认星君使用 STATUS_LABELS

  liubei: {
    greeting: '备虽不才，愿与君共谋大事',
    observing: '天下大势，分久必合，合久必分',
    acting: '备当亲率三军，北伐中原',
    success: '此乃天意，非备之功',
    failure: '备之过也，请君责罚',
    stuck: '备心如焚，请君教我',
  },

  zhuge: {
    greeting: '亮虽驽钝，愿效犬马之劳',
    observing: '运筹帷幄之中，决胜千里之外',
    acting: '亮夜观天象，此计可成',
    success: '此乃丞相之功，亮不敢居',
    failure: '亮之过也，请丞相责罚',
    stuck: '亮愚钝，请君明示',
  },

  // ... 其他英雄待实现 ...
}
```

---

## 七、工程实施路径

### Phase 1: 预留钩子（当前任务）

- [ ] 在 `types.ts` 添加 `HeroId` 类型（注释掉，不实际使用）
- [ ] 在 `AvatarContext` 添加 `hero` 字段（可选，默认 null）
- [ ] 在 `frames.ts` 添加 `HERO_TEMPLATES` 占位表
- [ ] 在 `avatar-renderer.ts` 的 `renderAvatar` 添加 `hero` 参数透传

### Phase 2: 美工设计完成后

- [ ] 填充 `HERO_TEMPLATES` 的实际印章冠/手势/配色
- [ ] 实现 `HERO_QUOTES` 台词系统
- [ ] 添加英雄选择 UI（`/hero <name>` 命令）
- [ ] 添加英雄切换动画

### Phase 3: 深度集成

- [ ] 英雄与 StarDomain 联动（破军 → 张飞，天府 → 诸葛亮）
- [ ] 英雄专属任务提示（基于角色性格）
- [ ] 英雄成长系统（基于任务完成度）

---

## 八、验收标准

### 当前阶段（预留钩子）

- [ ] `npm run typecheck` — 0 errors
- [ ] `npm test` — 全部 PASS
- [ ] 现有星君系统功能不受影响（向后兼容）
- [ ] `HeroId` 类型定义完整但不实际使用
- [ ] `AvatarContext.hero` 字段可选，默认 null
- [ ] `buildFrame` 和 `renderAvatar` 支持 `hero` 参数透传

### 未来阶段（美工完成后）

- [ ] 至少 3 个英雄有完整帧模板
- [ ] 英雄切换无视觉跳变（平滑过渡）
- [ ] 英雄台词在 RadioFeed 正确显示
- [ ] 英雄配色与五色星辰系统一致

---

## 九、风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| 美工设计延迟 | 中 | 低 | 预留钩子已完成，可独立迭代 |
| 英雄帧模板与现有系统不兼容 | 低 | 高 | 接口设计保持向后兼容 |
| 英雄台词文化敏感性 | 中 | 中 | 台词表由文化顾问审核 |
| 性能影响（多英雄渲染） | 低 | 低 | 纯函数设计，缓存友好 |

---

## 十、设计金句

> 「星君是天上的星辰之官，三国英雄是人间的豪杰之士。」
> —— 三层叙事：表层 kaomoji，中层印章，深层星辰英雄

> 「诸葛亮化身文星君辅佐，关羽化身武曲君开路。」
> —— 文/武模式与三国英雄的完美映射

> 「工程钩子先行，角色实现待美工。」
> —— 架构预留，独立迭代

---

## 十一、参考文献

- 《三国演义》罗贯中
- 北斗七星与道教星君信仰
- 中国传统五色体系与五行对应
- 终端角色设计：Claude Code buddy、Microsoft Clippy

---

*本文档为三国英雄伴侣系统的工程预留设计。*
*角色实现需等待美工设计完成后填入 HERO_TEMPLATES。*
*当前阶段重点：确保接口向后兼容，为未来扩展预留空间。*
