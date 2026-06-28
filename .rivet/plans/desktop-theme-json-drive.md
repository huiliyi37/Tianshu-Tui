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

## 设计细化（基于现状代码审计）

对 `tokens.css`（330 行）、`theme.ts`、`glass.ts`、`glass-custom.ts`、`shadcn-tokens.css`、`main.tsx` 六文件的审计结果。

### 1. 共享变量 vs 主题变量边界

**保留在 `tokens.css :root` 的共享变量**（不迁移）：
- 排版：`--font-sans`、`--font-mono`、`--text-xs` ~ `--text-xl`、`--leading`、`--weight-*`
- 间距：`--space-1` ~ `--space-8`
- 圆角：`--radius-sm`、`--radius-md`、`--radius-lg`、`--radius-pill`
- 动效：`--ease`、`--dur-fast`、`--dur`
- Z-index：`--z-modal`、`--z-toast`
- Markdown：`--md-gap`、`--md-code-radius`、`--md-quote-bar`

**迁移到 JSON 的主题变量**（每主题约 50 个变量）：
- 30+ 颜色变量：`--bg`、`--panel`、`--panel-2`、`--panel-3`、`--border`、`--border-strong`、`--text`、`--text-strong`、`--muted`、`--faint`、`--text-dim`、`--text-secondary`、`--hover`、`--bg-elevated`、`--surface-2`、`--link`、`--link-hover`、`--green`、`--accent`、`--accent-hover`、`--accent-fg`、`--accent-soft`、`--success`、`--success-soft`、`--warning`、`--warning-soft`、`--error`、`--error-soft`、`--info`、`--info-soft`
- 阴影：`--overlay`、`--shadow-sm`、`--shadow-md`、`--shadow-lg`
- 13 个 solid surface tokens：`--sidebar-surface-bg`、`--sidebar-surface-blur`、`--sidebar-surface-saturation`、`--main-surface-bg`、`--main-surface-blur`、`--main-surface-saturation`、`--compose-surface-bg`、`--compose-surface-border`、`--compose-surface-shadow`、`--compose-surface-blur`、`--compose-surface-saturation`、`--popup-surface-bg`、`--popup-surface-blur`、`--popup-surface-saturation`、`--modal-surface-bg`、`--modal-surface-blur`、`--modal-surface-saturation`
- Glass 自定义默认值：`--sidebar-glass-opacity`、`--sidebar-glass-blur`、`--main-glass-opacity`、`--main-glass-blur`

### 2. Glass 模式的本质：不是"叠加变量"，是"替换 surface token 组"

当前 CSS 中 glass 模式通过 `[data-surface="glass"]` 选择器**覆盖**同一组 CSS 变量名。例如 `--sidebar-surface-bg` 在 solid 模式是 `var(--panel)`，在 glass 模式是 `color-mix(in oklab, var(--bg) var(--sidebar-glass-opacity), transparent)`。

用 `setProperty` 模拟这个行为：glass 切换时**全量重写**所有 surface token 变量——而不是"在 base 上叠加 glass"。

Glass surface tokens 中的 `color-mix()` 表达式引用 base 变量（如 `var(--bg)`）和 slider 变量（如 `var(--sidebar-glass-opacity)`）。CSS 自定义属性的 live 特性保证：slider 变化时，所有引用它的 `color-mix()` 自动重算，无需重新 apply theme。

### 3. Light 主题的 glass 额外覆盖

Light 主题在 glass 模式下额外覆盖了 5 个文本对比度变量：
```css
--link: #5c35cc; --link-hover: #4a25a8;
--muted: #3a3a44; --faint: #6e6e78; --text-dim: #5c5c68;
```
这些需要包含在 `light.json` 的 `glass` 块中——它们是 base 变量的覆盖值，不属于 surface token。

### 4. `!important` 检查

`tokens.css` 和 `shadcn-tokens.css` 中均无 `!important`，`setProperty` 在 `element.style` 的优先级高于任何 stylesheet 规则，不会被覆盖。

### 5. 正确的 JSON 格式

```typescript
// TypeScript 类型定义
interface ThemeJson {
  name: string
  colorScheme: 'dark' | 'light'
  variables: Record<string, string>    // base 颜色、阴影等
  surfaces: Record<string, string>     // solid 模式 surface token
  glass: Record<string, string>        // glass 模式 surface token + 覆盖值
}
```

示例（dark.json 结构）：
```json
{
  "name": "暗色",
  "colorScheme": "dark",
  "variables": {
    "--bg": "#1c1c1e",
    "--panel": "#141416",
    "--panel-2": "#232326",
    "...": "..."
  },
  "surfaces": {
    "--sidebar-surface-bg": "var(--panel)",
    "--sidebar-surface-blur": "0px",
    "--sidebar-surface-saturation": "1",
    "--main-surface-bg": "var(--bg)",
    "...": "..."
  },
  "glass": {
    "--sidebar-surface-bg": "color-mix(in oklab, var(--bg) var(--sidebar-glass-opacity), transparent)",
    "--sidebar-surface-blur": "var(--sidebar-glass-blur)",
    "--sidebar-surface-saturation": "1.08",
    "...": "..."
  }
}
```

### 6. `applyThemeJson` 签名与行为

```typescript
function applyThemeJson(theme: ThemePref, glass: boolean): void {
  const json = loadThemeJson(resolveTheme(theme))
  const root = document.documentElement

  // 1. 设置 color-scheme
  root.style.setProperty('color-scheme', json.colorScheme)

  // 2. 写入 base 变量
  for (const [k, v] of Object.entries(json.variables)) {
    root.style.setProperty(k, v)
  }

  // 3. 写入 surface token（glass 模式用 glass 块，否则用 surfaces 块）
  const surfaceBlock = glass ? json.glass : json.surfaces
  for (const [k, v] of Object.entries(surfaceBlock)) {
    root.style.setProperty(k, v)
  }

  // 4. data-theme attribute（供 styles.css 的星域 accent 选择器使用）
  root.dataset.theme = resolveTheme(theme)
}
```

### 7. 初始化顺序（main.tsx）

```
initTheme()           → applyThemeJson(loadThemePref(), loadGlassMode())
initFontWeight()      → set data-font-weight attribute（不变）
initFontFamily()      → set data-font-family attribute（不变）
initGlassMode()       → set/remove data-surface attribute（不变，但需同步触发 applyThemeJson）
initGlassCustom()     → setProperty slider 值（不变，值在 glass surface token 之后写入，live resolve）
initI18n()            → set lang attribute（不变）
```

关键：`initGlassCustom()` 在 `initTheme()` **之后**调用，slider 值通过 `setProperty` 写入。Glass surface token 中的 `var(--sidebar-glass-opacity)` 引用自动解析为最新 slider 值。

### 8. Glass 切换时的行为

`useGlassMode` hook 中的 setter 需要扩展：toggling glass 时重新调用 `applyThemeJson`：

```typescript
// glass.ts 修订
function setGlassMode(value: boolean): void {
  saveGlassMode(value)
  applyGlassMode(value)  // 设置 data-surface attribute
  const theme = resolveTheme(loadThemePref())
  applyThemeJson(theme, value)  // 重写 surface token
}
```

不去掉 `data-surface` attribute——`shadcn-tokens.css` 和 `styles.css` 中仍有 `[data-surface="glass"]` 选择器用于非 token 级别的样式（如 popover/card/modal 映射）。

### 9. 星域 accent 覆盖兼容性

`styles.css` 中有 `:root[data-theme="dark"] .thread.domain-tianshu { --accent: #a78bfa; }` 等规则。这些依赖 CSS 自定义属性的**逐元素解析**——`.thread` 元素显式设置 `--accent`，覆盖从 `:root` 继承的值。即使 `:root` 的值来自 `setProperty`（inline style），`.thread` 的 CSS 规则仍然生效——inline style 只影响该元素自身，不影响后代元素的显式声明。

→ **JSON 驱动不会破坏星域 accent 覆盖**。

## 执行步骤（修订版）

### 步骤 1：创建类型定义 + 主题 JSON 文件
- [ ] 创建 `desktop/src/lib/theme-types.ts`：定义 `ThemeJson` interface（`variables` + `surfaces` + `glass`）
- [ ] 创建 `desktop/src/styles/themes/` 目录
- [ ] 从 `tokens.css` 逐变量提取 dark → `styles/themes/dark.json`
  - 先提取 `:root, :root[data-theme="dark"]` 块中的颜色/阴影变量 → `variables`
  - 再提取同块中的 solid surface token → `surfaces`
  - 再提取 `:root[data-surface="glass"]` 块（仅 dark 主题的 glass surface token）→ `glass`
- [ ] 同上提取 light → `styles/themes/light.json`（注意 `glass` 块包含 5 个文本对比度覆盖变量）
- [ ] 同上提取 nebula → `styles/themes/nebula.json`
- [ ] 运行现有测试确认未破坏（此时 JSON 尚未被消费）

### 步骤 2：添加 theme-loader.ts
- [ ] 创建 `desktop/src/lib/theme-loader.ts`
- [ ] 实现 `loadThemeJson(resolved: ResolvedTheme): ThemeJson` —— 静态 import 对应 JSON（TypeScript `resolveJsonModule` 已启用）
- [ ] 实现 `applyThemeJson(theme: ThemePref, glass: boolean): void`
  - set `color-scheme`
  - write all `json.variables` via `setProperty`
  - write `json.glass`（if glass）or `json.surfaces`（if not）via `setProperty`
  - set `data-theme` attribute
- [ ] 实现 `themeJsonToCss(theme: ResolvedTheme): string` —— 用于过渡期对比验证（将 JSON 渲染回 CSS 文本，与 tokens.css 原文 diff）

### 步骤 3：集成到现有模块
- [ ] 修改 `theme.ts`：
  - `initTheme()` → 调用 `applyThemeJson(loadThemePref(), loadGlassMode())`
  - `setThemePref()` → 调用 `applyThemeJson(pref, loadGlassMode())`
  - 保留 `resolveTheme()`、`loadThemePref()`、`saveThemePref()` 不变
- [ ] 修改 `glass.ts`：
  - 扩展 `useGlassMode` 的 setter：toggling 时调用 `applyThemeJson(loadThemePref(), newValue)`
  - 保留 `data-surface` attribute 的 set/remove（shadcn-tokens.css 仍用此选择器）
  - 导出 `applyThemeJson` 的 re-export 或让 glass.ts 直接 import theme-loader
- [ ] 修改 `SettingsSurface.tsx`：主题 Select 的 `pick()` 和 glass toggle 无需改动（它们调 `setThemePref` / `useGlassMode` setter，内部已触发 `applyThemeJson`）

### 步骤 4：清理 tokens.css
- [ ] 从 `tokens.css` 删除以下块：
  - `:root, :root[data-theme="dark"]` 整块（颜色 + surface token + glass 自定义默认值）
  - `:root[data-surface="glass"]` 整块（dark glass surface token）
  - `@media (prefers-reduced-transparency: reduce)` 整块（需改为 JS 实现，见下文风险 3）
  - `:root[data-theme="light"]` 整块
  - `:root[data-theme="light"][data-surface="glass"]` 整块
  - `:root[data-theme="nebula"]` 整块
  - `:root[data-theme="nebula"][data-surface="glass"]` 整块
- [ ] 保留：`:root` 共享变量块、`html[data-font-weight]`、`html[data-font-family]`
- [ ] 确认 `shadcn-tokens.css` 无需修改（它引用 `var()` 名称，变量来源透明）
- [ ] 确认 `styles.css` 的星域 accent 覆盖无需修改（逐元素解析，兼容 setProperty）

### 步骤 5：验证
- [ ] `cd desktop && npx tsc --noEmit`
- [ ] 运行 `theme.test.ts` 和 `glass.test.ts`，确认现有测试通过
- [ ] 新增 `theme-loader.test.ts`：
  - JSON 文件存在性 + 格式校验（每个 JSON 含 `variables`/`surfaces`/`glass` 三 key）
  - `applyThemeJson` 对 `document.documentElement.style` 的 setProperty 覆盖测试
  - glass toggle 前后 surface token 切换正确性
- [ ] `cd desktop && node --import tsx --test --test-reporter spec src/**/__tests__/*.test.ts`
- [ ] 目视验证：`npm run dev` 后切换 dark → light → nebula，开启/关闭毛玻璃，拖动 slider

## 风险与注意事项（修订版）

1. **`color-mix()` 表达式存储**：JSON 中 glass surface token 的值是 `color-mix(in oklab, var(--bg) var(--sidebar-glass-opacity), transparent)` 这类**CSS 表达式字符串**，不是解析后的颜色值。`setProperty` 接受任意字符串，浏览器在 computed-value 阶段解析 `color-mix()` 和 `var()`。这是合法的，也是唯一可行的方案——如果存解析后的 hex，slider 变化时颜色不会更新。

2. **JSON static import 不引入 FOUC**：`import dark from './themes/dark.json'` 是编译时常量，`applyThemeJson` 在 `main.tsx` 第一行同步调用。不使用 `await import()`，避免异步加载引入闪烁。

3. **`prefers-reduced-transparency` 媒体查询需用 JS 实现**：当前 tokens.css 用 `@media (prefers-reduced-transparency: reduce)` 强制 solid surface。JSON 驱动后需在 `theme-loader.ts` 中添加 `matchMedia` 监听，当用户启用减少透明度时自动忽略 glass 配置。或在 `applyThemeJson` 中检查此媒体查询，始终写入 `surfaces` 而非 `glass`。

4. **向后兼容策略**：过渡期 CSS + JSON 双轨运行不可行——`setProperty` 优先级高于 stylesheet，CSS 块的值会被 JSON 注入的值覆盖。执行步骤 4（清理 tokens.css）和步骤 3（集成）必须在同一次提交中完成，不能分批。

5. **新增主题只需一个 JSON 文件**：将 `ThemePref` 类型扩展为新主题名，创建对应 JSON，在 `theme-loader.ts` 的 import map 中加一项，在 `SettingsSurface.tsx` 的 Select options 中加一项——三步，不再碰 tokens.css。

## 验证命令

```bash
cd desktop
npx tsc --noEmit
npm run build
node --import tsx --test --test-reporter spec src/**/__tests__/*.test.ts
# 目视验证：npm run dev 后切换 dark → light → nebula，开启/关闭毛玻璃
```
