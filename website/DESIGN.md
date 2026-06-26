# 天枢 / Rivet 官方网站设计文档

## 1. 项目概述

为 **Rivet（天枢）** 创建一个现代化、响应式的官方网站，展示其作为开源终端 AI 编程代理的核心价值，同时引导用户了解终端版与桌面版两条产品线。

- **目录**：`website/`
- **技术栈**：Next.js 15 (App Router) + Tailwind CSS 4 + TypeScript
- **部署方式**：静态导出 (`output: 'export'`)，适配 GitHub Pages / Vercel / Cloudflare Pages
- **默认语言**：中文（结构预留 i18n 扩展）

## 2. 设计目标

1. **第一印象**：3 秒内传达「终端 AI 编程代理」的定位
2. **可信感**：通过技术细节（prefix cache 命中率、测试数量、模型矩阵）建立专业信任
3. **行动引导**：清晰区分「桌面版下载」与「终端版快速开始」两条路径
4. **品牌调性**：硬核工程 + 东方星象美学（天枢/北斗）

## 3. 信息架构

```
/
├── Hero
│   ├── Slogan
│   ├── 一句话描述
│   └── 双 CTA：下载桌面版 / 终端快速开始
├── Features
│   ├── Prefix Cache 引擎
│   ├── 多模型自适应路由
│   ├── 子智能体编排
│   ├── 安全与审批机制
│   ├── MCP 扩展生态
│   └── 桌面版能力
├── Terminal Demo
│   └── 模拟 TUI 交互动画
├── Desktop
│   ├── 桌面版介绍
│   └── 下载入口（指向 GitHub Releases）
├── Quick Start
│   └── 安装命令代码块
├── Community
│   ├── GitHub
│   ├── 文档
│   └── 贡献指南
└── Footer
```

## 4. 视觉风格

### 4.1 色彩系统

| Token | 值 | 用途 |
|-------|-----|------|
| `--bg-primary` | `#0a0a0f` | 主背景（深空黑） |
| `--bg-secondary` | `#111118` | 卡片/区块背景 |
| `--accent` | `#6366f1` | 主强调色（靛蓝） |
| `--accent-glow` | `#818cf8` | 高亮/光晕 |
| `--text-primary` | `#f8fafc` | 主文字 |
| `--text-secondary` | `#94a3b8` | 次要文字 |
| `--success` | `#22c55e` | 成功/缓存命中 |
| `--warning` | `#f59e0b` | 警告 |
| `--danger` | `#ef4444` | 危险/错误 |

### 4.2 字体

- 标题：`Inter` / `system-ui`（英文）+ `PingFang SC`、`Microsoft YaHei`（中文回退）
- 代码：`JetBrains Mono`、`SF Mono`、`monospace`

### 4.3 设计语言

- 深色模式为主，配合微妙渐变与光晕
- 卡片使用 1px 边框 + 低透明度背景
- 终端演示区域使用等宽字体 + 绿色/蓝色文本模拟真实 TUI
- 图标使用 `lucide-react`

## 5. 页面模块详细设计

### 5.1 导航栏 (Navbar)

- 左侧：天枢 Logo + 名称
- 中间：桌面版、终端版、文档、GitHub
- 右侧：下载按钮（桌面版）、主题切换（可选）
- 移动端：汉堡菜单

### 5.2 Hero 区域

- 大标题：**天枢 — 终端里的 AI 合伙人**
- 副标题：为 DeepSeek V4 前缀缓存优化的开源编程代理。多模型路由、子智能体编排、结构化安全机制，让长会话保持高效与可控。
- CTA 按钮：
  - 主按钮：下载桌面版（链接到 GitHub Releases）
  - 次按钮：终端快速开始 → 滚动到 Quick Start
- 背景： subtle grid + 渐变光晕

### 5.3 核心特性 (Features)

6 张特性卡片，2x3 网格：

1. **Prefix Cache 引擎**
   - 图标：`Zap`
   - 描述：冻结前缀 + 增量附录，DeepSeek V4 实战命中率 95–99%。
2. **多模型自适应路由**
   - 图标：`Network`
   - 描述：一条命令切换 DeepSeek、Claude、GLM、Codex、MiniMax、MiMo。
3. **子智能体编排**
   - 图标：`Users`
   - 描述：类型化 work order、只读/写 worker 隔离、批量调度与聚合。
4. **结构化安全机制**
   - 图标：`Shield`
   - 描述：路径边界、敏感文件拒绝、审批模式、git checkpoint + 文件级 undo。
5. **MCP 扩展生态**
   - 图标：`Puzzle`
   - 描述：通过 Model Context Protocol 接入文档、数据库、API 等外部工具。
6. **桌面版体验**
   - 图标：`Monitor`
   - 描述：Tauri 构建的本地 App，多会话、artifacts、审批介入、定时任务。

### 5.4 终端演示 (Terminal Demo)

- 一个模拟终端窗口，包含：
  - 窗口标题栏（红黄绿按钮）
  - 命令行输入动画：`rivet /goal 重构认证模块`
  - AI 回复逐字打印效果
  - 工具调用高亮（如 `read: src/auth.ts`）
- 使用 React state + setInterval 实现打字机效果
- 不依赖真实后端

### 5.5 桌面版介绍 (Desktop)

- 左侧：桌面版架构说明（Tauri + React + Node sidecar）
- 右侧：功能列表
  - 多会话 Dashboard
  - Artifact 审查与反馈
  - 审批介入（approval / intent）
  - 定时任务 /schedule
  - 浏览器验证面
- 下载按钮：下载 macOS 版（.app），其他平台标注「即将推出」

### 5.6 快速开始 (Quick Start)

- 代码块展示安装与启动：

```bash
git clone https://github.com/user/rivet.git && cd rivet
npm install && npm run build
export DEEPSEEK_API_KEY=sk-xxx
node dist/main.js
```

- 一键复制按钮
- 下方补充：`rivet config` 交互式配置

### 5.7 社区与开源 (Community)

- GitHub stars / forks 占位
- 文档链接
- 贡献指南链接
- MIT License 声明

### 5.8 Footer

- 左侧：版权、MIT License
- 中间：快速链接
- 右侧：GitHub、Twitter/X 占位

## 6. 技术实现要点

### 6.1 项目结构

```
website/
├── app/
│   ├── page.tsx              # 首页
│   ├── layout.tsx            # 根布局 + 元数据
│   └── globals.css           # 全局样式
├── components/
│   ├── navbar.tsx
│   ├── hero.tsx
│   ├── features.tsx
│   ├── terminal-demo.tsx
│   ├── desktop.tsx
│   ├── quick-start.tsx
│   ├── community.tsx
│   └── footer.tsx
├── components/ui/            # shadcn/ui 组件（如 Button、Card）
├── lib/
│   └── utils.ts              # cn() 工具函数
├── public/
│   ├── app-icon.png          # 从 desktop/src-tauri/icons 复制
│   └── og-image.png          # Open Graph 图片
├── next.config.js
├── tailwind.config.ts
├── tsconfig.json
└── package.json
```

### 6.2 关键配置

- `next.config.js`：设置 `output: 'export'`，配置 `distDir: 'dist'` 或 `'out'`
- 图片：使用 `<img>` 而非 `next/image`（静态导出兼容性）
- 路由：单页应用，无需动态路由
- 元数据：配置 title、description、Open Graph、Twitter Card

### 6.3 性能考虑

- 终端演示使用 requestAnimationFrame 或 setInterval，避免阻塞主线程
- 图标按需引入（`lucide-react` tree-shaking）
- 字体使用系统字体栈，减少加载

## 7. 部署建议

| 平台 | 步骤 |
|------|------|
| Vercel | 直接导入 Git 仓库，框架选 Next.js |
| GitHub Pages | 使用 GitHub Actions 构建并推送到 `gh-pages` 分支 |
| Cloudflare Pages | 构建命令 `npm run build`，输出目录 `out` |

## 8. 后续迭代

1. 英文版内容（`/en` 或子域名）
2. 文档站点集成（可复用 `/docs` 内容生成静态页面）
3. 真实下载统计与版本号 API
4. 博客 / Changelog 页面
5. 星域人格展示页（I1 迭代后）
