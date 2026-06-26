# 天枢 / Rivet 官方网站建设 — 项目计划

## 目标
为 Rivet（天枢）创建一个专业的产品官方网站，展示其作为开源终端 AI 编程代理的核心价值，同时兼顾桌面版的介绍与下载引导。

## 关键决策

| 维度 | 决策 | 理由 |
|------|------|------|
| 定位 | 产品官网 + 开源项目展示 | 既有终端工具又有桌面 App，需要产品介绍和下载入口 |
| 技术栈 | Next.js 15 (App Router) + Tailwind CSS 4 + TypeScript | SEO 友好、组件化、静态导出易部署 |
| 部署 | 静态导出 (`output: 'export'`) | 可部署到 GitHub Pages / Vercel / Cloudflare Pages |
| 语言 | 默认中文，结构预留英文 i18n | 项目内中文文档完善，中文名「天枢」有品牌感 |
| 目录 | `website/` | 与现有 `src/`、`desktop/` 隔离 |

## 阶段

### Phase 1 — 研究与设计
- [x] 阅读 README、package.json、AGENTS.md 等理解项目
- [x] 阅读桌面版 README/ROADMAP 了解产品线
- [x] 输出 `website/DESIGN.md` 设计文档

### Phase 2 — 项目脚手架
- [x] 初始化 Next.js + Tailwind 项目到 `website/`
- [x] 配置静态导出、路径前缀、元数据
- [x] 配置基础布局与主题色

### Phase 3 — 页面与组件
- [x] 导航栏（Logo、桌面版/终端、文档、GitHub）
- [x] Hero 区域（Slogan、双 CTA）
- [x] 核心特性展示（6 大卖点卡片）
- [x] 终端 TUI 模拟演示
- [x] 桌面版介绍与下载区
- [x] 快速开始命令区
- [x] Footer

### Phase 4 — 内容完善
- [x] 填充中文文案（技术准确、有品牌感）
- [x] 复用项目图标资产
- [x] 添加 Open Graph / Twitter Card 元数据

### Phase 5 — 构建与验证
- [x] 本地开发服务器验证
- [x] 静态构建验证
- [x] 响应式检查

## 风险与边界
- 不实现后端、不接入真实下载统计
- 桌面版下载链接可先指向 GitHub Releases（占位）
- 英文版可后续迭代，本次先保证中文版完整可用

## 错误记录
| 错误 | 尝试 | 解决 |
|------|------|------|
| 无 | - | - |
