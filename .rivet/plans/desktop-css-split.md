# 桌面端 CSS 拆分计划

## 问题

`desktop/src/styles.css` 当前 127KB，是单文件巨石。包含：
- Tailwind @import 指令 + @theme inline 块（L1-L30）
- 玻璃表面系统（L66-L104）
- 布局重置（html/body/#root, .shell, .main）
- Rail 导航栏、Surface 容器、Conversation 布局
- 20+ 组件样式（ThreadView, TerminalPanel, SettingsSurface, ReviewPanel 等）
- 壁纸/毛玻璃设置 UI
- glass-slider 自定义样式

每次新增主题或组件都在追加，维护成本指数增长。

## 目标

拆分为 3 个文件，保持 `main.tsx` 入口不变（通过 @import 级联）：

| 文件 | 内容 | 预估行数 |
|------|------|---------|
| `styles/base.css` | Tailwind @import + @theme inline + 全局重置 + 布局（rail/shell/surface/conversation）+ 所有组件样式 | ~2,400 行 |
| `styles/glass.css` | 玻璃表面系统（.surface-sidebar/.surface-main 等）+ 壁纸/毛玻璃 UI + glass-slider | ~250 行 |
| `styles/themes/dark.css` | 当前 `tokens.css` 中的 `[data-theme='dark']` 主题变量块 | ~200 行 |
| `styles/themes/light.css` | `[data-theme='light']` 主题变量块 | ~200 行 |
| `styles/themes/nebula.css` | `[data-theme='nebula']` 主题变量块 | ~200 行 |

## 执行步骤

### 步骤 1：创建 glass.css
- [ ] 从 `styles.css` 中提取 L66-L104（玻璃表面系统）及 L2189-L2202（壁纸 UI）及 L2684-L2710（glass-slider）到 `styles/glass.css`
- [ ] 验证提取完整性：grep 确认这些 CSS 规则在 `styles.css` 中不再出现
- [ ] 在 `styles.css` 顶部添加 `@import './styles/glass.css'`

### 步骤 2：提取主题变量到 themes/ 目录
- [ ] 在 `styles/tokens.css` 中定位 `:root[data-theme='dark']`、`[data-theme='light']`、`[data-theme='nebula']` 三个块及各自的 glass 模式覆盖
- [ ] 分别提取到 `styles/themes/dark.css`、`styles/themes/light.css`、`styles/themes/nebula.css`
- [ ] 在 `styles/tokens.css` 顶部添加 `@import './themes/dark.css'` 等（或改由 `styles.css` 统一导入）
- [ ] 确认 `tokens.css` 中保留共享变量（不随主题变化的 CSS 自定义属性）

### 步骤 3：重命名并整理 base.css
- [ ] 将剩余所有内容重命名为 `styles/base.css`
- [ ] 在文件顶部添加 `@import './styles/tokens.css'` 和 `@import './styles/glass.css'` 和 `@import './styles/themes/*.css'`
- [ ] 更新 `main.tsx` 中的 import：`import './styles/base.css'` 替代原来的 `import './styles.css'`
- [ ] 删除 `styles.css` 原文件

### 步骤 4：验证
- [ ] 运行 `cd desktop && npx tsc --noEmit`
- [ ] 运行 `cd desktop && npm run dev` 目视确认各主题（dark/light/nebula）和玻璃效果正常
- [ ] 确认 `shadcn-tokens.css` 的导入链未断裂（当前 `styles.css` L1 有 `@import './styles/shadcn-tokens.css'`）
- [ ] 运行 `cd desktop && node --import tsx --test --test-reporter spec src/**/__tests__/*.test.ts`（现有测试不受影响，但需确认构建产物包含拆分后的 CSS）

## 风险与注意事项

- **@import 顺序敏感**：`base.css` 的 Tailwind `@import "tailwindcss"` 必须在最前；`@theme` 块内引用的 CSS 变量必须先于 `@theme` 定义。建议将 `tokens.css` 的 @import 放在 `@theme` 之前
- **shadcn 映射文件**：`shadcn-tokens.css` 当前通过 `styles.css` L1 的 `@import './styles/shadcn-tokens.css'` 导入，拆分后该 import 需移到 `base.css` 顶部
- **glass.css 依赖 tokens.css**：玻璃表面系统引用 `var(--sidebar-glass-opacity)` 等变量，这些在 `tokens.css` 中定义。确保 `base.css` 中 `@import` 顺序为 tokens → glass → themes
- **构建工具兼容**：Vite 的 CSS 处理对 `@import` 的支持需要在 `vite.config.ts` 中确认——当前是单文件 import，拆分后需验证 Vite 正确处理 `@import` 链
- **无 JavaScript 逻辑变更**：纯 CSS 重组，`theme.ts` 中的 `setThemePref(data-theme)` 继续工作——它设置的是 `document.documentElement.dataset.theme`，CSS 选择器 `[data-theme='dark']` 继续匹配

## 验证命令

```bash
cd desktop
npx tsc --noEmit
npm run build  # 确认 Vite 打包正确
node --import tsx --test --test-reporter spec src/**/__tests__/*.test.ts
```
