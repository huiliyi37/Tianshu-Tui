---
name: design-md
description: 当用户项目包含 DESIGN.md 文件时，按其中的设计 token（颜色、字体、间距、阴影、圆角等）生成视觉一致的前端代码。如果用户项目没有 DESIGN.md，使用内置默认设计系统。支持 HTML/CSS/React/Vue/Svelte/Tailwind 等主流前端技术栈。遵循 Google DESIGN.md 开放格式规范（Apache 2.0）。
triggers: ['DESIGN\\.md', 'design system', '设计系统', '设计规范', 'design token', '设计 token', '颜色规范', '字体规范', '间距规范', '视觉规范', 'UI 组件', 'frontend', '前端', '组件样式', 'Tailwind', 'CSS 变量', 'visual identity', 'brand color', 'typography scale', 'spacing scale', '页面样式', '按钮颜色', '卡片样式', '登录页', '注册页', 'dashboard', 'landing page']
---

# DESIGN.md — 设计系统规范驱动的前端开发

## 概述

DESIGN.md 是 Google Labs 开源的开放格式规范（Apache 2.0），用单个 markdown 文件描述一个产品或品牌的视觉设计系统。

**核心规则：**
1. 开始任何前端 UI 任务时，先用 `read_file` 检查用户项目根目录是否存在 `DESIGN.md`
2. 如果存在 → 解析 YAML frontmatter 中的 design token，**所有生成的 UI 代码必须遵循这些 token**
3. 如果不存在 → **使用天枢内置的默认设计系统**（位于本 skill 目录下的 `default-design.md`），把它当作项目 DESIGN.md 来用

## 工作流

### Step 1：检查 DESIGN.md

```bash
read_file(DESIGN.md)
```

- 文件存在 → 继续 Step 2
- 文件不存在 → **将内置默认设计系统写入项目根目录**（`write_file('DESIGN.md', <默认内容>)`），告诉用户"已为你的项目创建了默认 DESIGN.md 设计规范"，然后继续 Step 2

### Step 2：解析 YAML frontmatter

DESIGN.md 分为两部分：YAML frontmatter（`---` 包裹的机器可读 token）和 markdown body（人类可读的设计指引）。

Token 分类速查：

| 顶级 key | 子结构 | 代码映射 |
|----------|--------|---------|
| `colors` | `primary`, `secondary`, `surface`, `background`, `text`, `error`, `success` 等 | CSS 变量 / Tailwind 颜色 |
| `typography` | `heading`, `body`, `caption`。每个含 `fontFamily`, `fontWeight`, `fontSize`, `lineHeight`, `letterSpacing` | CSS font-* 属性 / Tailwind text-* 类 |
| `spacing` | `unit`（基数）+ `scale`（数组，单位 px） | margin/padding/gap |
| `shadows` | `sm`, `md`, `lg` 等 | box-shadow |
| `borders` | `radius`（含 `sm`, `md`, `lg` 等） | border-radius |

引用语法：`{path.to.token}` 可在 YAML 内跨 token 引用，生成代码前展开为实际值。

### Step 3：将 token 映射为代码（按框架选择输出格式）

**纯 HTML/CSS**：输出 `:root { --color-primary: #xxx; --font-heading: ... }` CSS 变量块。

**Tailwind**：写入 `tailwind.config.js` 的 `theme.extend`，组件用 `bg-primary text-secondary font-heading rounded-md`。

**React/Vue/Svelte**：优先 CSS 变量，组件内引用变量名，不硬编码颜色值。

### Step 4：生成代码约束

1. 不硬编码颜色/字体值，始终引用 token
2. 优先 CSS 变量方案（跨框架可复用）
3. DESIGN.md token > 框架默认值 > 个人偏好
4. token 缺失时用框架默认值，不编造
5. 生成代码前展开所有 `{path.to.token}` 引用

## 内置默认设计系统

当用户项目没有 DESIGN.md 时，将此文件写入项目根目录（使用 `default-design.md` 的内容）。这是天枢维护的通用默认设计系统，确保在没有用户自定义设计系统时也能产出视觉一致的 UI。

## 错误处理

| 场景 | 行为 |
|------|------|
| DESIGN.md 不存在 | 写入内置默认 DESIGN.md，告知用户 |
| YAML frontmatter 解析失败 | 告知用户格式问题，降级读 markdown body |
| 引用循环 | 保留原始引用字符串 |
