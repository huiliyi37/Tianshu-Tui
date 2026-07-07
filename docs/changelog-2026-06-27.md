# Changelog — 2026-06-27

> Desktop shadcn/ui Phase 5：继续将高频自定义组件迁移到 shadcn/ui，统一交互语言并补齐确认对话框。

---

## 一、PlusMenu → DropdownMenu + Command 子面板

**问题**：Composer 的 `+` 菜单原先完全手写，自己维护打开状态、点击外部关闭、子面板搜索与键盘导航，代码量较大且可访问性较弱。

**改动**：

| 文件 | 变更 |
|------|------|
| `desktop/src/components/PlusMenu.tsx` | 根菜单改为 `DropdownMenu`；Plan/Agent 模式使用 `DropdownMenuRadioGroup`；Models / Skills / 星域 / 命令 改为 `CommandDialog` 可搜索子面板；MCP 状态也改用 Command 面板展示 |
| `desktop/src/components/Composer.tsx` | 移除 `plusOpen` 状态与手写点击外部关闭逻辑；直接渲染 `PlusMenu` |
| `desktop/src/styles.css` | 删除 `.plus-menu*`、`.plus-sub*`、`.pm-*` 等已废弃样式，保留 `.plus-wrap` / `.plus-btn` 触发器样式 |

**效果**：
- 菜单展开/收起、子面板返回、键盘导航由 base-ui/shadcn 接管
- 子面板支持输入过滤、↑↓ 选择、Enter 确认、Esc 关闭
- 删除约 60 行手写 CSS

---

## 二、SettingsSurface 选项改用 Select

**问题**：设置页的主题、语言、工具组密度、通知策略使用手写分段按钮（`.seg-item`），扩展选项时需要改 CSS 与 JSX 两处。

**改动**：

| 文件 | 变更 |
|------|------|
| `desktop/src/surfaces/SettingsSurface.tsx` | 外观/语言/工具组密度/通知四项统一改为 `Select` + `SelectItem` |

**效果**：新增选项只需扩展数组，样式由 shadcn 统一处理。

---

## 三、AlertDialog 二次确认

**问题**：关闭会话和回滚检查点是破坏性操作，原先直接执行，容易误触。

**改动**：

| 文件 | 变更 |
|------|------|
| `desktop/src/surfaces/ThreadView.tsx` | 标题栏关闭按钮增加 `AlertDialog` 确认：“关闭后该线程将从标签栏移除，未保存的上下文将丢失。” |
| `desktop/src/surfaces/ReviewPanel.tsx` | “确认回滚”按钮增加 `AlertDialog`，展示回滚预览摘要，并提示 bash 等副作用无法撤销 |
| `desktop/src/components/ui/alert-dialog.tsx` | 修复生成的 `bg-muted` 为 `bg-panel-2/50` / `bg-panel-2`，避免项目 `--muted` 是文本色导致的背景异常 |

---

## 四、ThreadTabs 右键菜单

**问题**：ThreadTabs 原先仅支持点击切换和中键关闭，缺少批量管理。

**改动**：

| 文件 | 变更 |
|------|------|
| `desktop/src/components/ThreadTabs.tsx` | 每个标签用 `ContextMenuTrigger` 包裹，右键菜单支持：复制标题、关闭、关闭其他标签、关闭右侧标签 |

**效果**：复用桌面端常见的标签右键交互，保留原有拖拽排序与中键关闭。

---

## 五、验证

- `npm run typecheck` ✅
- `npm run test` ✅ 136 tests pass
- `npm run check:i18n` ✅
- `npm run build` ✅

**构建体积**：JS gzip ~533 KB（+30 KB），CSS gzip ~35 KB（+1 KB）。
