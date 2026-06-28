# 桌面端主题 JSON 驱动迁移计划

## 问题

当前主题系统是 CSS 硬编码在 `desktop/src/styles/tokens.css` 中（530+ 行），三个主题块（dark/light/nebula）各自有独立的 CSS 变量定义块及 glass 模式覆盖。新增主题需要：
1. 在 `tokens.css` 中手写 CSS 变量块
2. 在 `theme.ts` 的 `ThemePref` 类型中加枚举值
3. 在 `SettingsSurface.tsx` 的 Select 中加选项

这个流程每次碰 3 个文件，容易遗漏 glass 模式覆盖。

## 目标

主题定义从 CSS 变量硬编码迁移到 JSON 文件驱动，新增主题只需加一个 JSON 文件。

### JSON 主题文件格式

```json
// styles/themes/dark.json
{
  "name": "暗色",
  "variables": {
    "--bg": "#0d1117",
    "--bg-alt": "#161b22",
    "--text": "#e6edf3",
    "--text-muted": "#8b949e",
    "--border": "#30363d",
    "--accent": "#58a6ff",
    ...
  },
  "glass": {
    "--sidebar-glass-opacity": "80%",
    "--sidebar-glass-blur": "24px",
    "--main-glass-opacity": "90%",
    "--main-glass-blur": "16px",
    "--glass-bg": "rgba(13,17,23,0.8)",
    "--glass-border": "rgba(48,54,61,0.4)"
  }
}
```

## 执行步骤

### 步骤 1：创建主题 JSON 文件
- [ ] 创建 `desktop/src/styles/themes/` 目录
- [ ] 从 `tokens.css` 提取 dark 主题变量 → `styles/themes/dark.json`
- [ ] 从 `tokens.css` 提取 light 主题变量 → `styles/themes/light.json`  
- [ ] 从 `tokens.css` 提取 nebula 主题变量 → `styles/themes/nebula.json`
- [ ] 每个 JSON 包含 `variables` + `glass` 两个顶层 key
- [ ] 运行现有测试确认未破坏（此时 JSON 尚未被消费）

### 步骤 2：添加 JSON 加载逻辑
- [ ] 创建 `desktop/src/lib/theme-loader.ts`
- [ ] 实现 `loadThemeVariables(theme: ThemePref): ThemeVariables` —— import 对应 JSON 文件
- [ ] 实现 `applyThemeJson(theme: ThemePref)` —— 先 apply base 变量，再检查 glass 模式叠加 glass 变量
- [ ] 变量注入方式：`.setProperty()` 到 `document.documentElement.style`（与当前 `initGlassCustom` 同模式）

### 步骤 3：切换到 JSON 驱动
- [ ] 修改 `theme.ts` 的 `setThemePref()`：调用 `applyThemeJson(theme)` 替代仅设置 `data-theme` attribute
- [ ] 修改 `glass.ts` 的 `applyGlassMode()`：当 glass 开启时调用 `applyThemeJson(currentTheme)` 叠加 glass 变量
- [ ] 修改 `main.tsx` 的 `initTheme()` 调用链：`initTheme()` → `applyThemeJson(loadThemePref())`

### 步骤 4：清理
- [ ] 从 `tokens.css` 中删除 dark/light/nebula 三个主题的 CSS 变量块（保留共享变量）
- [ ] 确认 `shadcn-tokens.css` 不受影响（它引用 CSS 变量名，变量来源从 CSS 块变成 JS setProperty 对浏览器透明）
- [ ] 运行 `cd desktop && npx tsc --noEmit`
- [ ] 运行 `cd desktop && npm run dev` 目视确认 dark/light/nebula 三个主题 + glass 模式均正常

### 步骤 5：验证
- [ ] 运行 `cd desktop && node --import tsx --test --test-reporter spec src/**/__tests__/*.test.ts`
- [ ] 新增主题验证测试：`theme-loader.test.ts`（验证 JSON 加载 + setProperty 注入）
- [ ] 更新 `theme.test.ts`（如果 `setThemePref` 行为变化）

## 风险与注意事项

- **Tailwind 兼容性**：Tailwind 的 `@theme` 块引用 `var(--bg)` 等 CSS 变量。浏览器的 CSS 自定义属性在 `:root` 上定义和在 `document.documentElement.style` 上 setProperty 是等价的——Tailwind 在运行时读取的是计算后的 CSS 变量值。**JSON 驱动不会破坏 Tailwind**。
- **FOUC（无样式闪烁）**：JSON import 是静态的（编译时确定），但 `applyThemeJson` 在 JS 执行后才生效。当前 `initTheme()` 在 `main.tsx` 最早期同步调用，不会引入新的 FOUC。但需确认：若 JSON import 变懒加载（`await import()`），会在首帧渲染前才应用主题。
- **Glass 模式叠加**：当前 `tokens.css` 中 glass 模式通过 `[data-surface='glass']` 选择器覆盖变量。JSON 驱动后需要 `applyThemeJson` 在 glass 开启时显式设置 glass 变量值（覆盖 base 变量），在 glass 关闭时恢复 base 值。
- **保持向后兼容**：过渡期可同时支持 CSS 块 + JSON 驱动。`applyThemeJson` 先于 CSS 块执行（setProperty 优先级低于 CSS 选择器特异性？不——setProperty 在 `element.style` 上的优先级高于任何 CSS 规则，除非 CSS 规则有 `!important`）。确认 tokens.css 中无 `!important`。
- **TypeScript 类型安全**：JSON 文件需要对应的类型定义。建议创建 `ThemeVariables` interface，`import` JSON 时用 `as ThemeVariables` 断言。

## 验证命令

```bash
cd desktop
npx tsc --noEmit
npm run build
node --import tsx --test --test-reporter spec src/**/__tests__/*.test.ts
# 目视验证：npm run dev 后切换 dark → light → nebula，开启/关闭毛玻璃
```
