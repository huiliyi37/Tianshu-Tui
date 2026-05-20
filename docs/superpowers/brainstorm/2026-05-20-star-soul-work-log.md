# 天枢星君 Avatar 系统 — 工作记录与总结

> **日期**：2026-05-20
> **分支**：feat/tianshu-star-soul
> **状态**：✅ 核心完成，三国英雄预留就绪

---

## 一、今日完成

### 1.1 星君系统 v1（国风双身）

**核心模块**（全部已提交）：

| 文件 | 职责 | 测试 |
|------|------|------|
| `src/tui/avatar/types.ts` | 类型定义（AvatarMode, AvatarMood, HeroId） | — |
| `src/tui/avatar/expressions.ts` | 10 种 kaomoji 表情 + 眨眼动画 | 28 tests |
| `src/tui/avatar/frames.ts` | 印章冠帧模板 + CJK 显示宽度 | 29 tests |
| `src/tui/avatar/avatar-renderer.ts` | 渲染流水线（情绪 + 炼金 + idle） | 16 tests |
| `src/tui/star-panel-colors.ts` | 五色星辰色板 + 256 色降级 | — |
| `src/tui/star-panel.tsx` | 紫微星桥侧边栏组件 | — |
| `src/tui/constellation.ts` | 纵向七星渲染（新增） | — |
| `src/tui/theme.ts` | observatory 主题（新增） | — |

**测试覆盖**：73 tests, 0 failures

### 1.2 审查问题修复

| # | 严重度 | 问题 | 状态 |
|---|--------|------|------|
| 1 | P1 | phaseToMood exhaustive check | ✅ 已修复 |
| 2 | P1 | CJK 显示宽度 padding | ✅ 已修复 |
| 3 | P2 | tick vs turn 语义混淆 | ✅ 已修复 |
| 4 | P2 | constellation.ts 死代码 | ✅ 已修复 |
| 5 | P2 | 纵向渲染零测试 | ⏳ 待补 |
| 6 | P2 | 硬编码颜色未用常量 | ✅ 已修复 |
| 7 | P3 | 注释写 12 种情绪实际 10 种 | ✅ 已修复 |
| 8 | P3 | 无 256 色降级方案 | ✅ 已修复 |

### 1.3 三国英雄伴侣工程预留

**设计文档**：`docs/superpowers/specs/2026-05-20-three-kingdoms-heroes-companion-design.md`

**工程钩子**（已提交）：
- ✅ `HeroId` 类型（7 位英雄 + null）
- ✅ `AvatarContext.hero` 可选字段
- ✅ `buildFrame()` 支持 hero 参数（默认 null）
- ✅ `renderAvatar()` 透传 hero

**向后兼容**：73 tests 全部通过

---

## 二、待后续安排

### 2.1 美工设计（三国英雄）

等待美工完成后填入：

- [ ] `HERO_TEMPLATES` 帧模板（印章冠/手势/配色）
- [ ] `HERO_QUOTES` 台词系统
- [ ] 英雄选择 UI（`/hero <name>` 命令）
- [ ] 英雄切换动画

**设计文档位置**：`docs/superpowers/specs/2026-05-20-three-kingdoms-heroes-companion-design.md`

### 2.2 侧边栏集成

等待 main session 集成：

- [ ] `src/tui/app.tsx` — side-by-side 布局 + 宽度检测 + 自动展开

### 2.3 测试补全

- [ ] `renderConstellationVertical` + `getActiveStarIndex` 测试

---

## 三、设计资产

### 3.1 设计文档

| 文档 | 路径 | 状态 |
|------|------|------|
| 国风再造设计过程 | `docs/superpowers/brainstorm/2026-05-20-star-lord-guofeng-design-process.md` | ✅ 完成 |
| Avatar 设计规格 | `docs/superpowers/specs/2026-05-20-avatar-styles-design.md` | ✅ 完成 |
| 三国英雄伴侣设计 | `docs/superpowers/specs/2026-05-20-three-kingdoms-heroes-companion-design.md` | ✅ 完成 |
| Observatory 主题设计 | `docs/superpowers/specs/2026-05-20-observatory-starmap-theme-design.md` | ✅ 完成 |
| 实施计划 | `docs/superpowers/plans/2026-05-20-observatory-avatar-starmap.md` | ✅ 完成 |

### 3.2 核心设计决策

| 决策 | 理由 |
|------|------|
| 印章冠 + kaomoji 面 | 三层可读性：表层全球通用，中层东亚文化，深层星辰叙事 |
| 文/武模式切换 | 来自布袋戏洞察：模式切换比微表情变化显眼 100 倍 |
| 五色星辰色板 | 基于中国传统五色体系，北斗在北属水色玄 |
| HeroId 可选字段 | 向后兼容，英雄系统可独立迭代 |
| CJK 显示宽度函数 | 处理中日韩字符占 2 列的问题 |

---

## 四、技术债务

| 项目 | 优先级 | 说明 |
|------|--------|------|
| 纵向渲染测试 | P2 | renderConstellationVertical + getActiveStarIndex 零测试 |
| 侧边栏集成 | P1 | 需 main session 修改 app.tsx |
| 英雄帧模板 | P3 | 等美工设计 |

---

## 五、下一步行动

1. **等待美工**：三国英雄角色设计（印章冠/手势/配色/台词）
2. **等待 main session**：app.tsx 侧边栏布局集成
3. **可选**：补全纵向渲染测试

---

## 六、验收清单

### 当前阶段（工程预留）

- [x] `npm run typecheck` — 0 errors
- [x] `npm test` — 全部 PASS（73 avatar tests）
- [x] 现有星君系统功能不受影响（向后兼容）
- [x] `HeroId` 类型定义完整但不实际使用
- [x] `AvatarContext.hero` 字段可选，默认 null
- [x] `buildFrame` 和 `renderAvatar` 支持 `hero` 参数透传
- [x] 设计文档完整（国风再造 + 三国英雄）

### 未来阶段（美工完成后）

- [ ] 至少 3 个英雄有完整帧模板
- [ ] 英雄切换无视觉跳变（平滑过渡）
- [ ] 英雄台词在 RadioFeed 正确显示
- [ ] 英雄配色与五色星辰系统一致

---

*本文档记录了天枢星君 Avatar 系统的完整工作历程。*
*三国英雄伴侣系统已预留工程钩子，等待美工设计后实现。*
