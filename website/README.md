# 天枢 / TianShu 官方网站

这是 TianShu（天枢）的官方网站源码，使用 Vue 3 + Vite + Tailwind CSS 4 构建。

> 注意：官网项目已与天枢核心仓库分离，独立维护。

## 开发

```bash
npm install
npm run dev
```

默认在 http://localhost:5173 启动。

## 构建

```bash
npm run build
```

构建产物输出到 `dist/`，可直接部署到任何静态托管服务。

## 部署建议

- **GitHub Pages**：将 `dist` 推送到 `gh-pages` 分支（推荐）。
- **Vercel**：导入 Git 仓库，框架选 Other / Vite，输出目录 `dist`。
- **Cloudflare Pages**：构建命令 `npm run build`，输出目录 `dist`。

## 页面结构

- `Navbar` — 顶部导航 + 下载入口
- `Hero` — 大标题、一键安装命令、双 CTA
- `TrustBar` — 开源协议、版本、测试覆盖等信任标识
- `Features` — 6 大核心特性卡片
- `TerminalDemo` — 可交互终端动画演示
- `DownloadSection` — 桌面版多平台下载入口
- `QuickStart` — 终端版安装步骤
- `FAQ` — 常见问题折叠面板
- `Community` — GitHub / 文档 / 讨论入口
- `Footer`

## 内容维护

- 页面模块位于 `src/components/`
- 文案集中在 `src/composables/useI18n.ts`，支持中/英切换
- 图标使用 `lucide-vue-next`，Windows/Linux 使用内联 SVG 组件

## 后续迭代

- [x] 英文版 i18n
- [ ] 真实下载链接与版本号自动同步
- [ ] 博客 / Changelog 页面
- [ ] 星域人格展示页
