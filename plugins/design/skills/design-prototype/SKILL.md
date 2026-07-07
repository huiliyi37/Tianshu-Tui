---
name: design-prototype
description: Frontend UI prototype workflow — clarify intent, explore directions, preview across viewports, diff against references, deliver with screenshot evidence
triggers: [设计, UI, 原型, landing, 界面, mockup, prototype, dashboard, 首页, 落地页, wireframe, 视觉, layout]
---

# Design Prototype（前端设计原型）

对标 Codex Product Design 插件的方法论，适配天枢交付纪律。

## 工作流

### 1. 意图澄清（单问约束）

开始动手前，若以下任一项不明，**只问一个最关键的问题**：

- 目标用户与核心动作（注册？购买？浏览？）
- 品牌调性（极简 / 企业 /  playful / 暗色）
- 有无参考（竞品截图、Figma 链接描述、色板）

不要一次抛多个选择题。

### 2. 探索 2–3 个视觉方向

每个方向输出**单文件 HTML 原型**：

- 内联 CSS（无构建步骤，即开即预览）
- 语义化 HTML + 基础可访问性（label、alt、focus 可见）
- 真实文案占位（不用 lorem 堆砌——用场景化假数据）
- 移动端优先，desktop 用 media query 扩展

文件命名：`prototype-{direction}.html`（如 `prototype-minimal.html`）

### 3. 多视口自检（必做）

每个方向完成后：

1. `ui_preview` — mobile / tablet / desktop 三视口截图
2. `ui_responsive_audit` — 抓横向溢出、过小点击区、过小字号

有问题先修 HTML，再进入下一步。不要带着 overflow 交付。

### 4. 参考对齐（有 mockup 时）

用户提供参考图或竞品截图时：

1. `ui_palette` — 从参考图提取色板，写入 CSS variables
2. 实现后 `ui_diff` — 与参考/mockup 像素对比，目标 mismatch < 5%
3. mismatch > 5% 必须迭代，不能口头说「差不多」

### 5. 交付纪律（复现即证明）

交付设计任务时**必须附带**：

- 至少一组三视口 `ui_preview` 截图路径
- `ui_responsive_audit` 结果（零 high 级 issue，或明确列出已知遗留）
- 若有参考：最新 `ui_diff` mismatch 百分比

口头描述「已经 responsive 了」不算交付。

## 工具速查

| 工具 | 何时用 |
|------|--------|
| `ui_preview` | HTML/URL → 多视口 PNG |
| `ui_diff` | 实现 vs 参考 mockup |
| `ui_palette` | 参考图 → CSS/Tailwind tokens |
| `ui_responsive_audit` | 布局问题清单 + 截图 |

## 反模式

- 不要跳过 preview 直接改 CSS 猜效果
- 不要用 `<table>` 做整页布局（2020 年代前的 hack）
- 不要在未装 `tianshu-design` 插件时会话里调用上述工具——先 `/plugin install` 或让用户安装
- Chrome 未安装时工具会返回明确错误；提示用户安装 Chrome 或设置 `CHROME_PATH`
