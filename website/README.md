# 天枢 / Rivet 官方网站

这是 Rivet（天枢）的官方网站源码，使用 Next.js 15 + Tailwind CSS 4 构建。

## 开发

```bash
cd website
npm install
npm run dev
```

默认在 http://localhost:3000 启动。

## 构建

```bash
cd website
npm run build
```

构建产物输出到 `website/dist/`，可直接部署到任何静态托管服务。

## 部署建议

- **Vercel**：导入 Git 仓库，框架选 Next.js
- **GitHub Pages**：使用 GitHub Actions 将 `website/dist` 推送到 `gh-pages` 分支
- **Cloudflare Pages**：构建命令 `cd website && npm run build`，输出目录 `website/dist`

## 内容维护

- 页面模块位于 `components/`
- 文案集中在各组件内，后续可提取为 i18n 资源
- 图标使用 `lucide-react`
- 项目图标来源：`desktop/src-tauri/icons/app-icon.png`

## 后续迭代

- [ ] 英文版 i18n
- [ ] 真实下载链接与版本号
- [ ] 博客 / Changelog 页面
- [ ] 星域人格展示页
